import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { IndexStore } from './store.js';
import { createMcpServer } from './mcpServer.js';

/**
 * Runs the MCP server over Streamable HTTP instead of stdio, so ONE daemon
 * process backed by ONE IndexStore can serve MULTIPLE clients (e.g. Claude
 * Code and Cursor pointed at the same repo) at the same time, each in its
 * own MCP session, instead of each client spawning its own stdio process
 * and duplicating the index.
 *
 * Each HTTP session gets its own lightweight McpServer + transport pair
 * (the MCP SDK ties one server to one transport), but every session reads
 * and writes through the same shared `store`, so indexing work and results
 * are shared, not duplicated.
 */
export async function startHttpMcpServer(store: IndexStore, port: number, token: string, logPath?: string): Promise<http.Server> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }

    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'Missing or invalid Authorization header' })
      );
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
      let existing = sessionId ? sessions.get(sessionId) : undefined;

      if (!existing) {
        // New session: pair a fresh McpServer with a fresh transport, both
        // wired to the one shared store.
        const mcpServer = createMcpServer(store, logPath);
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            sessions.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await mcpServer.connect(transport);
        existing = transport;
      }

      await (existing as StreamableHTTPServerTransport).handleRequest(req, res);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sessionId ? sessions.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(400).end('Unknown or missing session');
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405).end('Method not allowed');
  });

  // Bind to loopback only — this is meant for local tools on this machine,
  // not to be reachable from the network.
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
  console.error(
    `context-daemon MCP server listening on http://127.0.0.1:${port}/mcp\n` +
      `Point multiple MCP clients at this same URL (with header "Authorization: Bearer ${token}") to share one index.`
  );
  return httpServer;
}
