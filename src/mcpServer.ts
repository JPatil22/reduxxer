import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import { z } from 'zod';
import { IndexStore } from './store.js';
import { SearchLogEntry } from './types.js';

// Input bounds for the search_context tool — a client (or a prompt-injected
// one) must not be able to drive unbounded work through it.
const MAX_QUERY_LEN = 2000; // chars; a real natural-language query is far shorter
const MAX_LIMIT = 50; // max primary matches
const MAX_TOKEN_BUDGET = 200_000; // feeds the greedy budget assembly
// Default context size when the caller doesn't specify one. Deliberately lean:
// enough for the matched symbol(s) that answer a focused question, but small
// enough that the result never balloons past just reading the file. The old
// default ("5 chunks + unlimited cross-file dependency expansion") could return
// several files' worth of code — MORE tokens than the single file that held the
// answer — which defeats the whole point. Raise token_budget to pull in more.
const DEFAULT_TOKEN_BUDGET = 1500;

/** Clamp to [lo, hi]; a non-finite input (NaN/Infinity from a hostile client)
 *  falls back to the low bound rather than passing through. Exported for tests. */
export const clamp = (n: number, lo: number, hi: number): number =>
  Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : lo;

/**
 * Append one line per search_context call to an audit log, tagged with the
 * name of the MCP client that made the call (e.g. "Cursor", "claude-code").
 * This is the durable, per-client record of who is actually pulling context
 * through the daemon and how many tokens each call saved — the shared
 * middle-box's proof-of-work, not just an in-memory session counter.
 */
function appendRequestLog(logPath: string, clientName: string, query: string, entry: SearchLogEntry): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      client: clientName,
      query,
      chunks: entry.chunkCount,
      naiveTokens: entry.naiveTokens,
      targetedTokens: entry.targetedTokens,
      savedTokens: entry.savedTokens,
    });
    fs.appendFileSync(logPath, line + '\n');
  } catch {
    // Logging must never break serving context.
  }
}

/**
 * Exposes the live index over MCP so Claude Code / Cursor / Cline can
 * ask "what's relevant to X" and get back a handful of code chunks,
 * instead of the tool reading whole files into its own context.
 *
 * `logPath`, if given, is a file each search_context call is appended to,
 * stamped with the calling client's name — a durable audit trail of usage.
 */
export function createMcpServer(store: IndexStore, logPath?: string) {
  const server = new McpServer(
    { name: 'context-daemon', version: '0.2.0' },
    {
      instructions:
        'This server serves targeted code context for the current repository. When you need to ' +
        'find or understand code in this repo, prefer calling search_context first (describe what ' +
        'you want in plain language) instead of reading whole files — it returns just the relevant ' +
        'functions/classes and their dependencies, keeping context small and token usage low. ' +
        'Read full files only when you genuinely need the entire file or when search_context ' +
        'returns nothing useful.',
    }
  );

  server.tool(
    'search_context',
    'PREFERRED way to pull code from this repository into context. Before reading whole files ' +
      'to find or understand code here, call this first: describe what you are looking for in ' +
      'plain language and it returns the specific functions/classes that matter (plus the ones ' +
      'they depend on) as compact chunks, instead of you reading entire files. This keeps ' +
      'context small and token cost low. Good for "where/how is X handled", "find the code that ' +
      'does Y", or gathering the relevant pieces before an edit. Fall back to reading a full ' +
      'file only when you need the complete file (imports, top-level wiring) or a search turns ' +
      'up nothing.',
    {
      query: z
        .string()
        .describe('Plain-language description of the code you need, e.g. "handle user login" or "where orders get cancelled"'),
      limit: z
        .number()
        .optional()
        .describe('Max number of distinct primary matches to include (within the token budget). Optional.'),
      token_budget: z
        .number()
        .optional()
        .describe(
          'Roughly how many tokens of context to return — the top match(es) plus dependencies that fit. Defaults to a focused ~1500 that stays smaller than reading the file. Raise it (e.g. 4000) to pull in more context before a big edit.'
        ),
    },
    async ({ query, limit, token_budget }: { query: string; limit?: number; token_budget?: number }) => {
      // Clamp all inputs: a client (or a prompt-injected one) shouldn't be able
      // to drive unbounded work via a giant query, a huge limit, or a
      // pathological token_budget (which feeds the greedy budget assembly).
      const q = (typeof query === 'string' ? query : '').slice(0, MAX_QUERY_LEN);
      // Always budget-capped so the context can never balloon past reading the
      // file; `limit` (when given) caps the number of primary matches within it.
      // On the DEFAULT path (no explicit token_budget) also cap to the top-match
      // file's size, so a lookup never returns more tokens than reading that
      // file; an explicit token_budget is honored as-is (the caller opted in).
      const budget = clamp(token_budget ?? DEFAULT_TOKEN_BUDGET, 1, MAX_TOKEN_BUDGET);
      const maxPrimary = clamp(Math.floor(limit ?? 25), 1, MAX_LIMIT);
      const results = await store.searchWithinBudget(q, budget, maxPrimary, token_budget == null);
      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No matching context found. If you expected code here, read the relevant file directly.',
            },
          ],
        };
      }
      // Render as a ghost-file view (imports + matched code + collapsed
      // sibling signatures) so the caller has the structure to edit safely.
      const ghost = store.buildContext(results);
      const logEntry = store.trackSearch(q, results, ghost);
      if (logPath) {
        const client = server.server.getClientVersion();
        appendRequestLog(logPath, client?.name ?? 'unknown', q, logEntry);
      }
      const text =
        ghost +
        `\n\n---\n[context-daemon] ~${logEntry.savedTokens} tokens saved this call ` +
        `(${logEntry.naiveTokens} naive -> ${logEntry.targetedTokens} targeted). ` +
        `Lines shown are real; "// name (kind, lines …): signature" entries are other symbols in the file, collapsed — request them by name if you need their bodies.`;
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'get_index_stats',
    'Get stats about the live code index (files indexed, chunk count, last updated).',
    {},
    async () => {
      return { content: [{ type: 'text' as const, text: JSON.stringify(store.stats(), null, 2) }] };
    }
  );

  server.tool(
    'get_token_savings',
    'Get cumulative estimated token savings across ALL search_context calls (persisted across daemon restarts, not just this session), vs the naive baseline of reading the whole file(s) each call would otherwise have pulled in. This is a per-call cumulative sum, not a count of unique tokens.',
    {},
    async () => {
      return { content: [{ type: 'text' as const, text: JSON.stringify(store.tokenSavings(), null, 2) }] };
    }
  );

  return server;
}

export async function startMcpServer(store: IndexStore, logPath?: string): Promise<void> {
  const server = createMcpServer(store, logPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
