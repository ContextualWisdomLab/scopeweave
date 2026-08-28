import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
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

function taskHelpElementMarkup(html) {
  const match = html.match(/<p\s+[^>]*\bid=["']task-dependent-actions-help["'][^>]*>/i);
  assert.ok(match, 'production index.html contains task-dependent action help');
  return match[0];
}

function taskStatusElementMarkup(html) {
  const match = html.match(/<span\s+[^>]*\bid=["']task-dependent-actions-status["'][^>]*>/i);
  assert.ok(match, 'production index.html contains the persistent task-dependent live region');
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

test('task-dependent help is visible only while native actions are unavailable and live updates stay in-tree', () => {
  const exportButton = buttonElementMarkup(indexHtml, 'export-csv');
  const ganttButton = buttonElementMarkup(indexHtml, 'open-gantt');
  const help = taskHelpElementMarkup(indexHtml);
  const status = taskStatusElementMarkup(indexHtml);

  assert.match(
    exportButton,
    /\bdisabled\b/i,
    'task-dependent export starts disabled until app state is loaded',
  );
  assert.match(
    ganttButton,
    /\bdisabled\b/i,
    'task-dependent Gantt starts disabled until app state is loaded',
  );
  assert.match(
    exportButton,
    /\baria-describedby=["']task-dependent-actions-help["']/i,
    'initial export markup points to the unavailable-state explanation',
  );
  assert.match(
    ganttButton,
    /\baria-describedby=["']task-dependent-actions-help["']/i,
    'initial Gantt markup points to the unavailable-state explanation',
  );
  assert.doesNotMatch(help, /\brole=["']status["']/i, 'the conditionally hidden visible helper is not itself a live region');
  assert.match(status, /\bclass=["'][^"']*\bsr-only\b[^"']*["']/i, 'the live region stays visually hidden without leaving the accessibility tree');
  assert.match(status, /\brole=["']status["']/i, 'availability changes use a dedicated WAI-ARIA status region');
  assert.match(status, /\baria-live=["']polite["']/i, 'availability changes are announced politely');
  assert.match(status, /\baria-atomic=["']true["']/i, 'the complete reason and recovery action are announced');
  assert.match(
    stylesCss,
    /#task-dependent-actions-help\s*\{[^}]*\bdisplay\s*:\s*none\s*;[^}]*\}/s,
    'the visible unavailable-state explanation is hidden by default in the shipped stylesheet',
  );
  assert.match(
    stylesCss,
    /#open-gantt\[aria-disabled=["']true["']\]\s*\+\s*#task-dependent-actions-help\s*\{[^}]*\bdisplay\s*:\s*block\s*;[^}]*\}/s,
    'the shipped stylesheet shows the visible explanation only when the task-dependent actions are disabled',
  );
  assert.doesNotMatch(
    indexHtml,
    /<style\b/i,
    'production markup does not add a one-off inline style block for this state',
  );
  assert.match(
    appJs,
    /exportCsvButton\.setAttribute\(["']aria-describedby["'],\s*["']task-dependent-actions-help["']\)/,
    'disabled export state programmatically links to the visible reason',
  );
  assert.match(
    appJs,
    /openGanttButton\.setAttribute\(["']aria-describedby["'],\s*["']task-dependent-actions-help["']\)/,
    'disabled Gantt state programmatically links to the visible reason',
  );
  assert.match(
    appJs,
    /exportCsvButton\.removeAttribute\(["']aria-describedby["']\)/,
    'enabled export state removes the unavailable-state description',
  );
  assert.match(
    appJs,
    /openGanttButton\.removeAttribute\(["']aria-describedby["']\)/,
    'enabled Gantt state removes the unavailable-state description',
  );
  assert.match(
    appJs,
    /taskDependentActionsStatus\.textContent\s*!==\s*taskDependentActionsStatus[\s\S]*taskDependentActionsStatus\.textContent\s*=\s*taskDependentActionsStatus/,
    'the always-present live region mutates only when the availability message actually changes',
  );
  assert.match(
    indexHtml,
    /작업이 없으면 CSV 내보내기와 간트차트를 사용할 수 없습니다\. 최상위 작업을 추가하거나 CSV를 가져오세요\./,
    'the visible explanation states both the unavailable condition and recovery actions',
  );
});

test('native-disabled task actions do not retain unreachable click or tooltip fallbacks', () => {
  assert.match(
    appJs,
    /exportCsvButton\.addEventListener\(["']click["'],\s*exportCsv\)/,
    'export uses its direct action handler because native disabled blocks unavailable clicks',
  );
  assert.match(
    appJs,
    /openGanttButton\.addEventListener\(["']click["'],\s*openGanttModal\)/,
    'Gantt uses its direct action handler because native disabled blocks unavailable clicks',
  );
  assert.doesNotMatch(
    appJs,
    /exportCsvButton\.getAttribute\(["']aria-disabled["']\)/,
    'export no longer carries an unreachable disabled-click branch',
  );
  assert.doesNotMatch(
    appJs,
    /openGanttButton\.getAttribute\(["']aria-disabled["']\)/,
    'Gantt no longer carries an unreachable disabled-click branch',
  );
  assert.doesNotMatch(appJs, /exportCsvButton\.title\s*=/, 'export no longer relies on a tooltip that native disabled suppresses');
  assert.doesNotMatch(appJs, /openGanttButton\.title\s*=/, 'Gantt no longer relies on a tooltip that native disabled suppresses');
});
