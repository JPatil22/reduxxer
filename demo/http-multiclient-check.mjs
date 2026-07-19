// Manual check: two separate MCP clients (e.g. "Claude Code" and "Cursor")
// both talking to ONE running HTTP daemon at once, proving they share a single
// index instead of each spawning their own. This is the shared-daemon wedge.
//
// First start a daemon:
//   node dist/src/cli.js mcp /path/to/repo --http --port=7621
// then run:  node demo/http-multiclient-check.mjs /path/to/repo
// (an automated version of this lives in test/multiclient.test.ts)
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repo = path.resolve(process.argv[2] ?? process.cwd());
const port = process.env.PORT ?? 7621;
// The daemon prints and saves its per-repo bearer token; read it so the clients
// authenticate (the server rejects unauthenticated requests with 401).
const token =
  process.env.TOKEN ?? fs.readFileSync(path.join(repo, '.context-daemon', 'http-token'), 'utf-8').trim();

async function makeClient(name) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

const [clientA, clientB] = await Promise.all([makeClient('claude-code-sim'), makeClient('cursor-sim')]);

const [statsA, statsB] = await Promise.all([
  clientA.callTool({ name: 'get_index_stats', arguments: {} }),
  clientB.callTool({ name: 'get_index_stats', arguments: {} }),
]);
console.log('Client A (claude-code-sim) stats:', statsA.content[0].text);
console.log('Client B (cursor-sim) stats:', statsB.content[0].text);

const searchB = await clientB.callTool({
  name: 'search_context',
  arguments: { query: 'send an email when an order ships', limit: 2 },
});
console.log('\nClient B search_context result:\n', searchB.content[0].text.slice(0, 200), '...');

await clientA.close();
await clientB.close();
console.log('\nBoth clients connected to the SAME daemon process and got results from ONE shared index.');
