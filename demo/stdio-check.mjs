// Verifies the EXACT command Claude Code will run from .mcp.json works over
// stdio (the transport Claude Code uses), by spawning it with the real MCP
// SDK stdio client and calling search_context — the same handshake Claude
// Code performs. If this passes, the .mcp.json config is correct.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = 'E:/POC out of scope/tokekreduxxing/context-daemon';
const transport = new StdioClientTransport({
  command: 'node',
  args: [`${repo}/dist/src/cli.js`, 'mcp', repo],
});

const client = new Client({ name: 'stdio-check', version: '1.0.0' });
await client.connect(transport);

console.log('Connected. Tools available:');
const tools = await client.listTools();
console.log(tools.tools.map((t) => '  - ' + t.name).join('\n'));

const result = await client.callTool({
  name: 'search_context',
  arguments: { query: 'expand a search result with its dependencies', limit: 2 },
});
console.log('\nsearch_context result:\n');
console.log(result.content[0].text.split('\n').slice(0, 12).join('\n'));

await client.close();
console.log('\nOK — the .mcp.json command works with a real MCP stdio client.');
