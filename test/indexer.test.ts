import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../src/indexer.js';
import { IndexStore } from '../src/store.js';

test('parseFile extracts a function declaration as a chunk', () => {
  const chunks = parseFile('a.ts', 'export function greet(name: string) {\n  return `hi ${name}`;\n}\n');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].symbolName, 'greet');
  assert.equal(chunks[0].kind, 'function');
});

test('parseFile splits a class into a header chunk plus one chunk per method', () => {
  const chunks = parseFile('a.ts', 'export class Widget {\n  count = 0;\n  render() { return this.count; }\n  reset() { this.count = 0; }\n}\n');

  const header = chunks.find((c) => c.kind === 'class');
  assert.equal(header?.symbolName, 'Widget');
  // Header keeps the class shape (fields) but not method bodies.
  assert.match(header!.code, /count = 0/);
  assert.doesNotMatch(header!.code, /return this\.count/);

  const methods = chunks.filter((c) => c.kind === 'method').map((c) => c.symbolName);
  assert.deepEqual(methods, ['Widget.render', 'Widget.reset']);

  // The header's line range covers the declaration + fields, not the whole
  // class — its endLine must not run into the method bodies below.
  assert.equal(header!.startLine, 1);
  assert.equal(header!.endLine, 2); // the `count = 0` field on line 2, not the class's closing brace
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

test('parseFile emits a module chunk with imports and top-level constants', () => {
  const chunks = parseFile(
    'cli.ts',
    "import path from 'node:path';\nimport { IndexStore } from './store.js';\n\nconst DEFAULT_PORT = 7621;\n\nexport function run() { return DEFAULT_PORT; }\n"
  );
  const mod = chunks.find((c) => c.kind === 'module');
  assert.ok(mod, 'a module chunk should be emitted');
  assert.match(mod.code, /import .* from 'node:path'/);
  assert.match(mod.code, /DEFAULT_PORT = 7621/);
  // the function is still its own chunk, not swallowed into the module chunk
  assert.ok(chunks.some((c) => c.kind === 'function' && c.symbolName === 'run'));
});

test('parseFile extracts functions from a Vue SFC <script> block', () => {
  const sfc = [
    '<template>',
    '  <div>{{ label }}</div>',
    '</template>',
    '<script lang="ts">',
    'export function formatLabel(name: string) {',
    '  return name.toUpperCase();',
    '}',
    '</script>',
  ].join('\n');
  const chunks = parseFile('Widget.vue', sfc);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].symbolName, 'formatLabel');
  // line 5 in the SFC (1-indexed) is where the function starts
  assert.equal(chunks[0].startLine, 5);
});

test('parseFile extracts functions from a Svelte <script> block', () => {
  const sfc = ['<script>', 'export function double(n) {', '  return n * 2;', '}', '</script>', '<p>hi</p>'].join(
    '\n'
  );
  const chunks = parseFile('Counter.svelte', sfc);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].symbolName, 'double');
  assert.equal(chunks[0].startLine, 2);
});

test('parseFile captures ALL script blocks in a Vue SFC (script + script setup)', () => {
  const sfc = [
    '<template>',
    '  <div>{{ x }}</div>',
    '</template>',
    '',
    '<script>',
    'export function legacy() { return 1; }',
    '</script>',
    '',
    '<script setup lang="ts">',
    'function setupFn() { return 2; }',
    '</script>',
  ].join('\n');
  const chunks = parseFile('Widget.vue', sfc);
  const byName = new Map(chunks.map((c) => [c.symbolName, c]));
  assert.ok(byName.has('legacy'), 'first <script> block is captured');
  assert.ok(byName.has('setupFn'), 'second <script setup> block is captured too');
  // Line numbers map 1:1 to the source file (masking preserves positions).
  assert.equal(byName.get('legacy')!.startLine, 6);
  assert.equal(byName.get('setupFn')!.startLine, 10);
});

test('parseFile returns no chunks for a Vue SFC with no <script> block', () => {
  const chunks = parseFile('TemplateOnly.vue', '<template>\n  <div>static</div>\n</template>\n');
  assert.equal(chunks.length, 0);
});

test('parseFile records same-file call references between chunks', () => {
  const chunks = parseFile(
    'a.ts',
    [
      'function validateCard(card) { return true; }',
      'function processPayment(order) {',
      '  validateCard(order.card);',
      '  return true;',
      '}',
    ].join('\n')
  );
  const processPayment = chunks.find((c) => c.symbolName === 'processPayment')!;
  assert.deepEqual(processPayment.references, ['a.ts::validateCard']);
  const validateCard = chunks.find((c) => c.symbolName === 'validateCard')!;
  assert.equal(validateCard.references, undefined);
});

test('parseFile does not record a call to an unrelated/unknown function as a reference', () => {
  const chunks = parseFile('a.ts', 'function foo() { console.log("hi"); }\n');
  assert.equal(chunks[0].references, undefined);
});

test('parseFile does not record recursive self-calls as a reference', () => {
  const chunks = parseFile('a.ts', 'function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1); }\n');
  assert.equal(chunks[0].references, undefined);
});

// --- Symbol-ID collisions (overloads, declaration merging, accessors) -------

test('parseFile merges function overloads into one chunk (no id collision)', () => {
  const src = [
    'export function foo(a: number): void;', // 1
    'export function foo(a: string, b: number): void;', // 2
    'export function foo(a: any, b?: number): void {', // 3
    '  console.log(a, b);', // 4
    '}', // 5
  ].join('\n');
  const chunks = parseFile('a.ts', src);
  const foos = chunks.filter((c) => c.symbolName === 'foo');
  assert.equal(foos.length, 1, 'the three overload declarations collapse to one chunk');
  const foo = foos[0];
  assert.equal(foo.id, 'a.ts::foo');
  // The merged chunk spans the signatures through the implementation body.
  assert.equal(foo.startLine, 1);
  assert.equal(foo.endLine, 5);
  assert.match(foo.code, /foo\(a: number\): void;/, 'overload signature kept');
  assert.match(foo.code, /console\.log\(a, b\)/, 'implementation body kept');
  // No duplicate ids anywhere in the file.
  const ids = chunks.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'all chunk ids unique');
});

test('parseFile keeps both halves of a merged interface+function (distinct ids)', () => {
  const chunks = parseFile(
    'a.ts',
    'export interface Config { port: number }\nexport function Config() { return { port: 3000 }; }\n'
  );
  const iface = chunks.find((c) => c.kind === 'interface' && c.symbolName === 'Config');
  const fn = chunks.find((c) => c.kind === 'function' && c.symbolName === 'Config');
  assert.ok(iface, 'the interface half is indexed');
  assert.ok(fn, 'the function half is indexed');
  assert.notEqual(iface!.id, fn!.id, 'same name, but ids must differ so neither is dropped');
  assert.equal(iface!.id, 'a.ts::Config', 'first occurrence keeps the bare id');
  assert.equal(fn!.id, 'a.ts::Config$2', 'the collision is suffixed');
  const ids = chunks.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'all chunk ids unique');
});

test('parseFile indexes a get/set accessor pair as two distinct chunks', () => {
  const src = [
    'export class Box {',
    '  private _v = 0;',
    '  get value() { return this._v; }',
    '  set value(v: number) { this._v = v; }',
    '}',
  ].join('\n');
  const chunks = parseFile('a.ts', src);
  const getter = chunks.find((c) => c.kind === 'getter');
  const setter = chunks.find((c) => c.kind === 'setter');
  assert.ok(getter && getter.symbolName === 'Box.value', 'getter chunk present');
  assert.ok(setter && setter.symbolName === 'Box.value', 'setter chunk present');
  assert.notEqual(getter!.id, setter!.id, 'get/set share a name but need distinct ids');
  const ids = chunks.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'all chunk ids unique');
});

test('store: a colliding-name file lists no duplicate chunkIds and renders each symbol once', () => {
  const src = [
    'export interface Config { port: number }',
    'export function Config() { return { port: 3000 }; }',
    'export function foo(a: number): void;',
    'export function foo(a: string): void;',
    'export function foo(a: any): void { return; }',
  ].join('\n');
  const store = new IndexStore();
  const chunks = parseFile('a.ts', src);
  store.upsertFile('a.ts', 'hash1', chunks, src);

  // Render the ghost view with the function `foo` as the matched symbol.
  const foo = chunks.find((c) => c.kind === 'function' && c.symbolName === 'foo')!;
  const ghost = store.buildContext([foo]);
  // The matched symbol is expanded exactly once (old bug rendered it N times
  // because chunkIds held the same id N times).
  const fooMarkers = ghost.match(/^\/\/ ▸ foo\b/gm) ?? [];
  assert.equal(fooMarkers.length, 1, 'overloaded `foo` renders exactly once');
});

// --- Anonymous default exports ---------------------------------------------

test('parseFile indexes an anonymous default-exported function (was invisible)', () => {
  const chunks = parseFile('Button.tsx', 'import React from "react";\nexport default function() {\n  return null;\n}\n');
  const def = chunks.find((c) => c.symbolName === 'default');
  assert.ok(def, 'anonymous default export is indexed');
  assert.equal(def!.kind, 'function');
  assert.match(def!.code, /return null/, 'its body is captured');
});

test('parseFile indexes an anonymous default-exported arrow (export default () => ...)', () => {
  const chunks = parseFile('a.tsx', 'export default () => {\n  return 42;\n};\n');
  const def = chunks.find((c) => c.symbolName === 'default');
  assert.ok(def, 'default arrow export is indexed');
  assert.match(def!.code, /return 42/);
});

test('parseFile does not synthesize a default chunk for `export default <identifier>`', () => {
  // The identifier is already an indexed symbol; re-exporting needs no new chunk.
  const chunks = parseFile('a.ts', 'const Widget = () => null;\nexport default Widget;\n');
  assert.ok(chunks.some((c) => c.symbolName === 'Widget'));
  assert.ok(!chunks.some((c) => c.symbolName === 'default'), 'no redundant default chunk');
});

// --- Namespaces / modules ---------------------------------------------------

test('parseFile indexes a namespace and qualifies its members', () => {
  const src = [
    'export namespace Geometry {',
    '  export function area(r: number) { return r * r; }',
    '  export class Point { constructor(public x: number) {} }',
    '}',
  ].join('\n');
  const chunks = parseFile('a.ts', src);
  const names = chunks.map((c) => c.symbolName);
  assert.ok(names.includes('Geometry'), 'the namespace itself is findable');
  assert.equal(chunks.find((c) => c.symbolName === 'Geometry')!.kind, 'namespace');
  assert.ok(names.includes('Geometry.area'), 'members are qualified with the namespace');
  assert.ok(names.includes('Geometry.Point'));
  // No bare, unqualified member leaks (which would collide across namespaces).
  assert.ok(!names.includes('area'), 'members are not flattened to bare names');
});

// --- Class decorators -------------------------------------------------------

test('parseFile renders class decorators on their own line above the signature', () => {
  const src = [
    '@Component({',
    '  selector: "app-root",',
    '  template: "<div></div>",',
    '})',
    'export class AppComponent {',
    '  count = 0;',
    '}',
  ].join('\n');
  const chunks = parseFile('a.ts', src);
  const header = chunks.find((c) => c.kind === 'class' && c.symbolName === 'AppComponent')!;
  assert.match(header.code, /@Component\(\{/, 'decorator is present in the header');
  // The decorator sits on its own line, not mashed onto the class signature.
  const sigLine = header.code.split('\n').find((l) => l.includes('class AppComponent'))!;
  assert.doesNotMatch(sigLine, /@Component/, 'signature line has no decorator mashed into it');
});
