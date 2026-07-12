import ts from 'typescript';
import { CodeChunk } from './types.js';
import { hashContent } from './hash.js';

const SCRIPT_BLOCK = /<script[^>]*>([\s\S]*?)<\/script>/i;

/**
 * Vue (.vue) and Svelte (.svelte) files aren't plain JS/TS — they wrap
 * component logic in a <script> block alongside template/style markup
 * the TS compiler can't parse. Pull just that block out (with a line
 * offset so reported line numbers still point at the right place in the
 * original file) so the rest of the pipeline can treat it like a normal
 * TS/JS source string. Returns null if there's no script block to index.
 */
function extractScriptBlock(content: string): { code: string; lineOffset: number; isTs: boolean } | null {
  const match = SCRIPT_BLOCK.exec(content);
  if (!match || !match[1].trim()) return null;
  const openTag = match[0].slice(0, match[0].indexOf('>') + 1);
  const isTs = /lang\s*=\s*["']ts["']/i.test(openTag);
  const lineOffset = content.slice(0, match.index).split('\n').length - 1;
  return { code: match[1], lineOffset, isTs };
}

/**
 * Parses one file into symbol-level chunks (functions, classes,
 * interfaces, const arrow-functions) using the TypeScript compiler API.
 * No native bindings required, works for .js/.ts/.tsx/.jsx directly, and
 * for the <script> block of .vue/.svelte single-file components.
 */
export function parseFile(filePath: string, content: string): CodeChunk[] {
  const fileHash = hashContent(content);
  const isSfc = filePath.endsWith('.vue') || filePath.endsWith('.svelte');

  let codeToParse = content;
  let lineOffset = 0;
  let isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');

  if (isSfc) {
    const script = extractScriptBlock(content);
    if (!script) return []; // template/style-only file, nothing to index
    codeToParse = script.code;
    lineOffset = script.lineOffset;
    isTsx = false; // SFC <script> blocks are plain JS/TS, not JSX
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    codeToParse,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const chunks: CodeChunk[] = [];
  const lines = codeToParse.split('\n');
  // Names this chunk calls (e.g. `validateCard(...)`), resolved against
  // other chunks in this same file once every chunk has been collected.
  const calledNamesByChunkId = new Map<string, Set<string>>();

  function getLineRange(node: ts.Node): { start: number; end: number } {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 + lineOffset;
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1 + lineOffset;
    return { start, end };
  }

  /** Collects identifiers used as call/constructor targets within a node,
   *  e.g. `validateCard(x)` or `new Logger()` both contribute a name. */
  function collectCalledNames(node: ts.Node): Set<string> {
    const names = new Set<string>();
    function walk(n: ts.Node) {
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && ts.isIdentifier(n.expression)) {
        names.add(n.expression.text);
      }
      ts.forEachChild(n, walk);
    }
    walk(node);
    return names;
  }

  function addChunk(name: string, kind: string, node: ts.Node) {
    const { start, end } = getLineRange(node);
    // start/end are absolute file line numbers (offset applied); `lines` is
    // relative to the parsed block, so slice using the un-offset range.
    const code = lines.slice(start - 1 - lineOffset, end - lineOffset).join('\n');
    const id = `${filePath}::${name}`;
    calledNamesByChunkId.set(id, collectCalledNames(node));
    chunks.push({
      id,
      filePath,
      symbolName: name,
      kind,
      startLine: start,
      endLine: end,
      code,
      fileHash,
    });
  }

  function isFunctionLikeProperty(m: ts.ClassElement): boolean {
    return (
      ts.isPropertyDeclaration(m) &&
      m.initializer !== undefined &&
      (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))
    );
  }

  function memberName(m: ts.ClassElement): string {
    if (ts.isConstructorDeclaration(m)) return 'constructor';
    return m.name ? m.name.getText(sourceFile) : 'anonymous';
  }

  /**
   * A whole class indexed as one chunk is nearly the whole file — it matches
   * almost any query about the class, crowds out the specific method that
   * actually answers, and barely saves tokens. So split it: one compact
   * "header" chunk (class signature + field declarations, no method bodies)
   * that keeps the class's shape findable, plus one chunk per method.
   */
  function addClassChunks(node: ts.ClassDeclaration, className: string) {
    const methods: ts.ClassElement[] = [];
    const fields: ts.PropertyDeclaration[] = [];
    for (const member of node.members) {
      if (
        ts.isMethodDeclaration(member) ||
        ts.isConstructorDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member) ||
        isFunctionLikeProperty(member)
      ) {
        methods.push(member);
      } else if (ts.isPropertyDeclaration(member)) {
        fields.push(member);
      }
    }

    const mods = node.modifiers?.map((m) => m.getText(sourceFile)).join(' ') ?? '';
    const typeParams = node.typeParameters
      ? `<${node.typeParameters.map((t) => t.getText(sourceFile)).join(', ')}>`
      : '';
    const heritage = node.heritageClauses?.map((h) => h.getText(sourceFile)).join(' ') ?? '';
    const signature = `${mods ? mods + ' ' : ''}class ${className}${typeParams}${heritage ? ' ' + heritage : ''} {`;
    const headerCode = [signature, ...fields.map((f) => '  ' + f.getText(sourceFile)), '}'].join('\n');

    const { start, end } = getLineRange(node);
    const headerId = `${filePath}::${className}`;
    calledNamesByChunkId.set(headerId, new Set());
    chunks.push({
      id: headerId,
      filePath,
      symbolName: className,
      kind: 'class',
      startLine: start,
      endLine: end,
      code: headerCode,
      fileHash,
    });

    for (const member of methods) {
      addChunk(`${className}.${memberName(member)}`, 'method', member);
    }
  }

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      addChunk(node.name.text, 'function', node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      addClassChunks(node, node.name.text);
    } else if (ts.isInterfaceDeclaration(node)) {
      addChunk(node.name.text, 'interface', node);
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          addChunk(decl.name.text, 'const-function', node);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Resolve called names to chunk ids now that every same-file symbol is
  // known. Self-references (recursion) are dropped — not useful context.
  const nameToId = new Map(chunks.map((c) => [c.symbolName, c.id]));
  for (const chunk of chunks) {
    const calledNames = calledNamesByChunkId.get(chunk.id);
    if (!calledNames) continue;
    const references = [...calledNames]
      .map((n) => nameToId.get(n))
      .filter((id): id is string => id !== undefined && id !== chunk.id);
    if (references.length > 0) chunk.references = references;
  }

  if (chunks.length === 0 && codeToParse.trim().length > 0) {
    chunks.push({
      id: `${filePath}::__file__`,
      filePath,
      symbolName: '__file__',
      kind: 'file',
      startLine: 1 + lineOffset,
      endLine: lines.length + lineOffset,
      code: codeToParse,
      fileHash,
    });
  }

  return chunks;
}
