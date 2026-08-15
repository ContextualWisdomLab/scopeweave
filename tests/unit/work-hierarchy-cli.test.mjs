import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_HIERARCHY_FILE_BYTES,
  runWorkHierarchyCli,
  validateWorkHierarchyDocument,
  validateWorkHierarchyFile,
} from '../../server/work_hierarchy_cli.mjs';
import { WorkHierarchyError } from '../../server/work_hierarchy.mjs';

function fourLevel() {
  return [
    { id: 'phase-1', depth: 1, parentId: null },
    { id: 'activity-1', depth: 2, parentId: 'phase-1' },
    { id: 'task-1', depth: 3, parentId: 'activity-1' },
    { id: 'duty-1', depth: 4, parentId: 'task-1' },
  ];
}

function sink() {
  let value = '';
  return {
    stream: { write(chunk) { value += String(chunk); } },
    read() { return value; },
  };
}

function expectCode(fn, code, status = 400) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof WorkHierarchyError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test('document preflight accepts task arrays and ScopeWeave export envelopes', () => {
  assert.deepEqual(validateWorkHierarchyDocument(fourLevel()), { itemCount: 4, maxDepth: 4 });
  assert.deepEqual(validateWorkHierarchyDocument({ tasks: fourLevel() }), { itemCount: 4, maxDepth: 4 });
  expectCode(() => validateWorkHierarchyDocument({ projectName: 'missing tasks' }), 'work_hierarchy_document_invalid');
  expectCode(() => validateWorkHierarchyDocument('not a document'), 'work_hierarchy_document_invalid');
});

test('file preflight bounds bytes before reading and sanitizes file/JSON failures', async () => {
  const statFile = async () => ({ size: 128, isFile: () => true });
  const good = await validateWorkHierarchyFile('plan.json', {
    stat: statFile,
    readFile: async () => JSON.stringify({ tasks: fourLevel() }),
  });
  assert.deepEqual(good, { itemCount: 4, maxDepth: 4 });

  await assert.rejects(
    validateWorkHierarchyFile('', { stat: statFile, readFile: async () => '[]' }),
    (error) => error instanceof WorkHierarchyError && error.code === 'work_hierarchy_file_required',
  );
  await assert.rejects(
    validateWorkHierarchyFile('directory', {
      stat: async () => ({ size: 0, isFile: () => false }),
      readFile: async () => '[]',
    }),
    (error) => error instanceof WorkHierarchyError && error.code === 'work_hierarchy_file_unreadable',
  );
  await assert.rejects(
    validateWorkHierarchyFile('huge.json', {
      stat: async () => ({ size: MAX_HIERARCHY_FILE_BYTES + 1, isFile: () => true }),
      readFile: async () => { throw new Error('must not read oversized input'); },
    }),
    (error) => error instanceof WorkHierarchyError
      && error.code === 'work_hierarchy_file_too_large'
      && error.status === 413,
  );
  await assert.rejects(
    validateWorkHierarchyFile('missing.json', {
      stat: async () => { throw new Error('ENOENT /private/path'); },
      readFile: async () => '[]',
    }),
    (error) => error instanceof WorkHierarchyError
      && error.code === 'work_hierarchy_file_unreadable'
      && !error.message.includes('/private/path'),
  );
  await assert.rejects(
    validateWorkHierarchyFile('bad.json', {
      stat: statFile,
      readFile: async () => '{secret payload',
    }),
    (error) => error instanceof WorkHierarchyError
      && error.code === 'work_hierarchy_json_invalid'
      && !error.message.includes('secret payload'),
  );
});

test('CLI emits decision-ready JSON without echoing plan contents', async () => {
  const stdout = sink();
  const stderr = sink();
  const goodCode = await runWorkHierarchyCli({
    argv: ['plan.json'],
    stdout: stdout.stream,
    stderr: stderr.stream,
    stat: async () => ({ size: 128, isFile: () => true }),
    readFile: async () => JSON.stringify({ tasks: fourLevel(), confidential: 'do-not-echo' }),
  });
  assert.equal(goodCode, 0);
  assert.deepEqual(JSON.parse(stdout.read()), {
    valid: true,
    itemCount: 4,
    maxDepth: 4,
  });
  assert.equal(stdout.read().includes('do-not-echo'), false);
  assert.equal(stderr.read(), '');

  const failedOut = sink();
  const failedErr = sink();
  const badCode = await runWorkHierarchyCli({
    argv: ['plan.json'],
    stdout: failedOut.stream,
    stderr: failedErr.stream,
    stat: async () => ({ size: 128, isFile: () => true }),
    readFile: async () => JSON.stringify([
      { id: 'phase-1', depth: 1, parentId: null },
      { id: 'duty-secret-name', depth: 4, parentId: 'missing' },
    ]),
  });
  assert.equal(badCode, 1);
  assert.equal(failedOut.read(), '');
  assert.deepEqual(JSON.parse(failedErr.read()), {
    valid: false,
    code: 'work_hierarchy_parent_missing',
  });
  assert.equal(failedErr.read().includes('duty-secret-name'), false);
});
