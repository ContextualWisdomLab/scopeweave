import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const serverApp = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf8');
const staticDockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const serverDockerfile = readFileSync(new URL('../../Dockerfile.server', import.meta.url), 'utf8');
const pagesWorkflow = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');

function linkedStylesheets(html) {
  return [...html.matchAll(/<link\s+[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+\.css)["'][^>]*>/gi)]
    .map((match) => match[1]);
}

test('every planner stylesheet is shipped on every production serve path', () => {
  const stylesheets = linkedStylesheets(indexHtml);
  assert.notEqual(stylesheets.length, 0, 'the planner links at least one production stylesheet');

  for (const asset of stylesheets) {
    assert.equal(
      serverApp.includes(`'/${asset}'`) || serverApp.includes(`"/${asset}"`),
      true,
      `SaaS strict static allowlist serves ${asset}`,
    );
    assert.equal(staticDockerfile.includes(asset), true, `static Docker image copies ${asset}`);
    assert.equal(serverDockerfile.includes(asset), true, `SaaS Docker image copies ${asset}`);
    assert.equal(pagesWorkflow.includes(asset), true, `GitHub Pages stages ${asset}`);
  }
});
