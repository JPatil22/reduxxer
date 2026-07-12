#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IndexStore } from './store.js';
import { indexRepo, watchRepo } from './watcher.js';
import { startMcpServer } from './mcpServer.js';
import { startHttpMcpServer } from './httpServer.js';

const [, , command, ...rest] = process.argv;
const repoPath = rest.find((a) => !a.startsWith('--')) ?? process.cwd();
const daemonDir = path.join(repoPath, '.context-daemon');
const snapshotPath = path.join(daemonDir, 'index.json');
const tokenPath = path.join(daemonDir, 'http-token');
const useHttp = rest.includes('--http');
const portArg = rest.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.slice('--port='.length)) : 7621;
const tokenArg = rest.find((a) => a.startsWith('--token='));

/** A stable per-repo token, generated once and reused across restarts so
 *  client configs don't need updating every time the daemon restarts. */
function loadOrCreateToken(): string {
  if (tokenArg) return tokenArg.slice('--token='.length);
  if (fs.existsSync(tokenPath)) return fs.readFileSync(tokenPath, 'utf-8').trim();
  const token = randomUUID();
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(tokenPath, token, 'utf-8');
  return token;
}

async function main() {
  const store = new IndexStore();

  if (command === 'index') {
    const loaded = store.load(snapshotPath);
    console.error(loaded ? `Loaded snapshot from ${snapshotPath}, re-indexing changes ...` : `Indexing ${repoPath} ...`);
    await indexRepo(store, repoPath);
    store.save(snapshotPath);
    console.error(JSON.stringify(store.stats(), null, 2));
    return;
  }

  if (command === 'watch') {
    const loaded = store.load(snapshotPath);
    console.error(loaded ? `Loaded snapshot from ${snapshotPath}, re-indexing changes ...` : `Indexing ${repoPath} ...`);
    await indexRepo(store, repoPath);
    store.save(snapshotPath);
    console.error(JSON.stringify(store.stats(), null, 2));
    console.error('Watching for changes... (Ctrl+C to stop)');
    watchRepo(store, repoPath, (event, filePath) => {
      store.save(snapshotPath);
      console.error(`[${event}] re-indexed ${filePath} -> ${JSON.stringify(store.stats())}`);
    });
    return;
  }

  if (command === 'mcp') {
    store.load(snapshotPath);
    await indexRepo(store, repoPath);
    store.save(snapshotPath);
    watchRepo(store, repoPath, () => store.save(snapshotPath));
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
