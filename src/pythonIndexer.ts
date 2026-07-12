import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeChunk } from './types.js';
import { hashContent } from './hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is dist/src at runtime; the helper script ships alongside the
// TS source, not compiled, so walk up to the project root to find it.
const PARSE_SCRIPT = path.join(__dirname, '..', '..', 'python', 'parse_python.py');

const CANDIDATE_INTERPRETERS = ['python3', 'python'];
let interpreterPromise: Promise<string | null> | undefined;

/** Spawns a command and resolves its {code, stdout} without blocking the
 *  event loop. Rejects only on spawn failure (e.g. command not found). */
function run(command: string, args: string[], input?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? 0, stdout }));
    if (input !== undefined) {
      proc.stdin.on('error', () => {}); // ignore EPIPE if the child exits early
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

/** Finds a usable Python interpreter once, without blocking. Cached. */
function resolveInterpreter(): Promise<string | null> {
  if (interpreterPromise) return interpreterPromise;
  interpreterPromise = (async () => {
    for (const candidate of CANDIDATE_INTERPRETERS) {
      try {
        await run(candidate, ['--version']);
        return candidate;
      } catch {
        // not this one, try the next
      }
    }
    console.error(
      'context-daemon: no Python interpreter found on PATH (tried "python3", "python") — .py files will be skipped.'
    );
    return null;
  })();
  return interpreterPromise;
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
 *
 * Async (non-blocking): the earlier spawnSync froze the whole event loop
 * for every .py file, which stalled the MCP server and any client during
 * indexing of a Python repo. This streams via spawn instead.
 */
export async function parsePythonFile(filePath: string, content: string): Promise<CodeChunk[]> {
  const interpreter = await resolveInterpreter();
  if (!interpreter) return [];

  let stdout: string;
  try {
    const result = await run(interpreter, [PARSE_SCRIPT], content);
    if (result.code !== 0 || !result.stdout) return [];
    stdout = result.stdout;
  } catch {
    return []; // interpreter vanished, etc.
  }

  let parsed: { chunks?: PythonChunk[]; error?: string };
  try {
    parsed = JSON.parse(stdout);
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
