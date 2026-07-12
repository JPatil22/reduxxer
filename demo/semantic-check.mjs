import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:7625/mcp'));
const client = new Client({ name: 'semantic-check', version: '1.0.0' });
await client.connect(transport);

// Paraphrased query with no literal keyword overlap with expected symbols
// like "safeParse" / "ZodError" / "issues" — testing whether the embedding
// model, not just keyword matching, can find the right code.
const queries = [
  'let me know what went wrong instead of throwing',
  'turn this shape into a nullable version of itself',
];

for (const query of queries) {
  const result = await client.callTool({ name: 'search_context', arguments: { query, limit: 5 } });
  const text = result.content[0].text;
  const symbolLines = text.split('\n').filter((l) => l.startsWith('// ')).slice(0, 5);
  console.log(`--- query: "${query}" ---`);
  console.log(symbolLines.join('\n'));
  console.log();
}

await client.close();
