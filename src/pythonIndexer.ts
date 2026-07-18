import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import readline from 'node:readline';
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

// A single parse round-trip should take milliseconds (files are already size-
// capped before they reach here). This bound exists only so a wedged/hung
// worker can't leave a parse() awaiting forever and — via pLimit(8) upstream —
// stall ALL Python indexing. On timeout the worker is killed and respawned.
let parseTimeoutMs = 15000;

/** Test-only: shrink the per-parse timeout so the timeout+restart path can be
 *  exercised deterministically without a genuinely hung interpreter. */
export function setPythonParseTimeoutForTests(ms: number): void {
  parseTimeoutMs = ms;
}

interface PendingRequest {
  resolve: (val: any) => void;
  reject: (err: any) => void;
  timer: NodeJS.Timeout;
}

class PythonWorker {
  private proc: ChildProcess | null = null;
  // Correlated by request id, NOT arrival order — one malformed or dropped
  // line can no longer desync every subsequent response.
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private startPromise: Promise<boolean> | null = null;

  async start(): Promise<boolean> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const interp = await resolveInterpreter();
      if (!interp) return false;
      try {
        const proc = spawn(interp, ['-u', PARSE_SCRIPT, '--worker']);
        this.proc = proc;

        // Death handlers capture THIS proc and no-op if a newer worker has
        // since replaced it, so a dying old worker's exit event can't tear
        // down a freshly-spawned one (the classic stale-handler race).
        const onDead = (err: Error) => {
          if (this.proc !== proc) return;
          this.proc = null;
          this.startPromise = null;
          this.rejectAllPending(err);
        };
        proc.on('error', onDead);
        proc.on('exit', (code) => onDead(new Error(`Python worker exited with code ${code}`)));
        proc.stdin!.on('error', () => {}); // ignore EPIPE if the child exits mid-write
        proc.stderr!.on('data', (d) => {
          console.error(`context-daemon: python worker stderr: ${d.toString().trim()}`);
        });

        readline
          .createInterface({ input: proc.stdout!, terminal: false })
          .on('line', (line) => this.handleLine(line));

        return true;
      } catch (err) {
        console.error('context-daemon: failed to start Python worker:', err);
        this.proc = null;
        this.startPromise = null;
        return false;
      }
    })();
    return this.startPromise;
  }

  private handleLine(line: string): void {
    let resp: any;
    try {
      resp = JSON.parse(line);
    } catch {
      return; // stray/non-protocol stdout line — ignore, don't desync others
    }
    const id = resp?.id;
    const entry = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!entry) return; // unknown id, or one that already timed out
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(resp);
  }

  private rejectAllPending(err: Error): void {
    const pending = this.pending;
    this.pending = new Map();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  close(): void {
    const proc = this.proc;
    this.proc = null;
    this.startPromise = null;
    this.rejectAllPending(new Error('Python worker closed'));
    if (proc) proc.kill();
  }

  async parse(content: string): Promise<any> {
    const active = await this.start();
    if (!active || !this.proc) throw new Error('Python worker not active');
    const proc = this.proc;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return; // already answered
        reject(new Error(`Python worker timed out after ${parseTimeoutMs}ms`));
        // The worker is likely wedged. Tear it down SYNCHRONOUSLY — don't wait
        // for the async 'exit' event, which can lag — so the very next parse()
        // reliably spawns a fresh worker instead of reusing the dead one.
        if (this.proc === proc) {
          this.proc = null;
          this.startPromise = null;
        }
        this.rejectAllPending(new Error('Python worker restarted after a timeout'));
        proc.kill(); // onDead for this proc will no-op (this.proc is no longer it)
      }, parseTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin!.write(JSON.stringify({ id, content }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

const worker = new PythonWorker();

export function closePythonWorker() {
  worker.close();
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

function findRepoRoot(filePath: string): string {
  let current = path.dirname(path.resolve(filePath));
  while (true) {
    const daemonDir = path.join(current, '.context-daemon');
    if (fs.existsSync(daemonDir)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
}

/**
 * Resolves a Python `from ... import name` to "<path-without-ext>::<name>"
 * (the store tries .py / package __init__.py against it). Relative imports
 * (level >= 1) resolve precisely from the file's directory; absolute
 * imports (level 0) resolve relative to the repo root.
 */
function resolvePythonImport(filePath: string, ext: PythonExternal, repoRoot?: string): string {
  let baseDir: string;
  if (ext.level === 0) {
    baseDir = repoRoot ? path.resolve(repoRoot) : findRepoRoot(filePath);
  } else {
    baseDir = path.dirname(filePath);
    for (let i = 0; i < ext.level - 1; i++) baseDir = path.dirname(baseDir);
  }
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
 * This version uses a persistent Python worker process to handle AST requests,
 * eliminating the subprocess spawning overhead entirely.
 */
export async function parsePythonFile(filePath: string, content: string, repoRoot?: string): Promise<CodeChunk[]> {
  let result: any;
  try {
    result = await worker.parse(content);
    if (!result || result.error || !result.chunks) return [];
  } catch {
    return [];
  }

  const fileHash = hashContent(content);
  const lines = content.split('\n');

  const chunks: CodeChunk[] = result.chunks.map((c: PythonChunk) => ({
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
      ? c.external.map((ext) => resolvePythonImport(filePath, ext, repoRoot))
      : undefined,
  }));

  // Guarantee unique ids: Python too can bind the same name twice — typing
  // `@overload` stubs, or a conditional redefinition. Keep the first
  // occurrence bare (references resolve to it) and suffix the rest so none is
  // silently dropped when the store keys chunks by id.
  const nameCounts = new Map<string, number>();
  for (const chunk of chunks) {
    const n = (nameCounts.get(chunk.symbolName) ?? 0) + 1;
    nameCounts.set(chunk.symbolName, n);
    if (n > 1) chunk.id = `${filePath}::${chunk.symbolName}$${n}`;
  }

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

