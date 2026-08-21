import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const claudeGuide = readFileSync(new URL('../../CLAUDE.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

assert.doesNotMatch(
  readme,
  /^##\s+Merge order\b/im,
  'README must not restore a hard-coded historical merge-order table',
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

console.log('✓ canonical merge-guidance documentation contract passed');
