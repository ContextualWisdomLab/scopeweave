import assert from 'node:assert/strict';

import { downloadBlobSafely, routeTokenPathSegment } from '../../cloud-sync.js';

assert.equal(routeTokenPathSegment('abc_DEF-1234567890'), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('  abc_DEF-1234567890  '), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('../admin?force=true'), '');
assert.equal(routeTokenPathSegment('https://example.test/api'), '');
assert.equal(routeTokenPathSegment('short'), '');

function createDownloadHarness({ clickError = null, cleanupError = null, revokeError = null } = {}) {
  const events = [];
  const anchorPrototype = {
    remove() {
      events.push('prototype-remove');
      this.parentNode = null;
      if (cleanupError) throw cleanupError;
    },
  };
  const anchor = Object.create(anchorPrototype);
  anchor.parentNode = null;
  anchor.click = () => {
    events.push('click');
    if (clickError) throw clickError;
  };
  Object.defineProperty(anchor, 'remove', {
    configurable: true,
    value() {
      throw new Error('download cleanup must not trust the anchor remove method');
    },
  });

  const body = {
    appendChild(node) {
      assert.equal(node, anchor);
      events.push('append-anchor');
      anchor.parentNode = body;
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
      if (revokeError) throw revokeError;
    },
  };

  return { anchor, documentRef, events, urlRef };
}

const expectedLifecycle = [
  'create-url',
  'create-anchor',
  'append-anchor',
  'click',
  'prototype-remove',
  'revoke-url',
];

{
  const { anchor, documentRef, events, urlRef } = createDownloadHarness();
  downloadBlobSafely(new Blob(['buyer export']), 'scopeweave-export.json', { documentRef, urlRef });

  assert.equal(anchor.download, 'scopeweave-export.json');
  assert.equal(anchor.href, 'blob:scopeweave-test');
  assert.equal(anchor.rel, 'noopener noreferrer');
  assert.equal(anchor.parentNode, null);
  assert.deepEqual(events, expectedLifecycle);
}

{
  const cleanupError = new Error('browser anchor cleanup failed');
  const { anchor, documentRef, events, urlRef } = createDownloadHarness({ cleanupError });
  let observedError = null;

  try {
    downloadBlobSafely(new Blob(['metrics export']), 'metrics.csv', { documentRef, urlRef });
  } catch (error) {
    observedError = error;
  }

  assert.equal(observedError, cleanupError, 'cleanup-only failure remains observable');
  assert.equal(anchor.parentNode, null);
  assert.deepEqual(events, expectedLifecycle);
}

{
  const revokeError = new Error('browser object-url revoke failed');
  const { anchor, documentRef, events, urlRef } = createDownloadHarness({ revokeError });
  let observedError = null;

  try {
    downloadBlobSafely(new Blob(['schedule export']), 'schedule.json', { documentRef, urlRef });
  } catch (error) {
    observedError = error;
  }

  assert.equal(observedError, revokeError, 'revoke-only failure remains observable');
  assert.equal(anchor.parentNode, null);
  assert.deepEqual(events, expectedLifecycle);
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
  assert.deepEqual(events, expectedLifecycle);
}

{
  const causalError = new Error('browser download dispatch failed');
  const cleanupError = new Error('browser anchor cleanup failed');
  const revokeError = new Error('browser object-url revoke failed');
  const { anchor, documentRef, events, urlRef } = createDownloadHarness({
    clickError: causalError,
    cleanupError,
    revokeError,
  });
  let observedError = null;

  try {
    downloadBlobSafely(new Blob(['calendar export']), 'scopeweave.ics', { documentRef, urlRef });
  } catch (error) {
    observedError = error;
  }

  assert.equal(observedError, causalError, 'cleanup failures must not replace the first download failure');
  assert.equal(anchor.parentNode, null);
  assert.deepEqual(events, expectedLifecycle, 'all cleanup steps still run after the first failure');
}

{
  const cleanupError = new Error('browser anchor cleanup failed');
  const revokeError = new Error('browser object-url revoke failed');
  const { anchor, documentRef, events, urlRef } = createDownloadHarness({ cleanupError, revokeError });
  let observedError = null;

  try {
    downloadBlobSafely(new Blob(['portfolio export']), 'portfolio.json', { documentRef, urlRef });
  } catch (error) {
    observedError = error;
  }

  assert.equal(observedError, cleanupError, 'the first cleanup failure wins over later revocation failure');
  assert.equal(anchor.parentNode, null);
  assert.deepEqual(events, expectedLifecycle);
}
