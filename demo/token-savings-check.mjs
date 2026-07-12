import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:7622/mcp'));
const client = new Client({ name: 'savings-check', version: '1.0.0' });
await client.connect(transport);

const queries = ['send an email when an order ships', 'handle user login', 'cancel an order'];
for (const query of queries) {
  const result = await client.callTool({ name: 'search_context', arguments: { query, limit: 3 } });
  console.log(`--- query: "${query}" ---`);
  console.log(result.content[0].text.split('\n').slice(-2).join('\n'));
}

const savings = await client.callTool({ name: 'get_token_savings', arguments: {} });
console.log('\n=== cumulative token savings ===');
console.log(savings.content[0].text);

await client.close();
