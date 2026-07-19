import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { IndexStore } from '../src/store.js';
import { startHttpMcpServer } from '../src/httpServer.js';
import { setEmbeddingsEnabled } from '../src/embeddings.js';
import { estimateTokens } from '../src/tokens.js';
import type { CodeChunk } from '../src/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Lexical-only: the moat is about ONE shared index across clients, not the model.
setEmbeddingsEnabled(false);

function makeChunk(file: string, name: string, code: string): CodeChunk {
  return { id: `${file}::${name}`, filePath: file, symbolName: name, kind: 'function', startLine: 1, endLine: 3, code, fileHash: 'h' };
}

async function connectClient(name: string, port: number, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function toolText(res: any): string {
  return res.content[0].text as string;
}

test('two MCP clients share ONE index: an edit made once is visible to both', async () => {
  const store = new IndexStore();
  store.upsertFile('auth.ts', 'h', [makeChunk('auth.ts', 'validateLogin', 'function validateLogin(user) { return checkPassword(user); }')], 'x');

  const token = 'shared-token';
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')), 'requests.log');
  const server = await startHttpMcpServer(store, 0, token, logPath);
  const port = (server.address() as AddressInfo).port;

  const [claude, cursor] = await Promise.all([
    connectClient('claude-code', port, token),
    connectClient('cursor', port, token),
  ]);

  try {
    // Both clients see the same starting index.
    const a = await claude.callTool({ name: 'search_context', arguments: { query: 'validate login', limit: 3 } });
    const b = await cursor.callTool({ name: 'search_context', arguments: { query: 'validate login', limit: 3 } });
    assert.match(toolText(a), /validateLogin/, 'client A finds the seeded symbol');
    assert.match(toolText(b), /validateLogin/, 'client B finds the seeded symbol');

    // THE PROOF: make ONE edit to the shared store (as the file watcher would),
    // then BOTH clients must see it without re-indexing anything themselves.
    store.upsertFile('orders.ts', 'h', [makeChunk('orders.ts', 'cancelOrder', 'function cancelOrder(id) { return refund(id); }')], 'x');

    const a2 = await claude.callTool({ name: 'search_context', arguments: { query: 'cancel order', limit: 3 } });
    const b2 = await cursor.callTool({ name: 'search_context', arguments: { query: 'cancel order', limit: 3 } });
    assert.match(toolText(a2), /cancelOrder/, 'client A sees the edit made once');
    assert.match(toolText(b2), /cancelOrder/, 'client B sees the SAME edit — one shared index, not per-client copies');

    // Per-client attribution: the audit log tags each call with its client name.
    const log = fs.readFileSync(logPath, 'utf-8');
    assert.match(log, /"client":"claude-code"/, 'log attributes calls to claude-code');
    assert.match(log, /"client":"cursor"/, 'log attributes calls to cursor');
  } finally {
    await claude.close();
    await cursor.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('search_context defaults to a lean, budget-capped context (no uncapped multi-file bloat)', async () => {
  const store = new IndexStore();
  // 6 files that all strongly match the query, each a chunky function. The old
  // default (5 chunks + unlimited cross-file expansion) would return several
  // files' worth of code and blow past the budget; the lean default caps it.
  const body = (n: number) =>
    `function handleRequest${n}(req) {\n` +
    Array.from({ length: 40 }, (_, i) => `  const v${i} = validatePayload(req, ${i}); // request pipeline stage ${i}`).join('\n') +
    `\n  return persist${n}(req);\n}`;
  for (let i = 0; i < 6; i++) {
    store.upsertFile(`svc${i}.ts`, 'h', [makeChunk(`svc${i}.ts`, `handleRequest${i}`, body(i))], 'x');
  }

  const token = 't';
  const server = await startHttpMcpServer(store, 0, token);
  const port = (server.address() as AddressInfo).port;
  const client = await connectClient('c', port, token);
  try {
    // No limit / token_budget passed — exercises the DEFAULT path.
    const res = await client.callTool({ name: 'search_context', arguments: { query: 'handle request validate payload persist pipeline' } });
    const tok = estimateTokens(toolText(res));
    assert.ok(tok > 0, 'returns something');
    assert.ok(tok < 2200, `default context is budget-capped (~1500), got ${tok} tokens — not the old uncapped bloat`);
  } finally {
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('shared daemon stays correct under many concurrent searches from both clients', async () => {
  const store = new IndexStore();
  for (let i = 0; i < 20; i++) {
    store.upsertFile(`f${i}.ts`, 'h', [makeChunk(`f${i}.ts`, `handler${i}`, `function handler${i}(req) { return route${i}(req); }`)], 'x');
  }
  const token = 't';
  const server = await startHttpMcpServer(store, 0, token);
  const port = (server.address() as AddressInfo).port;
  const [c1, c2] = await Promise.all([connectClient('a', port, token), connectClient('b', port, token)]);
  try {
    // 20 searches fired at once across both clients against the one shared store.
    const calls: Promise<any>[] = [];
    for (let i = 0; i < 10; i++) {
      calls.push(c1.callTool({ name: 'search_context', arguments: { query: `handler${i}`, limit: 2 } }));
      calls.push(c2.callTool({ name: 'search_context', arguments: { query: `handler${i}`, limit: 2 } }));
    }
    const results = await Promise.all(calls);
    assert.equal(results.length, 20, 'every concurrent call resolved');
    for (const r of results) assert.ok(toolText(r).length > 0, 'each concurrent search returned content, none crashed');
  } finally {
    await c1.close();
    await c2.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
