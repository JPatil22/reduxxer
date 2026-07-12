import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IndexStore } from '../src/store.js';
import { CodeChunk } from '../src/types.js';

function chunk(overrides: Partial<CodeChunk>): CodeChunk {
  return {
    id: `${overrides.filePath ?? 'a.ts'}::${overrides.symbolName ?? 'foo'}`,
    filePath: 'a.ts',
    symbolName: 'foo',
    kind: 'function',
    startLine: 1,
    endLine: 1,
    code: 'function foo() {}',
    fileHash: 'hash1',
    ...overrides,
  };
}

test('upsertFile then removeFile leaves the store empty', () => {
  const store = new IndexStore();
  store.upsertFile('a.ts', 'hash1', [chunk({})], 'function foo() {}');
  assert.equal(store.stats().files, 1);
  assert.equal(store.stats().chunks, 1);

  store.removeFile('a.ts');
  assert.equal(store.stats().files, 0);
  assert.equal(store.stats().chunks, 0);
});

test('re-upserting a file replaces its old chunks rather than accumulating them', () => {
  const store = new IndexStore();
  store.upsertFile('a.ts', 'hash1', [chunk({ symbolName: 'foo' })], 'v1');
  store.upsertFile('a.ts', 'hash2', [chunk({ symbolName: 'bar', id: 'a.ts::bar' })], 'v2');
  assert.equal(store.stats().chunks, 1);
  assert.equal(store.allChunks()[0].symbolName, 'bar');
  assert.equal(store.getFileHash('a.ts'), 'hash2');
});

test('search finds a chunk via a literal keyword match (no embeddings involved)', async () => {
  const store = new IndexStore();
  store.upsertFile(
    'a.ts',
    'hash1',
    [chunk({ symbolName: 'cancelOrder', code: 'function cancelOrder(order) { /* cancels it */ }' })],
    'function cancelOrder(order) {}'
  );
  const results = await store.search('cancel order');
  assert.equal(results.length, 1);
  assert.equal(results[0].symbolName, 'cancelOrder');
});

test('search returns nothing for a query with no lexical or semantic match', async () => {
  const store = new IndexStore();
  store.upsertFile('a.ts', 'hash1', [chunk({ symbolName: 'cancelOrder' })], 'function cancelOrder() {}');
  const results = await store.search('completely unrelated zzz qqq');
  assert.equal(results.length, 0);
});

test('whole-file fallback chunks are ranked below a real symbol match on the same terms', async () => {
  const store = new IndexStore();
  store.upsertFile(
    'a.ts',
    'hash1',
    [
      chunk({
        symbolName: 'parseOrder',
        code: 'function parseOrder(input) { return input; }',
        kind: 'function',
        id: 'a.ts::parseOrder',
      }),
    ],
    ''
  );
  store.upsertFile(
    'b.ts',
    'hash2',
    [
      chunk({
        symbolName: '__file__',
        code: 'parse parse parse parse parse order order order order order, a giant file full of the word parse and order repeated many many times to inflate a raw keyword count',
        kind: 'file',
        filePath: 'b.ts',
        id: 'b.ts::__file__',
      }),
    ],
    ''
  );
  const results = await store.search('parse an order', 2);
  assert.equal(results[0].symbolName, 'parseOrder');
});

test('trackSearch computes naive vs targeted token counts and cumulative savings', () => {
  const store = new IndexStore();
  store.upsertFile('a.ts', 'hash1', [chunk({ code: 'short' })], 'a much longer full file content here');
  const results = store.allChunks();

  const entry = store.trackSearch('some query', results);
  assert.equal(entry.chunkCount, 1);
  assert.ok(entry.naiveTokens > entry.targetedTokens, 'naive (whole file) should cost more than the chunk');
  assert.equal(entry.savedTokens, entry.naiveTokens - entry.targetedTokens);

  const savings = store.tokenSavings();
  assert.equal(savings.calls, 1);
  assert.equal(savings.totalSavedTokens, entry.savedTokens);
});

test('save/load round-trips the index to disk', () => {
  const store = new IndexStore();
  store.upsertFile('a.ts', 'hash1', [chunk({})], 'function foo() {}');

  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-')), 'index.json');
  store.save(tmpFile);

  const loaded = new IndexStore();
  const ok = loaded.load(tmpFile);
  assert.equal(ok, true);
  assert.equal(loaded.stats().files, 1);
  assert.equal(loaded.stats().chunks, 1);
  assert.equal(loaded.getFileHash('a.ts'), 'hash1');
});

test('load returns false when there is no snapshot on disk', () => {
  const store = new IndexStore();
  const ok = store.load(path.join(os.tmpdir(), 'definitely-does-not-exist-index.json'));
  assert.equal(ok, false);
});
