import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { closePythonWorker } from '../src/pythonIndexer.js';

after(() => {
  closePythonWorker();
});
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

test('indexRepo does not follow a symlink pointing outside the repo', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'export function leakedSecret() { return "TOP SECRET"; }');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-repo-'));
  fs.writeFileSync(path.join(repo, 'real.ts'), 'export function realCode() { return 1; }');
  try {
    // A link inside the repo, named like indexable source, pointing OUT of it.
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(repo, 'evil.ts'), 'file');
  } catch {
    t.skip('symlink creation not permitted on this platform');
    return;
  }

  const store = new IndexStore();
  await indexRepo(store, repo);
  const names = store.allChunks().map((c) => c.symbolName);
  assert.ok(names.includes('realCode'), 'the real in-repo file is indexed');
  assert.ok(!names.includes('leakedSecret'), 'the symlinked out-of-repo file is NOT read or indexed');
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

test('indexRepo respects a nested .gitignore deep in a monorepo, scoped to its own subtree', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-daemon-nestedgitignore-'));
  // packages/app has its own .gitignore excluding "generated/" — that rule
  // must NOT leak out and affect packages/other, which has no such file.
  fs.mkdirSync(path.join(tmpDir, 'packages', 'app', 'generated'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'packages', 'other', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'packages', 'app', 'real.ts'), 'export function appReal() { return 1; }');
  fs.writeFileSync(
    path.join(tmpDir, 'packages', 'app', 'generated', 'gen.ts'),
    'export function appGenerated() { return 1; }'
  );
  fs.writeFileSync(path.join(tmpDir, 'packages', 'app', '.gitignore'), 'generated/\n');
  fs.writeFileSync(
    path.join(tmpDir, 'packages', 'other', 'generated', 'gen.ts'),
    'export function otherGenerated() { return 1; }'
  );

  const store = new IndexStore();
  await indexRepo(store, tmpDir);
  const names = store.allChunks().map((c) => c.symbolName).sort();
  assert.deepEqual(names, ['appReal', 'otherGenerated']);

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

test('search pulls in a dependency imported from another file (cross-file expansion)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-daemon-xfile-'));
  fs.writeFileSync(
    path.join(tmpDir, 'auth.ts'),
    'export function validateUser(id: string): boolean {\n  return id.length > 0;\n}\n'
  );
  fs.writeFileSync(
    path.join(tmpDir, 'orders.ts'),
    "import { validateUser } from './auth';\n\nexport function processOrder(userId: string): void {\n  if (!validateUser(userId)) throw new Error('bad');\n}\n"
  );

  const store = new IndexStore();
  await indexRepo(store, tmpDir);

  const results = await store.search('process an order for a user', 1);
  const names = results.map((r) => r.symbolName);
  assert.ok(names.includes('processOrder'), 'the matched function should be returned');
  assert.ok(
    names.includes('validateUser'),
    'the function imported from another file should be pulled in too'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('search pulls in a Python dependency imported from another file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-daemon-pyxfile-'));
  fs.writeFileSync(path.join(tmpDir, 'auth.py'), 'def validate_user(uid):\n    return len(uid) > 0\n');
  fs.writeFileSync(
    path.join(tmpDir, 'orders.py'),
    'from .auth import validate_user\n\n\ndef process_order(uid):\n    if not validate_user(uid):\n        raise ValueError("bad")\n'
  );

  const store = new IndexStore();
  await indexRepo(store, tmpDir);

  const results = await store.search('process an order for a user', 1);
  const names = results.map((r) => r.symbolName);
  assert.ok(names.includes('process_order'), 'the matched function should be returned');
  assert.ok(
    names.includes('validate_user'),
    'the Python function imported from another file should be pulled in too'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('search chases a multi-hop dependency chain (A -> B -> C), not just one hop', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-daemon-multihop-'));
  fs.writeFileSync(
    path.join(tmpDir, 'auth.ts'),
    'export function checkPermission(id: string): boolean {\n  return id.length > 0;\n}\n'
  );
  fs.writeFileSync(
    path.join(tmpDir, 'notify.ts'),
    "import { checkPermission } from './auth';\n\nexport function sendAlert(id: string): boolean {\n  return checkPermission(id);\n}\n"
  );
  fs.writeFileSync(
    path.join(tmpDir, 'orders.ts'),
    "import { sendAlert } from './notify';\n\nexport function shipOrder(id: string): boolean {\n  return sendAlert(id);\n}\n"
  );

  const store = new IndexStore();
  await indexRepo(store, tmpDir);

  const results = await store.search('ship an order', 1);
  const names = results.map((r) => r.symbolName);
  assert.ok(names.includes('shipOrder'), 'the matched function should be returned');
  assert.ok(names.includes('sendAlert'), 'the one-hop dependency should be pulled in');
  assert.ok(
    names.includes('checkPermission'),
    'the two-hop dependency (a dependency of a dependency) should be pulled in too'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('search resolves a tsconfig path-alias import (e.g. "@/auth"), not just relative imports', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-daemon-tsalias-'));
  fs.mkdirSync(path.join(tmpDir, 'src'));
  fs.writeFileSync(
    path.join(tmpDir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } })
  );
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'auth.ts'),
    'export function validateUser(id: string): boolean {\n  return id.length > 0;\n}\n'
  );
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'orders.ts'),
    "import { validateUser } from '@/auth';\n\nexport function processOrder(userId: string): void {\n  if (!validateUser(userId)) throw new Error('bad');\n}\n"
  );

  const store = new IndexStore();
  await indexRepo(store, tmpDir);

  const results = await store.search('process an order for a user', 1);
  const names = results.map((r) => r.symbolName);
  assert.ok(names.includes('processOrder'), 'the matched function should be returned');
  assert.ok(
    names.includes('validateUser'),
    'the function imported via a tsconfig path alias should be pulled in too'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('indexRepo skips files over the size limit, without reading their content', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-daemon-filesize-'));
  fs.writeFileSync(path.join(tmpDir, 'normal.ts'), 'export function normal() { return 1; }');
  // Just over the 1.5MB limit.
  fs.writeFileSync(path.join(tmpDir, 'huge.ts'), 'export function huge() {}\n// ' + 'x'.repeat(1.5 * 1024 * 1024 + 100));

  const store = new IndexStore();
  await indexRepo(store, tmpDir);

  assert.equal(store.stats().files, 1, 'only the normal-size file was indexed');
  assert.equal(store.allChunks()[0].symbolName, 'normal');
  assert.equal(store.getFileHash(path.join(tmpDir, 'huge.ts')), undefined, 'the huge file was never read/hashed');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a file with an extreme number of tiny functions still indexes for keyword search, but skips embedding', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-daemon-densefile-'));
  // Under the byte-size limit, but far past the chunk-count limit — e.g. a
  // generated file packed with many tiny functions. Real hand-written files
  // never have this many top-level symbols.
  const lines = [];
  for (let i = 0; i < 600; i++) lines.push(`export function fn${i}() { return ${i}; }`);
  fs.writeFileSync(path.join(tmpDir, 'dense.ts'), lines.join('\n'));

  const store = new IndexStore();
  await indexRepo(store, tmpDir);

  assert.equal(store.stats().chunks, 600, 'all functions are still indexed for keyword search');
  const target = store.allChunks().find((c) => c.symbolName === 'fn300');
  assert.ok(target, 'a specific function is still findable');
  assert.equal(target!.embedding, undefined, 'embedding was skipped for this file');

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
