import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf8');

test('webhook transport refuses redirects before recording delivery', () => {
  const sendWebhook = appSource.match(/async function sendWebhook[\s\S]*?\n}\n\nfunction deliver/)?.[0] ?? '';
  assert.match(sendWebhook, /redirect:\s*['"]error['"]/, 'redirects must never be followed across the SSRF boundary');
});

test('webhook transport pins the validated address for the connection', () => {
  const sendWebhook = appSource.match(/async function sendWebhook[\s\S]*?\n}\n\nfunction deliver/)?.[0] ?? '';
  assert.match(appSource, /import\s+\{\s*postWebhook\s*\}\s+from\s+['"]\.\/webhook_transport\.mjs['"]/, 'the owner transport must be explicit');
  assert.match(sendWebhook, /postWebhook\(\s*parsed,\s*destination\.address,\s*destination\.family,/, 'the request must receive the validated address');
  assert.doesNotMatch(sendWebhook, /\bfetch\s*\(/, 'fetch would resolve the hostname again after validation');
});
