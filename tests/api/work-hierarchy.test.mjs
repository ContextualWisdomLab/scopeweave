import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');

const request = (path, options = {}) => app.request(path, {
  ...options,
  headers: {
    'content-type': 'application/json',
    ...(options.headers || {}),
  },
});

async function createProject() {
  let response = await request('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email: 'hierarchy-contract@scopeweave.test',
      password: 'password123',
      name: 'Hierarchy Contract',
    }),
  });
  assert.equal(response.status, 200);
  const token = (await response.json()).token;
  const headers = { authorization: `Bearer ${token}` };

  response = await request('/api/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Four-level plan' }),
  });
  assert.equal(response.status, 200);
  const project = await response.json();
  return { headers, projectId: project.id };
}

async function putTasks(projectId, headers, version, tasks) {
  return request(`/api/projects/${projectId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ version, tasks }),
  });
}

test('project writes fail closed on corrupt hierarchy and persist a valid Duty level', async () => {
  const { headers, projectId } = await createProject();

  const invalidCases = [
    {
      code: 'work_hierarchy_parent_missing',
      tasks: [
        { id: 'phase-1', depth: 1, parentId: null },
        { id: 'activity-1', depth: 2, parentId: 'missing-phase' },
      ],
    },
    {
      code: 'work_hierarchy_depth_invalid',
      tasks: [{ id: 'too-deep', depth: 5, parentId: null }],
    },
    {
      code: 'work_hierarchy_cycle',
      tasks: [
        { id: 'phase-1', depth: 1, parentId: null },
        { id: 'activity-1', depth: 2, parentId: 'task-1' },
        { id: 'task-1', depth: 3, parentId: 'activity-1' },
      ],
    },
  ];

  for (const invalid of invalidCases) {
    const response = await putTasks(projectId, headers, 1, invalid.tasks);
    assert.equal(response.status, 400, `${invalid.code} is rejected`);
    assert.deepEqual(await response.json(), {
      error: 'invalid work hierarchy',
      code: invalid.code,
    });
  }

  let response = await request(`/api/projects/${projectId}`, { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).version, 1, 'rejected hierarchies do not advance project version');

  const fourLevel = [
    { id: 'phase-1', depth: 1, parentId: null, phase: 'Discovery' },
    { id: 'activity-1', depth: 2, parentId: 'phase-1', activity: 'Research' },
    { id: 'task-1', depth: 3, parentId: 'activity-1', task: 'Interview' },
    { id: 'duty-1', depth: 4, parentId: 'task-1', duty: 'Recruit participant' },
  ];

  response = await putTasks(projectId, headers, 1, fourLevel);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: 2 });

  response = await request(`/api/projects/${projectId}`, { headers });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.tasks, fourLevel, 'four-level identity and parent linkage round-trip without flattening');

  const threeLevel = fourLevel.slice(0, 3);
  response = await putTasks(projectId, headers, 2, threeLevel);
  assert.equal(response.status, 200, 'existing three-level plans remain writable');
  assert.deepEqual(await response.json(), { version: 3 });
});
