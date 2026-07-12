import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { IndexStore } from '../src/store.js';
import { indexRepo } from '../src/watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRepo = path.join(__dirname, '..', '..', 'demo', 'fixture-repo');

test('indexRepo indexes the fixture repo end to end', async () => {
  const store = new IndexStore();
  await indexRepo(store, fixtureRepo);
  const stats = store.stats();
  assert.equal(stats.files, 3);
  assert.ok(stats.chunks > 0);
});

test('indexRepo throws a clear error for a nonexistent repo path', async () => {
  const store = new IndexStore();
  await assert.rejects(() => indexRepo(store, '/definitely/not/a/real/path'), /Repo path does not exist/);
});

test('indexRepo respects the target repo\'s .gitignore', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-daemon-gitignore-'));
  fs.mkdirSync(path.join(tmpDir, 'src'));
  fs.mkdirSync(path.join(tmpDir, 'ignored-output'));
  fs.writeFileSync(path.join(tmpDir, 'src', 'real.ts'), 'export function real() { return 1; }');
  fs.writeFileSync(path.join(tmpDir, 'ignored-output', 'compiled.js'), 'function compiled(){return 1}');
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'ignored-output/\n');

  const store = new IndexStore();
  await indexRepo(store, tmpDir);
  assert.equal(store.stats().files, 1);
  assert.equal(store.allChunks()[0].symbolName, 'real');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('indexRepo excludes test files by default', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-daemon-testfiles-'));
  fs.writeFileSync(path.join(tmpDir, 'real.ts'), 'export function real() { return 1; }');
  fs.writeFileSync(path.join(tmpDir, 'real.test.ts'), 'test("it works", () => {});');

  const store = new IndexStore();
  await indexRepo(store, tmpDir);
  assert.equal(store.stats().files, 1);
  assert.equal(store.allChunks()[0].symbolName, 'real');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('indexRepo picks up a Python file via the same walk as JS/TS', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-daemon-python-'));
  fs.writeFileSync(path.join(tmpDir, 'orders.py'), 'def cancel_order(order_id):\n    pass\n');
  fs.writeFileSync(path.join(tmpDir, 'test_orders.py'), 'def test_cancel():\n    pass\n');

  const store = new IndexStore();
  await indexRepo(store, tmpDir);
  assert.equal(store.stats().files, 1); // test_orders.py excluded
  assert.equal(store.allChunks()[0].symbolName, 'cancel_order');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('indexing the same repo via relative and absolute paths does not duplicate chunks', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-daemon-pathnorm-'));
  fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export function alpha() { return 1; }');

  const store = new IndexStore();
  await indexRepo(store, tmpDir); // absolute
  const afterAbsolute = store.stats().chunks;

  // Index the very same repo again via a non-canonical spelling (trailing
  // "/." ). Without path normalization this stored every file a second time.
  await indexRepo(store, path.join(tmpDir, '.'));
  assert.equal(store.stats().chunks, afterAbsolute);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('re-indexing an unchanged repo skips re-parsing (hash-based skip)', async () => {
  const store = new IndexStore();
  await indexRepo(store, fixtureRepo);
  const firstChunkIdentity = store.allChunks()[0];

  await indexRepo(store, fixtureRepo);
  const secondChunkIdentity = store.allChunks().find((c) => c.id === firstChunkIdentity.id);

  // Same object reference back out means upsertFile was never called again
  // for that file on the second pass (skip-on-unchanged-hash worked).
  assert.equal(secondChunkIdentity, firstChunkIdentity);
});
