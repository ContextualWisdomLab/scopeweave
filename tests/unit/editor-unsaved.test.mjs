// Unit coverage for editor dirty-state and rerender-safe focus restoration.
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
  openEditor,
  saveEditor,
  handleInlineProgressChange,
  handleRowAction,
  state,
  DEFAULT_EDITOR_STATE,
};
;globalThis.__setEditorFocusTestHooks = (hooks = {}) => {
  if (hooks.renderAll) renderAll = hooks.renderAll;
  if (hooks.persistState) persistState = hooks.persistState;
  if (hooks.showToast) showToast = hooks.showToast;
  if (hooks.findTask) findTask = hooks.findTask;
  if (hooks.getVisibleTasks) getVisibleTasks = hooks.getVisibleTasks;
  if (hooks.deleteTaskAndDescendants) deleteTaskAndDescendants = hooks.deleteTaskAndDescendants;
};
`;

  const focusEvents = [];
  const selectorQueries = [];
  const idQueries = [];
  const escapeCalls = [];
  const taskRows = [];
  const inlineProgressControls = [];
  let querySelectorImpl;
  let getElementByIdImpl;

  const classList = {
    contains: () => false,
    add() {},
    remove() {},
    toggle() {},
  };
  const dummyElement = new Proxy(
    {
      classList,
      dataset: {},
      style: {},
      value: '',
      textContent: '',
      innerHTML: '',
      checked: false,
      focus() {
        focusEvents.push('focus');
      },
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        // Methods (setAttribute, addEventListener, append, …) must be callable.
        return () => dummyElement;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
  querySelectorImpl = () => dummyElement;
  getElementByIdImpl = () => dummyElement;

  const documentStub = {
    activeElement: null,
    getElementById(id) {
      idQueries.push(id);
      return getElementByIdImpl(id);
    },
    createElement: () => dummyElement,
    createTextNode: () => dummyElement,
    body: dummyElement,
    addEventListener() {},
    querySelector(selector) {
      selectorQueries.push(selector);
      return querySelectorImpl(selector);
    },
    querySelectorAll(selector) {
      selectorQueries.push(selector);
      if (selector === 'tr[data-task-id]') {
        return taskRows.slice();
      }
      if (selector === '[data-inline-progress]') {
        return inlineProgressControls.slice();
      }
      return [];
    },
    title: '',
  };

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

  let animationFrameCount = 0;
  let deferAnimationFrames = false;
  const pendingAnimationFrames = [];
  const requestAnimationFrame = (callback) => {
    animationFrameCount += 1;
    const frameId = animationFrameCount;
    if (deferAnimationFrames) {
      pendingAnimationFrames.push(() => callback(frameId));
    } else {
      callback(frameId);
    }
    return frameId;
  };
  const flushAnimationFrames = () => {
    while (pendingAnimationFrames.length > 0) {
      pendingAnimationFrames.shift()();
    }
  };

  const sandbox = {
    window: windowStub,
    self: windowStub,
    document: documentStub,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    CSS: {
      escape(value) {
        escapeCalls.push(String(value));
        return `safe-${escapeCalls.length}`;
      },
    },
    requestAnimationFrame,
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
  windowStub.requestAnimationFrame = requestAnimationFrame;

  const context = vm.createContext(sandbox);
  // Absolute path is required so c8/V8 maps coverage back to app.js.
  vm.runInContext(source, context, { filename: appJsPath });

  const exportsObj = sandbox.__editorExports;
  if (!exportsObj?.editorHasUnsavedChanges) {
    throw new Error('Failed to extract editor exports from app.js');
  }
  return {
    ...exportsObj,
    windowListeners,
    setConfirm: (fn) => { confirmImpl = fn; },
    setFocusHooks: sandbox.__setEditorFocusTestHooks,
    setActiveElement: (element) => { documentStub.activeElement = element; },
    setQuerySelector: (fn) => { querySelectorImpl = fn; },
    setGetElementById: (fn) => { getElementByIdImpl = fn; },
    setTaskRows: (rows) => {
      taskRows.splice(0, taskRows.length, ...rows);
    },
    setInlineProgressControls: (controls) => {
      inlineProgressControls.splice(0, inlineProgressControls.length, ...controls);
    },
    setAnimationFrameDeferred: (value) => { deferAnimationFrames = Boolean(value); },
    flushAnimationFrames,
    focusEvents,
    selectorQueries,
    idQueries,
    escapeCalls,
  };
}

const {
  editorHasUnsavedChanges,
  bindGlobalEvents,
  closeEditor,
  openEditor,
  saveEditor,
  handleInlineProgressChange,
  handleRowAction,
  state,
  DEFAULT_EDITOR_STATE,
  windowListeners,
  setConfirm,
  setFocusHooks,
  setActiveElement,
  setQuerySelector,
  setGetElementById,
  setTaskRows,
  setInlineProgressControls,
  setAnimationFrameDeferred,
  flushAnimationFrames,
  focusEvents,
  selectorQueries,
  idQueries,
  escapeCalls,
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

state.editor = {
  mode: 'edit',
  draft: { name: 'Task', owner: 'A', description: 'new' },
  initialDraft: { name: 'Task', owner: 'A' },
  errors: [],
};
assert.equal(editorHasUnsavedChanges(), true, 'draft-only field → dirty');

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

// --- rerender-safe focus restoration coverage ---
let renderCount = 0;
let persistCount = 0;
let visibleTasks = [];
const taskById = new Map();
setFocusHooks({
  renderAll() {
    renderCount += 1;
  },
  persistState() {
    persistCount += 1;
  },
  showToast() {},
  findTask(taskId) {
    return taskById.get(taskId) || null;
  },
  getVisibleTasks() {
    return visibleTasks;
  },
  deleteTaskAndDescendants(taskId) {
    visibleTasks = visibleTasks.filter((task) => task.id !== taskId);
    taskById.delete(taskId);
  },
});
setQuerySelector(() => ({ focus() { focusEvents.push('selector-focus'); } }));
setGetElementById(() => ({ focus() { focusEvents.push('id-focus'); } }));
setConfirm(() => true);

function createFocusable(label) {
  return {
    focus() {
      focusEvents.push(label);
    },
  };
}

function createTaskRow(taskId, actions) {
  const buttons = actions.map((action) => {
    const button = createFocusable(`row-focus:${action}`);
    button.dataset = { action };
    return button;
  });
  return {
    dataset: { taskId },
    querySelectorAll(selector) {
      return selector === 'button[data-action]' ? buttons : [];
    },
  };
}

function createInlineControl(taskId) {
  const control = createFocusable('inline-focus');
  control.dataset = { inlineProgress: taskId };
  return control;
}

function assertNoInterpolatedSelectors(queries, label) {
  assert.ok(
    !queries.some((selector) => selector.includes('"') && /data-(?:task-id|action|inline-progress)="/.test(selector)),
    `${label} does not interpolate persisted IDs or actions into CSS selector syntax`,
  );
  assert.equal(escapeCalls.length, 0, `${label} never calls CSS.escape`);
}

const hostileTaskId = 'task\"] [data-action="delete';
const inlineTask = { id: hostileTaskId, expanded: true, actualProgressStatus: '미착수(0%)' };
taskById.set(hostileTaskId, inlineTask);
setInlineProgressControls([
  createInlineControl('unrelated-task'),
  createInlineControl(hostileTaskId),
]);
setTaskRows([
  createTaskRow('unrelated-task', ['toggle', 'edit', 'delete']),
  createTaskRow(hostileTaskId, ['toggle', 'edit', 'delete']),
]);
handleInlineProgressChange({
  target: {
    dataset: { inlineProgress: hostileTaskId },
    value: '진행(50%)',
  },
});
assert.equal(inlineTask.actualProgressStatus, '진행(50%)', 'inline progress update is preserved');
assert.ok(selectorQueries.includes('[data-inline-progress]'), 'inline focus enumerates fixed data-inline-progress controls');
assertNoInterpolatedSelectors(selectorQueries, 'inline focus');
assert.ok(persistCount >= 1 && renderCount >= 1, 'inline progress still persists and rerenders before focus restoration');
assert.ok(focusEvents.includes('inline-focus'), 'inline progress restores focus to the rerendered control');

const toggleQueryStart = selectorQueries.length;
handleRowAction('toggle', hostileTaskId);
assert.equal(inlineTask.expanded, false, 'toggle action still updates expansion state');
assert.ok(selectorQueries.slice(toggleQueryStart).includes('tr[data-task-id]'), 'toggle restoration enumerates task rows with a fixed selector');
assertNoInterpolatedSelectors(selectorQueries.slice(toggleQueryStart), 'toggle focus');
assert.ok(focusEvents.includes('row-focus:toggle'), 'toggle restoration resolves the rerendered toggle button by dataset equality');

const deleteTaskId = 'delete\"] button[data-action="edit';
const successorTaskId = 'successor\"] button[data-action="toggle';
const deleteTask = { id: deleteTaskId, task: 'Delete me' };
const successorTask = { id: successorTaskId, task: 'Keep me' };
visibleTasks = [deleteTask, successorTask];
taskById.set(deleteTaskId, deleteTask);
taskById.set(successorTaskId, successorTask);
setTaskRows([
  createTaskRow(deleteTaskId, ['toggle', 'edit', 'delete']),
  createTaskRow(successorTaskId, ['toggle', 'edit', 'delete']),
]);
const deleteQueryStart = selectorQueries.length;
const deleteFocusStart = focusEvents.length;
handleRowAction('delete', deleteTaskId);
assert.deepEqual(visibleTasks.map((task) => task.id), [successorTaskId], 'delete path keeps the successor visible');
assert.ok(selectorQueries.slice(deleteQueryStart).includes('tr[data-task-id]'), 'delete restoration enumerates task rows with a fixed selector');
assertNoInterpolatedSelectors(selectorQueries.slice(deleteQueryStart), 'delete-successor focus');
assert.ok(focusEvents.slice(deleteFocusStart).includes('row-focus:delete'), 'delete restoration resolves a successor delete button by dataset equality');

setTaskRows([
  createTaskRow('unrelated-task', ['toggle', 'edit', 'delete']),
  createTaskRow(hostileTaskId, ['toggle', 'edit', 'delete']),
]);
const invokingControl = {
  id: 'edit-trigger',
  dataset: { action: 'edit' },
  closest(selector) {
    assert.equal(selector, 'tr');
    return { dataset: { taskId: hostileTaskId } };
  },
};
setActiveElement(invokingControl);
openEditor({ mode: 'create', parentId: null, depth: 1, draft: { task: 'Draft' } });
assert.equal(state.previousFocus.id, 'edit-trigger', 'openEditor records the stable element ID');
assert.equal(state.previousFocus.action, 'edit', 'openEditor records the stable action identity');
assert.equal(state.previousFocus.taskId, hostileTaskId, 'openEditor records the owning task identity');
const closeQueryStart = selectorQueries.length;
const closeFocusStart = focusEvents.length;
closeEditor(true);
assert.ok(selectorQueries.slice(closeQueryStart).includes('tr[data-task-id]'), 'closeEditor enumerates task rows with a fixed selector');
assertNoInterpolatedSelectors(selectorQueries.slice(closeQueryStart), 'closeEditor');
assert.ok(focusEvents.slice(closeFocusStart).includes('row-focus:edit'), 'closeEditor restores the allowlisted edit button by dataset equality');
assert.equal(state.previousFocus, null, 'closeEditor clears the stable focus descriptor after scheduling restoration');

setActiveElement({
  id: 'standalone-trigger',
  dataset: {},
  closest: () => null,
});
openEditor({ mode: 'create', parentId: null, depth: 1, draft: { task: 'Draft' } });
assert.equal(state.previousFocus.taskId, null, 'openEditor records an ID-only fallback when the invoker is outside a task row');
closeEditor(true);
assert.ok(idQueries.includes('standalone-trigger'), 'ID-only restoration resolves the newly rendered element by ID');

// saveEditor() closes the editor and performs one more full render before the
// browser runs requestAnimationFrame. Model that scheduling boundary explicitly
// so the unit coverage proves focus is resolved only after the final render.
setActiveElement({
  id: 'add-root-task',
  dataset: {},
  closest: () => null,
});
openEditor({ mode: 'create', parentId: null, depth: 1, draft: { phase: 'Saved phase' } });
const saveRenderStart = renderCount;
const saveFocusEvent = `save-focus-render-${saveRenderStart + 2}`;
setGetElementById((id) => ({
  focus() {
    focusEvents.push(id === 'add-root-task' ? `save-focus-render-${renderCount}` : 'id-focus');
  },
}));
setAnimationFrameDeferred(true);
saveEditor();
assert.equal(renderCount, saveRenderStart + 2, 'save closes the editor and completes its final rerender before deferred focus');
assert.equal(focusEvents.includes(saveFocusEvent), false, 'save focus waits for the deferred animation frame');
flushAnimationFrames();
assert.ok(idQueries.includes('add-root-task'), 'save restoration resolves the stable add-root-task ID');
assert.ok(focusEvents.includes(saveFocusEvent), 'save restores focus after the final save-triggered render');
setAnimationFrameDeferred(false);
setGetElementById(() => ({ focus() { focusEvents.push('id-focus'); } }));

state.previousFocus = { id: 'fallback-trigger', action: '', taskId: hostileTaskId };
closeEditor(true);
assert.ok(idQueries.includes('fallback-trigger'), 'missing action falls back to stable element ID even when a task ID exists');

const disallowedAction = 'edit"] [data-action="delete';
const disallowedQueryStart = selectorQueries.length;
const disallowedFocusStart = focusEvents.length;
state.previousFocus = { id: '', action: disallowedAction, taskId: hostileTaskId };
closeEditor(true);
assertNoInterpolatedSelectors(selectorQueries.slice(disallowedQueryStart), 'disallowed action');
assert.equal(focusEvents.length, disallowedFocusStart, 'disallowed actions fail closed without restoring a row control');

const focusCountBeforeMissing = focusEvents.length;
setGetElementById((id) => (id === 'missing-trigger' ? null : { focus() { focusEvents.push('id-focus'); } }));
state.previousFocus = { id: 'missing-trigger', action: null, taskId: null };
closeEditor(true);
assert.equal(focusEvents.length, focusCountBeforeMissing, 'missing rerender target is safely ignored');

state.previousFocus = {};
closeEditor(true);
assert.equal(state.previousFocus, null, 'empty focus descriptors fail closed without querying a selector');

setActiveElement(null);
openEditor({ mode: 'create', parentId: null, depth: 1, draft: { task: 'Draft' } });
assert.equal(state.previousFocus, null, 'openEditor handles an absent active element without retaining stale focus state');

console.log('✓ editor dirty-state and rerender focus coverage tests passed');
