import test from 'node:test';
import assert from 'node:assert/strict';
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

function buttonElementMarkup(html, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<button\\s+[^>]*\\bid=["']${escapedId}["'][^>]*>`, 'i'));
  assert.ok(match, `production index.html contains #${id}`);
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
  const serverApp = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf8');
  const pagesWorkflow = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const staticDockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  const serverDockerfile = readFileSync(new URL('../../Dockerfile.server', import.meta.url), 'utf8');
  assert.match(serverApp, /['"]\/toast-state\.css['"]/, 'SaaS allowlist serves the cloud toast stylesheet');
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

test('task-dependent help is exposed only while the native actions are unavailable', () => {
  const exportButton = buttonElementMarkup(indexHtml, 'export-csv');
  const ganttButton = buttonElementMarkup(indexHtml, 'open-gantt');

  assert.doesNotMatch(
    exportButton,
    /\baria-describedby=["']task-dependent-actions-help["']/i,
    'enabled export action must not carry an unavailable-state description',
  );
  assert.doesNotMatch(
    ganttButton,
    /\baria-describedby=["']task-dependent-actions-help["']/i,
    'enabled Gantt action must not carry an unavailable-state description',
  );
  assert.match(
    indexHtml,
    /#task-dependent-actions-help\s*\{[^}]*\bdisplay\s*:\s*none\s*;[^}]*\}/s,
    'the unavailable-state explanation is hidden by default',
  );
  assert.match(
    indexHtml,
    /#open-gantt\[aria-disabled=["']true["']\]\s*\+\s*#task-dependent-actions-help\s*\{[^}]*\bdisplay\s*:\s*block\s*;[^}]*\}/s,
    'the explanation becomes visible only when the task-dependent actions are disabled',
  );
  assert.match(
    indexHtml,
    /작업이 없으면 CSV 내보내기와 간트차트를 사용할 수 없습니다\. 최상위 작업을 추가하거나 CSV를 가져오세요\./,
    'the explanation states both the unavailable condition and recovery actions',
  );
});
