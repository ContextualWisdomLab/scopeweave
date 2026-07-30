// MS Project XML → ScopeWeave tasks (pure parser in cloud-sync.js).
// Run: node tests/unit/msproject.test.mjs
import assert from 'node:assert';
import { parseMsProjectXml } from '../../cloud-sync.js';

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Tasks>
    <Task><UID>0</UID><Name>전체 프로젝트</Name><OutlineLevel>0</OutlineLevel></Task>
    <Task><UID>1</UID><Name>준비 단계</Name><OutlineLevel>1</OutlineLevel>
      <Start>2026-03-02T08:00:00</Start><Finish>2026-03-13T17:00:00</Finish>
      <PercentComplete>100</PercentComplete></Task>
    <Task><UID>2</UID><Name>요구사항 정의</Name><OutlineLevel>2</OutlineLevel>
      <Start>2026-03-02T08:00:00</Start><Finish>2026-03-06T17:00:00</Finish>
      <PercentComplete>100</PercentComplete></Task>
    <Task><UID>3</UID><Name>요구사항 &amp; 검토 회의</Name><OutlineLevel>3</OutlineLevel>
      <Start>2026-03-09T08:00:00</Start><Finish>2026-03-13T17:00:00</Finish>
      <PercentComplete>50</PercentComplete>
      <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type></PredecessorLink></Task>
    <Task><UID>4</UID><Name>세부 작업 (4레벨)</Name><OutlineLevel>4</OutlineLevel>
      <Start>2026-03-10T08:00:00</Start><Finish>2026-03-11T17:00:00</Finish></Task>
    <Task><UID>5</UID><Name>구현 단계</Name><OutlineLevel>1</OutlineLevel>
      <Start>2026-03-16T08:00:00</Start><Finish>2026-05-29T17:00:00</Finish>
      <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type></PredecessorLink></Task>
  </Tasks>
</Project>`;

const tasks = parseMsProjectXml(xml);
assert.equal(tasks.length, 5, 'summary row (UID 0) skipped, 5 tasks parsed');

const [t1, t2, t3, t4, t5] = tasks;
assert.equal(t1.id, 'msp-1');
assert.equal(t1.depth, 1);
assert.equal(t1.phase, '준비 단계');
assert.equal(t1.parentId, '', 'level-1 has no parent');
assert.equal(t1.plannedStartDate, '2026-03-02', 'date normalized');
assert.equal(t1.plannedEndDate, '2026-03-13');
assert.equal(t1.actualProgress, 100, 'PercentComplete mapped');

assert.equal(t2.depth, 2);
assert.equal(t2.activity, '요구사항 정의');
assert.equal(t2.parentId, 'msp-1', 'nested under the phase');

assert.equal(t3.depth, 3);
assert.equal(t3.task, '요구사항 & 검토 회의', 'XML entities unescaped');
assert.equal(t3.parentId, 'msp-2');
assert.equal(t3.predecessors, 'msp-2', 'PredecessorLink mapped to our id space');

assert.equal(t4.depth, 3, 'level-4 flattened to depth 3');
assert.equal(t4.parentId, 'msp-2', 'flattened task keeps the level-2 parent');

assert.equal(t5.depth, 1);
assert.equal(t5.parentId, '', 'parent chain reset for the new phase');
assert.equal(t5.predecessors, 'msp-1');

assert.deepEqual(parseMsProjectXml('<Project></Project>'), [], 'no tasks → empty');

// --- tag() failure-branch regression tests (indexOf-slicing extractor) ---
// These pin the three defensive branches of the `tag()` helper introduced when
// the dynamic RegExp was removed, so a future parser change cannot silently
// alter how malformed or nested markup is handled.

// end === -1: <Name> opens but never closes → '' → task has no usable name → skipped.
assert.deepEqual(
  parseMsProjectXml('<Task><UID>10</UID><Name>broken</Task>'),
  [],
  'unterminated <Name> (end === -1) yields no name → task skipped',
);

// content.includes('<'): nested markup inside the value → '' → task skipped
// (mirrors the original /<name>([^<]*)<\/name>/ "no inner <" semantics).
assert.deepEqual(
  parseMsProjectXml('<Task><UID>11</UID><Name>a<b>c</b></Name><OutlineLevel>1</OutlineLevel></Task>'),
  [],
  'nested markup inside <Name> (content contains "<") is rejected → task skipped',
);

// start === -1: absent optional tags → '' (dates blank, OutlineLevel defaults to 1).
const sparseTasks = parseMsProjectXml('<Task><UID>12</UID><Name>NoDates</Name></Task>');
assert.equal(sparseTasks.length, 1, 'valid UID + Name parses even with no dates/level');
assert.equal(sparseTasks[0].id, 'msp-12');
assert.equal(sparseTasks[0].depth, 1, 'missing <OutlineLevel> (start === -1) defaults depth to 1');
assert.equal(sparseTasks[0].plannedStartDate, '', 'missing <Start> (start === -1) → empty date');
assert.equal(sparseTasks[0].plannedEndDate, '', 'missing <Finish> (start === -1) → empty date');
assert.equal(sparseTasks[0].actualProgress, 0, 'missing <PercentComplete> → 0');

console.log('✓ MS Project import tests passed');
