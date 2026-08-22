import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sentinel = await readFile(new URL('../../.jules/sentinel.md', import.meta.url), 'utf8');
const headings = sentinel.match(/^## /gm) || [];

assert.ok(
  headings.length >= 25,
  `sentinel security learnings must remain append-only enough to preserve the accumulated baseline; found ${headings.length} headings`,
);
assert.match(sentinel, /## 2026-06-02 - Add CSP Header and secure ID Generation/);
assert.match(sentinel, /## 2024-07-11 - Prevent CSV DDE injection via pipe-prefixed formulas in backend audit export/);
assert.match(sentinel, /## 2026-08-20 - 🛡️ Sentinel: HTTP 보안 헤더 적용 및 Strix 오탐 방지를 위한 innerHTML 제거/);
assert.match(sentinel, /## 2026-08-22 - Fix IDOR in webhook delivery lookup/);

console.log('sentinel accumulated-learning integrity regression passed');
