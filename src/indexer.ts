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
  // Keyed by the chunk OBJECT, not its id: ids are made unique in a later
  // pass (overload merge + collision suffixing), so an id captured now could
  // go stale — object identity never does.
  const calledNamesByChunk = new Map<CodeChunk, Set<string>>();
  // Function-declaration overload bookkeeping (see mergeFunctionOverloads).
  const fnDecls: Array<{ chunk: CodeChunk; parentPos: number; name: string; hasBody: boolean }> = [];

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

  function addChunk(name: string, kind: string, node: ts.Node): CodeChunk {
    const { start, end } = getLineRange(node);
    // start/end are absolute file line numbers (offset applied); `lines` is
    // relative to the parsed block, so slice using the un-offset range.
    const code = lines.slice(start - 1 - lineOffset, end - lineOffset).join('\n');
    const chunk: CodeChunk = {
      id: `${filePath}::${name}`, // provisional — made unique in assignUniqueIds()
      filePath,
      symbolName: name,
      kind,
      startLine: start,
      endLine: end,
      code,
      fileHash,
    };
    calledNamesByChunk.set(chunk, collectCalledNames(node));
    chunks.push(chunk);
    return chunk;
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

    // Decorators (@Component(...)) render on their own line(s) ABOVE the
    // signature. In TS 5's AST they live inside node.modifiers, so folding all
    // modifiers into one string would mash a multi-line decorator onto the
    // signature line — split them out via the typed accessors instead.
    const decoratorLines = (
      (ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined) ?? []
    ).map((d) => d.getText(sourceFile));
    const mods = (ts.getModifiers(node) ?? []).map((m) => m.getText(sourceFile)).join(' ');
    const typeParams = node.typeParameters
      ? `<${node.typeParameters.map((t) => t.getText(sourceFile)).join(', ')}>`
      : '';
    const heritage = node.heritageClauses?.map((h) => h.getText(sourceFile)).join(' ') ?? '';
    const signature = `${mods ? mods + ' ' : ''}class ${className}${typeParams}${heritage ? ' ' + heritage : ''} {`;
    const headerCode = [...decoratorLines, signature, ...fields.map((f) => '  ' + f.getText(sourceFile)), '}'].join(
      '\n'
    );

    // The header's line range must cover only what its code actually shows —
    // the declaration line through the last field — not the whole class span,
    // or an AI editing by these coordinates would target the wrong lines.
    const classStart = getLineRange(node).start;
    let headerEnd = classStart;
    for (const f of fields) headerEnd = Math.max(headerEnd, getLineRange(f).end);
    const headerChunk: CodeChunk = {
      id: `${filePath}::${className}`, // provisional — made unique in assignUniqueIds()
      filePath,
      symbolName: className,
      kind: 'class',
      startLine: classStart,
      endLine: headerEnd,
      code: headerCode,
      fileHash,
    };
    calledNamesByChunk.set(headerChunk, new Set());
    chunks.push(headerChunk);

    for (const member of methods) {
      // get/set accessor pairs share a member name; a distinct `kind` keeps the
      // two chunks self-describing, and assignUniqueIds keeps their ids apart.
      const kind = ts.isGetAccessorDeclaration(member)
        ? 'getter'
        : ts.isSetAccessorDeclaration(member)
          ? 'setter'
          : 'method';
      addChunk(`${className}.${memberName(member)}`, kind, member);
    }
  }

  /** A compact one-line header chunk for a namespace/module, so the namespace
   *  name itself is findable (its members are indexed separately, qualified). */
  function addNamespaceHeader(node: ts.ModuleDeclaration, qualifiedName: string): void {
    const { start } = getLineRange(node);
    const mods = (ts.getModifiers(node) ?? []).map((m) => m.getText(sourceFile)).join(' ');
    const keyword = node.flags & ts.NodeFlags.Namespace ? 'namespace' : 'module';
    const chunk: CodeChunk = {
      id: `${filePath}::${qualifiedName}`, // provisional — made unique in assignUniqueIds()
      filePath,
      symbolName: qualifiedName,
      kind: 'namespace',
      startLine: start,
      endLine: start,
      code: `${mods ? mods + ' ' : ''}${keyword} ${qualifiedName} {`,
      fileHash,
    };
    calledNamesByChunk.set(chunk, new Set());
    chunks.push(chunk);
  }

  function visit(node: ts.Node, prefix = '') {
    // namespace/module Foo { ... } — index the namespace itself and QUALIFY its
    // members (Foo.bar), the way class methods are qualified, instead of
    // flattening members to bare top-level names that collide across namespaces
    // and lose the namespace they belong to. String-module (`declare module
    // 'x'`) and `declare global` blocks fall through to the generic recursion.
    if (ts.isModuleDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      const qualified = prefix + node.name.text;
      addNamespaceHeader(node, qualified);
      if (node.body) {
        if (ts.isModuleBlock(node.body)) {
          for (const stmt of node.body.statements) visit(stmt, `${qualified}.`);
        } else if (ts.isModuleDeclaration(node.body)) {
          visit(node.body, `${qualified}.`); // dotted shorthand: `namespace A.B {}`
        }
      }
      return; // handled the body ourselves — skip the generic recursion below
    }

    if (ts.isFunctionDeclaration(node)) {
      // A nameless function declaration is only legal as `export default
      // function() {}` — index it under a synthetic `default` name so its body
      // is findable instead of invisible.
      const name = prefix + (node.name?.text ?? 'default');
      const chunk = addChunk(name, 'function', node);
      // Bodyless declarations are overload signatures; the one with a body is
      // the implementation. Grouped and merged after the walk.
      fnDecls.push({ chunk, parentPos: node.parent.pos, name, hasBody: !!node.body });
    } else if (ts.isClassDeclaration(node)) {
      // Named, or anonymous `export default class {}`.
      addClassChunks(node, prefix + (node.name?.text ?? 'default'));
    } else if (ts.isInterfaceDeclaration(node)) {
      addChunk(prefix + node.name.text, 'interface', node);
    } else if (ts.isExportAssignment(node) && !node.isExportEquals && !ts.isIdentifier(node.expression)) {
      // `export default <expr>` where expr isn't a bare identifier (a bare
      // identifier just re-exports an already-indexed symbol). Captures
      // anonymous default arrows/functions and HOC-wrapped components
      // (`export default connect()(App)`), which were otherwise invisible.
      const kind =
        ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression)
          ? 'const-function'
          : ts.isClassExpression(node.expression)
            ? 'class'
            : 'value';
      addChunk(prefix + 'default', kind, node);
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          addChunk(prefix + decl.name.text, 'const-function', node);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, prefix));
  }

  visit(sourceFile);

  /**
   * Collapse function-declaration overloads into one chunk. TS requires
   * overload signatures (bodyless) to be contiguous and to immediately
   * precede the implementation, all sharing a parent — so a group keyed by
   * (parent, name) spans a clean, contiguous line range. Without this, three
   * `foo` declarations produced three chunks with the SAME id, and all but
   * one were silently dropped by the store.
   */
  function mergeFunctionOverloads(): void {
    const groups = new Map<string, typeof fnDecls>();
    for (const fd of fnDecls) {
      const key = `${fd.parentPos}::${fd.name}`;
      const g = groups.get(key);
      if (g) g.push(fd);
      else groups.set(key, [fd]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // Representative: the implementation if present, else the last signature
      // (ambient overloads that have no implementation body).
      const rep = group.find((g) => g.hasBody) ?? group[group.length - 1];
      let start = rep.chunk.startLine;
      let end = rep.chunk.endLine;
      for (const g of group) {
        start = Math.min(start, g.chunk.startLine);
        end = Math.max(end, g.chunk.endLine);
      }
      rep.chunk.startLine = start;
      rep.chunk.endLine = end;
      rep.chunk.code = lines.slice(start - 1 - lineOffset, end - lineOffset).join('\n');
      for (const g of group) {
        if (g.chunk === rep.chunk) continue;
        const idx = chunks.indexOf(g.chunk);
        if (idx >= 0) chunks.splice(idx, 1);
        calledNamesByChunk.delete(g.chunk);
      }
    }
  }

  /**
   * Guarantee every chunk id is unique within the file. Two symbols can
   * legitimately share a name — declaration merging (an `interface Config`
   * plus a `function Config`, a value plus a type), get/set accessor pairs,
   * or any residual same-name symbols. The first occurrence keeps the bare
   * `${file}::${name}` id (so cross-file import resolution still finds it);
   * later ones are suffixed with `$n` so none is silently overwritten.
   */
  function assignUniqueIds(): void {
    const counts = new Map<string, number>();
    for (const chunk of chunks) {
      const n = (counts.get(chunk.symbolName) ?? 0) + 1;
      counts.set(chunk.symbolName, n);
      chunk.id = n === 1 ? `${filePath}::${chunk.symbolName}` : `${filePath}::${chunk.symbolName}$${n}`;
    }
  }

  mergeFunctionOverloads();
  assignUniqueIds();

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
    const calledNames = calledNamesByChunk.get(chunk);
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
