import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const claudeGuide = readFileSync(new URL('../../CLAUDE.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const deployGuide = readFileSync(new URL('../../docs/deploy.md', import.meta.url), 'utf8');

assert.doesNotMatch(
  readme,
  /^\s{0,3}#{1,6}\s+Merge order\b/im,
  'README must not restore a hard-coded historical merge-order section at any Markdown heading level',
);
assert.match(
  readme,
  /Always read the live PR base\/head relationships and current protected branch before deciding integration order\./,
  'README must direct integration decisions to live ancestry and protected-branch evidence',
);
assert.doesNotMatch(
  claudeGuide,
  /see\s+["“]?Merge order["”]?\s+in\s+`README\.md`/i,
  'CLAUDE.md must not point to the removed README Merge order section',
);
assert.match(
  claudeGuide,
  /Before retargeting or merging stacked work, refetch the live protected `develop` tip, each PR's exact base\/head ancestry, and current required evidence/,
  'CLAUDE.md must direct stacked-PR integration to fresh protected-head, ancestry, and evidence checks',
);
assert.doesNotMatch(
  claudeGuide,
  /Environment variables[\s\S]{0,240}are tabled in `README\.md`/i,
  'CLAUDE.md must not point environment-variable guidance at the removed README table',
);
assert.match(
  claudeGuide,
  /Environment variables[\s\S]{0,240}(?:are documented in|see) `docs\/deploy\.md`/i,
  'CLAUDE.md must direct environment-variable guidance to the deployment guide',
);
assert.match(
  deployGuide,
  /^## Required \/ optional environment$/m,
  'deployment guide must retain the environment-variable destination referenced by CLAUDE.md',
);

console.log('✓ canonical documentation authority contract passed');
