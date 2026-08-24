import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.SCOPEWEAVE_DEV;
process.env.ORCHESTRATOR_URL = 'https://orchestrator.example';
process.env.ORCHESTRATOR_TOKEN = 'secret-token';
process.env.ORCHESTRATOR_MODEL = 'nvidia/nemotron-3-super-120b-a12b';

const providerCalls = [];
globalThis.fetch = async (url, init) => {
  providerCalls.push({ url: String(url), init });
  return new Response(JSON.stringify({
    choices: [{ message: { content: 'Grounded production response' } }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const { app } = await import(`../../server/app.mjs?attribution-api-test=${Date.now()}`);

const jsonRequest = (path, options = {}) => app.request(path, {
  ...options,
  headers: {
    'content-type': 'application/json',
    ...(options.headers || {}),
  },
});
const jsonBody = (value) => JSON.stringify(value);

async function createAccount(email) {
  let response = await jsonRequest('/api/auth/signup', {
    method: 'POST',
    body: jsonBody({ email, password: 'password123', name: email }),
  });
  assert.equal(response.status, 200, `${email} signup`);
  const token = (await response.json()).token;
  const auth = { authorization: `Bearer ${token}` };
  response = await jsonRequest('/api/me', { headers: auth });
  assert.equal(response.status, 200, `${email} account lookup`);
  const account = await response.json();
  return { auth, orgId: account.orgs[0].id };
}

const owner = await createAccount('orchestrator-owner@scopeweave.test');
const outsider = await createAccount('orchestrator-outsider@scopeweave.test');

let response = await jsonRequest('/api/projects', {
  method: 'POST',
  headers: owner.auth,
  body: jsonBody({ name: 'Attribution Project' }),
});
assert.equal(response.status, 200, 'owner creates attribution project');
const projectId = (await response.json()).id;

response = await jsonRequest(`/api/projects/${projectId}/ai/brief`, {
  method: 'POST',
  headers: owner.auth,
  body: jsonBody({ account: String(outsider.orgId), service: 'spoofed-client-service' }),
});
assert.equal(response.status, 200, 'authorized owner receives AI briefing');
assert.equal(providerCalls.length, 1, 'authorized briefing performs one provider call');
assert.equal(providerCalls[0].url, 'https://orchestrator.example/v1/chat/completions');
const providerBody = JSON.parse(providerCalls[0].init.body);
assert.deepEqual(
  providerBody.attribution,
  { service: 'scopeweave', account: String(owner.orgId) },
  'the authenticated server-side project organization owns cost attribution',
);
assert.notEqual(
  providerBody.attribution.account,
  String(outsider.orgId),
  'browser-supplied account data cannot spoof another tenant attribution',
);

response = await jsonRequest(`/api/projects/${projectId}/ai/brief`, {
  method: 'POST',
  headers: outsider.auth,
  body: jsonBody({ account: String(owner.orgId) }),
});
assert.equal(response.status, 404, 'cross-tenant AI briefing hides project existence');
assert.equal(
  providerCalls.length,
  1,
  'cross-tenant requests are rejected before any contextual-orchestrator call',
);

globalThis.fetch = async (url, init) => {
  providerCalls.push({ url: String(url), init });
  return new Response(JSON.stringify({
    error: 'private upstream diagnostic: nim-route-abc secret-token',
  }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
};

response = await jsonRequest(`/api/projects/${projectId}/ai/brief`, {
  method: 'POST',
  headers: owner.auth,
  body: jsonBody({}),
});
assert.equal(response.status, 502, 'provider failure is translated at the ScopeWeave boundary');
assert.equal(response.headers.get('cache-control'), 'no-store', 'AI failure responses are not cacheable');
const failure = await response.json();
assert.deepEqual(failure, {
  error: 'AI 분석을 지금 완료할 수 없습니다.',
  code: 'ai_brief_unavailable',
  action: '잠시 후 다시 시도하세요. 계속 실패하면 워크스페이스 관리자에게 문의하세요.',
  retryable: true,
});
const serializedFailure = JSON.stringify(failure);
for (const internalDetail of ['contextual-orchestrator', 'ORCHESTRATOR_', 'secret-token', 'nim-route-abc', 'HTTP 503']) {
  assert.equal(
    serializedFailure.includes(internalDetail),
    false,
    `customer AI failure envelope excludes internal detail: ${internalDetail}`,
  );
}

console.log('✓ AI briefing attribution and customer error-boundary tests passed');
