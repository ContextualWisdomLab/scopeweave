import fs from 'fs';

let content = fs.readFileSync('tests/api/smoke.mjs', 'utf8');
content = content.replace(
  "  r = await req(`/api/orgs/\${orgAId}/webhooks`, { method: 'POST', headers: auth, body: body({ url: 'http://example.com/hook', events: ['project.update'] }) });",
  "r = await req(`/api/orgs/\${orgAId}/webhooks`, { method: 'POST', headers: auth, body: body({ url: 'https://192.168.example.com/hook', events: ['never'] }) });"
);
content = content.replace(
  `// trigger project.update → a delivery is attempted (counter increments synchronously)
const before = (await (await req('/api/metrics')).json()).webhookDeliveries;
r = await req(\`/api/projects/\${proj.id}\`, { headers: auth });
const pv2 = (await r.json()).version;
r = await req(\`/api/projects/\${proj.id}\`, { method: 'PUT', headers: auth, body: body({ tasks: [{ id: 'wh', name: '훅' }], version: pv2 }) });
assert.equal(r.status, 200);
const after = (await (await req('/api/metrics')).json()).webhookDeliveries;
assert.ok(after > before, 'webhook delivery attempted on project.update');
// outcome recorded: refused url → ok=0, retried to attempt 2
await new Promise((res) => setTimeout(res, 900));
r = await req(\`/api/orgs/\${orgAId}/webhooks/\${wh.id}/deliveries\`, { headers: auth });
assert.equal(r.status, 200, 'deliveries endpoint');
const dels = (await r.json()).deliveries;
assert.ok(dels.length >= 2, 'delivery attempts recorded');
assert.ok(dels.every((d) => d.ok === 0), 'refused url recorded as failed');
assert.ok(dels.some((d) => d.attempt === 2), 'failed delivery retried (attempt 2)');`,
  `// This subscription is deliberately unused; deterministic network/retry behavior is
// covered by webhook-ssrf.test.mjs without relying on public DNS or Internet timing.
r = await req(\`/api/orgs/\${orgAId}/webhooks/\${wh.id}/deliveries\`, { headers: auth });
assert.equal(r.status, 200, 'deliveries endpoint');
assert.deepEqual((await r.json()).deliveries, [], 'unused webhook has no deliveries');`
);
fs.writeFileSync('tests/api/smoke.mjs', content);
