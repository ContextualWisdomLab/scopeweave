import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORK_ITEM_LEVELS,
  projectWorkItemHierarchy,
  validateWorkItemHierarchy,
} from '../../server/work_item_hierarchy.mjs';

const validFourLevelPlan = () => [
  { id: 'phase-alpha', parentId: null, depth: 1, phase: 'Discovery' },
  { id: 'activity-research', parentId: 'phase-alpha', depth: 2, activity: 'Research' },
  { id: 'task-interviews', parentId: 'activity-research', depth: 3, task: 'Interviews' },
  { id: 'duty-recruit', parentId: 'task-interviews', depth: 4, duty: 'Recruit participants' },
  { id: 'task-analysis', parentId: 'activity-research', depth: 3, task: 'Analysis' },
];

test('projects Phase → Activity → Task → Duty without changing source records', () => {
  const source = validFourLevelPlan();
  const before = structuredClone(source);

  const projected = projectWorkItemHierarchy(source);

  assert.deepEqual(source, before, 'projection must not mutate persisted plan input');
  assert.deepEqual(WORK_ITEM_LEVELS, Object.freeze(['phase', 'activity', 'task', 'duty']));
  assert.deepEqual(projected.map(({ id, parentId, depth, kind }) => ({ id, parentId, depth, kind })), [
    { id: 'phase-alpha', parentId: null, depth: 1, kind: 'phase' },
    { id: 'activity-research', parentId: 'phase-alpha', depth: 2, kind: 'activity' },
    { id: 'task-interviews', parentId: 'activity-research', depth: 3, kind: 'task' },
    { id: 'duty-recruit', parentId: 'task-interviews', depth: 4, kind: 'duty' },
    { id: 'task-analysis', parentId: 'activity-research', depth: 3, kind: 'task' },
  ]);
  assert.deepEqual(projected.map((item) => item.sourceIndex), [0, 1, 2, 3, 4]);
});

test('preserves existing three-level plans exactly and never synthesizes duties', () => {
  const legacy = validFourLevelPlan().filter((item) => item.depth <= 3);
  const projected = projectWorkItemHierarchy(legacy);

  assert.equal(projected.length, legacy.length);
  assert.deepEqual(
    projected.map(({ id, parentId, depth }) => ({ id, parentId, depth })),
    legacy.map(({ id, parentId, depth }) => ({ id, parentId, depth })),
  );
  assert.equal(projected.some((item) => item.kind === 'duty'), false);
});

test('validates hierarchy relationships without depending on source ordering', () => {
  const source = validFourLevelPlan();
  const reordered = [source[3], source[1], source[4], source[0], source[2]];

  assert.deepEqual(validateWorkItemHierarchy(reordered), { valid: true, errors: [] });
});

test('normalizes only absent root parents and accepts an empty plan', () => {
  const rootWithoutParentProperty = [{ id: 'phase-root', depth: 1 }];
  assert.deepEqual(validateWorkItemHierarchy([]), { valid: true, errors: [] });
  assert.deepEqual(projectWorkItemHierarchy([]), []);
  assert.equal(projectWorkItemHierarchy(rootWithoutParentProperty)[0].parentId, null);
  assert.equal(projectWorkItemHierarchy([{ id: 'phase-root', parentId: '', depth: 1 }])[0].parentId, null);
});

test('rejects duplicate public identifiers', () => {
  const source = validFourLevelPlan();
  source.push({ id: 'task-analysis', parentId: 'activity-research', depth: 3 });

  assert.deepEqual(validateWorkItemHierarchy(source), {
    valid: false,
    errors: [{ code: 'duplicate_id', id: 'task-analysis' }],
  });
  assert.throws(() => projectWorkItemHierarchy(source), /duplicate_id/);
});

test('rejects orphaned parents, root parents, depth jumps, cycles, and depth outside 1..4', () => {
  const cases = [
    {
      source: [{ id: 'activity-a', parentId: 'missing-phase', depth: 2 }],
      code: 'missing_parent',
    },
    {
      source: [{ id: 'phase-a', parentId: 'another-root', depth: 1 }],
      code: 'invalid_parent_depth',
    },
    {
      source: [
        { id: 'phase-a', parentId: null, depth: 1 },
        { id: 'task-a', parentId: 'phase-a', depth: 3 },
      ],
      code: 'invalid_parent_depth',
    },
    {
      source: [
        { id: 'bad-parent', parentId: null, depth: '2' },
        { id: 'task-a', parentId: 'bad-parent', depth: 3 },
      ],
      code: 'invalid_parent_depth',
    },
    {
      source: [
        { id: 'task-a', parentId: 'duty-a', depth: 3 },
        { id: 'duty-a', parentId: 'task-a', depth: 4 },
      ],
      code: 'cycle',
    },
    {
      source: [{ id: 'too-deep', parentId: null, depth: 5 }],
      code: 'invalid_depth',
    },
  ];

  for (const { source, code } of cases) {
    const result = validateWorkItemHierarchy(source);
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((error) => error.code === code), true, `${code} should be reported`);
  }
});

test('rejects blank, numeric, and unsafe public identifiers instead of coercing them', () => {
  for (const id of ['', '   ', 42, '__proto__']) {
    const result = validateWorkItemHierarchy([{ id, parentId: null, depth: 1 }]);
    assert.equal(result.valid, false);
    assert.equal(result.errors[0]?.code, 'invalid_id');
  }
  assert.equal(
    validateWorkItemHierarchy([{ id: 'activity-a', parentId: '__proto__', depth: 2 }]).errors[0]?.code,
    'missing_parent',
  );
});

test('returns deterministic validation errors for malformed record containers', () => {
  assert.deepEqual(validateWorkItemHierarchy(null), {
    valid: false,
    errors: [{ code: 'invalid_records' }],
  });
  assert.deepEqual(validateWorkItemHierarchy([null]), {
    valid: false,
    errors: [{ code: 'invalid_record', sourceIndex: 0 }],
  });
  assert.deepEqual(validateWorkItemHierarchy([[]]), {
    valid: false,
    errors: [{ code: 'invalid_record', sourceIndex: 0 }],
  });
});

test('handles a realistic 10,000-item portfolio hierarchy without changing IDs', () => {
  const source = [];
  for (let root = 0; root < 2500; root += 1) {
    const phaseId = `phase-${root}`;
    const activityId = `activity-${root}`;
    const taskId = `task-${root}`;
    source.push(
      { id: phaseId, parentId: null, depth: 1 },
      { id: activityId, parentId: phaseId, depth: 2 },
      { id: taskId, parentId: activityId, depth: 3 },
      { id: `duty-${root}`, parentId: taskId, depth: 4 },
    );
  }

  const projected = projectWorkItemHierarchy(source);
  assert.equal(projected.length, 10_000);
  assert.equal(projected[0].id, 'phase-0');
  assert.equal(projected.at(-1).id, 'duty-2499');
});
