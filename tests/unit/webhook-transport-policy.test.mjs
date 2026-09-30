import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf8');

test('webhook transport refuses redirects before recording delivery', () => {
  const sendWebhook = appSource.match(/async function sendWebhook[\s\S]*?\n}\n\nfunction deliver/)?.[0] ?? '';
  assert.doesNotMatch(sendWebhook, /\bfetch\s*\(/, 'fetch would follow an independently resolved destination');
  assert.match(sendWebhook, /postWebhook\(/, 'the pinned Node transport does not follow redirects');
});

test('webhook transport pins the validated address for the connection', () => {
  const sendWebhook = appSource.match(/async function sendWebhook[\s\S]*?\n}\n\nfunction deliver/)?.[0] ?? '';
  assert.match(appSource, /import\s+\{\s*postWebhook\s*\}\s+from\s+['"]\.\/webhook_transport\.mjs['"]/, 'the owner transport must be explicit');
  assert.match(sendWebhook, /postWebhook\(\s*parsed,\s*destination\.address,\s*destination\.family,/, 'the request must receive the validated address');
  assert.doesNotMatch(sendWebhook, /\bfetch\s*\(/, 'fetch would resolve the hostname again after validation');
});

test('webhook transport connects only to the supplied validated address', async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { postWebhook } = await import('../../server/webhook_transport.mjs');
  const { port } = server.address();
  const result = await postWebhook(
    new URL(`http://does-not-resolve.invalid:${port}/hook`),
    '127.0.0.1',
    4,
    { headers: { 'content-type': 'application/json' }, body: '{}' },
  );

  assert.equal(result.status, 204);
  assert.equal(result.ok, true);
});
