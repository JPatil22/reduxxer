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

  function getLineRange(node: ts.Node): { start: number; end: number } {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 + lineOffset;
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1 + lineOffset;
    return { start, end };
  }

  function addChunk(name: string, kind: string, node: ts.Node) {
    const { start, end } = getLineRange(node);
    // start/end are absolute file line numbers (offset applied); `lines` is
    // relative to the parsed block, so slice using the un-offset range.
    const code = lines.slice(start - 1 - lineOffset, end - lineOffset).join('\n');
    chunks.push({
      id: `${filePath}::${name}`,
      filePath,
      symbolName: name,
      kind,
      startLine: start,
      endLine: end,
      code,
      fileHash,
    });
  }

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      addChunk(node.name.text, 'function', node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      addChunk(node.name.text, 'class', node);
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
