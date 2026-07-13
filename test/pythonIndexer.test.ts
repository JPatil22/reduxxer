import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parsePythonFile, closePythonWorker } from '../src/pythonIndexer.js';

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

