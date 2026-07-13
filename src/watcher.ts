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
import { pLimit } from './utils.js';

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.py']);

/** Test files add noise to search results (huge files, no real symbols to
 *  target) without being what someone means by "give me the relevant code". */
const TEST_FILE_PATTERN =
  /(\.(test|spec)\.[jt]sx?$)|([\\/](__tests__|test|tests)[\\/])|([\\/]test_[^\\/]+\.py$)|(_test\.py$)/;

function parseByExtension(filePath: string, content: string, repoRoot?: string): Promise<CodeChunk[]> {
  return filePath.endsWith('.py')
    ? parsePythonFile(filePath, content, repoRoot)
    : Promise.resolve(parseFile(filePath, content, repoRoot));
}

/** Sane baseline ignores, applied even if the repo has no .gitignore (or
 *  one that doesn't cover build output). Combined with the root .gitignore
 *  (if any) into one Ignore checked against paths relative to the repo root. */
function loadBaselineIgnore(rootDir: string): Ignore {
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
    // no root .gitignore present, baseline ignores above still apply
  }
  return ig;
}

/** Resolves ignore rules the way git does across a monorepo: the root
 *  .gitignore (plus baseline ignores) applies everywhere, and each
 *  subdirectory's own .gitignore additionally applies to paths under it,
 *  with its patterns matched relative to THAT directory, not the repo root.
 *  Per-directory .gitignore contents are cached (read once, reused for every
 *  file under that directory) so this stays cheap on repeated lookups. */
class RepoIgnore {
  private readonly baseline: Ignore;
  private readonly dirIgnoreCache = new Map<string, Ignore | null>();

  constructor(private readonly rootDir: string) {
    this.baseline = loadBaselineIgnore(rootDir);
  }

  private getDirIgnore(dir: string): Ignore | null {
    if (this.dirIgnoreCache.has(dir)) return this.dirIgnoreCache.get(dir)!;
    let ig: Ignore | null = null;
    try {
      ig = ignoreLib().add(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8'));
    } catch {
      ig = null;
    }
    this.dirIgnoreCache.set(dir, ig);
    return ig;
  }

  isIgnored(fullPath: string): boolean {
    const relFromRoot = path.relative(this.rootDir, fullPath).split(path.sep).join('/');
    if (relFromRoot === '') return false;
    if (this.baseline.ignores(relFromRoot)) return true;

    // Check every intermediate directory's own .gitignore (the root's was
    // already folded into `baseline` above), matching the remaining path
    // relative to that directory — a nested .gitignore's patterns are
    // scoped to its own subtree, same as git.
    const parts = relFromRoot.split('/');
    let dir = this.rootDir;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = path.join(dir, parts[i]);
      const ig = this.getDirIgnore(dir);
      if (ig && ig.ignores(parts.slice(i + 1).join('/'))) return true;
    }
    return false;
  }
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

const indexLimit = pLimit(8);

// Files past this size are skipped entirely (not even read) — minified
// bundles and large generated files can stall the TS compiler or Python's
// ast module and produce a giant, low-value embedding call. Genuine
// hand-written source is essentially never this large. Measured on a
// realistic 1.5MB single-blob minified file: ~2.6s to parse, ~2s to embed
// — real but bounded cost, vs. 11s+ at 5MB for the same shape of file.
const MAX_FILE_SIZE_BYTES = 1.5 * 1024 * 1024; // 1.5MB

// A single file producing more chunks than this skips embedding for that
// file — a byte-size guard alone misses a small-but-dense file (thousands
// of tiny functions packed under the size limit). Verified: a 950KB file
// with 22,615 functions parses fine, but sequential embedding at ~15ms/chunk
// would take ~6 minutes for that ONE file inside a single indexFile() call.
// No genuine hand-written file has this many top-level symbols — it's a
// reliable signal of generated/data-like content. Chunks are still stored
// for lexical/BM25 search, just without semantic search for that file.
const MAX_CHUNKS_FOR_EMBEDDING = 500;

/** Re-index a single file, but skip it if content hash hasn't changed. */
export async function indexFile(store: IndexStore, filePath: string, repoRoot?: string): Promise<void> {
  return indexLimit(async () => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        console.error(
          `context-daemon: skipped ${filePath} — ${Math.round(stat.size / 1024)}KB exceeds the ${MAX_FILE_SIZE_BYTES / 1024}KB indexing limit (likely generated/minified)`
        );
        return;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      const hash = hashContent(content);
      if (store.getFileHash(filePath) === hash) return; // unchanged, skip
      const chunks = await parseByExtension(filePath, content, repoRoot);
      if (chunks.length > MAX_CHUNKS_FOR_EMBEDDING) {
        console.error(
          `context-daemon: ${filePath} — ${chunks.length} symbols exceeds the ${MAX_CHUNKS_FOR_EMBEDDING}-chunk embedding limit (likely generated/data-like); indexing for keyword search only, skipping semantic embedding`
        );
      } else {
        // One batched model call for all of this file's chunks instead of one
        // call per chunk — amortizes tokenization/model overhead.
        const vectors = await embedTexts(chunks.map((c) => embeddingInput(c.symbolName, c.code)));
        chunks.forEach((chunk, i) => {
          chunk.embedding = vectors[i];
        });
      }
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
  });
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
  const ig = new RepoIgnore(rootDir);

  const tasks: Promise<void>[] = [];
  async function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = path.join(dir, entry.name);
      if (ig.isIgnored(full)) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (isIndexable(full)) {
        tasks.push(indexFile(store, full, rootDir));
      }
    }
  }
  await walk(rootDir);
  await Promise.all(tasks);
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
  const ig = new RepoIgnore(rootDir);
  const watcher = chokidar.watch(rootDir, {
    ignored: (filePath: string) => ig.isIgnored(filePath),
    ignoreInitial: true,
    persistent: true,
    // A `change` event can fire mid-write (an editor saving, `git pull`
    // rewriting a file), so reading immediately can grab a partial or empty
    // file and index garbage. Wait until the file has stopped growing.
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });

  watcher.on('add', async (filePath) => {
    if (isIndexable(filePath)) {
      await indexFile(store, filePath, rootDir);
      onChange?.('add', filePath);
    }
  });
  watcher.on('change', async (filePath) => {
    if (isIndexable(filePath)) {
      await indexFile(store, filePath, rootDir);
      onChange?.('change', filePath);
    }
  });
  watcher.on('unlink', (filePath) => {
    store.removeFile(filePath);
    onChange?.('remove', filePath);
  });

  return watcher;
}
