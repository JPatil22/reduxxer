import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../src/indexer.js';

test('parseFile extracts a function declaration as a chunk', () => {
  const chunks = parseFile('a.ts', 'export function greet(name: string) {\n  return `hi ${name}`;\n}\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].symbolName, 'greet');
  assert.equal(chunks[0].kind, 'function');
});

test('parseFile extracts a class declaration as a chunk', () => {
  const chunks = parseFile('a.ts', 'export class Widget {\n  render() {}\n}\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].symbolName, 'Widget');
  assert.equal(chunks[0].kind, 'class');
});

test('parseFile extracts an interface declaration as a chunk', () => {
  const chunks = parseFile('a.ts', 'export interface Point {\n  x: number;\n  y: number;\n}\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].symbolName, 'Point');
  assert.equal(chunks[0].kind, 'interface');
});

test('parseFile extracts a const arrow function as a chunk', () => {
  const chunks = parseFile('a.ts', 'export const add = (a: number, b: number) => a + b;\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].symbolName, 'add');
  assert.equal(chunks[0].kind, 'const-function');
});

test('parseFile extracts multiple top-level symbols from one file', () => {
  const chunks = parseFile(
    'a.ts',
    'export function one() {}\nexport function two() {}\nexport class Three {}\n'
  );
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((c) => c.symbolName),
    ['one', 'two', 'Three']
  );
});

test('parseFile falls back to a whole-file chunk when there are no named symbols', () => {
  const chunks = parseFile('a.ts', 'console.log("just a script, no functions");\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'file');
  assert.equal(chunks[0].symbolName, '__file__');
});

test('parseFile returns no chunks for an empty file', () => {
  const chunks = parseFile('a.ts', '');
  assert.equal(chunks.length, 0);
});

test('parseFile chunk ids are unique and derived from filePath + symbolName', () => {
  const chunks = parseFile('src/a.ts', 'export function foo() {}\nexport function bar() {}\n');
  assert.equal(chunks[0].id, 'src/a.ts::foo');
  assert.equal(chunks[1].id, 'src/a.ts::bar');
});
