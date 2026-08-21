import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../../scripts/ci/workflow_registry_audit.mjs';

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    async json() { return body; },
  };
}

test('workflow registry GET retries use a fresh bounded AbortSignal for every request attempt', async () => {
  const signals = [];
  let attempts = 0;
  const recovered = await requestJson({
    url: 'https://api.github.test/probe',
    fetchImpl: async (_url, init) => {
      signals.push(init?.signal);
      attempts += 1;
      return attempts < 3 ? response(503, {}) : response(200, { ok: true });
    },
    sleepImpl: async () => {},
  });

  assert.deepEqual(recovered.data, { ok: true });
  assert.equal(signals.length, 3);
  assert.equal(new Set(signals).size, 3, 'each retry must receive a fresh timeout signal');
  for (const signal of signals) {
    assert.ok(signal instanceof AbortSignal, 'every GitHub GET must have a bounded abort signal');
    assert.equal(signal.aborted, false, 'fresh request signals must not be pre-aborted');
  }
});
