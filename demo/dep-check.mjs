import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.argv[2];
const port = process.argv[3];
const query = process.argv[4] ?? 'safely parse and return validation errors';
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'dep-check', version: '1.0.0' });
await client.connect(transport);
const result = await client.callTool({ name: 'search_context', arguments: { query, limit: 1 } });
console.log(result.content[0].text);
await client.close();
