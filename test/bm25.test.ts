import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/store.js';
import { parseFile } from '../src/indexer.js';
import { setEmbeddingsEnabled } from '../src/embeddings.js';

// Lexical-only: deterministic ranking driven purely by BM25, no model needed.
setEmbeddingsEnabled(false);

function upsert(store: IndexStore, file: string, code: string): void {
  store.upsertFile(file, `h:${code.length}`, parseFile(file, code), code);
}

test('incremental BM25 maintenance matches a full rebuild after edits', async () => {
  const store = new IndexStore();
  upsert(store, 'a.ts', 'export function alpha() { return charge(); }\nfunction charge() { return 1; }');
  upsert(store, 'b.ts', 'export function beta() { return 2; }');
  upsert(store, 'c.ts', 'export function gamma() { return 3; }');

  // Warm the stats so the edits below go through the INCREMENTAL path
  // (a search rebuilds once, clearing bm25Dirty).
  await store.search('warm up the index', 1);

  // These three mutations must be handled incrementally (bm25 is now clean):
  upsert(store, 'b.ts', 'export function beta() { return chargeUp(); }\nfunction chargeUp() { return charge(); }'); // re-upsert (remove old + add new)
  store.removeFile('c.ts'); // incremental remove
  upsert(store, 'd.ts', 'export function delta() { return charge(); }'); // incremental add

  const incremental = (await store.search('charge', 10)).map((c) => c.id);

  // Now force a from-scratch recompute and re-run the same query.
  store.rebuildBm25ForTests();
  const rebuilt = (await store.search('charge', 10)).map((c) => c.id);

  assert.ok(incremental.length > 0, 'sanity: the query matches something');
  assert.deepEqual(
    incremental,
    rebuilt,
    'incrementally-maintained BM25 stats produce identical ranking to a full rebuild'
  );
});

test('inverted-index search finds real matches, excludes non-overlap, and is deterministic', async () => {
  const store = new IndexStore();
  upsert(store, 'a.ts', 'export function chargeCard(card) { return authorize(card); }\nfunction authorize(c) { return true; }');
  upsert(store, 'b.ts', 'export function shipOrder(o) { return o.ready; }');
  upsert(store, 'c.ts', 'export function refundPayment(p) { return chargeback(p); }\nfunction chargeback(p) { return true; }');

  const r1 = (await store.search('charge card authorize', 5)).map((c) => c.symbolName);
  assert.ok(r1.includes('chargeCard'), 'the matching function is found through the inverted index');
  assert.ok(!r1.includes('shipOrder'), 'a function with no query-term overlap is not returned');

  // Repeated runs give the exact same order (stable tie-breaking preserved).
  const r2 = (await store.search('charge card authorize', 5)).map((c) => c.symbolName);
  assert.deepEqual(r1, r2, 'results are deterministic');
});

test('BM25 stats stay correct across a remove that empties a term from the corpus', async () => {
  const store = new IndexStore();
  upsert(store, 'only.ts', 'export function uniqueBeacon() { return 1; }');
  upsert(store, 'other.ts', 'export function somethingElse() { return 2; }');
  await store.search('warm', 1); // clean stats

  // Removing the only file that contains "beacon" must drop its df to zero
  // (removeChunkFromBm25 deletes the term), not leave a stale df of 1.
  store.removeFile('only.ts');

  const incremental = (await store.search('uniqueBeacon', 10)).map((c) => c.id);
  store.rebuildBm25ForTests();
  const rebuilt = (await store.search('uniqueBeacon', 10)).map((c) => c.id);

  assert.deepEqual(incremental, rebuilt, 'removing the last doc with a term matches a full rebuild');
  assert.ok(!incremental.some((id) => id.startsWith('only.ts')), 'the removed file no longer appears');
});
