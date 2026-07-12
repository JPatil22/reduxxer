import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:7624/mcp'));
const client = new Client({ name: 'real-repo-check', version: '1.0.0' });
await client.connect(transport);

const stats = await client.callTool({ name: 'get_index_stats', arguments: {} });
console.log('=== index stats (zod) ===');
console.log(stats.content[0].text);

const queries = ['parse a string schema', 'validate an object schema', 'safe parse and return errors'];
for (const query of queries) {
  const result = await client.callTool({ name: 'search_context', arguments: { query, limit: 5 } });
  const text = result.content[0].text;
  const symbolLines = text
    .split('\n')
    .filter((l) => l.startsWith('// '))
    .slice(0, 5);
  console.log(`\n--- query: "${query}" ---`);
  console.log(symbolLines.join('\n'));
  console.log(text.split('\n').slice(-1)[0]);
}

const savings = await client.callTool({ name: 'get_token_savings', arguments: {} });
console.log('\n=== cumulative token savings ===');
console.log(savings.content[0].text);

await client.close();
