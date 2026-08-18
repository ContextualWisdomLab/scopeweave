import assert from 'node:assert/strict';

import { downloadBlobSafely } from '../../cloud-sync.js';

function createHarness({ clickError = null } = {}) {
  const events = [];
  const anchorPrototype = {
    remove() {
      events.push('prototype-remove');
      this.isConnected = false;
    },
  };
  const anchor = Object.create(anchorPrototype);
  anchor.isConnected = false;
  anchor.click = () => {
    events.push('click');
    if (clickError) throw clickError;
  };
  Object.defineProperty(anchor, 'remove', {
    configurable: true,
    value() {
      throw new Error('clobbered instance remove must not run');
    },
  });

  const documentRef = {
    createElement(tagName) {
      assert.equal(tagName, 'a');
      events.push('create-anchor');
      return anchor;
    },
    body: {
      appendChild(node) {
        assert.equal(node, anchor);
        events.push('append-anchor');
        node.isConnected = true;
      },
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
  const { anchor, documentRef, events, urlRef } = createHarness();
  downloadBlobSafely(new Blob(['buyer export']), 'scopeweave-export.json', { documentRef, urlRef });

  assert.equal(anchor.download, 'scopeweave-export.json');
  assert.equal(anchor.href, 'blob:scopeweave-test');
  assert.equal(anchor.rel, 'noopener noreferrer');
  assert.equal(anchor.isConnected, false);
  assert.deepEqual(events, [
    'create-url',
    'create-anchor',
    'append-anchor',
    'click',
    'prototype-remove',
    'revoke-url',
  ]);
}

{
  const causalError = new Error('browser download dispatch failed');
  const { anchor, documentRef, events, urlRef } = createHarness({ clickError: causalError });

  assert.throws(
    () => downloadBlobSafely(new Blob(['audit export']), 'audit.csv', { documentRef, urlRef }),
    (error) => error === causalError,
  );
  assert.equal(anchor.isConnected, false);
  assert.deepEqual(events, [
    'create-url',
    'create-anchor',
    'append-anchor',
    'click',
    'prototype-remove',
    'revoke-url',
  ]);
}
