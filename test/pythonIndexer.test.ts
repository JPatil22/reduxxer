import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePythonFile } from '../src/pythonIndexer.js';

test('parsePythonFile extracts a top-level function', () => {
  const chunks = parsePythonFile('a.py', 'def greet(name):\n    return f"hi {name}"\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].symbolName, 'greet');
  assert.equal(chunks[0].kind, 'function');
});

test('parsePythonFile extracts a class (with its methods included in the chunk)', () => {
  const chunks = parsePythonFile('a.py', 'class Widget:\n    def render(self):\n        pass\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].symbolName, 'Widget');
  assert.equal(chunks[0].kind, 'class');
  assert.match(chunks[0].code, /def render/);
});

test('parsePythonFile distinguishes async functions', () => {
  const chunks = parsePythonFile('a.py', 'async def fetch(url):\n    return await get(url)\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'async-function');
});

test('parsePythonFile extracts multiple top-level symbols', () => {
  const chunks = parsePythonFile('a.py', 'def one():\n    pass\n\n\ndef two():\n    pass\n\n\nclass Three:\n    pass\n');
  assert.deepEqual(
    chunks.map((c) => c.symbolName),
    ['one', 'two', 'Three']
  );
});

test('parsePythonFile falls back to a whole-file chunk when there are no top-level defs', () => {
  const chunks = parsePythonFile('a.py', 'print("just a script")\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'file');
  assert.equal(chunks[0].symbolName, '__file__');
});

test('parsePythonFile returns no chunks for a file with a syntax error', () => {
  const chunks = parsePythonFile('a.py', 'def broken(:\n    this is not valid python\n');
  assert.equal(chunks.length, 0);
});

test('parsePythonFile returns no chunks for an empty file', () => {
  const chunks = parsePythonFile('a.py', '');
  assert.equal(chunks.length, 0);
});
