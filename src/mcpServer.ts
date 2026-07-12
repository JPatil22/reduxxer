import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { IndexStore } from './store.js';

/**
 * Exposes the live index over MCP so Claude Code / Cursor / Cline can
 * ask "what's relevant to X" and get back a handful of code chunks,
 * instead of the tool reading whole files into its own context.
 */
export function createMcpServer(store: IndexStore) {
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
      limit: z.number().optional().describe('Max chunks to return, default 5'),
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const results = await store.search(query, limit ?? 5);
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
      const logEntry = store.trackSearch(query, results, ghost);
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
    'Get cumulative estimated token savings from search_context calls this session, vs the naive baseline of reading whole files.',
    {},
    async () => {
      return { content: [{ type: 'text' as const, text: JSON.stringify(store.tokenSavings(), null, 2) }] };
    }
  );

  return server;
}

export async function startMcpServer(store: IndexStore): Promise<void> {
  const server = createMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
