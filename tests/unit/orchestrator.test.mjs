import assert from 'node:assert/strict';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function restoreEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  globalThis.fetch = ORIGINAL_FETCH;
}

async function freshModule(label) {
  return import(`../../server/orchestrator.mjs?test=${label}-${Date.now()}-${Math.random()}`);
}

try {
  delete process.env.ORCHESTRATOR_URL;
  delete process.env.ORCHESTRATOR_TOKEN;
  delete process.env.ORCHESTRATOR_MODEL;
  delete process.env.SCOPEWEAVE_DEV;
  const unconfigured = await freshModule('unconfigured');
  assert.equal(unconfigured.orchestratorMock, false);
  await assert.rejects(
    unconfigured.chat([{ role: 'user', content: 'status' }]),
    (error) => error.code === 'orchestrator_not_configured',
  );

  process.env.SCOPEWEAVE_DEV = '1';
  const development = await freshModule('development');
  assert.equal(development.orchestratorMock, true);
  const developmentResult = await development.chat([
    { role: 'system', content: 'Summarize the plan.' },
    { role: 'user', content: 'Find the critical path.' },
  ]);
  assert.match(developmentResult, /^\[dev-orchestrator\]/);
  assert.match(developmentResult, /Find the critical path/);

  delete process.env.SCOPEWEAVE_DEV;
  process.env.ORCHESTRATOR_URL = 'https://orchestrator.example';
  delete process.env.ORCHESTRATOR_TOKEN;
  const missingToken = await freshModule('missing-token');
  await assert.rejects(
    missingToken.chat([{ role: 'user', content: 'status' }]),
    (error) => error.code === 'orchestrator_token_missing',
  );

  process.env.ORCHESTRATOR_URL = 'http://orchestrator.example';
  process.env.ORCHESTRATOR_TOKEN = 'secret-token';
  const insecure = await freshModule('insecure');
  await assert.rejects(
    insecure.chat([{ role: 'user', content: 'status' }]),
    (error) => error.code === 'orchestrator_transport_insecure',
  );

  process.env.ORCHESTRATOR_URL = 'https://orchestrator.example';
  process.env.ORCHESTRATOR_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
  const configured = await freshModule('configured');
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Grounded production response' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  assert.equal(
    await configured.chat([{ role: 'user', content: 'status' }]),
    'Grounded production response',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://orchestrator.example/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-token');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'nvidia/nemotron-3-super-120b-a12b',
    messages: [{ role: 'user', content: 'status' }],
  });

  for (const invalidMessages of [
    [],
    [null],
    [{ role: 'tool', content: 'status' }],
    [{ role: 'user', content: '' }],
    [{ role: 'user', content: 'x'.repeat(100_001) }],
  ]) {
    await assert.rejects(
      configured.chat(invalidMessages),
      (error) => error.code.startsWith('orchestrator_message'),
    );
  }

  globalThis.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(
    configured.chat([{ role: 'user', content: 'status' }]),
    (error) => error.code === 'orchestrator_provider_unavailable',
  );

  globalThis.fetch = async () => new Response('not-json', { status: 502 });
  await assert.rejects(
    configured.chat([{ role: 'user', content: 'status' }]),
    (error) => error.code === 'orchestrator_response_invalid',
  );

  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'x'.repeat(1024 * 1024) } }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(
    configured.chat([{ role: 'user', content: 'status' }]),
    (error) => error.code === 'orchestrator_response_size_invalid',
  );

  globalThis.fetch = async () => new Response(JSON.stringify({ error: {} }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(
    configured.chat([{ role: 'user', content: 'status' }]),
    (error) => error.code === 'orchestrator_provider_rejected',
  );

  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(
    configured.chat([{ role: 'user', content: 'status' }]),
    (error) => error.code === 'orchestrator_response_invalid',
  );

  globalThis.fetch = undefined;
  await assert.rejects(
    configured.chat([{ role: 'user', content: 'status' }]),
    (error) => error.code === 'orchestrator_transport_unavailable',
  );
} finally {
  restoreEnvironment();
}

console.log('✓ orchestrator production boundary tests passed');
