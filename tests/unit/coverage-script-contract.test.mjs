// This contract prevents coverage evidence from silently omitting either runtime.
// ScopeWeave owns browser code and Node/server code; each runtime must enforce
// exact 100% Istanbul statement/branch/function/line coverage on the same PR head.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const scripts = packageJson.scripts;

assert.equal(
  scripts.coverage,
  'npm run test:coverage',
  'the public coverage command delegates to the canonical complete coverage producer',
);
assert.equal(
  scripts['test:coverage'],
  'npm run test:coverage:server && npm run test:coverage:browser',
  'canonical coverage must prove both Node/server and real-browser production code',
);
assert.match(
  scripts['test:coverage:server'],
  /\bc8\b.*--reporter=json(?![-\w]).*npm run test:coverage:cases/,
  'server coverage creates Istanbul JSON before executing deterministic cases',
);
assert.match(
  scripts['test:coverage:server'],
  /--reporter=json-summary\b/,
  'server coverage also creates the Istanbul JSON summary',
);
for (const requiredCoverageOption of [
  '--all',
  '--check-coverage',
  '--per-file',
  '--lines 100',
  '--functions 100',
  '--branches 100',
  '--statements 100',
]) {
  assert.equal(
    scripts['test:coverage:server'].includes(requiredCoverageOption),
    true,
    `server coverage must enforce ${requiredCoverageOption}`,
  );
}
for (const requiredServerModule of [
  'scripts/ci/static_coverage_evidence.mjs',
  'server/attachment_status.mjs',
  'server/app.mjs',
  'server/auth.mjs',
  'server/clearfolio.mjs',
  'server/orchestrator.mjs',
]) {
  assert.equal(
    scripts['test:coverage:server'].includes(`--include=${requiredServerModule}`),
    true,
    `server coverage must instrument ${requiredServerModule}`,
  );
}
assert.doesNotMatch(
  scripts['test:coverage:server'],
  /--include=(?:app|cloud-sync)\.js\b/,
  'browser production must not be scored from a Node VM that cannot observe real browser execution',
);
assert.equal(
  scripts['test:coverage:browser'],
  'node scripts/ci/browser_coverage.mjs',
  'browser coverage must use the repository-owned Chromium/Istanbul collector',
);
assert.equal(
  scripts['test:coverage:cases'],
  'npm run test:unit && npm run test:api',
  'server coverage instruments the complete deterministic unit and API suites instead of a stale curated subset',
);
assert.match(
  scripts['test:unit'],
  /tests\/unit\/clearfolio-status-signal\.test\.mjs/,
  'the complete unit suite retains the Clearfolio signal and HTTP failure regression',
);
assert.doesNotMatch(
  scripts['test:coverage:cases'],
  /npm run (?:coverage|test:coverage)(?:\s|$)/,
  'coverage cases never recursively invoke a coverage wrapper',
);

const e2eDirectory = new URL('../e2e/', import.meta.url);
const e2eSpecs = readdirSync(e2eDirectory)
  .filter((name) => name.endsWith('.spec.js'))
  .sort();
assert.ok(e2eSpecs.length > 0, 'real-browser coverage requires executable Playwright specs');
for (const specName of e2eSpecs) {
  const specSource = readFileSync(new URL(specName, e2eDirectory), 'utf8');
  assert.match(
    specSource,
    /import\s*\{\s*test\s*,\s*expect\s*\}\s*from\s*['"]\.\/coverage-test\.js['"];/,
    `${specName} must use the coverage-aware Playwright fixture so browser coverage cannot run without raw evidence`,
  );
  assert.doesNotMatch(
    specSource,
    /from\s*['"]@playwright\/test['"]/,
    `${specName} must not bypass the coverage-aware fixture with a direct Playwright test import`,
  );
}

console.log('✓ coverage script contract tests passed');
