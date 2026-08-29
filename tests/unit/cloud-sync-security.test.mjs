import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { downloadBlobSafely, routeTokenPathSegment } from '../../cloud-sync.js';

assert.equal(routeTokenPathSegment('abc_DEF-1234567890'), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('  abc_DEF-1234567890  '), 'abc_DEF-1234567890');
assert.equal(routeTokenPathSegment('../admin?force=true'), '');
assert.equal(routeTokenPathSegment('https://example.test/api'), '');
assert.equal(routeTokenPathSegment('short'), '');

function createDownloadHarness({
  createError = null,
  appendError = null,
  clickError = null,
  cleanupError = null,
  revokeError = null,
} = {}) {
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
      if (appendError) throw appendError;
      anchor.parentNode = body;
      return anchor;
    },
  };

  const documentRef = {
    body,
    createElement(tagName) {
      assert.equal(tagName, 'a');
      events.push('create-anchor');
      if (createError) throw createError;
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
  const createError = new Error('browser anchor creation failed');
  const revokeError = new Error('browser object-url revoke failed');
  const { documentRef, events, urlRef } = createDownloadHarness({ createError, revokeError });
  let observedError = null;

  try {
    downloadBlobSafely(new Blob(['creation failure']), 'creation.json', { documentRef, urlRef });
  } catch (error) {
    observedError = error;
  }

  assert.equal(observedError, createError, 'anchor-creation failure remains the first causal error');
  assert.deepEqual(
    events,
    ['create-url', 'create-anchor', 'revoke-url'],
    'object URL revocation is still attempted when no anchor was successfully created',
  );
}

{
  const appendError = new Error('browser anchor attachment failed');
  const cleanupError = new Error('browser anchor cleanup failed');
  const revokeError = new Error('browser object-url revoke failed');
  const { anchor, documentRef, events, urlRef } = createDownloadHarness({
    appendError,
    cleanupError,
    revokeError,
  });
  let observedError = null;

  try {
    downloadBlobSafely(new Blob(['attachment failure']), 'attachment.json', { documentRef, urlRef });
  } catch (error) {
    observedError = error;
  }

  assert.equal(observedError, appendError, 'anchor-attachment failure wins over cleanup and revocation failures');
  assert.equal(anchor.parentNode, null);
  assert.deepEqual(
    events,
    ['create-url', 'create-anchor', 'append-anchor', 'prototype-remove', 'revoke-url'],
    'every reachable cleanup step runs after anchor attachment fails',
  );
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

const appJsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.js');

function loadLocalDownloadFile({ clickError = null, cleanupError = null, revokeError = null } = {}) {
  let source = fs.readFileSync(appJsPath, 'utf8');
  const withoutBootstrap = source.replace(/^\s*bootstrap\(\);\s*$/m, ';');
  if (withoutBootstrap === source) {
    throw new Error('Failed to strip the bootstrap() call from app.js');
  }
  source = withoutBootstrap;
  source += '\n;globalThis.__downloadFile = downloadFile;\n';

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
      throw new Error('local download cleanup must not trust the anchor remove method');
    },
  });

  const classList = {
    contains: () => false,
    add() {},
    remove() {},
    toggle() {},
  };
  const dummyElement = new Proxy(
    { classList, style: {}, value: '', textContent: '', innerHTML: '', checked: false },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => dummyElement;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
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
    getElementById: () => dummyElement,
    createElement(tagName) {
      if (tagName === 'a') {
        events.push('create-anchor');
        return anchor;
      }
      return dummyElement;
    },
    addEventListener() {},
    querySelector: () => dummyElement,
    querySelectorAll: () => [],
  };
  class SandboxURL extends URL {}
  SandboxURL.createObjectURL = (blob) => {
    assert.ok(blob instanceof Blob);
    events.push('create-url');
    return 'blob:scopeweave-local-test';
  };
  SandboxURL.revokeObjectURL = (url) => {
    assert.equal(url, 'blob:scopeweave-local-test');
    events.push('revoke-url');
    if (revokeError) throw revokeError;
  };
  const windowStub = {
    addEventListener() {},
    removeEventListener() {},
    confirm: () => true,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  const sandbox = {
    window: windowStub,
    self: windowStub,
    document: documentRef,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    fetch: () => Promise.reject(new Error('fetch disabled in local download harness')),
    AbortController: globalThis.AbortController,
    Blob,
    crypto: globalThis.crypto,
    Uint32Array,
    console,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    requestAnimationFrame: (callback) => callback(),
    Date,
    Math,
    JSON,
    Object,
    Array,
    Set,
    Map,
    WeakMap,
    Symbol,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    URL: SandboxURL,
    Proxy,
    Reflect,
    Promise,
  };
  sandbox.globalThis = sandbox;
  windowStub.window = windowStub;

  vm.runInContext(source, vm.createContext(sandbox), { filename: appJsPath });
  if (typeof sandbox.__downloadFile !== 'function') {
    throw new Error('Failed to extract downloadFile from app.js');
  }
  return { downloadFile: sandbox.__downloadFile, events };
}

{
  const causalError = new Error('local download dispatch failed');
  const revokeError = new Error('local object-url revoke failed');
  const { downloadFile, events } = loadLocalDownloadFile({ clickError: causalError, revokeError });
  let observedError = null;

  try {
    downloadFile('buyer csv', 'wbs.csv', 'text/csv');
  } catch (error) {
    observedError = error;
  }

  assert.equal(observedError, causalError, 'local CSV export must preserve the click failure over revoke cleanup');
  assert.deepEqual(events, expectedLifecycle, 'local CSV export still attempts every cleanup step after click failure');
}

{
  const cleanupError = new Error('local anchor cleanup failed');
  const revokeError = new Error('local object-url revoke failed');
  const { downloadFile, events } = loadLocalDownloadFile({ cleanupError, revokeError });
  let observedError = null;

  try {
    downloadFile('buyer csv', 'wbs.csv', 'text/csv');
  } catch (error) {
    observedError = error;
  }

  assert.equal(observedError, cleanupError, 'local CSV export must surface the first cleanup failure');
  assert.deepEqual(events, expectedLifecycle, 'local CSV export attempts object-url revocation after cleanup failure');
}

{
  const revokeError = new Error('local object-url revoke failed');
  const { downloadFile, events } = loadLocalDownloadFile({ revokeError });
  let observedError = null;

  try {
    downloadFile('buyer csv', 'wbs.csv', 'text/csv');
  } catch (error) {
    observedError = error;
  }

  assert.equal(observedError, revokeError, 'local CSV export must surface a revoke-only failure');
  assert.deepEqual(events, expectedLifecycle, 'local CSV export attempts revocation after a successful click');
}

class CloudElementStub {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.childNodes = this.children;
    this.listeners = new Map();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classList._names.add(name)),
      remove: (...names) => names.forEach((name) => this.classList._names.delete(name)),
      contains: (name) => this.classList._names.has(name),
      _names: new Set(),
    };
    this.style = {};
    this.dataset = {};
    this.parentNode = null;
    this.textContent = '';
    this.innerHTML = '';
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }

  querySelector(selector) {
    if (selector.startsWith('#') && this.id === selector.slice(1)) return this;
    for (const child of this.children) {
      const match = child.querySelector?.(selector);
      if (match) return match;
    }
    return null;
  }
}

function loadCloudDownloadCallers() {
  const cloudSyncPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cloud-sync.js');
  let source = fs.readFileSync(cloudSyncPath, 'utf8')
    .replaceAll(/^export (?=function|const)/gm, '       ');
  source += '\n;globalThis.__cloudDownloadCoverage = { exportOrg, openBaselineModal, renderAudit, setOrgId: (id) => { currentOrgId = id; } };\n';

  const storage = new Map([
    ['scopeweave:token', 'test-token'],
    ['scopeweave:project', '7'],
  ]);
  const calls = [];
  const downloads = [];
  const body = new CloudElementStub('body');
  const toastElement = new CloudElementStub('output');
  toastElement.id = 'toast';
  body.appendChild(toastElement);

  const response = ({ json = {}, blob = new Blob(['download']), status = 200 } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => json,
    blob: async () => blob,
  });

  const fetchRef = async (requestPath) => {
    const url = String(requestPath);
    calls.push(url);
    if (url === '/api/orgs/42/export') return response({ blob: new Blob(['org export']) });
    if (url === '/api/projects/7/revisions') return response({ json: { revisions: [] } });
    if (url === '/api/projects/7/baselines') return response({ json: { baselines: [] } });
    if (url === '/api/projects/7/calendar.ics') return response({ blob: new Blob(['calendar']) });
    if (url === '/api/orgs/42/audit?limit=12') {
      return response({ json: { events: [{ action: 'project.create', actorEmail: 'owner@example.test', createdAt: '2026-08-29T12:34:56Z' }] } });
    }
    if (url === '/api/orgs/42/audit?format=csv&limit=500') return response({ blob: new Blob(['audit']) });
    throw new Error(`unexpected cloud download request: ${url}`);
  };

  const anchorPrototype = {
    remove() {
      this.parentNode = null;
    },
  };
  const documentRef = {
    body,
    createElement(tagName) {
      if (tagName !== 'a') return new CloudElementStub(tagName);
      const anchor = Object.create(anchorPrototype);
      anchor.parentNode = null;
      anchor.click = () => undefined;
      downloads.push(anchor);
      return anchor;
    },
    getElementById(id) {
      if (id === 'toast') return toastElement;
      return body.querySelector(`#${id}`);
    },
    querySelector: () => null,
  };
  class SandboxURL extends URL {}
  SandboxURL.createObjectURL = () => 'blob:scopeweave-cloud-test';
  SandboxURL.revokeObjectURL = () => undefined;
  const windowStub = {
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  const locationStub = {
    origin: 'http://scopeweave.test',
    pathname: '/',
    search: '',
    hash: '',
  };
  const sandbox = {
    window: windowStub,
    self: windowStub,
    document: documentRef,
    location: locationStub,
    history: { replaceState() {} },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    fetch: fetchRef,
    Blob,
    URL: SandboxURL,
    URLSearchParams,
    EventSource: class {},
    navigator: { clipboard: { writeText: async () => undefined } },
    prompt: () => null,
    confirm: () => true,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Set,
    Map,
    WeakMap,
    Symbol,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    Promise,
    encodeURIComponent,
    decodeURIComponent,
    console,
  };
  sandbox.globalThis = sandbox;
  windowStub.window = windowStub;
  vm.runInContext(source, vm.createContext(sandbox), { filename: cloudSyncPath });
  return { body, calls, downloads, functions: sandbox.__cloudDownloadCoverage };
}

{
  const { body, calls, downloads, functions } = loadCloudDownloadCallers();
  functions.setOrgId(42);

  await functions.exportOrg();
  assert.ok(calls.includes('/api/orgs/42/export'));
  assert.equal(downloads.at(-1).download, 'scopeweave-org-42.json');

  await functions.openBaselineModal();
  const calendarButton = body.querySelector('#baseline-panel').children.find((child) => child.textContent === '캘린더 내보내기 (.ics)');
  assert.ok(calendarButton);
  await calendarButton.listeners.get('click')[0]();
  assert.ok(calls.includes('/api/projects/7/calendar.ics'));
  assert.equal(downloads.at(-1).download, 'scopeweave-7.ics');

  const auditBody = new CloudElementStub('section');
  await functions.renderAudit(auditBody);
  const csvButton = auditBody.children[0]?.children.find((child) => child.textContent === 'CSV 다운로드');
  assert.ok(csvButton);
  await csvButton.listeners.get('click')[0]();
  assert.ok(calls.includes('/api/orgs/42/audit?format=csv&limit=500'));
  assert.equal(downloads.at(-1).download, 'scopeweave-audit-42.csv');
}
