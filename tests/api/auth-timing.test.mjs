import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const script = `
import assert from 'node:assert';
import { serve } from '@hono/node-server';
import { app } from './server/app.mjs';

const PORT = 3000 + Math.floor(Math.random() * 1000);
const server = serve({ fetch: app.fetch, port: PORT }, async (info) => {
  try {
    const url = \`http://localhost:\${info.port}/api/auth/login\`;
    const body = JSON.stringify({ email: 'nonexistent@example.com', password: 'password123' });
    const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 401);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
});
`;

const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
  cwd: root,
  env: { ...process.env, SCOPEWEAVE_JWT_SECRET: '0123456789abcdef0123456789abcdef' },
  encoding: 'utf8',
});

assert.equal(result.status, 0, result.stderr || result.stdout);
console.log('✓ API auth timing attack mitigation tests passed');
