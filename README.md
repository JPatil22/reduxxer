# context-daemon

**Stop your AI coding tool from burning tokens re-reading your whole codebase.**

Claude Code, Cursor, and Cline pull large chunks of your repo into context on
almost every message — often the same files, over and over. That's a big part
of why people hit their token/quota limits so fast.

context-daemon runs quietly in the background, keeps a live index of your repo
at the **function/class level**, and — when your AI tool asks — hands back just
the few functions relevant to the task instead of whole files. Your tool gets
what it needs; you stop paying for the rest.

### What makes it different

- **Targeted, not bulk.** Returns the handful of relevant functions, not entire
  files or a full-repo dump. Meaningfully fewer tokens per request.
- **Live, not one-shot.** A file watcher re-indexes only what you change, so the
  index stays current without re-scanning the whole repo. Saved to disk, so
  restarts are instant.
- **Shared, not duplicated.** One daemon can serve several tools at once (e.g.
  Claude Code *and* Cursor on the same repo) from one shared index, instead of
  each tool re-indexing separately — an
  [open gap in the tools themselves](https://github.com/anthropics/claude-code/issues/28860).
- **Understands dependencies.** When it returns a function, it also pulls in the
  functions that one calls — so the AI isn't handed code with the important
  pieces missing.
- **Local and private.** Your code never leaves your machine. Works fully
  offline after a one-time model download.

Works with **JavaScript, TypeScript, React, Vue, Svelte, and Python**.

### Quick start

```bash
git clone https://github.com/JPatil22/reduxxer
cd reduxxer/context-daemon
npm install && npm run build

# index your project and serve it to your AI tool over MCP
node dist/src/cli.js mcp /path/to/your/project
```

Then point your AI coding tool at it (see [Run it as an MCP server](#run-it-as-an-mcp-server) below).

## What's inside

```
context-daemon/
  src/
    types.ts        - CodeChunk / FileRecord / SearchLogEntry shapes
    store.ts         - in-memory index, persistence, lexical+semantic search, token-savings tracking
    indexer.ts        - parses JS/TS/Vue/Svelte into symbol-level chunks (TypeScript compiler API)
    pythonIndexer.ts    - parses Python into symbol-level chunks (Python's own `ast`, via subprocess)
    watcher.ts             - walks a repo once, then watches it and re-indexes only changed files
    embeddings.ts             - local embedding model (all-MiniLM-L6-v2 via @xenova/transformers)
    mcpServer.ts                 - exposes search_context / get_index_stats / get_token_savings as MCP tools
    httpServer.ts                   - Streamable HTTP transport so multiple clients share one daemon
    cli.ts                             - entrypoint: index | watch | mcp [--http --port=N]
  python/
    parse_python.py    - the ast-based parser invoked by pythonIndexer.ts
  demo/
    fixture-repo/    - tiny sample repo (auth.ts, orders.ts, notifications.ts)
    benchmark.ts      - naive full-dump vs targeted search_context token comparison
    *-check.mjs        - scripts used to validate multi-client sharing, token tracking, semantic search
  test/
    *.test.ts          - automated test suite (node:test)
```

## Setup

```bash
cd context-daemon
npm install
npm run build
npm test
```

## Try the benchmark first

```bash
npm run benchmark
# or with your own query:
node dist/demo/benchmark.js "cancel an order"
```

This runs against the tiny included fixture repo just to prove the mechanism
works end to end. To see a realistic size of savings, point the indexer at
an actual project:

```bash
node dist/src/cli.js index /path/to/a/real/repo
```

### How much does it actually save?

Measured, reproducible, and honest about the baseline. The comparison is:

- **Baseline (without the daemon):** the AI reads the **whole file(s)** that
  contain the code it needs — the common fallback when hunting for or
  understanding code.
- **With the daemon:** exactly what `search_context` returns — the rendered
  **ghost-file view** (`buildContext`: module header + the matched symbol
  bodies + one-line collapsed signatures of every other symbol in the file).
  This is what the model actually receives, and it's what the numbers below
  measure — *not* the raw matched-chunk bodies, which are smaller and would
  overstate the result.

On the **code-retrieval portion of a request**, that lands around
**~50–65% fewer tokens** on real repositories (measured: ~63% across a
mixed session on this repo via `node demo/measure-savings.mjs .`, ~52–54%
on a larger real repo from the `requests.log` audit trail; the 3-file
fixture is smaller at ~46% because there's little to collapse). Per-query
it ranges widely (roughly 20–90%) depending on how much of the touched
files the query actually needed.

This is the **code-context portion only.** A real AI session also spends
tokens on the system prompt, conversation history, and the model's own
reply — the daemon doesn't change those, so whole-session reduction is
smaller than the retrieval-only figure.

The first index of a repo writes a `.context-daemon/index.json` snapshot
into it; re-running only re-parses files whose content hash changed. Add
`.context-daemon/` to that repo's `.gitignore`.

The first time semantic search runs, it downloads and caches a small local
embedding model (~90MB, one time, fully offline afterward).

## Run it as an MCP server

### Recommended: zero-touch setup (stdio)

This is the setup most people want. **Your AI tool starts and stops the
daemon for you** — you never launch anything manually, and there's nothing
to keep running in the background. Add this to your tool's MCP config
(e.g. `.mcp.json` for Claude Code, or the equivalent in Cursor):

```json
{
  "mcpServers": {
    "context-daemon": {
      "command": "node",
      "args": ["/absolute/path/to/context-daemon/dist/src/cli.js", "mcp", "/absolute/path/to/your/repo"]
    }
  }
}
```

That's the whole setup. From then on:

- Your AI tool launches the daemon automatically each session — **no manual
  start, no restarts.**
- The daemon loads its saved index instantly and watches your repo, so as
  you edit files it keeps itself current in the background.
- When the AI needs context, it calls the daemon and gets back just the
  relevant functions. You never think about it.

(You'll restart your editor **once** after first adding the config, so it
picks up the new MCP server. After that, it's automatic.)

### Getting your AI tool to actually prefer the daemon

MCP tools are *advisory* — the model decides each turn whether to call
`search_context` or just read files itself. The daemon's tool description and
server instructions already steer it toward searching first, but the
strongest lever is a **standing instruction in your project**, which the
assistant reads as a direct rule for that repo. Drop this into your project's
`CLAUDE.md` (Claude Code) or `.cursorrules` (Cursor):

```md
## Finding code in this repo

Always use the `search_context` tool FIRST when you need to find or
understand code here — describe what you want in plain language. It returns
the relevant functions (and their dependencies) as a compact ghost-file view.
Only read a whole file when search_context returns nothing, or when you
genuinely need the entire file (e.g. full top-level wiring).
```

This won't *force* it (nothing can, with MCP), but it's the most reliable way
to make the assistant reach for the daemon by default instead of reading
files.

### Advanced: share one daemon across multiple tools (HTTP)

Only needed if you want, say, Claude Code *and* Cursor hitting **one** shared
index at the same time. Here you start the daemon yourself and leave it
running:

```bash
node dist/src/cli.js mcp /path/to/a/real/repo --http --port=7621
```

This binds to `127.0.0.1` only and prints a per-repo auth token (generated
once and saved to `.context-daemon/http-token`, or set your own with
`--token=secret`). Configure each client to connect to
`http://127.0.0.1:7621/mcp` over Streamable HTTP with header
`Authorization: Bearer <token>`. All clients read and write through the
same live index.

Once connected, a tool can call:

- `search_context` — natural-language query, returns the top-N relevant
  code chunks (not whole files), plus an estimated token-savings note.
- `get_index_stats` — files/chunks indexed, last updated.
- `get_token_savings` — cumulative estimated tokens saved vs. the naive
  "read the whole file" baseline, persisted across daemon restarts.

## How search works

Each indexed chunk gets a local embedding vector at index time. A query is
embedded and ranked by a hybrid of two signals: cosine similarity (semantic)
and **BM25** (lexical). BM25 is the standard information-retrieval scorer —
it weights rare query terms higher via IDF (so `bm25Score` surfaces for
"bm25 ranking" but a ubiquitous word like `process` barely moves the
ranking), saturates repeated terms, and normalizes for document length.
Identifiers are split on camelCase (`getUserById` → get/user/by/id), and
every token is reduced to a root form with a Porter stemmer, so "running"
matches a function called `run_process` and "handled" matches `handleRequest`
— without needing embeddings to bridge the gap. Combining BM25 with semantic
similarity covers both paraphrased queries ("terminate a user's session" →
`logout`) and exact identifier lookups. Whole-file fallback chunks and test
files are de-prioritized/excluded so they don't drown out real symbol
matches.

Alongside functions and classes, each file also produces a **module-header
chunk** — its imports, re-exports, top-level constants/config, and type
declarations. This is the file-level wiring that isn't a function or class,
so questions like "what does this file import" or "what's the default port"
(a top-level constant) resolve instead of forcing a whole-file read.

A **relevance gate** keeps results honest: a chunk only counts as a match if
the query is a substring of its symbol name, or it clears a semantic
similarity floor, or at least two distinct query words actually appear in
it. A query for functionality that doesn't exist shares at most one
incidental word and scores low, so it returns *nothing* rather than
confidently handing back the nearest wrong chunk — and the caller can then
fall back to reading a file.

Results aren't returned as floating, context-free snippets. `search_context`
renders a **ghost file** per source file: the file's imports and top-level
constants at the top, the full code of the matched symbols in place, and
every *other* symbol in that file collapsed to a one-line signature with its
line range. This gives an AI the structural coordinates it needs to edit
safely — what's imported, what else lives in the file, and exact line
numbers — without shipping whole files. Collapsed entries are clearly marked
comments, so real source is never confused with omitted bodies; the caller
can request a collapsed symbol by name if it needs the body.

At index time, each chunk records which other symbols it calls — both
same-file (e.g. `processPayment` calling `validateCard`) and, for JS/TS,
symbols imported from another file (`import { validateUser } from './auth'`).
The top search match gets expanded with its direct dependencies instead of
being returned in isolation — so asking about a function that delegates to
helpers, including helpers in *other* files, gets you those too, not just
the entry point. Expansion is one hop deep and capped so it can't dwarf the
real matches. Cross-file resolution covers JS/TS relative imports and Python
`from ... import` statements.

## Scaling (measured, reproducible)

Run it yourself: `npm run scale-bench` (generates synthetic repos and reports
the numbers below; embeddings are off so it measures the index/search/snapshot
machinery, not model inference — see the script header for why). Representative
run, Intel i5-10300H, Node 22, lexical path:

| files | chunks | cold index | search (selective) | search (broad) | incr. re-index | snapshot | load | RSS |
|------:|-------:|-----------:|-------------------:|---------------:|---------------:|---------:|-----:|----:|
| 1,000 | 9,000 | 2.6s | 2ms | 20ms | 5ms | 4MB | 59ms | 186MB |
| 5,000 | 45,000 | 8.4s | 6ms | 45ms | 3ms | 22MB | 229ms | 318MB |
| 20,000 | 180,000 | 72s | 24ms | 278ms | 7ms | 90MB | 975ms | 714MB |

What this shows honestly:

- **Incremental editing stays flat (~3–7ms) at every size** — the BM25 stats are
  maintained incrementally, not rebuilt per keystroke, so a search right after
  an edit costs the same as any other search. This is the property that matters
  for a live daemon, and it holds.
- **Realistic searches stay fast** (~24ms at 180k chunks). A keyword **inverted
  index** means only the chunks that actually contain a query term get scored,
  not the whole corpus. The `search (broad)` column is the worst case — a query
  whose every word appears in nearly *every* file, so the candidate set is
  everything and it scans proportionally (~280ms at 180k). Real natural-language
  queries use rarer, more selective terms and land in the `selective` column.
- **Cold first-index is the real cost** and the honest weak point — ~72s for a
  20k-file repo even without embeddings (with embeddings on, first-index of a
  repo that large is much slower, bounded by the ~tens-of-ms-per-chunk model
  cost). Persistence means it's paid **once**; restarts load the snapshot
  (~1s at 180k chunks) instead of re-indexing.

Fast-search (ANN) vs brute-force cosine, synthetic 384-d vectors: at 25,000
vectors the ANN index answers in ~0.5ms vs brute-force's ~39ms (~80× faster),
against a one-time index build of ~39s — consistent with the threshold-based
design (brute-force below 20k chunks, ANN above).

## Known limitations

- Supported languages: JS/TS-family (`.js`/`.ts`/`.jsx`/`.tsx`, plus all
  `<script>` blocks of Vue/Svelte single-file components — `<script>` and
  `<script setup>` together) via the TypeScript compiler API, and Python
  (`.py`) via Python's own `ast` module. No Go/Rust/Java support yet.
- The repo-root `.gitignore` (plus a built-in ignore list — `node_modules`,
  `dist`, `build`, `.next`, `coverage`, `__pycache__`, `.venv`, … — applied
  at any depth) applies everywhere, and each subdirectory's own `.gitignore`
  additionally applies to paths under it, scoped to that subtree the same
  way git itself resolves nested `.gitignore` files in a monorepo.
- Python support requires a `python3` or `python` interpreter on PATH —
  `.py` files are silently skipped (with a one-time warning) if neither
  is found. Only top-level functions/classes are extracted, same
  granularity as the JS/TS side (a class chunk includes its methods).
- Files over 1.5MB are skipped entirely (logged, not silent) — minified
  bundles and large generated files can stall the parser/embedding step
  for little benefit. Genuine hand-written source is essentially never
  this large. Separately, a file *under* the size limit but producing more
  than 500 chunks (e.g. a generated file packed with thousands of tiny
  functions — verified with a real 950KB/22,615-function file) skips
  embedding for that file specifically: its symbols still index for
  keyword/BM25 search, just without semantic search, since sequential
  embedding at that count
  would otherwise take several minutes for a single file.
- Embedding every chunk at index time is CPU-bound and not fast — expect
  tens of milliseconds per chunk on first index of a large repo, sequentially
  (batching many chunks into one model call was tried and measured slower
  on this CPU/ONNX runtime, due to padding overhead across variable-length
  chunks — see the comment on `embedTexts` in `embeddings.ts`). Persistence
  means this cost is only paid once per file, not on every restart. Pass
  `--no-embeddings` to skip the model entirely (no ~90MB download, lexical
  search only). On first run the model download is announced, not silent.
- **Semantic search scales via a fast-search (ANN) index above 20,000
  embedded chunks** (`usearch`/HNSW) — below that, brute-force cosine
  similarity is already fast (~81ms at 25,000 chunks) and is what every
  repo uses by default; the ANN index only kicks in for the rare, genuinely
  huge repo, and never affects normal-sized ones. Two other approaches were
  evaluated first and rejected with real benchmarks: `sqlite-vec` only gave
  ~3x (not the order-of-magnitude a true ANN index provides) and was slower
  to write to; `hnswlib-node` gave real ANN performance but requires a C++
  compiler toolchain most users don't have. `usearch` was chosen after
  verifying it avoids both problems — prebuilt binaries for Windows/Mac/
  Linux (confirmed, no compiler needed) and genuine flat query time
  regardless of scale (measured 1.6ms at 25,000 chunks vs. brute-force's
  81ms, with the gap widening enormously at real large-repo scale).
  Correctness was verified against exact brute-force search on real code
  embeddings (100% recall across two test corpora), and it's more
  memory-efficient too (~99MB vs ~200MB at 25,000 chunks). The one real
  cost is a slower one-time index build the first time a repo crosses the
  threshold (~68s at 25,000 chunks, longer for bigger repos) — logged
  clearly, not a silent wait, and persisted to disk so it's paid once, not
  on every restart. `IndexStore`'s brute-force path stays fully intact and
  unchanged for every repo below the threshold; pass `--no-ann` to force
  brute-force even on a huge repo if the fast-search path is ever suspected
  of causing a problem.
- Dependency expansion chases a chain up to 2 hops deep (A -> B -> C), capped
  at 4 pulled-in chunks total so it can't dwarf the real matches. Cross-file
  resolution follows JS/TS relative imports, tsconfig/jsconfig `paths`
  aliases (e.g. `@/utils/x`, matched against the repo-root config), and
  Python `from ... import` statements; it does not resolve `import x`
  followed by `x.y()` attribute calls, or imports of genuine external
  packages (react, lodash, ...).
- The HTTP transport is localhost-only with a per-repo bearer token, not
  meant to be exposed beyond the machine it runs on.

## Suggested next steps

- Publish to npm as `tokenreduxxer` so `npx tokenreduxxer <repo>` works without
  cloning. The packaging itself is done and verified — a real `npm pack` +
  isolated global install was tested end to end (JS/TS and Python indexing
  both confirmed working from the installed layout, not just the source
  tree) — just not published yet.
