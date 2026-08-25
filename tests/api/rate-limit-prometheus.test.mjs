import assert from 'node:assert/strict';

const validJwtSecret = '0123456789abcdef0123456789abcdef';
process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = validJwtSecret;
process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '3';
process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '60000';
process.env.SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX = '20';
process.env.SCOPEWEAVE_TRUSTED_PROXY_IPS = '127.0.0.1';

const { app } = await import('../../server/app.mjs');
const nodeEnv = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const requestFrom = (client, path = '/api/health') => app.request(
  path,
  { headers: { 'x-forwarded-for': client } },
  nodeEnv,
);

function metricValue(body, name) {
  const match = new RegExp(`^${name}\\s+(-?\\d+(?:\\.\\d+)?)$`, 'm').exec(body);
  assert.ok(match, `${name} is present as an unlabeled Prometheus metric`);
  return Number(match[1]);
}

const beforeBody = await (await requestFrom(
  '198.51.100.240',
  '/api/metrics?format=prometheus',
)).text();
const beforeRequests = metricValue(beforeBody, 'scopeweave_requests');
const beforeS4xx = metricValue(beforeBody, 'scopeweave_s4xx');

for (let i = 0; i < 3; i += 1) {
  assert.equal(
    (await requestFrom('203.0.113.240')).status,
    200,
    'requests below the configured envelope limit remain allowed',
  );
}
assert.equal(
  (await requestFrom('203.0.113.240')).status,
  429,
  'the fourth request is blocked by the envelope limiter',
);

const afterBody = await (await requestFrom(
  '198.51.100.241',
  '/api/metrics?format=prometheus',
)).text();
const afterRequests = metricValue(afterBody, 'scopeweave_requests');
const afterS4xx = metricValue(afterBody, 'scopeweave_s4xx');

assert.equal(
  afterRequests - beforeRequests,
  5,
  'Prometheus request totals include the prior metrics read, three allowed requests, and the blocked 429',
);
assert.equal(
  afterS4xx - beforeS4xx,
  1,
  'Prometheus 4xx totals include the blocked 429 exactly once',
);

console.log('✓ rate-limit Prometheus observability regression passed');
