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

test('buildContext renders a ghost file: imports + matched code + collapsed siblings', () => {
  const store = new IndexStore();
  const mod = chunk({
    filePath: 'auth.ts',
    symbolName: '__module__',
    kind: 'module',
    id: 'auth.ts::__module__',
    code: "import bcrypt from 'bcrypt';",
    startLine: 1,
    endLine: 1,
  });
  const login = chunk({
    filePath: 'auth.ts',
    symbolName: 'login',
    id: 'auth.ts::login',
    code: 'export function login(u: string) {\n  return hashPassword(u);\n}',
    startLine: 5,
    endLine: 7,
  });
  const hashPassword = chunk({
    filePath: 'auth.ts',
    symbolName: 'hashPassword',
    id: 'auth.ts::hashPassword',
    code: 'function hashPassword(pw: string): string {\n  return bcrypt.hashSync(pw);\n}',
    startLine: 9,
    endLine: 11,
  });
  store.upsertFile('auth.ts', 'h', [mod, login, hashPassword], 'file');

  const ghost = store.buildContext([login]); // only login is "relevant"

  assert.match(ghost, /import bcrypt/, 'imports (module header) are shown');
  assert.match(ghost, /return hashPassword\(u\)/, 'the matched function body is shown in full');
  // the non-relevant sibling appears as a one-line collapsed signature, not its body
  assert.match(ghost, /hashPassword.*lines 9-11.*function hashPassword/);
  assert.doesNotMatch(ghost, /bcrypt\.hashSync/, "the sibling's body is collapsed away");
});

test('stats().lastUpdated reflects the real last change, not the current time', async () => {
  const store = new IndexStore();
  store.upsertFile('a.ts', 'h', [chunk({})], 'x');
  const first = store.stats().lastUpdated;

  // Two reads with no change in between must return the SAME timestamp —
  // the old bug returned new Date() on every call.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(store.stats().lastUpdated, first);

  // A real change advances it.
  await new Promise((r) => setTimeout(r, 5));
  store.upsertFile('b.ts', 'h', [chunk({ filePath: 'b.ts', id: 'b.ts::foo' })], 'y');
  assert.notEqual(store.stats().lastUpdated, first);
});

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

test('short identifiers like "id" and "db" are not dropped from matching', async () => {
  const store = new IndexStore();
  store.upsertFile(
    'db.ts',
    'h',
    [chunk({ symbolName: 'getUserById', code: 'function getUserById(id) { return db.find(id); }', id: 'db.ts::getUserById' })],
    'x'
  );
  // "user id" — both short-ish content words present in getUserById.
  const results = await store.search('user id');
  assert.ok(results.some((r) => r.symbolName === 'getUserById'));
});

test('relevance gate: two distinct query words in one chunk match; a single incidental word does not', async () => {
  const store = new IndexStore();
  // No embeddings on these chunks, so this exercises the lexical gate only.
  store.upsertFile(
    'orders.ts',
    'h1',
    [chunk({ symbolName: 'cancelOrder', code: 'function cancelOrder(order) { /* cancel this order */ }' })],
    'x'
  );
  store.upsertFile(
    'misc.ts',
    'h2',
    [chunk({ symbolName: 'process', code: 'function process(x) { return x; }', id: 'misc.ts::process' })],
    'x'
  );

  // "cancel order" — two distinct content words present in cancelOrder.
  const hit = await store.search('cancel order');
  assert.ok(hit.some((r) => r.symbolName === 'cancelOrder'));

  // "process refunds now" — only the incidental word "process" appears
  // anywhere, and "refunds" exists nowhere, so nothing should match.
  const miss = await store.search('process refunds now');
  assert.equal(miss.length, 0);
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

test('search expands the top match with its direct same-file dependencies', async () => {
  const store = new IndexStore();
  store.upsertFile(
    'a.ts',
    'hash1',
    [
      chunk({
        symbolName: 'processPayment',
        code: 'function processPayment(order) { validateCard(order); }',
        id: 'a.ts::processPayment',
        references: ['a.ts::validateCard'],
      }),
      chunk({
        symbolName: 'validateCard',
        code: 'function validateCard(order) { return true; }',
        id: 'a.ts::validateCard',
      }),
      chunk({
        symbolName: 'unrelatedHelper',
        code: 'function unrelatedHelper() { return 1; }',
        id: 'a.ts::unrelatedHelper',
      }),
    ],
    ''
  );
  const results = await store.search('process a payment', 1);
  const symbolNames = results.map((r) => r.symbolName);
  assert.ok(symbolNames.includes('processPayment'));
  assert.ok(symbolNames.includes('validateCard'), 'expanded dependency should be included');
  assert.ok(!symbolNames.includes('unrelatedHelper'), 'non-referenced chunk should not be pulled in');
});

test('search does not expand when the top match has no references', async () => {
  const store = new IndexStore();
  store.upsertFile('a.ts', 'hash1', [chunk({ symbolName: 'standalone', code: 'function standalone() {}' })], '');
  const results = await store.search('standalone', 1);
  assert.equal(results.length, 1);
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

test('save/load round-trips the index to disk', async () => {
  const store = new IndexStore();
  store.upsertFile('a.ts', 'hash1', [chunk({})], 'function foo() {}');

  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-')), 'index.json');
  await store.save(tmpFile);

  const loaded = new IndexStore();
  const ok = loaded.load(tmpFile);
  assert.equal(ok, true);
  assert.equal(loaded.stats().files, 1);
  assert.equal(loaded.stats().chunks, 1);
  assert.equal(loaded.getFileHash('a.ts'), 'hash1');
});

test('save/load round-trips an embedding through the base64 Float32 format', async () => {
  const store = new IndexStore();
  const embedding = [0.1, -0.25, 0.5, 0.75, -1, 0]; // Float32-representable values
  store.upsertFile('a.ts', 'h', [chunk({ embedding })], 'x');

  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'store-emb-')), 'index.json');
  await store.save(tmpFile);
  // Snapshot must not contain a raw JSON number array for the embedding.
  const raw = fs.readFileSync(tmpFile, 'utf-8');
  assert.doesNotMatch(raw, /"embedding":\s*\[/);
  assert.match(raw, /"emb":/);

  const loaded = new IndexStore();
  loaded.load(tmpFile);
  const back = loaded.allChunks()[0].embedding!;
  assert.equal(back.length, embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    assert.ok(Math.abs(back[i] - embedding[i]) < 1e-6, `component ${i} preserved`);
  }
});

test('load refuses a snapshot written by a different embedding model', async () => {
  const store = new IndexStore();
  store.upsertFile('a.ts', 'hash1', [chunk({})], 'function foo() {}');

  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-model-')), 'index.json');
  await store.save(tmpFile);

  // Simulate a snapshot saved by an older/different embedding model.
  const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
  raw.embeddingModel = 'some-other-model';
  fs.writeFileSync(tmpFile, JSON.stringify(raw), 'utf-8');

  const loaded = new IndexStore();
  const ok = loaded.load(tmpFile);
  assert.equal(ok, false);
  assert.equal(loaded.stats().files, 0);
});

test('load returns false when there is no snapshot on disk', () => {
  const store = new IndexStore();
  const ok = store.load(path.join(os.tmpdir(), 'definitely-does-not-exist-index.json'));
  assert.equal(ok, false);
});
