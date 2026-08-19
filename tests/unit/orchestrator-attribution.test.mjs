import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DEV = '';
process.env.ORCHESTRATOR_URL = 'https://orchestrator.example';
process.env.ORCHESTRATOR_TOKEN = 'secret-token';
process.env.ORCHESTRATOR_MODEL = 'nvidia/nemotron-3-super-120b-a12b';

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

const { chat } = await import(
  `../../server/orchestrator.mjs?attribution-test=${Date.now()}-${Math.random()}`
);

const messages = [{ role: 'user', content: 'status' }];

assert.equal(
  await chat(messages, {
    service: 'scopeweave',
    account: 42,
    upstream_api: 'requested-upstream-label',
    provider: 'requested-provider-label',
    model_name: 'requested-model-label',
    team: null,
    group: '',
    company: '   ',
    unsupported_dimension: 'must-not-cross-boundary',
  }),
  'Grounded production response',
);

assert.equal(calls.length, 1);
const attributedBody = JSON.parse(calls[0].init.body);
assert.equal(attributedBody.model, 'nvidia/nemotron-3-super-120b-a12b');
assert.equal(attributedBody.orchestration_mode, 'auto');
assert.equal(Object.hasOwn(attributedBody, 'provider'), false);
assert.deepEqual(attributedBody.attribution, {
  service: 'scopeweave',
  account: '42',
  upstream_api: 'requested-upstream-label',
  provider: 'requested-provider-label',
  model_name: 'requested-model-label',
});
assert.equal(
  Object.hasOwn(attributedBody.attribution, 'unsupported_dimension'),
  false,
  'unknown attribution keys never cross the ScopeWeave boundary',
);

await chat(messages, { unsupported_dimension: 'x', account: '   ' });
const emptyBody = JSON.parse(calls[1].init.body);
assert.equal(emptyBody.orchestration_mode, 'auto');
assert.equal(
  Object.hasOwn(emptyBody, 'attribution'),
  false,
  'an attribution field is omitted when no non-empty allowed dimensions remain',
);

await chat(messages);
const legacyBody = JSON.parse(calls[2].init.body);
assert.deepEqual(
  legacyBody,
  {
    model: 'nvidia/nemotron-3-super-120b-a12b',
    orchestration_mode: 'auto',
    messages,
  },
  'omitting attribution preserves the hardened adaptive request shape exactly',
);

for (const invalidAttribution of [
  [],
  'scopeweave',
  { service: 'x'.repeat(257) },
  { service: ['scopeweave'] },
  { account: { organization_id: 42 } },
  { team: Symbol('scopeweave') },
  { group: Number.NaN },
  { company: Number.POSITIVE_INFINITY },
]) {
  await assert.rejects(
    chat(messages, invalidAttribution),
    (error) => error.code === 'orchestrator_attribution_invalid',
    'malformed, non-scalar, non-finite, or unbounded attribution fails before provider transport',
  );
}
assert.equal(calls.length, 3, 'invalid attribution never reaches the provider');

const originalJsonStringify = JSON.stringify;
let serializedAttributionPrototype;
JSON.stringify = (value, ...args) => {
  if (value?.attribution) {
    serializedAttributionPrototype = Object.getPrototypeOf(value.attribution);
  }
  return originalJsonStringify(value, ...args);
};
try {
  await chat(messages, { service: 'scopeweave' });
} finally {
  JSON.stringify = originalJsonStringify;
}
assert.equal(
  serializedAttributionPrototype,
  null,
  'validated attribution is held in a prototype-free map before provider serialization',
);
assert.equal(calls.length, 4, 'prototype-free attribution still reaches the provider once');

console.log('✓ orchestrator attribution boundary tests passed');