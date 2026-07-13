import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { IndexStore } from '../src/store.js';
import { startHttpMcpServer } from '../src/httpServer.js';

test('HTTP Server Auth and Route Boundaries', async () => {
  const store = new IndexStore();
  const token = 'my-secret-token';
  
  // Bind to 0 to let the OS assign a random free port
  const server = await startHttpMcpServer(store, 0, token);
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  
  try {
    // 1. Missing Authorization header should get 401
    const resNoAuth = await fetch(`${url}/mcp`, { method: 'POST' });
    assert.equal(resNoAuth.status, 401);
    const bodyNoAuth = (await resNoAuth.json()) as { error: string };
    assert.match(bodyNoAuth.error, /Missing or invalid Authorization header/);

    // 2. Bad token should get 401
    const resBadToken = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(resBadToken.status, 401);

    // 3. Unrelated route should get 404
    const res404 = await fetch(`${url}/unrelated`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res404.status, 404);

    // 4. Correct POST to initialize session should return 200 and session ID
    const resInit = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0' },
        },
        id: 1,
      }),
    });
    assert.equal(resInit.status, 200);
    const sessionId = resInit.headers.get('mcp-session-id');
    assert.ok(sessionId, 'Should return mcp-session-id header');
    
    const text = await resInit.text();
    const match = /data:\s*({.*})/.exec(text);
    assert.ok(match, 'Should find data JSON block in SSE stream');
    const bodyInit = JSON.parse(match[1]);
    assert.equal(bodyInit.id, 1);
    assert.ok(bodyInit.result);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
