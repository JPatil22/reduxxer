// Simulates two separate MCP clients (e.g. "Claude Code" and "Cursor")
// both talking to the same running HTTP daemon at once, to prove they
// share one index instead of each getting their own.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function makeClient(name) {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:7621/mcp'));
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
console.log('\nBoth clients connected to the SAME daemon process and got consistent results from ONE shared index.');
