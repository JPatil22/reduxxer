/**
 * Honest before/after measurement of the code-context tokens the daemon
 * saves, over a simulated work session of realistic tasks against this repo.
 *
 * For each task we compare two ways an AI could get the code it needs:
 *   - WITHOUT the daemon: read the whole file(s) that contain the relevant
 *     code (the typical fallback when hunting for/understanding code).
 *   - WITH the daemon: call search_context and use just the returned chunks.
 *
 * This measures the CODE-CONTEXT portion of tokens only — not a whole Claude
 * Code session (system prompt, conversation history, tool overhead all sit
 * on top and are unchanged by the daemon). Token counts use the same
 * ~4-chars/token estimate as the rest of the project.
 *
 * Run:  node demo/measure-savings.mjs [/path/to/repo]
 */
import fs from 'node:fs';
import { IndexStore } from '../dist/src/store.js';
import { indexRepo } from '../dist/src/watcher.js';
import { estimateTokens } from '../dist/src/tokens.js';

const repo = process.argv[2] ?? process.cwd();

// Realistic things a developer (or their AI) would ask while working here.
const tasks = [
  'how does it avoid re-indexing a file that has not changed',
  'where is the bearer auth token checked on the http server',
  'how does search rank results and blend semantic with lexical',
  'how are token savings tracked per search',
  'how does a class get split into method-level chunks',
  'how does cross-file import dependency expansion work',
];

const store = new IndexStore();
await indexRepo(store, repo);

let totalWithout = 0;
let totalWith = 0;

console.log(`Repo: ${repo}`);
console.log(`Indexed: ${store.stats().files} files, ${store.stats().chunks} chunks\n`);
console.log('Task-by-task (code-context tokens):\n');

for (const task of tasks) {
  const results = await store.search(task, 5);
  // WITH daemon: just the returned chunks.
  const withTokens = estimateTokens(results.map((r) => r.code).join('\n\n'));
  // WITHOUT daemon: read the whole file(s) those chunks live in.
  const files = new Set(results.map((r) => r.filePath));
  let withoutTokens = 0;
  for (const f of files) {
    try {
      withoutTokens += estimateTokens(fs.readFileSync(f, 'utf-8'));
    } catch {
      /* file gone */
    }
  }
  totalWith += withTokens;
  totalWithout += withoutTokens;
  const pct = withoutTokens ? Math.round((1 - withTokens / withoutTokens) * 100) : 0;
  console.log(`  "${task}"`);
  console.log(
    `     without daemon (read ${files.size} whole file(s)): ${withoutTokens} tok` +
      `   |   with daemon: ${withTokens} tok   |   -${pct}%\n`
  );
}

const overallPct = totalWithout ? Math.round((1 - totalWith / totalWithout) * 100) : 0;
console.log('─'.repeat(70));
console.log(`Session total — without daemon: ${totalWithout} tok   with daemon: ${totalWith} tok`);
console.log(`Code-context token reduction across the session: ${overallPct}%`);
console.log(
  '\nNote: this is the code-retrieval portion only. A real AI session also\n' +
    'spends tokens on the system prompt, conversation history, and its reply —\n' +
    'the daemon does not change those, so whole-session reduction is smaller.'
);
