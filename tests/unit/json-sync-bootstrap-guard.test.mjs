import assert from 'node:assert/strict';

const attributes = new Map();
const syncButton = {
  disabled: false,
  title: '',
  setAttribute(name, value) {
    attributes.set(name, value);
  },
  removeAttribute(name) {
    attributes.delete(name);
  },
};
const taskTableBody = { childElementCount: 0 };

let observerCallback = null;
let observedTarget = null;
let observedOptions = null;
let disconnectCalls = 0;

class FakeMutationObserver {
  constructor(callback) {
    observerCallback = callback;
  }

  observe(target, options) {
    observedTarget = target;
    observedOptions = options;
  }

  disconnect() {
    disconnectCalls += 1;
  }
}

globalThis.document = {
  getElementById(id) {
    if (id === 'connect-json-sync') {
      return syncButton;
    }
    if (id === 'task-table-body') {
      return taskTableBody;
    }
    return null;
  },
};
globalThis.window = {};
globalThis.MutationObserver = FakeMutationObserver;

try {
  await import('../../json-sync-bootstrap-guard.js');

  assert.equal(syncButton.disabled, true);
  assert.equal(attributes.get('aria-disabled'), 'true');
  assert.equal(syncButton.title, '프로젝트 데이터를 불러오는 중입니다.');
  assert.equal(observedTarget, taskTableBody);
  assert.deepEqual(observedOptions, { childList: true });
  assert.equal(typeof observerCallback, 'function');

  observerCallback();
  assert.equal(disconnectCalls, 0);
  assert.equal(syncButton.disabled, true);
  assert.equal(syncButton.title, '프로젝트 데이터를 불러오는 중입니다.');

  taskTableBody.childElementCount = 1;
  observerCallback();
  assert.equal(disconnectCalls, 1);
  assert.equal(syncButton.disabled, true);
  assert.equal(attributes.get('aria-disabled'), 'true');
  assert.equal(syncButton.title, '이 브라우저는 wbs.json 직접 저장 연결을 지원하지 않습니다.');

  globalThis.window.showSaveFilePicker = async () => {};
  observerCallback();
  assert.equal(disconnectCalls, 2);
  assert.equal(syncButton.disabled, false);
  assert.equal(attributes.has('aria-disabled'), false);
  assert.equal(syncButton.title, '');
} finally {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.MutationObserver;
}

console.log('✓ JSON sync bootstrap guard behavior tests passed');
