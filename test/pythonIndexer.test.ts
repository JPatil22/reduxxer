import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parsePythonFile, closePythonWorker, setPythonParseTimeoutForTests } from '../src/pythonIndexer.js';

after(() => {
  closePythonWorker();
});

test('parsePythonFile extracts a top-level function', async () => {
  const chunks = await parsePythonFile('a.py', 'def greet(name):\n    return f"hi {name}"\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].symbolName, 'greet');
  assert.equal(chunks[0].kind, 'function');
});

test('parsePythonFile splits a class into a header chunk plus one chunk per method', async () => {
  const chunks = await parsePythonFile(
    'a.py',
    'class Widget:\n    rate = 5\n\n    def render(self):\n        pass\n\n    async def refresh(self):\n        pass\n'
  );

  const header = chunks.find((c) => c.kind === 'class');
  assert.equal(header?.symbolName, 'Widget');
  assert.match(header!.code, /rate = 5/);
  assert.doesNotMatch(header!.code, /def render/);

  const methods = chunks.filter((c) => c.kind.endsWith('method')).map((c) => c.symbolName);
  assert.deepEqual(methods, ['Widget.render', 'Widget.refresh']);
  assert.equal(chunks.find((c) => c.symbolName === 'Widget.refresh')?.kind, 'async-method');
});

test('parsePythonFile distinguishes async functions', async () => {
  const chunks = await parsePythonFile('a.py', 'async def fetch(url):\n    return await get(url)\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'async-function');
});

test('parsePythonFile extracts multiple top-level symbols', async () => {
  const chunks = await parsePythonFile('a.py', 'def one():\n    pass\n\n\ndef two():\n    pass\n\n\nclass Three:\n    pass\n');
  assert.deepEqual(
    chunks.map((c) => c.symbolName),
    ['one', 'two', 'Three']
  );
});

test('parsePythonFile falls back to a whole-file chunk when there are no top-level defs', async () => {
  const chunks = await parsePythonFile('a.py', 'print("just a script")\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'file');
  assert.equal(chunks[0].symbolName, '__file__');
});

test('parsePythonFile returns no chunks for a file with a syntax error', async () => {
  const chunks = await parsePythonFile('a.py', 'def broken(:\n    this is not valid python\n');
  assert.equal(chunks.length, 0);
});

test('parsePythonFile returns no chunks for an empty file', async () => {
  const chunks = await parsePythonFile('a.py', '');
  assert.equal(chunks.length, 0);
});

test('parsePythonFile records same-file call references between chunks', async () => {
  const chunks = await parsePythonFile(
    'a.py',
    ['def validate_card(card):', '    return True', '', '', 'def process_payment(order):', '    validate_card(order)', '    return True'].join(
      '\n'
    )
  );
  const processPayment = chunks.find((c) => c.symbolName === 'process_payment')!;
  assert.deepEqual(processPayment.references, ['a.py::validate_card']);
  const validateCard = chunks.find((c) => c.symbolName === 'validate_card')!;
  assert.equal(validateCard.references, undefined);
});

test('parsePythonFile gives same-named defs (typing.overload/redefinition) distinct ids', async () => {
  const chunks = await parsePythonFile(
    'a.py',
    [
      'from typing import overload',
      '',
      '@overload',
      'def read(x: int) -> int: ...',
      '@overload',
      'def read(x: str) -> str: ...',
      'def read(x):',
      '    return x',
    ].join('\n')
  );
  const reads = chunks.filter((c) => c.symbolName === 'read');
  assert.ok(reads.length >= 2, 'each same-named def is preserved, not collapsed by id collision');
  const ids = chunks.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'all chunk ids unique');
  assert.ok(ids.includes('a.py::read'), 'first occurrence keeps the bare id');
  assert.ok(
    ids.some((id) => /^a\.py::read\$\d+$/.test(id)),
    'later occurrences are suffixed'
  );
});

test('parsePythonFile handles many concurrent parses without desyncing responses', async () => {
  // Fire many distinct files at the single shared worker at once. Each result
  // must come back matched to ITS OWN request — the guarantee id-based
  // correlation provides and the old arrival-order queue did not.
  const N = 30;
  const inputs = Array.from({ length: N }, (_, i) => ({ file: `f${i}.py`, src: `def func_${i}():\n    return ${i}\n` }));
  const results = await Promise.all(inputs.map((inp) => parsePythonFile(inp.file, inp.src)));
  for (let i = 0; i < N; i++) {
    assert.equal(results[i].length, 1, `file ${i} returns exactly one chunk`);
    assert.equal(results[i][0].symbolName, `func_${i}`, `file ${i} got its OWN function back, not another's`);
  }
});

test('parsePythonFile times out instead of hanging, then recovers', async () => {
  setPythonParseTimeoutForTests(1); // 1ms — the real round-trip cannot beat it
  try {
    const timedOut = await parsePythonFile('slow.py', 'def slow():\n    return 1\n');
    assert.deepEqual(timedOut, [], 'a timed-out parse fails soft (returns []) rather than hanging forever');
  } finally {
    setPythonParseTimeoutForTests(15000); // restore before other tests run
  }
  const recovered = await parsePythonFile('fine.py', 'def fine():\n    return 2\n');
  assert.ok(recovered.some((c) => c.symbolName === 'fine'), 'the worker respawned and works again after a timeout');
});

test('parsePythonFile respawns the worker after it is closed mid-session', async () => {
  const before = await parsePythonFile('a.py', 'def a():\n    return 1\n');
  assert.ok(before.some((c) => c.symbolName === 'a'));
  closePythonWorker(); // simulate a crash / explicit shutdown
  const after = await parsePythonFile('b.py', 'def b():\n    return 2\n');
  assert.ok(after.some((c) => c.symbolName === 'b'), 'worker respawned transparently after being closed');
});

test('parsePythonFile records absolute imports resolved relative to repo root', async () => {
  const chunks = await parsePythonFile(
    'a.py',
    ['from my_app.models import User', '', 'def process_order():', '    User()'].join('\n'),
    process.cwd()
  );
  const processOrder = chunks.find((c) => c.symbolName === 'process_order')!;
  const expectedRoot = path.resolve(process.cwd());
  assert.deepEqual(processOrder.externalRefs, [`${path.join(expectedRoot, 'my_app', 'models')}::User`]);
});

