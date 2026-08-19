import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const serverApp = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf8');
const staticDockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const serverDockerfile = readFileSync(new URL('../../Dockerfile.server', import.meta.url), 'utf8');
const pagesWorkflow = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');

function linkedStylesheets(html) {
  return [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => {
      const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1] ?? '';
      const href = tag.match(/\bhref=["']([^"']+\.css)["']/i)?.[1] ?? null;
      const isStylesheet = rel.split(/\s+/).some((token) => token.toLowerCase() === 'stylesheet');
      return isStylesheet ? href : null;
    })
    .filter(Boolean);
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('every planner stylesheet is shipped on every production serve path', () => {
  const stylesheets = linkedStylesheets(indexHtml);
  assert.notEqual(stylesheets.length, 0, 'the planner links at least one production stylesheet');

  for (const asset of stylesheets) {
    const assetPattern = escaped(asset);
    assert.equal(
      serverApp.includes(`'/${asset}': ['${asset}', 'text/css; charset=utf-8']`),
      true,
      `SaaS strict static allowlist maps ${asset} to itself with the CSS MIME type`,
    );
    assert.match(
      staticDockerfile,
      new RegExp(`^COPY [^\\r\\n]*\\b${assetPattern}\\b[^\\r\\n]* /usr/share/nginx/html/$`, 'm'),
      `static Docker image copy command ships ${asset}`,
    );
    assert.match(
      serverDockerfile,
      new RegExp(`^COPY [^\\r\\n]*\\b${assetPattern}\\b[^\\r\\n]* \\./$`, 'm'),
      `SaaS Docker image copy command ships ${asset}`,
    );
    assert.match(
      pagesWorkflow,
      new RegExp(`^\\s*cp [^\\r\\n]*\\b${assetPattern}\\b[^\\r\\n]* _site/$`, 'm'),
      `GitHub Pages staging command ships ${asset}`,
    );
  }
});
