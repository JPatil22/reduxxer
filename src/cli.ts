#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IndexStore } from './store.js';
import { indexRepo, watchRepo } from './watcher.js';
import { startMcpServer } from './mcpServer.js';
import { startHttpMcpServer } from './httpServer.js';
import { disableEmbeddings } from './embeddings.js';
import { closePythonWorker } from './pythonIndexer.js';

const [, , command, ...rest] = process.argv;
if (rest.includes('--no-embeddings')) {
  disableEmbeddings();
  console.error('context-daemon: --no-embeddings set — lexical-only search, no model download.');
}
// Resolve to absolute so the snapshot location and the indexed file paths
// are canonical no matter whether the repo was passed as "." or a full path.
const repoPath = path.resolve(rest.find((a) => !a.startsWith('--')) ?? process.cwd());
const daemonDir = path.join(repoPath, '.context-daemon');
const snapshotPath = path.join(daemonDir, 'index.json');
const tokenPath = path.join(daemonDir, 'http-token');
const useHttp = rest.includes('--http');
const portArg = rest.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.slice('--port='.length)) : 7621;
const tokenArg = rest.find((a) => a.startsWith('--token='));

/** Ensures the daemon's own folder can never be committed to the user's
 *  repo — it holds the index snapshot and the plaintext HTTP auth token.
 *  Self-protecting via an ignore-everything .gitignore inside the folder,
 *  so it works even if the repo's own .gitignore doesn't mention it. */
function ensureDaemonDirIgnored(): void {
  fs.mkdirSync(daemonDir, { recursive: true });
  const gitignore = path.join(daemonDir, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n', 'utf-8');
}

/** A stable per-repo token, generated once and reused across restarts so
 *  client configs don't need updating every time the daemon restarts. */
function loadOrCreateToken(): string {
  if (tokenArg) return tokenArg.slice('--token='.length);
  if (fs.existsSync(tokenPath)) return fs.readFileSync(tokenPath, 'utf-8').trim();
  const token = randomUUID();
  ensureDaemonDirIgnored();
  fs.writeFileSync(tokenPath, token, 'utf-8');
  return token;
}

/** Batches rapid successive file-change events into one snapshot write
 *  after a short quiet period, instead of a full snapshot rewrite (which
 *  includes every file's full content) on every single save. */
function debouncedSaver(store: InstanceType<typeof IndexStore>, delayMs = 2000) {
  let timer: NodeJS.Timeout | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      store.save(snapshotPath).catch((err) => console.error('Failed to save index snapshot:', err));
    }, delayMs);
  };
}

async function main() {
  const store = new IndexStore();
  if (command === 'index' || command === 'watch' || command === 'mcp') {
    ensureDaemonDirIgnored();
  }

  if (command === 'index') {
    const loaded = store.load(snapshotPath);
    console.error(loaded ? `Loaded snapshot from ${snapshotPath}, re-indexing changes ...` : `Indexing ${repoPath} ...`);
    await indexRepo(store, repoPath);
    await store.save(snapshotPath);
    console.error(JSON.stringify(store.stats(), null, 2));
    closePythonWorker();
    return;
  }

  if (command === 'watch') {
    const loaded = store.load(snapshotPath);
    console.error(loaded ? `Loaded snapshot from ${snapshotPath}, re-indexing changes ...` : `Indexing ${repoPath} ...`);
    await indexRepo(store, repoPath);
    await store.save(snapshotPath);
    console.error(JSON.stringify(store.stats(), null, 2));
    console.error('Watching for changes... (Ctrl+C to stop)');
    const saveDebounced = debouncedSaver(store);
    watchRepo(store, repoPath, (event, filePath) => {
      saveDebounced();
      console.error(`[${event}] re-indexed ${filePath} -> ${JSON.stringify(store.stats())}`);
    });
    return;
  }

  if (command === 'mcp') {
    store.load(snapshotPath);
    await indexRepo(store, repoPath);
    await store.save(snapshotPath);
    watchRepo(store, repoPath, debouncedSaver(store));
    if (useHttp) {
      await startHttpMcpServer(store, port, loadOrCreateToken());
    } else {
      await startMcpServer(store);
    }
    return;
  }

  console.error(`Usage:
  context-daemon index <repoPath>              One-time index + print stats
  context-daemon watch <repoPath>               Index + watch + log changes as they happen
  context-daemon mcp <repoPath>                 Index + watch + serve over MCP (stdio), one client per process
  context-daemon mcp <repoPath> --http [--port=7621] [--token=secret]
                                                 Index + watch + serve over MCP (Streamable HTTP) so
                                                 multiple clients (Claude Code, Cursor, ...) can share
                                                 one running daemon and one index at the same time.
                                                 Binds to 127.0.0.1 only. A per-repo auth token is
                                                 generated once and saved to .context-daemon/http-token
                                                 (or pass --token= to set your own); clients must send
                                                 it as "Authorization: Bearer <token>".

  --no-embeddings  (any command)                 Skip the embedding model entirely: no ~90MB download,
                                                 no inference. Search falls back to lexical-only — faster
                                                 to start, but no semantic/paraphrase matching.
`);
}

main().catch((err) => {
  // Known, expected failures (bad repo path, etc.) get a clean one-line
  // message; anything unexpected still gets the full stack for debugging.
  if (err instanceof Error && err.message.startsWith('Repo path')) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
