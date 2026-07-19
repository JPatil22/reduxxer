/**
 * Answer-quality A/B: the gold-standard proof that the daemon saves tokens
 * WITHOUT making an AI's answers worse. Token savings are meaningless if the
 * answers degrade, so this measures answer quality head-to-head.
 *
 * For each realistic question about this codebase:
 *   1. Answer it giving the AI ONLY what search_context returns (targeted).
 *   2. Answer it giving the AI the WHOLE file(s) — the no-daemon baseline.
 *   3. A blind judge (order randomized) picks which answer is more correct.
 * Then tally how often the daemon's answers were as-good-or-better, alongside
 * the token cost of each side. Blind + randomized to avoid position bias.
 *
 * This calls a real chat model via any OpenAI-compatible API (Groq's free tier,
 * PoYo, OpenAI, …). Nothing runs or costs anything until YOU set a key and run
 * it — run with no key to print setup instructions, or with --estimate for a
 * free token/cost projection with no API calls.
 *
 * Config (env): LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_JUDGE_MODEL, LLM_TPM
 * (client-side tokens/minute pacing for free tiers). POYO_* names also work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { IndexStore } from '../dist/src/store.js';
import { indexRepo } from '../dist/src/watcher.js';
import { estimateTokens } from '../dist/src/tokens.js';
import { closePythonWorker } from '../dist/src/pythonIndexer.js';

// Works with any OpenAI-compatible chat API (Groq's free tier, PoYo, OpenAI, …).
// LLM_* are the generic names; POYO_* still work as fallbacks.
const API_KEY = process.env.LLM_API_KEY ?? process.env.POYO_API_KEY;
const BASE_URL = process.env.LLM_BASE_URL ?? process.env.POYO_BASE_URL ?? 'https://api.poyo.ai/v1/chat/completions';
const MODEL = process.env.LLM_MODEL ?? process.env.POYO_MODEL ?? 'gemini-3-flash-preview';
const JUDGE_MODEL = process.env.LLM_JUDGE_MODEL ?? process.env.POYO_JUDGE_MODEL ?? MODEL;
// Client-side tokens-per-minute pace, to respect free-tier limits (e.g. Groq's
// ~12K TPM on the 70B model). 0 = no pacing (paid providers with high limits).
const TPM = Number(process.env.LLM_TPM) || 0;
// Cap the context SENT to the model per call. OFF by default (0) so the test is
// always valid — truncating a whole-file baseline can cut the answer out of it
// and invalidate the comparison. Only set this (e.g. 4000) on a tight free tier
// where a big whole-file call would otherwise exceed a per-minute token limit,
// accepting that big files get trimmed for those calls.
const MAX_CONTEXT = Number(process.env.LLM_MAX_CONTEXT) || 0;
const repo = process.cwd();
const N = Number(process.argv[2]) || 6;
const ESTIMATE = process.argv.includes('--estimate'); // dry run: cost projection, no API calls

// Approximate PoYo chat prices ($ per 1M tokens, input/output) for the cost
// projection — see poyo.ai/pricing. Ranges are shown at their midpoint.
const PRICES = {
  'deepseek-v4-flash': { in: 0.11, out: 0.22 },
  'gpt-5.2': { in: 0.44, out: 3.5 },
  'gemini-3-flash-preview': { in: 0.6, out: 3.6 },
  'claude-sonnet-4-5-20250929': { in: 0.8, out: 4.0 },
  'claude-opus-4.8': { in: 4.0, out: 20.0 },
};

if (!API_KEY && !ESTIMATE) {
  console.error(
    'This runs a real chat model to grade answers, so it needs an API key for any\n' +
      'OpenAI-compatible provider. Two easy options (PowerShell shown):\n\n' +
      '  FREE — Groq (no card, free tier):\n' +
      '    $env:LLM_API_KEY   = "gsk_..."\n' +
      '    $env:LLM_BASE_URL  = "https://api.groq.com/openai/v1/chat/completions"\n' +
      '    $env:LLM_MODEL     = "llama-3.3-70b-versatile"\n' +
      '    $env:LLM_TPM       = "12000"   # pace under Groq free-tier tokens/minute\n\n' +
      '  PoYo (uses your credits):\n' +
      '    $env:LLM_API_KEY   = "sk-..."\n' +
      '    $env:LLM_BASE_URL  = "https://api.poyo.ai/v1/chat/completions"\n' +
      '    $env:LLM_MODEL     = "gpt-5.2"\n\n' +
      'Then:  node demo/eval-answer-quality.mjs [numQuestions]   (default 6)\n' +
      'Free dry-run (no key, no calls):  node demo/eval-answer-quality.mjs 12 --estimate\n' +
      'Optional: LLM_JUDGE_MODEL (defaults to LLM_MODEL).'
  );
  process.exit(1);
}

// {question, files[]} — the file(s) that contain the answer. The whole file(s)
// are the "no daemon" baseline AND the judge's ground-truth reference.
const QUESTIONS = [
  { q: 'Where and how is the bearer auth token validated on the HTTP server?', files: ['src/httpServer.ts'] },
  { q: 'How does search ranking blend semantic similarity with BM25 lexical scoring?', files: ['src/store.ts'] },
  { q: 'How does the daemon skip re-indexing a file whose content has not changed?', files: ['src/watcher.ts'] },
  { q: 'How is the cumulative token-savings percentage computed?', files: ['src/store.ts'] },
  { q: 'How is the index written to disk atomically so a crash cannot corrupt it?', files: ['src/store.ts'] },
  { q: 'How are concurrent embedding-model calls serialized?', files: ['src/embeddings.ts'] },
  { q: 'How does the reconcile sweep detect files deleted while the watcher missed the event?', files: ['src/watcher.ts'] },
  { q: 'How does it resolve a tsconfig path alias like "@/utils" to a real file?', files: ['src/indexer.ts'] },
  { q: 'How does the Python worker recover after a parse times out?', files: ['src/pythonIndexer.ts'] },
  { q: 'How does budget-based context assembly pack chunks up to a token budget?', files: ['src/store.ts'] },
  { q: 'How is a class split into a header chunk plus one chunk per method?', files: ['src/indexer.ts'] },
  { q: 'How does cross-file dependency expansion pull in an imported function?', files: ['src/store.ts'] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Truncate text to ~maxTokens (proportional by chars) so a single call fits
// small free-tier limits. Used only for what's SENT to the model, not the
// reported token savings.
function capText(text, maxTokens) {
  if (!maxTokens || estimateTokens(text) <= maxTokens) return text;
  const cut = Math.floor(text.length * (maxTokens / estimateTokens(text)) * 0.95);
  return text.slice(0, cut) + '\n\n/* …truncated to fit the model context limit… */';
}

// Client-side tokens-per-minute pacing: keeps a rolling 60s window of tokens
// spent and waits before a call that would exceed LLM_TPM, so free-tier TPM
// caps (e.g. Groq) don't just start 429-ing. No-op when TPM is 0.
let tokenWindow = [];
async function pace(estTokens) {
  if (!TPM) return;
  for (;;) {
    const now = Date.now();
    tokenWindow = tokenWindow.filter((e) => now - e.t < 60000);
    const used = tokenWindow.reduce((s, e) => s + e.tokens, 0);
    if (used + estTokens <= TPM || tokenWindow.length === 0) break;
    await sleep(60000 - (now - tokenWindow[0].t) + 200); // wait for the oldest to age out
  }
  tokenWindow.push({ t: Date.now(), tokens: estTokens });
}

async function callModel(model, messages, maxTokens) {
  await pace(estimateTokens(messages.map((m) => m.content).join('\n')) + maxTokens);
  for (let attempt = 0; attempt < 7; attempt++) {
    let res;
    try {
      res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens, stream: false }),
      });
    } catch (err) {
      if (attempt < 6) { await sleep(2000); continue; }
      throw err;
    }
    if (res.status === 429) {
      // Rate limited — wait as long as the server says (retry-after), else back
      // off exponentially (5s,10s,20s,…) so a per-minute token limit can reset.
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Math.min(5 * 2 ** attempt, 60)) * 1000;
      await sleep(waitMs + 500);
      continue;
    }
    const json = await res.json();
    if (json.code && json.code !== 200 && !json.choices && !json.data) {
      throw new Error(`API error ${json.code}: ${json.message ?? JSON.stringify(json).slice(0, 200)}`);
    }
    // Standard OpenAI shape is { choices: [...] }; PoYo wraps it in { data: {...} }.
    const payload = json.data ?? json;
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new Error(`Unexpected response shape: ${JSON.stringify(json).slice(0, 300)}`);
    return content.trim();
  }
  throw new Error('rate-limited after several retries');
}

function answer(code, question) {
  return callModel(
    MODEL,
    [
      { role: 'system', content: 'You answer questions about a codebase using ONLY the code provided. Be correct and concise (a short paragraph). If the provided code does not contain the answer, say so plainly.' },
      { role: 'user', content: `CODE:\n\n${code}\n\nQUESTION: ${question}` },
    ],
    700
  );
}

async function judge(question, reference, ansA, ansB) {
  const out = await callModel(
    JUDGE_MODEL,
    [
      { role: 'system', content: 'You grade two answers to a question about code. Use the REFERENCE code only as the source of truth for FACTUAL correctness. Judge which answer more correctly and completely answers the QUESTION. Do NOT reward length, verbosity, or wording that merely echoes the reference — a shorter answer that is factually correct and complete is at least as good. If both are correct and complete, reply TIE. Reply with EXACTLY one token: A, B, or TIE.' },
      { role: 'user', content: `REFERENCE CODE:\n\n${reference}\n\nQUESTION: ${question}\n\nANSWER A:\n${ansA}\n\nANSWER B:\n${ansB}\n\nWhich answer is better? Reply A, B, or TIE.` },
    ],
    8
  );
  const m = out.toUpperCase().match(/\b(A|B|TIE)\b/);
  return m ? m[1] : 'TIE';
}

const store = new IndexStore();
console.log(`Indexing ${repo} ...`);
await indexRepo(store, repo);
console.log(`Indexed ${store.stats().files} files, ${store.stats().chunks} chunks.  answerer=${MODEL}  judge=${JUDGE_MODEL}\n`);

const qs = QUESTIONS.slice(0, Math.min(N, QUESTIONS.length));

// --estimate: project token consumption + cost from the REAL contexts, no calls.
if (ESTIMATE) {
  let input = 0, output = 0;
  const ANSWER_OUT = 450, JUDGE_OUT = 6, WRAP = 60; // realistic output/wrapper sizes
  for (const { q, files } of qs) {
    const wc = estimateTokens(store.buildContext(await store.searchWithinBudget(q, 1500, 25, true)));
    const oc = estimateTokens(files.map((f) => fs.readFileSync(path.join(repo, f), 'utf-8')).join('\n\n'));
    // 3 calls: answer-with (in wc), answer-without (in oc), judge (in oc + 2 answers).
    input += wc + WRAP + (oc + WRAP) + (oc + 2 * ANSWER_OUT + WRAP);
    output += ANSWER_OUT + ANSWER_OUT + JUDGE_OUT;
  }
  console.log(`Projected consumption for ${qs.length} questions (${qs.length * 3} model calls):`);
  console.log(`  input  ~${input.toLocaleString('en-US')} tokens`);
  console.log(`  output ~${output.toLocaleString('en-US')} tokens\n`);
  const CREDIT_USD = 0.005; // PoYo: ~1 credit = half a cent (see poyo.ai/pricing)
  console.log('  model                          est. cost      credits');
  for (const [m, p] of Object.entries(PRICES)) {
    const usd = (input / 1e6) * p.in + (output / 1e6) * p.out;
    console.log(`  ${m.padEnd(30)} $${usd.toFixed(3).padEnd(9)}  ~${Math.ceil(usd / CREDIT_USD)} credits`);
  }
  console.log('\n(estimate only — no API calls were made; failed calls do not consume credits)');
  closePythonWorker();
  process.exit(0);
}

let withWins = 0, ties = 0, withoutWins = 0, withTok = 0, withoutTok = 0, skipped = 0;

for (const { q, files } of qs) {
  try {
    const withCtx = store.buildContext(await store.searchWithinBudget(q, 1500, 25, true));
    const withoutCtx = files.map((f) => fs.readFileSync(path.join(repo, f), 'utf-8')).join('\n\n');
    // Real sizes for the savings stat; capped copies for the actual API calls.
    const wt = estimateTokens(withCtx), ot = estimateTokens(withoutCtx);
    const withForCall = capText(withCtx, MAX_CONTEXT);
    const withoutForCall = capText(withoutCtx, MAX_CONTEXT);

    const ansWith = await answer(withForCall, q);
    const ansWithout = await answer(withoutForCall, q);
    const withIsA = Math.random() < 0.5; // blind + randomized order
    const verdict = await judge(q, withoutForCall, withIsA ? ansWith : ansWithout, withIsA ? ansWithout : ansWith);
    let winner;
    if (verdict === 'TIE') { winner = 'tie'; ties++; }
    else if ((verdict === 'A') === withIsA) { winner = 'with'; withWins++; }
    else { winner = 'without'; withoutWins++; }

    withTok += wt; withoutTok += ot;
    console.log(`  [${winner.toUpperCase().padEnd(7)}] ${q}`);
    console.log(`      context tokens — daemon: ${wt}  |  whole file(s): ${ot}  (-${Math.round((1 - wt / ot) * 100)}%)`);
  } catch (err) {
    // One failed question (e.g. an unrecoverable rate limit) skips — it must
    // not crash the whole run and lose the questions that DID complete.
    skipped++;
    console.log(`  [SKIP   ] ${q}\n      ${err.message}`);
  }
  await sleep(600);
}

const done = qs.length - skipped;
const notWorse = withWins + ties;
console.log('\n' + '─'.repeat(72));
console.log(`Answer quality (blind judge): ${done}/${qs.length} completed${skipped ? `, ${skipped} skipped (rate limits)` : ''}`);
console.log(`  daemon answer BETTER : ${withWins}`);
console.log(`  TIE                  : ${ties}`);
console.log(`  whole-file BETTER    : ${withoutWins}`);
if (done > 0) console.log(`  => daemon as-good-or-better on ${notWorse}/${done} (${Math.round((notWorse / done) * 100)}%)`);
if (withoutTok > 0) console.log(`  context tokens: ${withTok} (daemon) vs ${withoutTok} (whole files) — ${Math.round((1 - withTok / withoutTok) * 100)}% fewer`);
console.log('\nEach question = 3 model calls (answer-with, answer-without, judge).');
closePythonWorker();
