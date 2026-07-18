/**
 * Reproducible scaling benchmark for context-daemon.
 *
 * Generates synthetic repos of increasing size and measures the parts with real
 * algorithmic concern: cold index, incremental re-index of one file, search
 * latency (with AND without a preceding edit — the second exercises the
 * incremental-BM25 path that used to re-tokenize the whole corpus), snapshot
 * save/size/load, and resident memory.
 *
 * Embeddings are DISABLED here on purpose: embedding cost is separate and
 * roughly linear (~15ms/chunk on CPU, measured independently) and would
 * otherwise dominate and take hours at these scales. The fast-search (ANN)
 * index is measured separately below with synthetic unit vectors, so the ANN
 * path is exercised at scale without paying for the model.
 *
 * Run:  node demo/scale-bench.mjs [fileCounts...]     (default: 1000 5000 20000)
 * e.g.  node demo/scale-bench.mjs 500 2000            (quick)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexStore } from '../dist/src/store.js';
import { indexRepo, indexFile } from '../dist/src/watcher.js';
import { setEmbeddingsEnabled, cosineSimilarity } from '../dist/src/embeddings.js';
import { AnnIndex } from '../dist/src/annIndex.js';

setEmbeddingsEnabled(false);

const now = () => performance.now();
const ms = (t) => `${t.toFixed(0)}ms`;
const mb = (b) => `${(b / 1024 / 1024).toFixed(0)}MB`;

function genFile(i) {
  return [
    `import { helper } from './mod_${i + 1}';`,
    `export function handler_${i}(req) { return validate_${i}(req) && persist_${i}(req); }`,
    `function validate_${i}(x) { return x != null && x.id_${i % 100} > 0; }`,
    `function persist_${i}(x) { return database.save(x, ${i}); }`,
    `export class Service_${i} {`,
    `  run() { return handler_${i}({}); }`,
    `  stop() { return true; }`,
    `}`,
    // tagA${i}/tagB${i} give each file two file-unique tokens ("a${i}"/"b${i}"),
    // so a query like "a<n> b<n>" is SELECTIVE — it hits one file, the case a
    // real natural-language query resembles (rare terms), unlike the broad
    // query below whose words appear in every file.
    `export function tagA${i}() { return tagB${i}(); }`,
    `function tagB${i}() { return true; }`,
  ].join('\n');
}

function makeRepo(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cd-scale-${n}-`));
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `mod_${i}.ts`), genFile(i));
  return dir;
}

async function benchRepo(nFiles) {
  const dir = makeRepo(nFiles);
  const store = new IndexStore();

  let t = now();
  await indexRepo(store, dir);
  const coldMs = now() - t;
  const { chunks } = store.stats();

  await store.search('warm up the index once', 1); // one-time BM25 build

  // Broad query: every word appears in every file, so nearly every chunk is a
  // candidate — the WORST case for the inverted index (no selectivity to exploit).
  const broadQuery = 'handler validate persist request service';
  t = now();
  for (let k = 0; k < 5; k++) await store.search(broadQuery, 5);
  const searchBroadMs = (now() - t) / 5;

  // Selective query: two file-unique tokens, so only a couple of chunks are
  // candidates — what a real query with rarer terms looks like.
  const mid = Math.floor(nFiles / 2);
  const selectiveQuery = `a${mid} b${mid}`;
  t = now();
  for (let k = 0; k < 5; k++) await store.search(selectiveQuery, 5);
  const searchSelectiveMs = (now() - t) / 5;

  const target = path.join(dir, 'mod_0.ts');
  fs.writeFileSync(target, genFile(0) + '\nexport function extra0() { return handler_0({}); }');
  t = now();
  await indexFile(store, target, dir);
  const incrementalMs = now() - t;

  const snap = path.join(dir, '.context-daemon', 'index.json');
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  t = now();
  await store.save(snap);
  const saveMs = now() - t;
  const snapBytes = fs.statSync(snap).size;
  const store2 = new IndexStore();
  t = now();
  store2.load(snap);
  const loadMs = now() - t;

  const rss = process.memoryUsage().rss;
  fs.rmSync(dir, { recursive: true, force: true });
  return { nFiles, chunks, coldMs, searchBroadMs, searchSelectiveMs, incrementalMs, saveMs, snapBytes, loadMs, rss };
}

function randomUnitVectors(n, dim) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = new Array(dim);
    let norm = 0;
    for (let d = 0; d < dim; d++) {
      v[d] = Math.random() * 2 - 1;
      norm += v[d] * v[d];
    }
    norm = Math.sqrt(norm);
    for (let d = 0; d < dim; d++) v[d] /= norm;
    out.push(v);
  }
  return out;
}

function benchAnn(nVectors, dim = 384) {
  const vecs = randomUnitVectors(nVectors, dim);
  const query = vecs[0];

  let t = now();
  const ann = new AnnIndex(dim);
  for (let i = 0; i < nVectors; i++) ann.add(`c${i}`, vecs[i]);
  const annBuildMs = now() - t;

  t = now();
  for (let k = 0; k < 20; k++) ann.search(query, 10);
  const annQueryMs = (now() - t) / 20;

  t = now();
  for (let k = 0; k < 5; k++) {
    vecs.map((v, i) => ({ i, s: cosineSimilarity(query, v) })).sort((a, b) => b.s - a.s).slice(0, 10);
  }
  const bruteQueryMs = (now() - t) / 5;

  return { nVectors, annBuildMs, annQueryMs, bruteQueryMs };
}

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const fileCounts = sizes.length ? sizes : [1000, 5000, 20000];

console.log(`context-daemon scaling benchmark  (node ${process.version}, ${os.cpus()[0].model}, embeddings OFF)\n`);
console.log('Index / search / snapshot (lexical path).  search-broad = query words in every file');
console.log('(worst case); search-sel = selective query (rare terms, ~one file) — the realistic case:');
console.log('  files    chunks    cold     search-broad  search-sel  incr-reidx   save    snap    load    RSS');
for (const n of fileCounts) {
  const r = await benchRepo(n);
  console.log(
    `  ${String(r.nFiles).padStart(6)}  ${String(r.chunks).padStart(7)}  ${ms(r.coldMs).padStart(7)}  ` +
      `${ms(r.searchBroadMs).padStart(11)}  ${ms(r.searchSelectiveMs).padStart(9)}  ${ms(r.incrementalMs).padStart(9)}  ` +
      `${ms(r.saveMs).padStart(6)}  ${mb(r.snapBytes).padStart(6)}  ${ms(r.loadMs).padStart(6)}  ${mb(r.rss).padStart(6)}`
  );
}

console.log('\nFast-search (ANN) vs brute-force cosine, synthetic 384-d unit vectors:');
console.log('  vectors   ann-build   ann-query   brute-query   speedup');
for (const n of [5000, 25000]) {
  const r = benchAnn(n);
  console.log(
    `  ${String(r.nVectors).padStart(7)}   ${ms(r.annBuildMs).padStart(9)}   ${r.annQueryMs.toFixed(2).padStart(7)}ms   ` +
      `${r.bruteQueryMs.toFixed(2).padStart(9)}ms   ${(r.bruteQueryMs / Math.max(r.annQueryMs, 0.001)).toFixed(0)}x`
  );
}
