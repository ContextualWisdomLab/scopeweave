import assert from 'node:assert/strict';

import * as cloudSync from '../../cloud-sync.js';

const { routeTokenPathSegment } = cloudSync;

assert.equal(routeTokenPathSegment('abc_DEF-1234567890'), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('  abc_DEF-1234567890  '), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('../admin?force=true'), '');
assert.equal(routeTokenPathSegment('https://example.test/api'), '');
assert.equal(routeTokenPathSegment('short'), '');

assert.equal(
  typeof cloudSync.resolveTaskName,
  'function',
  'task-name lookup must expose a live-state resolver',
);
let tasks = [{ id: 'task-1', name: 'Draft' }];
assert.equal(cloudSync.resolveTaskName(tasks, 'task-1'), 'Draft');
tasks = [{ id: 'task-1', name: 'Review' }];
assert.equal(cloudSync.resolveTaskName(tasks, 'task-1'), 'Review');
assert.equal(cloudSync.resolveTaskName(tasks, 'missing'), 'missing');
