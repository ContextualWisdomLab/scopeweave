import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');

test('released changelog versions keep their published notes', () => {
  assert.match(changelog, /## \[1\.0\.0\] - 2026-04-20/);
  assert.match(changelog, /Initial ScopeWeave Planner release with tree-table editing/);
  assert.match(changelog, /## \[1\.0\.1\] - 2026-06-25/);
  assert.match(changelog, /O\(1\) 해시맵\(Map\) 기반의 캐싱 조회 로직/);
});
