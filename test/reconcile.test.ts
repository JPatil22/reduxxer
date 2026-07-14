import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IndexStore } from '../src/store.js';
import { indexRepo, reconcile } from '../src/watcher.js';
import { disableEmbeddings } from '../src/embeddings.js';

// Lexical-only keeps this test fast and deterministic; symbol presence is all
// we assert here, which doesn't need semantic vectors.
disableEmbeddings();

test('reconcile catches an add, an edit, and a delete that no watch event fired for', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  fs.writeFileSync(path.join(repo, 'a.js'), 'export function alpha(){ return 1; }\n');

  const store = new IndexStore();
  await indexRepo(store, repo);
  const has = (sym: string) => store.allChunks().some((c) => c.symbolName === sym);
  assert.ok(has('alpha'), 'seed file indexed');

  // ADD — no watcher is running, so it must be reconcile that finds it
  fs.writeFileSync(path.join(repo, 'b.js'), 'export function beta(){ return 2; }\n');
  assert.ok(!has('beta'), 'not indexed before reconcile');
  await reconcile(store, repo);
  assert.ok(has('beta'), 'reconcile picked up the added file');

  // EDIT
  fs.writeFileSync(path.join(repo, 'a.js'), 'export function alphaRenamed(){ return 9; }\n');
  await reconcile(store, repo);
  assert.ok(has('alphaRenamed') && !has('alpha'), 'reconcile picked up the edit');

  // DELETE
  fs.rmSync(path.join(repo, 'b.js'));
  await reconcile(store, repo);
  assert.ok(!has('beta'), 'reconcile pruned the deleted file');

  fs.rmSync(repo, { recursive: true, force: true });
});
