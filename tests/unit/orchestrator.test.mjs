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

  const invalidEndpointConfigurations = [
    ['credentials', 'https://user:pass@orchestrator.example', 'orchestrator_url_credentials_forbidden'],
    ['path', 'https://orchestrator.example/api', 'orchestrator_url_path_forbidden'],
    ['query', 'https://orchestrator.example?tenant=scopeweave', 'orchestrator_url_query_forbidden'],
    ['fragment', 'https://orchestrator.example#tenant', 'orchestrator_url_fragment_forbidden'],
  ];
  const transportBeforeEndpointChecks = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('invalid endpoint configuration must fail before transport');
  };
  for (const [label, url, expectedCode] of invalidEndpointConfigurations) {
    process.env.ORCHESTRATOR_URL = url;
    const invalidEndpoint = await freshModule(`invalid-endpoint-${label}`);
    await assert.rejects(
      invalidEndpoint.chat([{ role: 'user', content: 'status' }]),
      (error) => error.code === expectedCode,
      `${label} endpoint configuration fails before provider transport`,
    );
  }
  globalThis.fetch = transportBeforeEndpointChecks;

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

  let rejectedBodyRead = false;
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    headers: new Headers({ 'content-type': 'text/plain' }),
    body: {
      getReader() {
        rejectedBodyRead = true;
        throw new Error('rejected provider body must not be parsed');
      },
    },
  });
  await assert.rejects(
    configured.chat([{ role: 'user', content: 'status' }]),
    (error) => error.code === 'orchestrator_provider_rejected',
  );
  assert.equal(rejectedBodyRead, false, 'non-success provider responses are classified before body parsing');

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

  let knownLengthBodyRead = false;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(1024 * 1024 + 1) }),
    body: {
      getReader() {
        knownLengthBodyRead = true;
        throw new Error('oversized declared body must not be read');
      },
    },
  });
  await assert.rejects(
    configured.chat([{ role: 'user', content: 'status' }]),
    (error) => error.code === 'orchestrator_response_size_invalid',
  );
  assert.equal(knownLengthBodyRead, false, 'oversized declared response is rejected before body allocation');

  let streamedReads = 0;
  let streamedCancelled = false;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            streamedReads += 1;
            if (streamedReads === 1) {
              return { done: false, value: new Uint8Array(1024 * 1024 + 1) };
            }
            throw new Error('reader must stop after the first oversized chunk');
          },
          async cancel() {
            streamedCancelled = true;
          },
        };
      },
    },
  });
  await assert.rejects(
    configured.chat([{ role: 'user', content: 'status' }]),
    (error) => error.code === 'orchestrator_response_size_invalid',
  );
  assert.equal(streamedReads, 1, 'stream reader stops as soon as the response exceeds the byte budget');
  assert.equal(streamedCancelled, true, 'oversized response stream is cancelled');

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
