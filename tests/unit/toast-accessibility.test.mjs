import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const toastStateCss = readFileSync(new URL('../../toast-state.css', import.meta.url), 'utf8');
const cloudSyncJs = readFileSync(new URL('../../cloud-sync.js', import.meta.url), 'utf8');

function toastElementMarkup(html) {
  const match = html.match(/<div\s+[^>]*\bid=["']toast["'][^>]*>/i);
  assert.ok(match, 'production index.html contains the toast container');
  return match[0];
}

function syncStatusElementMarkup(html) {
  const match = html.match(/<span\s+[^>]*\bid=["']sync-status["'][^>]*>/i);
  assert.ok(match, 'production index.html contains the sync status container');
  return match[0];
}

test('toast container exposes advisory status updates without taking focus', () => {
  const toast = toastElementMarkup(indexHtml);
  assert.match(toast, /\brole=["']status["']/i, 'toast uses the WAI-ARIA status role');
  assert.match(toast, /\baria-live=["']polite["']/i, 'toast explicitly uses polite announcements');
  assert.match(toast, /\baria-atomic=["']true["']/i, 'toast announces its complete updated content');
  assert.doesNotMatch(toast, /\btabindex\s*=/i, 'status updates do not move keyboard focus');
});

test('sync status uses the same explicit advisory status semantics', () => {
  const syncStatus = syncStatusElementMarkup(indexHtml);
  assert.match(syncStatus, /\brole=["']status["']/i, 'sync feedback uses the WAI-ARIA status role');
  assert.match(syncStatus, /\baria-live=["']polite["']/i, 'sync feedback explicitly uses polite announcements');
  assert.match(syncStatus, /\baria-atomic=["']true["']/i, 'sync feedback announces its complete updated content');
  assert.doesNotMatch(syncStatus, /\btabindex\s*=/i, 'sync feedback does not become a synthetic keyboard stop');
});

test('cloud toast stylesheet is on every production serve path', () => {
  const pagesWorkflow = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const staticDockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  const serverDockerfile = readFileSync(new URL('../../Dockerfile.server', import.meta.url), 'utf8');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    process.env.SCOPEWEAVE_DB = ':memory:';
    delete process.env.SCOPEWEAVE_DEV;
    process.env.SCOPEWEAVE_PUBLIC_ORIGIN = 'https://scopeweave.example';
    process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.STRIPE_SECRET_KEY = 'sk_test_scopeweave_toast';
    process.env.STRIPE_PRICE_ID = 'price_scopeweave_toast';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_scopeweave_toast_secret';
    const { app } = await import('./server/app.mjs?toast-route-contract=1');
    const toastRoutes = app.routes.filter(
      ({ method, path }) => method === 'GET' && path === '/toast-state.css',
    );
    process.stdout.write(JSON.stringify({ toastRouteCount: toastRoutes.length }));
  `], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);
  const resultLine = child.stdout.trim().split('\n').at(-1);
  assert.deepEqual(
    JSON.parse(resultLine),
    { toastRouteCount: 1 },
    'SaaS route graph exposes the shipped toast stylesheet exactly once',
  );
  assert.match(pagesWorkflow, /\btoast-state\.css\b/, 'GitHub Pages stages the cloud toast stylesheet');
  assert.match(staticDockerfile, /\btoast-state\.css\b/, 'static image copies the cloud toast stylesheet');
  assert.match(serverDockerfile, /\btoast-state\.css\b/, 'SaaS image copies the cloud toast stylesheet');
});

test('cloud toast state is visibly rendered by a shipped stylesheet', () => {
  assert.match(
    cloudSyncJs,
    /classList\.add\(["']visible["']\)/,
    'cloud status messages activate the visible toast state',
  );
  assert.match(
    indexHtml,
    /<link\s+[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']toast-state\.css["'][^>]*>/i,
    'the production document loads the cloud toast state stylesheet',
  );
  assert.match(
    toastStateCss,
    /\.toast\.visible\s*\{[^}]*\bopacity\s*:\s*1\s*;[^}]*\btransform\s*:\s*translateY\(0\)\s*;/s,
    'the shipped cloud toast state becomes visually observable',
  );
});
