import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const appJsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.js');

function loadApp() {
  let createElementCalls = 0;
  let source = fs.readFileSync(appJsPath, 'utf8');
  source = source.replace(/^\s*bootstrap\(\);\s*$/m, ';');
  source += `
;globalThis.__cachingExports = {
  createStatusCellContent,
  createOwnerCellContent,
  createActualProgressCellContent,
  getStatusBadgeTemplate: () => statusBadgeTemplate,
  getOwnerBadgeTemplate: () => ownerBadgeTemplate,
  getActualProgressSelectTemplate: () => actualProgressSelectTemplate,
};
`;

  class DummyNode {
    constructor(name) {
      this.name = name;
      this.attributes = Object.create(null);
      this.dataset = Object.create(null);
      this.style = Object.create(null);
      this.children = [];
    }
    set className(value) { this.attributes.class = value; }
    get className() { return this.attributes.class; }
    set textContent(value) { this.text = value; }
    get textContent() { return this.text; }
    set title(value) { this.titleAttribute = value; }
    get title() { return this.titleAttribute; }
    setAttribute(key, value) { this.attributes[key] = value; }
    appendChild(child) { this.children.push(child); }
    append(...children) { this.children.push(...children); }
    cloneNode(deep) {
      const node = new DummyNode(this.name);
      node.attributes = { ...this.attributes };
      node.dataset = { ...this.dataset };
      node.style = { ...this.style };
      node.titleAttribute = this.titleAttribute;
      node.id = this.id;
      node.value = this.value;
      if (deep) {
        node.text = this.text;
        node.children = this.children.map((child) => child.cloneNode(true));
      }
      return node;
    }
  }

  const dummyElement = new DummyNode('div');
  const classList = {
    contains: () => false,
    add() {},
    remove() {},
    toggle() {},
  };
  const proxyDummy = new Proxy(dummyElement, {
    get(target, property) {
      if (property === 'classList') return classList;
      if (property in target) return target[property];
      return () => proxyDummy;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  });

  const sandbox = {
    document: {
      createElement: (name) => {
        createElementCalls += 1;
        return new DummyNode(name);
      },
      getElementById: () => proxyDummy,
      querySelector: () => proxyDummy,
      querySelectorAll: () => [],
      body: proxyDummy,
      addEventListener() {},
    },
    window: {
      addEventListener() {},
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      confirm: () => true,
    },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    console,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    WeakMap,
    Symbol,
    Error,
    TypeError,
    Date,
    JSON,
    Proxy,
    Promise,
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: appJsPath });

  return {
    ...sandbox.__cachingExports,
    getCreateElementCalls: () => createElementCalls,
  };
}

const {
  createStatusCellContent,
  createOwnerCellContent,
  createActualProgressCellContent,
  getStatusBadgeTemplate,
  getOwnerBadgeTemplate,
  getActualProgressSelectTemplate,
  getCreateElementCalls,
} = loadApp();

const doneState = {
  label: '완료',
  className: 'done',
  description: '실적이 모두 입력되어 완료된 작업입니다.',
};

const firstDoneCell = createStatusCellContent(doneState);
assert.equal(firstDoneCell.text, '완료');
assert.equal(firstDoneCell.className, 'status-badge done');
assert.equal(firstDoneCell.title, doneState.description);
assert.equal(
  firstDoneCell.attributes['aria-label'],
  `완료 - ${doneState.description}`,
);
const statusShell = getStatusBadgeTemplate();
assert.equal(statusShell.className, 'status-badge');
assert.equal(statusShell.textContent, undefined, 'cached status shell must not retain row text');
assert.equal(statusShell.title, undefined, 'cached status shell must not retain row title');
assert.equal(
  statusShell.attributes['aria-label'],
  undefined,
  'cached status shell must not retain row accessibility text',
);

const equivalentDoneCell = createStatusCellContent({ ...doneState });
assert.notEqual(firstDoneCell, equivalentDoneCell);
assert.equal(equivalentDoneCell.text, '완료');
assert.equal(getStatusBadgeTemplate(), statusShell, 'status rendering reuses one immutable shell');

const revisedDescription = '완료되었지만 검토가 필요한 작업입니다.';
const revisedDoneCell = createStatusCellContent({
  ...doneState,
  description: revisedDescription,
});
assert.equal(revisedDoneCell.title, revisedDescription);
assert.equal(
  revisedDoneCell.attributes['aria-label'],
  `완료 - ${revisedDescription}`,
);
assert.equal(statusShell.textContent, undefined, 'status shell remains free of revised row text');
assert.equal(statusShell.title, undefined, 'status shell remains free of revised row descriptions');

const createElementCallsBeforeStatuses = getCreateElementCalls();
for (let index = 0; index < 300; index += 1) {
  createStatusCellContent({
    label: `status-${index}`,
    className: `state-${index}`,
    description: `description-${index}`,
  });
}
assert.equal(
  getCreateElementCalls() - createElementCallsBeforeStatuses,
  0,
  'status values clone one immutable shell without allocating per-value templates',
);
assert.equal(statusShell.textContent, undefined, 'status shell never retains customer status values');

const emptyState = { label: '', className: '', description: '' };
const emptyCell = createStatusCellContent(emptyState);
assert.equal(emptyCell.name, 'span');
assert.equal(emptyCell.className, 'empty-cell');

const firstOwnerCell = createOwnerCellContent('홍길동');
assert.equal(firstOwnerCell.text, '홍길동');
assert.match(firstOwnerCell.className, /^owner-badge owner-badge--color-\d+$/);
assert.equal(firstOwnerCell.style.background, undefined, 'owner color must not use inline style');
const ownerShell = getOwnerBadgeTemplate();
assert.equal(ownerShell.className, 'owner-badge');
assert.equal(ownerShell.textContent, undefined, 'cached owner shell must not retain user data');
assert.equal(ownerShell.style.background, undefined, 'cached owner shell must not retain inline color');

const secondOwnerCell = createOwnerCellContent('홍길동');
assert.notEqual(firstOwnerCell, secondOwnerCell);
assert.equal(secondOwnerCell.text, '홍길동');
assert.equal(firstOwnerCell.className, secondOwnerCell.className, 'owner color class stays deterministic');
assert.equal(getOwnerBadgeTemplate(), ownerShell, 'owner rendering reuses one immutable shell');

const createElementCallsBeforeOwners = getCreateElementCalls();
for (let index = 0; index < 300; index += 1) {
  const ownerCell = createOwnerCellContent(`owner-${index}`);
  assert.match(ownerCell.className, /^owner-badge owner-badge--color-\d+$/);
}
assert.equal(
  getCreateElementCalls() - createElementCallsBeforeOwners,
  0,
  'unique owner values clone one immutable shell without allocating user-keyed templates',
);
assert.equal(ownerShell.textContent, undefined, 'owner shell never retains customer owner values');

const createElementCallsBeforeVolume = getCreateElementCalls();
for (let rowIndex = 0; rowIndex < 5_000; rowIndex += 1) {
  createOwnerCellContent('same-owner');
}
assert.equal(
  getCreateElementCalls() - createElementCallsBeforeVolume,
  0,
  '5,000 identical owner rows clone the existing immutable shell without new elements',
);

const emptyOwner = createOwnerCellContent('');
assert.equal(emptyOwner.className, 'empty-cell');

// Issue #409 also requires the pre-existing cached progress <select> shell to
// remain detached from row-specific IDs, task data, selected values, and
// validation metadata. Exercise two rows with different validation states so a
// cached clone cannot leak aria-invalid/aria-describedby into the next row.
const warningTask = {
  id: 'task-a',
  task: '검증 필요 작업',
  activity: '',
  phase: 'Phase A',
  actualProgressStatus: '진행(50%)',
};
const warningProgressCell = createActualProgressCellContent(warningTask, {
  plannedDateWarning: '계획 일정 검증 필요',
  actualDateWarning: '',
});
const warningSelect = warningProgressCell.children[1];
assert.equal(warningSelect.name, 'select');
assert.equal(warningSelect.id, 'actual-progress-task-a');
assert.equal(warningSelect.dataset.inlineProgress, 'task-a');
assert.equal(warningSelect.value, '진행(50%)');
assert.equal(warningSelect.attributes['aria-invalid'], 'true');
assert.equal(warningSelect.attributes['aria-describedby'], 'actual-progress-error-task-a');

const progressShell = getActualProgressSelectTemplate();
assert.equal(progressShell.name, 'select');
assert.equal(progressShell.id, undefined, 'cached progress shell must not retain a row ID');
assert.equal(progressShell.dataset.inlineProgress, undefined, 'cached progress shell must not retain a task ID');
assert.equal(progressShell.value, undefined, 'cached progress shell must not retain a selected row value');
assert.equal(progressShell.attributes['aria-invalid'], undefined, 'cached progress shell must not retain validation state');
assert.equal(progressShell.attributes['aria-describedby'], undefined, 'cached progress shell must not retain validation references');

const cleanTask = {
  id: 'task-b',
  task: '정상 작업',
  activity: '',
  phase: 'Phase A',
  actualProgressStatus: '완료(100%)',
};
const cleanProgressCell = createActualProgressCellContent(cleanTask, {
  plannedDateWarning: '',
  actualDateWarning: '',
});
const cleanSelect = cleanProgressCell.children[1];
assert.notEqual(cleanSelect, warningSelect, 'each progress row receives a distinct select clone');
assert.equal(cleanSelect.id, 'actual-progress-task-b');
assert.equal(cleanSelect.dataset.inlineProgress, 'task-b');
assert.equal(cleanSelect.value, '완료(100%)');
assert.equal(cleanSelect.attributes['aria-invalid'], undefined, 'validation state does not leak between progress clones');
assert.equal(cleanSelect.attributes['aria-describedby'], undefined, 'validation references do not leak between progress clones');
assert.equal(getActualProgressSelectTemplate(), progressShell, 'progress rendering reuses one immutable select shell');

console.log('✓ immutable DOM badge and progress shell caching tests passed');
