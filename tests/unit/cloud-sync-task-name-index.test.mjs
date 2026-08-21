import assert from 'node:assert/strict';

import { buildTaskNameIndex } from '../../cloud-sync.js';

const tasks = Array.from({ length: 10_000 }, (_, index) => ({
  id: `task-${index}`,
  name: index % 2 === 0 ? `Task ${index}` : '',
  task: index % 2 === 0 ? '' : `Leaf ${index}`,
  activity: `Activity ${index}`,
  phase: `Phase ${index}`,
}));

tasks.push({
  id: 'task-9999',
  name: 'duplicate must not replace first match',
  task: 'duplicate',
});
tasks.push({
  id: 'legacy-fallback',
  name: '',
  task: '',
  activity: 'must not change the historical modal label',
  phase: 'must not change the historical modal label',
});

const index = buildTaskNameIndex(tasks);

assert.equal(index.size, 10_001, 'one index entry is retained per distinct task id');
assert.equal(index.get('task-0'), 'Task 0');
assert.equal(index.get('task-1'), 'Leaf 1');
assert.equal(index.get('task-9999'), 'Leaf 9999', 'first duplicate retains the previous Array.find semantics');
assert.equal(index.get('legacy-fallback'), 'legacy-fallback', 'performance work must not broaden buyer-visible label fallback semantics');
assert.equal(index.get('missing-task'), undefined);

for (let i = 0; i < 10_000; i += 1) {
  assert.equal(index.get(`task-${i}`), i % 2 === 0 ? `Task ${i}` : `Leaf ${i}`);
}
