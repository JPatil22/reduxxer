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
- `get_token_savings` — cumulative estimated tokens saved this session vs.
  the naive "read the whole file" baseline.

## How search works

Each indexed chunk gets a local embedding vector at index time. A query is
embedded and ranked primarily by cosine similarity, with a lexical
keyword/symbol-name match folded in as a smaller boost — so both
paraphrased queries ("terminate a user's session" → `logout`) and exact
identifier searches work well. Whole-file fallback chunks (files with no
top-level function/class match) and test files are de-prioritized/excluded
so they don't drown out real symbol matches.

At index time, each chunk also records which other same-file top-level
symbols it calls (e.g. `processPayment` calling `validateCard`). The top
search match gets expanded with its direct dependencies (up to 3, labeled
`referenced by <match>` in the output) instead of being returned in
isolation — so asking about a function that mostly delegates to helpers
gets you those helpers too, not just the entry point. This is same-file
only (no cross-file import resolution) and one hop deep.

## Known limitations

- Supported languages: JS/TS-family (`.js`/`.ts`/`.jsx`/`.tsx`, plus the
  `<script>` block of Vue/Svelte single-file components) via the
  TypeScript compiler API, and Python (`.py`) via Python's own `ast`
  module. No Go/Rust/Java support yet.
- Python support requires a `python3` or `python` interpreter on PATH —
  `.py` files are silently skipped (with a one-time warning) if neither
  is found. Only top-level functions/classes are extracted, same
  granularity as the JS/TS side (a class chunk includes its methods).
- Embedding every chunk at index time is CPU-bound and not fast — expect
  tens of milliseconds per chunk on first index of a large repo, sequentially
  (batching many chunks into one model call was tried and measured slower
  on this CPU/ONNX runtime, due to padding overhead across variable-length
  chunks — see the comment on `embedTexts` in `embeddings.ts`). Persistence
  means this cost is only paid once per file, not on every restart.
- Search is brute-force cosine similarity over every embedded chunk — fine
  at the thousands-of-chunks scale this has been tested at, not verified
  at tens-of-thousands-of-chunks monorepo scale.
- Dependency expansion is same-file and one-hop only — it won't follow a
  call into a function imported from another file, and won't chase a
  dependency's own dependencies.
- The HTTP transport is localhost-only with a per-repo bearer token, not
  meant to be exposed beyond the machine it runs on.
- Token-savings tracking is session-scoped (not persisted to the snapshot).

## Suggested next steps

- Persist the token-savings log alongside the index snapshot.
- Cross-file dependency expansion (resolve imports, not just same-file calls).
- Package for `npx context-daemon` / global install instead of clone + build.
