import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
const cloudSyncJs = readFileSync(new URL('../../cloud-sync.js', import.meta.url), 'utf8');

function toastElementMarkup(html) {
  const match = html.match(/<div\s+[^>]*\bid=["']toast["'][^>]*>/i);
  assert.ok(match, 'production index.html contains the toast container');
  return match[0];
}

test('toast container exposes advisory status updates without taking focus', () => {
  const toast = toastElementMarkup(indexHtml);
  assert.match(toast, /\brole=["']status["']/i, 'toast uses the WAI-ARIA status role');
  assert.match(toast, /\baria-live=["']polite["']/i, 'toast explicitly uses polite announcements');
  assert.match(toast, /\baria-atomic=["']true["']/i, 'toast announces its complete updated content');
  assert.doesNotMatch(toast, /\btabindex\s*=/i, 'status updates do not move keyboard focus');
});

test('cloud toast state is covered by the production visible-state selector', () => {
  assert.match(
    cloudSyncJs,
    /classList\.add\(["']visible["']\)/,
    'cloud status messages activate the visible toast state',
  );
  assert.match(
    stylesCss,
    /\.toast\.visible\s*(?:,\s*\.toast\.show\s*)?\{/,
    'the production stylesheet must render the visible state used by cloud-sync.js',
  );
});
