/**
 * Retrieval-quality eval: does search_context return the code a developer
 * actually needs to answer a question? Token savings are worthless if the
 * wrong code comes back, so this measures the OTHER half of the claim.
 *
 * Method (honest, reproducible):
 *  - Index this repo with the REAL product config (embeddings on).
 *  - Ask a fixed set of realistic questions, each labelled with the GOLD
 *    symbol(s) that must appear for the question to be answerable.
 *  - A question "hits" if any of its gold symbols is in the returned results.
 *  - A NEGATIVE-control question (functionality that doesn't exist) "passes"
 *    only if search returns nothing — testing the relevance gate, not recall.
 *  - Report hit-rate, negative-control pass-rate, and per-question misses.
 *
 * This is a proof, not a victory lap: misses are printed so they can be fixed.
 *
 * Run:  node demo/eval-retrieval.mjs [repoPath]     (default: cwd)
 */
import path from 'node:path';
import { IndexStore } from '../dist/src/store.js';
import { indexRepo } from '../dist/src/watcher.js';
import { closePythonWorker } from '../dist/src/pythonIndexer.js';

const repo = path.resolve(process.argv[2] ?? process.cwd());

// Each gold symbol may be written bare (matches a qualified method too, e.g.
// "rankChunks" matches "IndexStore.rankChunks"). `gold: []` marks a negative
// control (correct behaviour is to return nothing).
const QUESTIONS = [
  { q: 'where is the bearer auth token checked on the http server', gold: ['startHttpMcpServer'] },
  { q: 'how does search blend semantic similarity with BM25 lexical scoring', gold: ['rankChunks'] },
  { q: 'how are BM25 scores computed from the inverted index posting lists', gold: ['bm25ScoresForQuery'] },
  { q: 'how does it skip re-indexing a file whose content has not changed', gold: ['indexFile'] },
  { q: 'how is the cumulative token savings percentage computed', gold: ['tokenSavings'] },
  { q: 'how does the ghost file view get rendered per source file', gold: ['renderFileBlock', 'buildContext'] },
  { q: 'how is the index written to disk atomically without corruption', gold: ['save'] },
  { q: 'how does the fast search ANN index get built after crossing the threshold', gold: ['maybeInitAnn'] },
  { q: 'how are concurrent embedding model calls serialized', gold: ['withInferenceLock', 'embedText'] },
  { q: 'how does the reconcile sweep detect files deleted while the watcher missed it', gold: ['reconcile'] },
  { q: 'how does the file watcher re-index a single changed file', gold: ['watchRepo'] },
  { q: 'how are cross-file imported dependencies resolved to indexed chunks', gold: ['resolveExternalRef', 'directDependencies'] },
  { q: 'how does it resolve a tsconfig path alias like @/utils to a real file', gold: ['resolveTsAlias', 'loadTsConfig'] },
  { q: 'how is a class split into a header chunk plus one chunk per method', gold: ['addClassChunks', 'emit_class'] },
  { q: 'how does budget based context assembly pack chunks up to a token budget', gold: ['searchWithinBudget'] },
  { q: 'how does the python worker recover after a parse times out', gold: ['parse', 'PythonWorker'] },
  // Negative controls — this functionality does not exist in the repo:
  { q: 'how does it connect to a postgres database and run migrations', gold: [] },
  { q: 'how does the kafka consumer rebalance partitions across brokers', gold: [] },
];

function hasSymbol(results, gold) {
  const g = gold.toLowerCase();
  return results.some((r) => {
    const s = r.symbolName.toLowerCase();
    return s === g || s.endsWith(`.${g}`);
  });
}

const store = new IndexStore();
console.log(`Indexing ${repo} (real config, embeddings on)...`);
await indexRepo(store, repo);
console.log(`Indexed: ${store.stats().files} files, ${store.stats().chunks} chunks\n`);

let hits = 0;
let recallDenom = 0;
let negPass = 0;
let negDenom = 0;
const misses = [];

for (const { q, gold } of QUESTIONS) {
  // Must mirror EXACTLY what the MCP search_context tool does, or this eval
  // measures a code path users never hit (it previously called search(q,5),
  // which the product stopped using when the default became budget-based).
  const results = await store.searchWithinBudget(q, 1500, 25, true);
  const names = results.map((r) => r.symbolName);
  if (gold.length === 0) {
    negDenom++;
    const passed = results.length === 0;
    if (passed) negPass++;
    else misses.push(`NEG  "${q}"  -> expected nothing, got: ${names.join(', ')}`);
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] (neg) "${q}"  -> ${results.length === 0 ? 'nothing (correct)' : names.join(', ')}`);
  } else {
    recallDenom++;
    const hit = gold.some((g) => hasSymbol(results, g));
    if (hit) hits++;
    else misses.push(`MISS "${q}"  -> wanted [${gold.join(' | ')}], got: ${names.join(', ') || '(nothing)'}`);
    console.log(`  [${hit ? 'HIT ' : 'MISS'}] "${q}"  -> ${names.join(', ') || '(nothing)'}`);
  }
}

console.log('\n' + '─'.repeat(70));
console.log(`Answerable questions found (recall):  ${hits}/${recallDenom}  (${Math.round((hits / recallDenom) * 100)}%)`);
console.log(`Negative controls correctly empty:    ${negPass}/${negDenom}`);
if (misses.length) {
  console.log('\nFailures (fix these — not hidden):');
  for (const m of misses) console.log('  ' + m);
}
closePythonWorker();

// Regression gate (used by CI). Retrieval quality is the whole point of this
// tool, so a drop should fail the build rather than be noticed months later —
// exactly how the "94%" figure silently became 75% when the default search path
// changed. Tune the floor with EVAL_MIN_RECALL as quality improves.
const MIN_RECALL = Number(process.env.EVAL_MIN_RECALL) || 0.7;
const recall = recallDenom > 0 ? hits / recallDenom : 0;
if (recall < MIN_RECALL) {
  console.error(`\nFAIL: recall ${(recall * 100).toFixed(0)}% is below the ${(MIN_RECALL * 100).toFixed(0)}% floor.`);
  process.exit(1);
}
if (negPass < negDenom) {
  console.error(`\nFAIL: ${negDenom - negPass} negative control(s) returned results — the relevance gate regressed.`);
  process.exit(1);
}
console.log('\nRegression gate: PASS');
