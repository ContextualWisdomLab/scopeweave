import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../cloud-sync.js', import.meta.url), 'utf8');

function functionBody(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `expected ${startMarker} section`);
  return source.slice(start, end);
}

function assertTaskSnapshotAfterRemoteRead(section, endpointFragment) {
  const remoteRead = section.indexOf(`const data = await api(\`/api/projects/\${pid}/${endpointFragment}`);
  const taskSnapshot = section.indexOf('const taskMap = new Map(');
  assert.ok(remoteRead >= 0, `${endpointFragment}: expected remote read`);
  assert.ok(taskSnapshot >= 0, `${endpointFragment}: expected task lookup map`);
  assert.ok(
    taskSnapshot > remoteRead,
    `${endpointFragment}: task labels must snapshot current host state after the awaited remote read`,
  );
}

assertTaskSnapshotAfterRemoteRead(
  functionBody('async function openAttachmentsModal()', '// ------------------------------------------------------------- comments'),
  'attachments',
);
assertTaskSnapshotAfterRemoteRead(
  functionBody('async function openCommentsModal()', '// ------------------------------------------------------------- search'),
  'comments',
);
