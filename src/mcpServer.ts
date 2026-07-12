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
  const server = new McpServer({ name: 'context-daemon', version: '0.2.0' });

  server.tool(
    'search_context',
    'Search the live codebase index for the most relevant functions/classes for a task. Returns compact code chunks, not whole files.',
    {
      query: z.string().describe('What you are trying to do or find, e.g. "handle user login"'),
      limit: z.number().optional().describe('Max chunks to return, default 5'),
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const results = await store.search(query, limit ?? 5);
      const logEntry = store.trackSearch(query, results);
      const topReferences = new Set(results[0]?.references ?? []);
      const text =
        results.length === 0
          ? 'No matching context found.'
          : results
              .map((r) => {
                const label = topReferences.has(r.id) ? `${r.kind}, referenced by ${results[0].symbolName}` : r.kind;
                return `// ${r.filePath} :: ${r.symbolName} (${label}, lines ${r.startLine}-${r.endLine})\n${r.code}`;
              })
              .join('\n\n---\n\n') +
            `\n\n---\n[context-daemon] ~${logEntry.savedTokens} tokens saved this call ` +
            `(${logEntry.naiveTokens} naive -> ${logEntry.targetedTokens} targeted)`;
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
