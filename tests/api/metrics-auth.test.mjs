import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';
const METRICS_TOKEN = 'scopeweave-metrics-test-token-0123456789abcdef';

function runApp(metricsToken, script) {
  const env = {
    ...process.env,
    SCOPEWEAVE_DB: ':memory:',
    SCOPEWEAVE_JWT_SECRET: JWT_SECRET,
  };
  if (metricsToken === undefined) delete env.SCOPEWEAVE_METRICS_TOKEN;
  else env.SCOPEWEAVE_METRICS_TOKEN = metricsToken;

  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { cwd: process.cwd(), env, encoding: 'utf8' },
  );
}

const disabled = runApp(undefined, `
  import assert from 'node:assert';
  const { app } = await import('./server/app.mjs');
  const response = await app.request('/api/metrics');
  assert.equal(response.status, 404, 'metrics are disabled unless an operator token is configured');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text();
  assert.doesNotMatch(text, /requests|signups|projectsCreated|webhookDeliveries/i);
`);
assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);

for (const invalidToken of [
  '',
  'short-metrics-token',
  'x'.repeat(31),
  ' '.repeat(32),
  `${'x'.repeat(31)} `,
  '${SCOPEWEAVE_METRICS_TOKEN:-}',
  `\${SCOPEWEAVE_METRICS_TOKEN:-${'x'.repeat(32)}}`,
]) {
  const result = runApp(invalidToken, "await import('./server/app.mjs')");
  assert.notEqual(result.status, 0, 'configured weak or placeholder metrics tokens must fail startup');
  assert.match(result.stderr, /SCOPEWEAVE_METRICS_TOKEN must be at least 32 non-whitespace characters/);
}

const protectedMetrics = runApp(METRICS_TOKEN, `
  import assert from 'node:assert';
  const { app } = await import('./server/app.mjs');
  const token = ${JSON.stringify(METRICS_TOKEN)};

  for (const authorization of [
    undefined,
    'Basic ' + Buffer.from('operator:wrong').toString('base64'),
    'Bearer wrong-metrics-token-0123456789abcdef',
    'bearer ' + token,
    'Bearer ' + token + ' ',
  ]) {
    const headers = authorization ? { authorization } : undefined;
    const response = await app.request('/api/metrics', { headers });
    assert.equal(response.status, 401, 'missing, malformed, or wrong metrics authorization must fail closed');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('www-authenticate') || '', /^Bearer /);
    const body = await response.text();
    assert.ok(!body.includes(token), 'metrics token must never be reflected');
    assert.doesNotMatch(body, /requests|signups|projectsCreated|webhookDeliveries/i);
  }

  let response = await app.request('/api/metrics', {
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const json = await response.json();
  assert.equal(typeof json.requests, 'number');
  assert.equal(typeof json.uptimeSec, 'number');
  assert.ok(!JSON.stringify(json).includes(token), 'JSON metrics must not expose the operator token');

  response = await app.request('/api/metrics?format=prometheus', {
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type') || '', /^text\/plain/);
  const prometheus = await response.text();
  assert.match(prometheus, /scopeweave_requests /);
  assert.ok(!prometheus.includes(token), 'Prometheus metrics must not expose the operator token');

  response = await app.request('/api/health');
  assert.equal(response.status, 200, 'health remains public for load balancers and orchestrators');
`);
assert.equal(protectedMetrics.status, 0, protectedMetrics.stderr || protectedMetrics.stdout);

console.log('✓ operational metrics authorization tests passed');
