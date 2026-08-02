// Unit coverage for editorHasUnsavedChanges + beforeunload dirty-draft guard.
// app.js is browser-first; evaluate under vm with an absolute filename so c8/V8
// attributes coverage to app.js (same pattern as tests/fuzz/harness.mjs).
// Run: node tests/unit/editor-unsaved.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const appJsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.js');

function loadApp() {
  let source = fs.readFileSync(appJsPath, 'utf8');
  source = source.replace(/^\s*bootstrap\(\);\s*$/m, ';');
  source += `
;globalThis.__editorExports = {
  editorHasUnsavedChanges,
  bindGlobalEvents,
  closeEditor,
  state,
  DEFAULT_EDITOR_STATE,
};
`;

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
        // Methods (setAttribute, focus, addEventListener, …) must be callable.
        return () => dummyElement;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );

  const windowListeners = Object.create(null);
  let confirmImpl = () => true;
  const windowStub = {
    addEventListener(type, handler) {
      (windowListeners[type] ||= []).push(handler);
    },
    removeEventListener() {},
    confirm(msg) {
      return confirmImpl(msg);
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };

  const sandbox = {
    window: windowStub,
    self: windowStub,
    document: {
      getElementById: () => dummyElement,
      createElement: () => dummyElement,
      body: dummyElement,
      addEventListener() {},
      querySelector: () => dummyElement,
      querySelectorAll: () => [],
    },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    fetch: () => Promise.reject(new Error('fetch disabled in unit harness')),
    AbortController: globalThis.AbortController,
    crypto: globalThis.crypto,
    Uint32Array,
    console,
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
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    URL: globalThis.URL,
    Proxy,
    Reflect,
    Promise,
  };
  sandbox.globalThis = sandbox;
  windowStub.window = windowStub;

  const context = vm.createContext(sandbox);
  // Absolute path is required so c8/V8 maps coverage back to app.js.
  vm.runInContext(source, context, { filename: appJsPath });

  const exportsObj = sandbox.__editorExports;
  if (!exportsObj?.editorHasUnsavedChanges) {
    throw new Error('Failed to extract editor exports from app.js');
  }
  return { ...exportsObj, windowListeners, setConfirm: (fn) => { confirmImpl = fn; } };
}

const {
  editorHasUnsavedChanges,
  bindGlobalEvents,
  closeEditor,
  state,
  DEFAULT_EDITOR_STATE,
  windowListeners,
  setConfirm,
} = loadApp();

// --- editorHasUnsavedChanges ---
state.editor = { mode: null, draft: null, initialDraft: null, errors: [] };
assert.equal(editorHasUnsavedChanges(), false, 'no mode → clean');

state.editor = { mode: 'edit', draft: null, initialDraft: { name: 'a' }, errors: [] };
assert.equal(editorHasUnsavedChanges(), false, 'missing draft → clean');

state.editor = { mode: 'edit', draft: { name: 'a' }, initialDraft: null, errors: [] };
assert.equal(editorHasUnsavedChanges(), false, 'missing initialDraft → clean');

state.editor = {
  mode: 'edit',
  draft: { name: 'Task', owner: 'A' },
  initialDraft: { name: 'Task', owner: 'A' },
  errors: [],
};
assert.equal(editorHasUnsavedChanges(), false, 'identical draft → clean');

state.editor = {
  mode: 'edit',
  draft: { name: 'Task*', owner: 'A' },
  initialDraft: { name: 'Task', owner: 'A' },
  errors: [],
};
assert.equal(editorHasUnsavedChanges(), true, 'mutated field → dirty');

// --- beforeunload ---
bindGlobalEvents();
const handlers = windowListeners.beforeunload || [];
assert.ok(handlers.length >= 1, 'beforeunload listener registered');

function fireBeforeUnload() {
  const event = {
    prevented: false,
    returnValue: undefined,
    preventDefault() {
      this.prevented = true;
    },
  };
  for (const h of handlers) h(event);
  return event;
}

state.editor = { mode: 'edit', draft: { name: 'x' }, initialDraft: { name: 'x' }, errors: [] };
let ev = fireBeforeUnload();
assert.equal(ev.prevented, false, 'clean draft does not block unload');
assert.equal(ev.returnValue, undefined, 'clean draft leaves returnValue alone');

state.editor = { mode: 'edit', draft: { name: 'dirty' }, initialDraft: { name: 'x' }, errors: [] };
ev = fireBeforeUnload();
assert.equal(ev.prevented, true, 'dirty draft blocks unload');
assert.equal(ev.returnValue, '', 'dirty draft sets returnValue for browsers');

// --- closeEditor confirm paths ---
state.editor = {
  mode: 'edit',
  draft: { name: 'dirty' },
  initialDraft: { name: 'clean' },
  errors: [],
  targetId: 't1',
};
state.previousFocus = null;
setConfirm(() => false);
closeEditor(false);
assert.equal(state.editor.mode, 'edit', 'discard declined keeps editor open');

setConfirm(() => true);
closeEditor(false);
assert.equal(state.editor.mode, DEFAULT_EDITOR_STATE.mode, 'discard accepted resets editor');

state.editor = {
  mode: 'edit',
  draft: { name: 'same' },
  initialDraft: { name: 'same' },
  errors: [],
};
closeEditor(false);
assert.equal(state.editor.mode, DEFAULT_EDITOR_STATE.mode, 'clean close without confirm');

state.editor = {
  mode: 'edit',
  draft: { name: 'dirty' },
  initialDraft: { name: 'clean' },
  errors: [],
};
setConfirm(() => {
  throw new Error('confirm must not run when force=true');
});
closeEditor(true);
assert.equal(state.editor.mode, DEFAULT_EDITOR_STATE.mode, 'force close skips confirm');

console.log('✓ editor unsaved / beforeunload coverage tests passed');
