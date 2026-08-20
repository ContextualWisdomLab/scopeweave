import assert from 'node:assert/strict';
import { once } from 'node:events';

const originalPort = process.env.PORT;
const originalDatabase = process.env.SCOPEWEAVE_DB;
const originalJwtSecret = process.env.SCOPEWEAVE_JWT_SECRET;
const originalOrchestratorUrl = process.env.ORCHESTRATOR_URL;
const originalConsoleLog = console.log;

process.env.PORT = '0';
process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.ORCHESTRATOR_URL;

const logs = [];
console.log = (...parts) => logs.push(parts.join(' '));
let liveServer;

try {
  const entrypoint = await import('../../server/server.mjs');

  assert.equal(
    typeof entrypoint.resolvePort,
    'function',
    'the production entrypoint exposes deterministic port validation for direct regression coverage',
  );
  assert.equal(entrypoint.resolvePort('0'), 0, 'port 0 remains valid for an ephemeral test listener');
  assert.equal(entrypoint.resolvePort('65535'), 65535, 'the highest TCP port remains valid');
  assert.equal(entrypoint.resolvePort(''), 8787, 'blank configuration falls back to the default port');
  assert.equal(entrypoint.resolvePort(undefined), 8787, 'missing configuration falls back to the default port');
  assert.equal(entrypoint.resolvePort('3.5'), 8787, 'fractional ports fail closed to the default');
  assert.equal(entrypoint.resolvePort('-1'), 8787, 'negative ports fail closed to the default');
  assert.equal(entrypoint.resolvePort('65536'), 8787, 'out-of-range ports fail closed to the default');

  liveServer = entrypoint.server;
  assert.equal(
    typeof liveServer?.close,
    'function',
    'the production entrypoint exposes its listener so lifecycle tests and operators can close it cleanly',
  );
  if (!liveServer.listening) await once(liveServer, 'listening');

  const address = liveServer.address();
  assert.ok(address && typeof address === 'object', 'the production listener reports its bound address');
  assert.ok(address.port > 0, 'port 0 resolves to a real ephemeral listener port');

  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.equal(response.status, 200, 'the real entrypoint serves the health endpoint');
  assert.deepEqual(await response.json(), { ok: true }, 'the live health response keeps its public contract');
  assert.match(
    logs.join('\n'),
    new RegExp(`ScopeWeave API listening on http://localhost:${address.port}`),
    'the startup callback reports the actual bound listener port',
  );
} finally {
  if (liveServer?.listening) {
    await new Promise((resolve, reject) => {
      liveServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
  console.log = originalConsoleLog;
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
  if (originalDatabase === undefined) delete process.env.SCOPEWEAVE_DB;
  else process.env.SCOPEWEAVE_DB = originalDatabase;
  if (originalJwtSecret === undefined) delete process.env.SCOPEWEAVE_JWT_SECRET;
  else process.env.SCOPEWEAVE_JWT_SECRET = originalJwtSecret;
  if (originalOrchestratorUrl === undefined) delete process.env.ORCHESTRATOR_URL;
  else process.env.ORCHESTRATOR_URL = originalOrchestratorUrl;
}

console.log('✓ server entrypoint lifecycle and coverage regression passed');
