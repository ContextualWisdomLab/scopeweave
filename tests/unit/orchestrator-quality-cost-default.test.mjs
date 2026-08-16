import assert from 'node:assert/strict';
import test from 'node:test';

let importSequence = 0;

async function importClient({ url, token } = {}) {
  const originalUrl = process.env.ORCHESTRATOR_URL;
  const originalToken = process.env.ORCHESTRATOR_TOKEN;

  if (url === undefined) delete process.env.ORCHESTRATOR_URL;
  else process.env.ORCHESTRATOR_URL = url;
  if (token === undefined) delete process.env.ORCHESTRATOR_TOKEN;
  else process.env.ORCHESTRATOR_TOKEN = token;

  try {
    importSequence += 1;
    return await import(
      `../../server/orchestrator.mjs?quality-cost-test=${importSequence}`
    );
  } finally {
    if (originalUrl === undefined) delete process.env.ORCHESTRATOR_URL;
    else process.env.ORCHESTRATOR_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ORCHESTRATOR_TOKEN;
    else process.env.ORCHESTRATOR_TOKEN = originalToken;
  }
}

async function withFetch(fetchImpl, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('unconfigured deployments keep the deterministic non-LLM fallback', async () => {
  const { chat, orchestratorMock } = await importClient();
  assert.equal(orchestratorMock, true);

  const result = await chat([
    { role: 'system', content: 'planner' },
    { role: 'user', content: 'Inspect the critical path.' },
  ]);

  assert.match(result, /^\[mock-orchestrator\] 분석 요약:/);
  assert.match(result, /Inspect the critical path\./);
});

test('production analysis requests delegate execution to contextual-orchestrator auto', async () => {
  const { chat, orchestratorMock } = await importClient({
    url: 'https://orchestrator.example.test/',
    token: 'scopeweave_test_token',
  });
  assert.equal(orchestratorMock, false);

  let observedUrl;
  let observedInit;
  const result = await withFetch(async (url, init) => {
    observedUrl = url;
    observedInit = init;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'adaptive result' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }, () => chat([
    { role: 'user', content: 'Analyze the critical path and verify the result.' },
  ]));

  assert.equal(result, 'adaptive result');
  assert.equal(
    observedUrl,
    'https://orchestrator.example.test/v1/chat/completions',
  );
  assert.equal(observedInit.method, 'POST');
  assert.equal(observedInit.headers.authorization, 'Bearer scopeweave_test_token');
  assert.equal(observedInit.headers['content-type'], 'application/json');
  assert.ok(observedInit.signal instanceof AbortSignal);

  const body = JSON.parse(observedInit.body);
  assert.equal(body.model, 'contextual-orchestrator');
  assert.equal(body.orchestration_mode, 'auto');
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'Analyze the critical path and verify the result.' },
  ]);
});

test('production requests do not invent an authorization header when no token is configured', async () => {
  const { chat } = await importClient({ url: 'https://orchestrator.example.test' });
  let observedInit;

  const result = await withFetch(async (_url, init) => {
    observedInit = init;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'public result' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }, () => chat([{ role: 'user', content: 'Analyze.' }]));

  assert.equal(result, 'public result');
  assert.equal('authorization' in observedInit.headers, false);
});

test('provider errors retain their bounded contextual-orchestrator message', async () => {
  const { chat } = await importClient({ url: 'https://orchestrator.example.test' });

  await assert.rejects(
    withFetch(
      async () => new Response(
        JSON.stringify({ error: { message: 'capacity unavailable' } }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
      () => chat([{ role: 'user', content: 'Analyze.' }]),
    ),
    /capacity unavailable/,
  );
});

test('missing or malformed response content fails with the stable status fallback', async () => {
  const { chat } = await importClient({ url: 'https://orchestrator.example.test' });

  await assert.rejects(
    withFetch(
      async () => new Response('{not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      () => chat([{ role: 'user', content: 'Analyze.' }]),
    ),
    /orchestrator failed \(200\)/,
  );

  await assert.rejects(
    withFetch(
      async () => new Response(JSON.stringify({ choices: [{}] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      () => chat([{ role: 'user', content: 'Analyze.' }]),
    ),
    /orchestrator failed \(200\)/,
  );
});

test('the request timeout abort callback is wired into the production request', async () => {
  const { chat } = await importClient({ url: 'https://orchestrator.example.test' });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let clearedToken;
  let observedSignal;

  globalThis.setTimeout = (callback, milliseconds) => {
    assert.equal(milliseconds, 60000);
    callback();
    return 9191;
  };
  globalThis.clearTimeout = (token) => {
    clearedToken = token;
  };

  try {
    const result = await withFetch(async (_url, init) => {
      observedSignal = init.signal;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'after abort' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }, () => chat([{ role: 'user', content: 'Analyze.' }]));

    assert.equal(result, 'after abort');
    assert.equal(observedSignal.aborted, true);
    assert.equal(clearedToken, 9191);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
