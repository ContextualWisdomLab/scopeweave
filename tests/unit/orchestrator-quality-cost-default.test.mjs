import assert from 'node:assert/strict';
import test from 'node:test';

test('production analysis requests delegate execution to contextual-orchestrator auto', async () => {
  const originalUrl = process.env.ORCHESTRATOR_URL;
  const originalToken = process.env.ORCHESTRATOR_TOKEN;
  const originalFetch = globalThis.fetch;
  let observedUrl;
  let observedInit;

  process.env.ORCHESTRATOR_URL = 'https://orchestrator.example.test';
  process.env.ORCHESTRATOR_TOKEN = 'scopeweave_test_token';
  globalThis.fetch = async (url, init) => {
    observedUrl = url;
    observedInit = init;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'adaptive result' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const { chat, orchestratorMock } = await import(
      `../../server/orchestrator.mjs?quality-cost-test=${Date.now()}`
    );
    assert.equal(orchestratorMock, false);

    const result = await chat([
      { role: 'user', content: 'Analyze the critical path and verify the result.' },
    ]);

    assert.equal(result, 'adaptive result');
    assert.equal(
      observedUrl,
      'https://orchestrator.example.test/v1/chat/completions',
    );

    const body = JSON.parse(observedInit.body);
    assert.deepEqual(Object.keys(body).sort(), [
      'messages',
      'model',
      'orchestration_mode',
    ]);
    assert.equal(body.model, 'contextual-orchestrator');
    assert.equal(body.orchestration_mode, 'auto');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.ORCHESTRATOR_URL;
    else process.env.ORCHESTRATOR_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ORCHESTRATOR_TOKEN;
    else process.env.ORCHESTRATOR_TOKEN = originalToken;
  }
});
