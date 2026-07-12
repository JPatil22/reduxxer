# context-daemon

A local daemon that incrementally indexes a repo (JS/TS — including React,
Vue, and Svelte components — plus Python) at the function/class level and
serves **targeted** code context over MCP — instead of AI coding tools
(Claude Code, Cursor, Cline) re-reading whole files or the whole repo on
every request.

## Why

Every message to an AI coding tool re-sends a lot of context, and people are
hitting token/quota limits fast because of it. Token-reduction tools already
exist (repomix, various MCP servers), but they mostly do a one-shot index —
not a live index shared across multiple tools working the same repo at once.

context-daemon proves three things:

1. You can maintain a **live, incrementally-updated** index (only the
   changed file gets re-parsed, not the whole repo) using a file watcher
   and content hashing, persisted to disk so restarts are cheap.
2. Serving **targeted, semantically-relevant chunks** (matched
   functions/classes) instead of full files or a full repo dump
   meaningfully cuts token usage — 70%+ in testing, more on larger repos.
3. **One daemon process can serve multiple MCP clients at once** (e.g.
   Claude Code and Cursor pointed at the same repo), sharing one index
   instead of each tool spawning its own and duplicating the work — see
   [Claude Code issue #28860](https://github.com/anthropics/claude-code/issues/28860).

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

**Single client (stdio)** — one process per client, standard MCP pattern:

```bash
node dist/src/cli.js mcp /path/to/a/real/repo
```

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

**Multiple clients sharing one daemon (HTTP)** — start it once, point as
many MCP clients at it as you want:

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
