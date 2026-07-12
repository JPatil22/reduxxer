import chokidar from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ignoreLib, { type Ignore } from 'ignore';
import { IndexStore } from './store.js';
import { parseFile } from './indexer.js';
import { embedText } from './embeddings.js';

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

/** Test files add noise to search results (huge files, no real symbols to
 *  target) without being what someone means by "give me the relevant code". */
const TEST_FILE_PATTERN = /(\.(test|spec)\.[jt]sx?$)|([\\/](__tests__|test|tests)[\\/])/;

/** Sane baseline ignores, applied even if the repo has no .gitignore (or
 *  one that doesn't cover build output). Real repos also get whatever
 *  their own .gitignore excludes — which naturally solves noise like a
 *  package that ships both src/ and a compiled dist/ of the same code. */
function loadIgnore(rootDir: string): Ignore {
  const ig = ignoreLib();
  ig.add(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.context-daemon']);
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

function hashContent(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex');
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
    const chunks = parseFile(filePath, content);
    for (const chunk of chunks) {
      chunk.embedding = await embedText(embeddingInput(chunk.symbolName, chunk.code));
    }
    store.upsertFile(filePath, hash, chunks, content);
  } catch {
    // unreadable/binary file, ignore
  }
}

export async function indexRepo(store: IndexStore, rootDir: string): Promise<void> {
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Repo path does not exist: ${rootDir}`);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Repo path is not a directory: ${rootDir}`);
  }

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
  const ig = loadIgnore(rootDir);
  const watcher = chokidar.watch(rootDir, {
    ignored: (filePath: string) => isIgnored(ig, rootDir, filePath),
    ignoreInitial: true,
    persistent: true,
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
