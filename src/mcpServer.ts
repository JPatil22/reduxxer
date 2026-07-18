import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import { z } from 'zod';
import { IndexStore } from './store.js';
import { SearchLogEntry } from './types.js';

// Input bounds for the search_context tool — a client (or a prompt-injected
// one) must not be able to drive unbounded work through it.
const MAX_QUERY_LEN = 2000; // chars; a real natural-language query is far shorter
const MAX_LIMIT = 50; // chunks
const MAX_TOKEN_BUDGET = 200_000; // feeds the greedy budget assembly

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
      limit: z.number().optional().describe('Max chunks to return, default 5. Ignored when token_budget is set.'),
      token_budget: z
        .number()
        .optional()
        .describe(
          'If set, return as much relevant context (top matches plus the functions they depend on) as fits in about this many tokens, instead of a fixed chunk count. Tune to how much of your context window you want to spend on this lookup, e.g. 3000.'
        ),
    },
    async ({ query, limit, token_budget }: { query: string; limit?: number; token_budget?: number }) => {
      // Clamp all inputs: a client (or a prompt-injected one) shouldn't be able
      // to drive unbounded work via a giant query, a huge limit, or a
      // pathological token_budget (which feeds the greedy budget assembly).
      const q = (typeof query === 'string' ? query : '').slice(0, MAX_QUERY_LEN);
      const results = token_budget
        ? await store.searchWithinBudget(q, clamp(token_budget, 1, MAX_TOKEN_BUDGET))
        : await store.search(q, clamp(Math.floor(limit ?? 5), 1, MAX_LIMIT));
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
