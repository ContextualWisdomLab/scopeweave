import assert from 'node:assert/strict';
import { buildTaskNameIndex } from '../../cloud-sync.js';

const tasks = [
  { id: 'duplicate-task', name: 'First visible task name' },
  { id: 'duplicate-task', name: 'Later duplicate must not replace the first task' },
  { id: 'legacy-task', task: 'Legacy task label' },
  { id: 'id-fallback', name: '', task: '' },
];

const index = buildTaskNameIndex(tasks);

assert.equal(
  index.get('duplicate-task'),
  'First visible task name',
  'task-name indexing must preserve the previous Array.find first-match semantics',
);
assert.equal(index.get('legacy-task'), 'Legacy task label');
assert.equal(index.get('id-fallback'), 'id-fallback');
assert.equal(index.has('missing-task'), false);

const largeTasks = Array.from({ length: 10_000 }, (_, indexValue) => ({
  id: `task-${indexValue}`,
  name: `Task ${indexValue}`,
}));
largeTasks.push({ id: 'task-9999', name: 'Conflicting duplicate' });
const largeIndex = buildTaskNameIndex(largeTasks);

assert.equal(largeIndex.size, 10_000);
assert.equal(largeIndex.get('task-9999'), 'Task 9999');
