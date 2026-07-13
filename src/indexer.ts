import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
import { CodeChunk } from './types.js';
import { hashContent } from './hash.js';

interface TsPathConfig {
  baseUrl: string; // absolute
  paths: Record<string, string[]>;
}

// Parsed once per repo root and reused for every file — tsconfig.json rarely
// changes mid-session, and re-reading/parsing it per file would be wasteful.
const tsConfigCache = new Map<string, TsPathConfig | null>();

/** Loads `compilerOptions.paths`/`baseUrl` from tsconfig.json or
 *  jsconfig.json at the repo root, so non-relative imports like `@/utils/x`
 *  can be resolved to an in-repo file instead of being treated as an
 *  external package (and silently dropped from dependency expansion). */
function loadTsConfig(repoRoot: string): TsPathConfig | null {
  if (tsConfigCache.has(repoRoot)) return tsConfigCache.get(repoRoot)!;
  let config: TsPathConfig | null = null;
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const configPath = path.join(repoRoot, name);
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      // tsconfig allows comments/trailing commas, hence TS's own parser.
      const parsed = ts.parseConfigFileTextToJson(configPath, raw);
      const paths = parsed.config?.compilerOptions?.paths;
      if (!paths) continue;
      const baseUrl = path.resolve(repoRoot, parsed.config.compilerOptions.baseUrl ?? '.');
      config = { baseUrl, paths };
      break;
    } catch {
      continue; // file missing or unparseable, try the next candidate
    }
  }
  tsConfigCache.set(repoRoot, config);
  return config;
}

/** Resolves a non-relative import specifier against tsconfig `paths`
 *  patterns (e.g. `@/*` -> `src/*`, or an exact alias with no wildcard).
 *  Returns an absolute path prefix (no extension) or null if no pattern
 *  matches, in which case the import is treated as a real external package. */
function resolveTsAlias(spec: string, config: TsPathConfig): string | null {
  for (const [pattern, targets] of Object.entries(config.paths)) {
    const star = pattern.indexOf('*');
    if (star < 0) {
      if (pattern !== spec) continue;
      const target = targets[0];
      if (!target) continue;
      return path.resolve(config.baseUrl, target);
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
    const matched = spec.slice(prefix.length, spec.length - suffix.length);
    const target = targets[0];
    if (!target) continue;
    return path.resolve(config.baseUrl, target.replace('*', matched));
  }
  return null;
}

const SCRIPT_BLOCK = /<script[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Vue (.vue) and Svelte (.svelte) files aren't plain JS/TS — they wrap
 * component logic in <script> blocks alongside template/style markup the TS
 * compiler can't parse. Rather than extract one block, we mask everything
 * *outside* the script blocks to blanks (preserving newlines), so:
 *   - ALL script blocks are kept — Vue 3's `<script>` + `<script setup>`,
 *     Svelte's `<script module>`, etc. — not just the first;
 *   - script content stays at its original line positions, so reported line
 *     numbers map 1:1 to the source file with no offset arithmetic.
 * Returns null if there's no script content at all.
 */
function maskToScripts(content: string): string | null {
  const ranges: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  SCRIPT_BLOCK.lastIndex = 0;
  while ((match = SCRIPT_BLOCK.exec(content)) !== null) {
    if (!match[1].trim()) continue;
    const innerStart = match.index + match[0].indexOf('>') + 1;
    ranges.push([innerStart, innerStart + match[1].length]);
  }
  if (ranges.length === 0) return null;

  let out = '';
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '\n') out += '\n';
    else if (ranges.some(([s, e]) => i >= s && i < e)) out += ch;
    else out += ' ';
  }
  return out;
}

/**
 * Parses one file into symbol-level chunks (functions, classes,
 * interfaces, const arrow-functions) using the TypeScript compiler API.
 * No native bindings required, works for .js/.ts/.tsx/.jsx directly, and
 * for the <script> block of .vue/.svelte single-file components.
 */
export function parseFile(filePath: string, content: string, repoRoot?: string): CodeChunk[] {
  const fileHash = hashContent(content);
  const isSfc = filePath.endsWith('.vue') || filePath.endsWith('.svelte');

  let codeToParse = content;
  let lineOffset = 0;
  let isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');

  if (isSfc) {
    const masked = maskToScripts(content);
    if (!masked) return []; // template/style-only file, nothing to index
    codeToParse = masked; // line-aligned with the source, so no offset needed
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

    // The header's line range must cover only what its code actually shows —
    // the declaration line through the last field — not the whole class span,
    // or an AI editing by these coordinates would target the wrong lines.
    const classStart = getLineRange(node).start;
    let headerEnd = classStart;
    for (const f of fields) headerEnd = Math.max(headerEnd, getLineRange(f).end);
    const headerId = `${filePath}::${className}`;
    calledNamesByChunkId.set(headerId, new Set());
    chunks.push({
      id: headerId,
      filePath,
      symbolName: className,
      kind: 'class',
      startLine: classStart,
      endLine: headerEnd,
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

  // Map each locally-bound imported name to the target file (resolved,
  // without extension) and the original exported name. Relative imports
  // resolve directly; non-relative ones are checked against tsconfig/
  // jsconfig `paths` aliases (e.g. `@/utils/x`) when a repo root is known —
  // anything else is a real external package (react, lodash, ...) and isn't
  // in the index. `import { validateUser as vu } from './auth'` records
  // vu -> { pathPrefix: <dir>/auth, originalName: validateUser }.
  const importMap = new Map<string, { pathPrefix: string; originalName: string }>();
  const fileDir = path.dirname(filePath);
  const tsConfig = repoRoot ? loadTsConfig(repoRoot) : null;
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    let resolved: string;
    if (spec.startsWith('.')) {
      resolved = path.resolve(fileDir, spec);
    } else if (tsConfig) {
      const aliased = resolveTsAlias(spec, tsConfig);
      if (!aliased) continue; // no matching alias, a real external package
      resolved = aliased;
    } else {
      continue; // no tsconfig/jsconfig paths known, treat as external package
    }
    const pathPrefix = resolved.replace(/\.(ts|tsx|js|jsx)$/, '');
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) importMap.set(clause.name.text, { pathPrefix, originalName: clause.name.text });
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        importMap.set(el.name.text, {
          pathPrefix,
          originalName: (el.propertyName ?? el.name).text,
        });
      }
    }
  }

  // Resolve called names to chunk ids now that every same-file symbol is
  // known. Self-references (recursion) are dropped — not useful context.
  // Names that aren't same-file but are imported become cross-file refs,
  // resolved to actual chunk ids by the store at search time.
  const nameToId = new Map(chunks.map((c) => [c.symbolName, c.id]));
  for (const chunk of chunks) {
    const calledNames = calledNamesByChunkId.get(chunk.id);
    if (!calledNames) continue;
    const references: string[] = [];
    const externalRefs: string[] = [];
    for (const name of calledNames) {
      const sameFileId = nameToId.get(name);
      if (sameFileId && sameFileId !== chunk.id) {
        references.push(sameFileId);
      } else if (!sameFileId) {
        const imported = importMap.get(name);
        if (imported) externalRefs.push(`${imported.pathPrefix}::${imported.originalName}`);
      }
    }
    if (references.length > 0) chunk.references = references;
    if (externalRefs.length > 0) chunk.externalRefs = externalRefs;
  }

  // Module-header chunk: imports, re-exports, top-level constants/config, and
  // type/enum declarations — the file-level wiring that isn't a function or
  // class. Without this, questions like "what does this file import" or
  // "what's the default port" (a top-level const) match nothing, forcing a
  // full-file read. Additive and small, so it doesn't crowd real symbols.
  const headerParts: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) {
      headerParts.push(stmt.getText(sourceFile));
    } else if (ts.isVariableStatement(stmt)) {
      const isFn = stmt.declarationList.declarations.some(
        (d) => d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
      );
      if (!isFn) headerParts.push(stmt.getText(sourceFile));
    } else if (ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      headerParts.push(stmt.getText(sourceFile));
    }
  }
  if (headerParts.length > 0) {
    chunks.push({
      id: `${filePath}::__module__`,
      filePath,
      symbolName: '__module__',
      kind: 'module',
      startLine: 1 + lineOffset,
      endLine: lines.length + lineOffset,
      code: headerParts.join('\n'),
      fileHash,
    });
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
