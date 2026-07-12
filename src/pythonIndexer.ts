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

interface PythonChunk {
  name: string;
  kind: string;
  start: number;
  end: number;
  references: string[];
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
