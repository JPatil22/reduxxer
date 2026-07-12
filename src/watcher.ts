import chokidar from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { IndexStore } from './store.js';
import { parseFile } from './indexer.js';
import { embedText } from './embeddings.js';

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

/** Test files add noise to search results (huge files, no real symbols to
 *  target) without being what someone means by "give me the relevant code". */
const TEST_FILE_PATTERN = /(\.(test|spec)\.[jt]sx?$)|([\\/](__tests__|test|tests)[\\/])/;

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

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

export async function indexRepo(store: IndexStore, rootDir: string): Promise<void> {
  async function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) await walk(full);
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
  const watcher = chokidar.watch(rootDir, {
    ignored: [/node_modules/, /\.git/, /dist/, /build/],
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
