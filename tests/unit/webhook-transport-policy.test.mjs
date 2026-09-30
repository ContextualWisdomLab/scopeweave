import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf8');

test('webhook transport refuses redirects before recording delivery', () => {
  const sendWebhook = appSource.match(/async function sendWebhook[\s\S]*?\n}\n\nfunction deliver/)?.[0] ?? '';
  assert.match(sendWebhook, /redirect:\s*['"]error['"]/, 'redirects must never be followed across the SSRF boundary');
});
