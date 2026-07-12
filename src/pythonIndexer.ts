import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeChunk } from './types.js';
import { hashContent } from './hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is dist/src at runtime; the helper script ships alongside the
// TS source, not compiled, so walk up to the project root to find it.
const PARSE_SCRIPT = path.join(__dirname, '..', '..', 'python', 'parse_python.py');

const CANDIDATE_INTERPRETERS = ['python3', 'python'];
let resolvedInterpreter: string | null | undefined; // undefined = not checked yet, null = none found

function resolveInterpreter(): string | null {
  if (resolvedInterpreter !== undefined) return resolvedInterpreter;
  for (const candidate of CANDIDATE_INTERPRETERS) {
    const probe = spawnSync(candidate, ['--version']);
    if (!probe.error) {
      resolvedInterpreter = candidate;
      return resolvedInterpreter;
    }
  }
  resolvedInterpreter = null;
  console.error(
    'context-daemon: no Python interpreter found on PATH (tried "python3", "python") — .py files will be skipped.'
  );
  return null;
}

interface PythonExternal {
  name: string;
  level: number; // 0 = absolute import, 1 = `.`, 2 = `..`, ...
  module: string | null;
}

interface PythonChunk {
  name: string;
  kind: string;
  start: number;
  end: number;
  references: string[];
  external?: PythonExternal[];
}

/**
 * Resolves a Python `from ... import name` to "<path-without-ext>::<name>"
 * (the store tries .py / package __init__.py against it). Relative imports
 * (level >= 1) resolve precisely from the file's directory; absolute
 * imports (level 0) are a best-effort guess relative to the same directory,
 * which simply finds nothing (harmless) if the guess is wrong.
 */
function resolvePythonImport(filePath: string, ext: PythonExternal): string {
  let baseDir = path.dirname(filePath);
  for (let i = 0; i < ext.level - 1; i++) baseDir = path.dirname(baseDir);
  const moduleParts = ext.module ? ext.module.split('.') : [];
  const prefix = path.join(baseDir, ...moduleParts);
  return `${prefix}::${ext.name}`;
}

/**
 * Parses a Python file into symbol-level chunks (top-level functions,
 * async functions, and classes) using Python's own `ast` module via a
 * subprocess — real parsing, not regex, but out-of-process since there's
 * no equivalent to the TypeScript compiler API for Python in Node.
 */
export function parsePythonFile(filePath: string, content: string): CodeChunk[] {
  const interpreter = resolveInterpreter();
  if (!interpreter) return [];

  const result = spawnSync(interpreter, [PARSE_SCRIPT], {
    input: content,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error || result.status !== 0 || !result.stdout) return [];

  let parsed: { chunks?: PythonChunk[]; error?: string };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  if (parsed.error || !parsed.chunks) return []; // syntax error in the target file, skip it

  const fileHash = hashContent(content);
  const lines = content.split('\n');

  const chunks: CodeChunk[] = parsed.chunks.map((c) => ({
    id: `${filePath}::${c.name}`,
    filePath,
    symbolName: c.name,
    kind: c.kind,
    startLine: c.start,
    endLine: c.end,
    code: lines.slice(c.start - 1, c.end).join('\n'),
    fileHash,
    references: c.references?.length ? c.references.map((name) => `${filePath}::${name}`) : undefined,
    externalRefs: c.external?.length
      ? c.external.map((ext) => resolvePythonImport(filePath, ext))
      : undefined,
  }));

  if (chunks.length === 0 && content.trim().length > 0) {
    chunks.push({
      id: `${filePath}::__file__`,
      filePath,
      symbolName: '__file__',
      kind: 'file',
      startLine: 1,
      endLine: lines.length,
      code: content,
      fileHash,
    });
  }

  return chunks;
}
