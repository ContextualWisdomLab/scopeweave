import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_WORK_ITEMS,
  WorkHierarchyError,
  validateWorkHierarchy,
} from '../../server/work_hierarchy.mjs';

function item(id, depth, parentId = null, extra = {}) {
  return { id, depth, parentId, ...extra };
}

function expectHierarchyError(input, code, status = 400) {
  assert.throws(
    () => validateWorkHierarchy(input),
    (error) => {
      assert.ok(error instanceof WorkHierarchyError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      return true;
    },
  );
}

test('accepts empty, legacy three-level, and canonical four-level hierarchies', () => {
  assert.deepEqual(validateWorkHierarchy([]), { itemCount: 0, maxDepth: 0 });

  assert.deepEqual(validateWorkHierarchy([
    item('phase-1', 1),
    item('activity-1', 2, 'phase-1'),
    item('task-1', 3, 'activity-1'),
  ]), { itemCount: 3, maxDepth: 3 });

  assert.deepEqual(validateWorkHierarchy([
    item('phase-1', 1, ''),
    item('activity-1', 2, 'phase-1'),
    item('task-1', 3, 'activity-1'),
    item('duty-1', 4, 'task-1'),
  ]), { itemCount: 4, maxDepth: 4 });
});

test('accepts a realistic 10,000-item bounded portfolio graph in linear time', () => {
  const tasks = [];
  for (let phase = 0; phase < 2_500; phase += 1) {
    const phaseId = `phase-${phase}`;
    const activityId = `activity-${phase}`;
    const taskId = `task-${phase}`;
    tasks.push(
      item(phaseId, 1),
      item(activityId, 2, phaseId),
      item(taskId, 3, activityId),
      item(`duty-${phase}`, 4, taskId),
    );
  }
  assert.equal(tasks.length, 10_000);
  assert.deepEqual(validateWorkHierarchy(tasks), { itemCount: 10_000, maxDepth: 4 });
  assert.ok(MAX_WORK_ITEMS >= 10_000);
});

test('rejects malformed records, identifiers, duplicate identities, and unsupported depths', () => {
  expectHierarchyError(null, 'work_hierarchy_tasks_invalid');
  expectHierarchyError([null], 'work_hierarchy_record_invalid');
  expectHierarchyError([[]], 'work_hierarchy_record_invalid');
  expectHierarchyError([item('', 1)], 'work_hierarchy_id_invalid');
  expectHierarchyError([item(' phase-1 ', 1)], 'work_hierarchy_id_invalid');
  expectHierarchyError([item('phase\n1', 1)], 'work_hierarchy_id_invalid');
  expectHierarchyError([item('x'.repeat(129), 1)], 'work_hierarchy_id_invalid');
  expectHierarchyError([item('same', 1), item('same', 1)], 'work_hierarchy_id_duplicate');
  expectHierarchyError([item('phase-1', 0)], 'work_hierarchy_depth_invalid');
  expectHierarchyError([item('phase-1', 5)], 'work_hierarchy_depth_invalid');
  expectHierarchyError([item('phase-1', 1.5)], 'work_hierarchy_depth_invalid');
  expectHierarchyError([item('phase-1', '1')], 'work_hierarchy_depth_invalid');
});

test('requires roots to be parentless and every child to reference the immediately preceding depth', () => {
  expectHierarchyError([
    item('phase-1', 1, 'other-root'),
  ], 'work_hierarchy_root_parent_invalid');

  expectHierarchyError([
    item('phase-1', 1),
    item('activity-1', 2, 'missing-phase'),
  ], 'work_hierarchy_parent_missing');

  expectHierarchyError([
    item('phase-1', 1),
    item('task-1', 3, 'phase-1'),
  ], 'work_hierarchy_parent_depth_invalid');

  expectHierarchyError([
    item('phase-1', 1),
    item('activity-1', 2, null),
  ], 'work_hierarchy_parent_required');
});

test('rejects self/cyclic ancestry before a corrupt graph reaches persistence', () => {
  expectHierarchyError([
    item('phase-1', 1),
    item('activity-1', 2, 'activity-1'),
  ], 'work_hierarchy_cycle');

  expectHierarchyError([
    item('phase-1', 1),
    item('activity-1', 2, 'task-1'),
    item('task-1', 3, 'activity-1'),
  ], 'work_hierarchy_cycle');
});

test('rejects payloads above the bounded work-item budget', () => {
  const tooMany = Array.from(
    { length: MAX_WORK_ITEMS + 1 },
    (_, index) => item(`root-${index}`, 1),
  );
  expectHierarchyError(tooMany, 'work_hierarchy_too_large', 413);
});
