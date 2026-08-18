import assert from 'node:assert/strict';

import { downloadBlobSafely, routeTokenPathSegment } from '../../cloud-sync.js';

assert.equal(routeTokenPathSegment('abc_DEF-1234567890'), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('  abc_DEF-1234567890  '), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('../admin?force=true'), '');
assert.equal(routeTokenPathSegment('https://example.test/api'), '');
assert.equal(routeTokenPathSegment('short'), '');

function createDownloadHarness({ clickError = null } = {}) {
  const events = [];
  const anchor = {
    parentNode: null,
    click() {
      events.push('click');
      if (clickError) throw clickError;
    },
    remove() {
      throw new Error('download cleanup must not trust the anchor remove method');
    },
  };

  const body = {
    appendChild(node) {
      assert.equal(node, anchor);
      events.push('append-anchor');
      anchor.parentNode = body;
      return anchor;
    },
    removeChild(node) {
      assert.equal(node, anchor);
      assert.equal(anchor.parentNode, body);
      events.push('remove-anchor');
      anchor.parentNode = null;
      return anchor;
    },
  };

  const documentRef = {
    body,
    createElement(tagName) {
      assert.equal(tagName, 'a');
      events.push('create-anchor');
      return anchor;
    },
  };

  const urlRef = {
    createObjectURL(blob) {
      assert.ok(blob instanceof Blob);
      events.push('create-url');
      return 'blob:scopeweave-test';
    },
    revokeObjectURL(url) {
      assert.equal(url, 'blob:scopeweave-test');
      events.push('revoke-url');
    },
  };

  return { anchor, documentRef, events, urlRef };
}

{
  const { anchor, documentRef, events, urlRef } = createDownloadHarness();
  downloadBlobSafely(new Blob(['buyer export']), 'scopeweave-export.json', { documentRef, urlRef });

  assert.equal(anchor.download, 'scopeweave-export.json');
  assert.equal(anchor.href, 'blob:scopeweave-test');
  assert.equal(anchor.rel, 'noopener noreferrer');
  assert.equal(anchor.parentNode, null);
  assert.deepEqual(events, [
    'create-url',
    'create-anchor',
    'append-anchor',
    'click',
    'remove-anchor',
    'revoke-url',
  ]);
}

{
  const causalError = new Error('browser download dispatch failed');
  const { anchor, documentRef, events, urlRef } = createDownloadHarness({ clickError: causalError });
  let observedError = null;

  try {
    downloadBlobSafely(new Blob(['audit export']), 'audit.csv', { documentRef, urlRef });
  } catch (error) {
    observedError = error;
  }

  assert.equal(observedError, causalError);
  assert.equal(anchor.parentNode, null);
  assert.deepEqual(events, [
    'create-url',
    'create-anchor',
    'append-anchor',
    'click',
    'remove-anchor',
    'revoke-url',
  ]);
}
