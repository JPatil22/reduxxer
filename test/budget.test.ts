import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/store.js';
import { estimateTokens } from '../src/tokens.js';
import type { CodeChunk } from '../src/types.js';

// Build a store with a chain of functions across two files: D -> C -> B -> A,
// each a decent-sized body, so a budget can meaningfully include more or fewer.
function chunk(file: string, name: string, code: string, refs: string[] = [], ext: string[] = []): CodeChunk {
  return {
    id: `${file}::${name}`,
    filePath: file,
    symbolName: name,
    kind: 'function',
    startLine: 1,
    endLine: 20,
    code,
    fileHash: 'h',
    references: refs.map((r) => `${file}::${r}`),
    externalRefs: ext,
  };
}
const body = (n: string) => `function ${n}(x) {\n` + Array.from({ length: 12 }, (_, i) => `  const v${i} = compute(${i}, x); // ${n} line ${i}`).join('\n') + `\n  return v0;\n}`;

function makeStore(): IndexStore {
  const store = new IndexStore();
  const fileA = '/repo/a.js';
  const fileB = '/repo/b.js';
  // a.js: A (leaf), B -> A
  store.upsertFile(fileA, 'ha', [
    chunk(fileA, 'alphaLeaf', body('alphaLeaf')),
    chunk(fileA, 'betaMid', body('betaMid'), ['alphaLeaf']),
  ], 'x'.repeat(10));
  // b.js: C -> B(cross-file), D -> C
  store.upsertFile(fileB, 'hb', [
    chunk(fileB, 'gammaCollect', body('gammaCollect'), [], ['/repo/b::betaMid']),
    chunk(fileB, 'deltaTop', body('deltaTop'), ['gammaCollect']),
  ], 'x'.repeat(10));
  return store;
}

test('searchWithinBudget respects the budget and grows with it', async () => {
  const store = makeStore();

  const small = await store.searchWithinBudget('deltaTop', 200);
  const large = await store.searchWithinBudget('deltaTop', 5000);

  assert.ok(small.length >= 1, 'always returns at least the top match');
  assert.ok(large.length >= small.length, 'a larger budget includes at least as many chunks');

  const smallTokens = estimateTokens(store.buildContext(small));
  const largeTokens = estimateTokens(store.buildContext(large));
  assert.ok(largeTokens >= smallTokens, 'more budget => more (or equal) context');

  // The top match must be present regardless of budget.
  assert.ok(small.some((c) => c.symbolName === 'deltaTop'), 'top match kept under tight budget');
});

test('searchWithinBudget never wildly overshoots a workable budget', async () => {
  const store = makeStore();
  const budget = 3000;
  const results = await store.searchWithinBudget('deltaTop', budget);
  const tokens = estimateTokens(store.buildContext(results));
  // With a budget this size relative to the fixtures, the greedy fill must not
  // blow far past it — allow one chunk of slack for the last-added package.
  assert.ok(tokens <= budget * 1.5, `rendered ${tokens} tokens should stay near budget ${budget}`);
});

test('a tiny budget still returns the single best match (never empty on a hit)', async () => {
  const store = makeStore();
  const results = await store.searchWithinBudget('deltaTop', 1);
  assert.equal(results.length, 1, 'tiny budget yields exactly the top match');
  assert.equal(results[0].symbolName, 'deltaTop');
});
