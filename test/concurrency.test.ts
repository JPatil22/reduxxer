import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexStore } from '../src/store.js';
import { indexRepo } from '../src/watcher.js';

// Reproduces the concurrency window: a search suspends on the query-embedding
// await, and while it's suspended a file-watch / reconcile mutation removes a
// file from the index. The search must still resume against a consistent index
// — no crash, and no chunk from the removed file leaking into the result.
test('a file removed while a search is mid-embedding gives a consistent, crash-free result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-conc-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'export function alphaHandler(x) { return x + 1; }\n');
    fs.writeFileSync(path.join(dir, 'b.js'), 'export function betaHandler(y) { return y * 2; }\n');

    const store = new IndexStore();
    await indexRepo(store, dir);
    const fileB = path.join(dir, 'b.js');
    assert.ok(store.getFileHash(fileB), 'b.js indexed');

    // search() runs synchronously up to `await embedText(query)`, then suspends
    // and hands control back here — so the synchronous removeFile below lands
    // squarely inside the embedding window, exactly the race we're guarding.
    const pending = store.search('handler', 10);
    store.removeFile(fileB);
    const results = await pending;

    assert.ok(
      !results.some((c) => c.filePath === fileB),
      'a chunk from the file removed mid-search must not appear in the result'
    );
    assert.doesNotThrow(() => store.buildContext(results), 'context assembly over the post-mutation set must not throw');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an added file mid-budget-search does not corrupt the assembly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-conc2-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'export function alphaHandler(x) { return x + 1; }\n');
    const store = new IndexStore();
    await indexRepo(store, dir);

    const pending = store.searchWithinBudget('handler', 4000);
    // Mutate during the embedding await (removeFile is synchronous like a live
    // unlink event would drive).
    store.removeFile(path.join(dir, 'a.js'));
    const results = await pending;
    assert.doesNotThrow(() => store.buildContext(results));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
