import chokidar from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import ignoreLib, { type Ignore } from 'ignore';
import { IndexStore } from './store.js';
import { parseFile } from './indexer.js';
import { parsePythonFile } from './pythonIndexer.js';
import { embedTexts } from './embeddings.js';
import { hashContent } from './hash.js';
import { CodeChunk } from './types.js';

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.py']);

/** Test files add noise to search results (huge files, no real symbols to
 *  target) without being what someone means by "give me the relevant code". */
const TEST_FILE_PATTERN =
  /(\.(test|spec)\.[jt]sx?$)|([\\/](__tests__|test|tests)[\\/])|([\\/]test_[^\\/]+\.py$)|(_test\.py$)/;

function parseByExtension(filePath: string, content: string): Promise<CodeChunk[]> {
  return filePath.endsWith('.py')
    ? parsePythonFile(filePath, content)
    : Promise.resolve(parseFile(filePath, content));
}

/** Sane baseline ignores, applied even if the repo has no .gitignore (or
 *  one that doesn't cover build output). Real repos also get whatever
 *  their own .gitignore excludes — which naturally solves noise like a
 *  package that ships both src/ and a compiled dist/ of the same code. */
function loadIgnore(rootDir: string): Ignore {
  const ig = ignoreLib();
  ig.add([
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    'coverage',
    '.context-daemon',
    '__pycache__',
    '.venv',
    'venv',
    '.pytest_cache',
    '*.egg-info',
  ]);
  try {
    ig.add(fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf-8'));
  } catch {
    // no .gitignore present, baseline ignores above still apply
  }
  return ig;
}

function isIgnored(ig: Ignore, rootDir: string, fullPath: string): boolean {
  const rel = path.relative(rootDir, fullPath).split(path.sep).join('/');
  return rel !== '' && ig.ignores(rel);
}

function isIndexable(filePath: string): boolean {
  return EXTENSIONS.has(path.extname(filePath)) && !TEST_FILE_PATTERN.test(filePath);
}

/** Truncated text fed to the embedding model — it has a small context window
 *  anyway, and the symbol name plus the first chunk of code is enough to
 *  capture what a chunk is about for semantic matching. */
function embeddingInput(symbolName: string, code: string): string {
  return `${symbolName}\n${code.slice(0, 1000)}`;
}

/** Re-index a single file, but skip it if content hash hasn't changed. */
export async function indexFile(store: IndexStore, filePath: string): Promise<void> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const hash = hashContent(content);
    if (store.getFileHash(filePath) === hash) return; // unchanged, skip
    const chunks = await parseByExtension(filePath, content);
    // One batched model call for all of this file's chunks instead of one
    // call per chunk — amortizes tokenization/model overhead.
    const vectors = await embedTexts(chunks.map((c) => embeddingInput(c.symbolName, c.code)));
    chunks.forEach((chunk, i) => {
      chunk.embedding = vectors[i];
    });
    store.upsertFile(filePath, hash, chunks, content);
  } catch (err) {
    // A file vanishing between walk and read (ENOENT) is normal churn and
    // stays quiet. Anything else — a parse crash, an embedding failure — is
    // surfaced so a partially-indexed repo isn't a silent mystery.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`context-daemon: skipped ${filePath} — ${message}`);
  }
}

export async function indexRepo(store: IndexStore, rootDir: string): Promise<void> {
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Repo path does not exist: ${rootDir}`);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Repo path is not a directory: ${rootDir}`);
  }

  // Normalize to an absolute path so a file is always stored under one
  // canonical path spelling — otherwise indexing the same repo once as "."
  // and once as its absolute path stores every file twice (duplicate chunks,
  // wasted tokens in search results).
  rootDir = path.resolve(rootDir);
  const ig = loadIgnore(rootDir);

  async function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = path.join(dir, entry.name);
      if (isIgnored(ig, rootDir, full)) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (isIndexable(full)) {
        await indexFile(store, full);
      }
    }
  }
  await walk(rootDir);
}

/** Watches the repo and incrementally re-indexes only the file that changed. */
export function watchRepo(
  store: IndexStore,
  rootDir: string,
  onChange?: (event: string, filePath: string) => void
) {
  // Same canonicalization as indexRepo — chokidar reports absolute paths,
  // so the watcher and the initial walk must agree on path spelling or
  // change events would key differently than the indexed entries.
  rootDir = path.resolve(rootDir);
  const ig = loadIgnore(rootDir);
  const watcher = chokidar.watch(rootDir, {
    ignored: (filePath: string) => isIgnored(ig, rootDir, filePath),
    ignoreInitial: true,
    persistent: true,
    // A `change` event can fire mid-write (an editor saving, `git pull`
    // rewriting a file), so reading immediately can grab a partial or empty
    // file and index garbage. Wait until the file has stopped growing.
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });

  watcher.on('add', async (filePath) => {
    if (isIndexable(filePath)) {
      await indexFile(store, filePath);
      onChange?.('add', filePath);
    }
  });
  watcher.on('change', async (filePath) => {
    if (isIndexable(filePath)) {
      await indexFile(store, filePath);
      onChange?.('change', filePath);
    }
  });
  watcher.on('unlink', (filePath) => {
    store.removeFile(filePath);
    onChange?.('remove', filePath);
  });

  return watcher;
}
