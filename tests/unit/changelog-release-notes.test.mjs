import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');

test('released changelog versions keep their published notes', () => {
  assert.match(changelog, /## \[1\.0\.0\] - 2026-04-20/);
  assert.match(changelog, /Initial ScopeWeave Planner release with tree-table editing/);
  assert.match(changelog, /GitHub Pages deployment workflow and operator documentation\./);
  assert.match(changelog, /## \[1\.0\.1\] - 2026-06-25/);
  assert.match(
    changelog,
    /드래그 앤 드롭 동작 중 `dragover` 이벤트에서 발생하는 O\(N\) 작업 리스트 검색 성능 병목 문제를, O\(1\) 해시맵\(Map\) 기반의 캐싱 조회 로직으로 개선하여 큰 크기의 WBS 리스트에서의 버벅임 현상을 해결했습니다\./,
  );
});
