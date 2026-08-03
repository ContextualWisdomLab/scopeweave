// Regression coverage for cloned WBS cell templates.
// app.js is browser-first; evaluate it in a small DOM harness and exercise the
// production functions so template reuse cannot leak row-specific state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const appJsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.js');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.id = '';
    this.htmlFor = '';
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.attributes = new Map();
    this._value = '';
    this.classList = {
      contains: () => false,
      add() {},
      remove() {},
      toggle() {},
    };
  }

  set value(value) {
    const next = String(value);
    if (this.tagName === 'SELECT' && this.children.length > 0) {
      const options = this.children.map((child) => child.value);
      this._value = options.includes(next) ? next : '';
      return;
    }
    this._value = next;
  }

  get value() {
    return this._value;
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener() {}

  focus() {}

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  cloneNode(deep = false) {
    const clone = new FakeElement(this.tagName);
    clone.className = this.className;
    clone.textContent = this.textContent;
    clone.title = this.title;
    clone.id = this.id;
    clone.htmlFor = this.htmlFor;
    clone.dataset = { ...this.dataset };
    clone.style = { ...this.style };
    clone.attributes = new Map(this.attributes);
    if (deep) {
      clone.children = this.children.map((child) => child.cloneNode(true));
    }
    clone._value = this._value;
    return clone;
  }
}

function loadRenderFunctions() {
  let source = fs.readFileSync(appJsPath, 'utf8');
  source = source.replace(/^\s*bootstrap\(\);\s*$/m, ';');
  source += `
;globalThis.__renderTemplateExports = {
  createOwnerCellContent,
  createStatusCellContent,
  createActualProgressCellContent,
};
`;

  const dummyElement = new FakeElement();
  const windowStub = {
    addEventListener() {},
    removeEventListener() {},
    confirm: () => true,
    setTimeout: () => 0,
    clearTimeout() {},
  };
  windowStub.window = windowStub;

  const sandbox = {
    window: windowStub,
    self: windowStub,
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      getElementById: () => dummyElement,
      querySelector: () => dummyElement,
      querySelectorAll: () => [],
      addEventListener() {},
      body: dummyElement,
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    fetch: () => Promise.reject(new Error('fetch disabled in unit harness')),
    AbortController: globalThis.AbortController,
    crypto: globalThis.crypto,
    Uint32Array,
    console,
    setTimeout: () => 0,
    clearTimeout() {},
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

  vm.runInContext(source, vm.createContext(sandbox), { filename: appJsPath });
  return sandbox.__renderTemplateExports;
}

const {
  createOwnerCellContent,
  createStatusCellContent,
  createActualProgressCellContent,
} = loadRenderFunctions();

const firstOwner = createOwnerCellContent('Alice');
firstOwner.className = 'poisoned';
firstOwner.title = 'leaked title';
firstOwner.setAttribute('aria-label', 'leaked label');
firstOwner.style.background = 'leaked color';
const secondOwner = createOwnerCellContent('Bob');
assert.notEqual(secondOwner, firstOwner);
assert.equal(secondOwner.className, 'owner-badge');
assert.equal(secondOwner.textContent, 'Bob');
assert.equal(secondOwner.title, '');
assert.equal(secondOwner.getAttribute('aria-label'), null);
assert.notEqual(secondOwner.style.background, 'leaked color');

const describedStatus = createStatusCellContent({
  label: '지연',
  className: 'status-delayed',
  description: '계획보다 늦음',
});
describedStatus.className = 'poisoned';
describedStatus.textContent = 'poisoned';
describedStatus.title = 'poisoned';
describedStatus.setAttribute('aria-label', 'poisoned');
const plainStatus = createStatusCellContent({
  label: '정상',
  className: 'status-on-track',
  description: '',
});
assert.equal(plainStatus.className, 'status-badge status-on-track');
assert.equal(plainStatus.textContent, '정상');
assert.equal(plainStatus.title, '');
assert.equal(plainStatus.getAttribute('aria-label'), null);
const nextDescribedStatus = createStatusCellContent({
  label: '주의',
  className: 'status-warning',
  description: '검토 필요',
});
assert.equal(nextDescribedStatus.title, '검토 필요');
assert.equal(nextDescribedStatus.getAttribute('aria-label'), '주의 - 검토 필요');

const firstProgress = createActualProgressCellContent(
  { id: 'task-alpha', task: '첫 작업', actualProgressStatus: '진행(50%)' },
  { plannedDateWarning: '계획일 경고', actualDateWarning: '' },
);
const [firstSrOnly, firstSelect, firstValidation] = firstProgress.children;
assert.equal(firstProgress.htmlFor, 'actual-progress-task-alpha');
assert.equal(firstSrOnly.textContent, '실적진척상태 - 첫 작업');
assert.equal(firstSelect.id, 'actual-progress-task-alpha');
assert.equal(firstSelect.dataset.inlineProgress, 'task-alpha');
assert.equal(firstSelect.value, '진행(50%)');
assert.equal(firstValidation.id, 'actual-progress-error-task-alpha');
assert.equal(firstSelect.getAttribute('aria-describedby'), firstValidation.id);

firstProgress.htmlFor = 'poisoned';
firstSrOnly.textContent = 'poisoned';
firstSelect.id = 'poisoned';
firstSelect.dataset.inlineProgress = 'poisoned';
firstSelect.setAttribute('aria-invalid', 'poisoned');
firstSelect.setAttribute('aria-describedby', 'poisoned');
firstValidation.id = 'poisoned';

const secondProgress = createActualProgressCellContent(
  { id: 'task-beta', activity: '둘째 활동', actualProgressStatus: '착수(20%)' },
  { plannedDateWarning: '', actualDateWarning: '' },
);
const [secondSrOnly, secondSelect] = secondProgress.children;
assert.equal(secondProgress.htmlFor, 'actual-progress-task-beta');
assert.equal(secondProgress.children.length, 2, 'warning node must not leak from the previous row');
assert.equal(secondSrOnly.className, 'sr-only');
assert.equal(secondSrOnly.textContent, '실적진척상태 - 둘째 활동');
assert.equal(secondSelect.id, 'actual-progress-task-beta');
assert.equal(secondSelect.dataset.inlineProgress, 'task-beta');
assert.equal(secondSelect.value, '착수(20%)');
assert.equal(secondSelect.getAttribute('aria-invalid'), null);
assert.equal(secondSelect.getAttribute('aria-describedby'), null);

const thirdProgress = createActualProgressCellContent(
  { id: 'task-gamma', phase: '셋째 단계', actualProgressStatus: 'invalid-value' },
  { plannedDateWarning: '', actualDateWarning: '실적일 경고' },
);
const [thirdSrOnly, thirdSelect, thirdValidation] = thirdProgress.children;
assert.equal(thirdSrOnly.textContent, '실적진척상태 - 셋째 단계');
assert.equal(thirdSelect.id, 'actual-progress-task-gamma');
assert.equal(thirdSelect.value, '미착수(0%)');
assert.equal(thirdValidation.id, 'actual-progress-error-task-gamma');
assert.equal(thirdValidation.textContent, '실적일 경고');
assert.equal(thirdSelect.getAttribute('aria-describedby'), thirdValidation.id);

console.log('✓ render template isolation tests passed');
