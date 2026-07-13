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

class PythonWorker {
  private proc: ChildProcess | null = null;
  private queue: Array<{ resolve: (val: any) => void; reject: (err: any) => void }> = [];
  private startPromise: Promise<boolean> | null = null;

  async start(): Promise<boolean> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const interp = await resolveInterpreter();
      if (!interp) return false;
      
      try {
        this.proc = spawn(interp, ['-u', PARSE_SCRIPT, '--worker']);
        this.proc.on('error', (err) => {
          this.handleCrash(err);
        });
        this.proc.on('exit', (code) => {
          this.handleCrash(new Error(`Python process exited with code ${code}`));
        });
        
        // Suppress stderr noise but allow printing errors
        this.proc.stderr!.on('data', (d) => {
          console.error(`context-daemon: python worker stderr: ${d.toString().trim()}`);
        });

        const rl = readline.createInterface({
          input: this.proc.stdout!,
          terminal: false
        });
        
        rl.on('line', (line) => {
          const next = this.queue.shift();
          if (!next) return;
          try {
            const parsed = JSON.parse(line);
            next.resolve(parsed);
          } catch (e) {
            next.reject(e);
          }
        });
        
        return true;
      } catch (err) {
        console.error('context-daemon: failed to start Python worker:', err);
        return false;
      }
    })();
    return this.startPromise;
  }

  private handleCrash(err: Error) {
    const oldQueue = this.queue;
    this.queue = [];
    for (const item of oldQueue) {
      item.reject(err);
    }
    this.proc = null;
    this.startPromise = null;
  }

  close() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.startPromise = null;
    this.queue = [];
  }

  async parse(content: string): Promise<any> {
    const active = await this.start();
    if (!active || !this.proc) {
      throw new Error('Python worker not active');
    }
    
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.proc!.stdin!.write(JSON.stringify({ content }) + '\n');
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

