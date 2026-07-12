#!/usr/bin/env node
import path from 'node:path';
import { IndexStore } from './store.js';
import { indexRepo, watchRepo } from './watcher.js';
import { startMcpServer } from './mcpServer.js';
import { startHttpMcpServer } from './httpServer.js';

const [, , command, ...rest] = process.argv;
const repoPath = rest.find((a) => !a.startsWith('--')) ?? process.cwd();
const snapshotPath = path.join(repoPath, '.context-daemon', 'index.json');
const useHttp = rest.includes('--http');
const portArg = rest.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.slice('--port='.length)) : 7621;

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
      await startHttpMcpServer(store, port);
    } else {
      await startMcpServer(store);
    }
    return;
  }

  console.error(`Usage:
  context-daemon index <repoPath>              One-time index + print stats
  context-daemon watch <repoPath>               Index + watch + log changes as they happen
  context-daemon mcp <repoPath>                 Index + watch + serve over MCP (stdio), one client per process
  context-daemon mcp <repoPath> --http [--port=7621]
                                                 Index + watch + serve over MCP (Streamable HTTP) so
                                                 multiple clients (Claude Code, Cursor, ...) can share
                                                 one running daemon and one index at the same time
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
