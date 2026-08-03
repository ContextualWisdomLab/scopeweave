import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class FakeNode {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.id = '';
    this.htmlFor = '';
    this.title = '';
  }

  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === 'id') this.id = text;
    if (name === 'title') this.title = text;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  cloneNode(deep = false) {
    const clone = new FakeNode(this.tagName, this.ownerDocument);
    clone.attributes = new Map(this.attributes);
    clone.style = { ...this.style };
    clone.dataset = { ...this.dataset };
    clone.className = this.className;
    clone.textContent = this.textContent;
    clone.value = this.value;
    clone.id = this.id;
    clone.htmlFor = this.htmlFor;
    clone.title = this.title;
    if (deep) clone.children = this.children.map((child) => child.cloneNode(true));
    return clone;
  }
}

const createCounts = new Map();
const documentStub = {
  createElement(tagName) {
    createCounts.set(tagName, (createCounts.get(tagName) || 0) + 1);
    return new FakeNode(tagName, documentStub);
  },
  createTextNode(text) {
    const node = new FakeNode('#text', documentStub);
    node.textContent = String(text);
    return node;
  },
};

const dummyElement = new Proxy(new FakeNode('div', documentStub), {
  get(target, property) {
    if (property in target) return target[property];
    return () => undefined;
  },
});
documentStub.getElementById = () => dummyElement;
documentStub.querySelector = () => null;
documentStub.querySelectorAll = () => [];
documentStub.body = dummyElement;

a function loadRenderHelpers() {
  let source = fs.readFileSync('app.js', 'utf8');
  source = source.replace(/^\s*bootstrap\(\);\s*$/m, ';');
  source += `\n;globalThis.__renderHelpers = {\n    createOwnerCellContent,\n    createStatusCellContent,\n    createActualProgressCellContent,\n  };\n`;

  const windowStub = { addEventListener() {}, removeEventListener() {} };
  const sandbox = {
    window: windowStub,
    self: windowStub,
    document: documentStub,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    fetch: () => Promise.reject(new Error('fetch disabled in unit harness')),
    AbortController: globalThis.AbortController,
    crypto: globalThis.crypto,
    structuredClone: globalThis.structuredClone,
    TextEncoder: globalThis.TextEncoder,
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
  };
  sandbox.globalThis = sandbox;
  windowStub.window = windowStub;

  vm.runInContext(source, vm.createContext(sandbox), { filename: 'app.js' });
  return sandbox.__renderHelpers;
}

const {
  createOwnerCellContent,
  createStatusCellContent,
  createActualProgressCellContent,
} = loadRenderHelpers();

const ownerOne = createOwnerCellContent('Kim');
const ownerTwo = createOwnerCellContent('Lee');
assert.notEqual(ownerOne, ownerTwo, 'owner badges are independent clones');
assert.equal(ownerOne.textContent, 'Kim');
assert.equal(ownerTwo.textContent, 'Lee');

const describedStatus = createStatusCellContent({
  label: '지연',
  className: 'delay',
  description: '계획보다 늦음',
});
const plainStatus = createStatusCellContent({
  label: '정상',
  className: 'active',
  description: '',
});
assert.equal(describedStatus.title, '계획보다 늦음');
assert.equal(plainStatus.title, '', 'status metadata does not leak between clones');
assert.equal(plainStatus.getAttribute('aria-label'), null);

const warningLabel = createActualProgressCellContent(
  { id: 'task-1', task: '검증', actualProgressStatus: '진행중(50%)' },
  { plannedDateWarning: '계획일 확인', actualDateWarning: '' },
);
const cleanLabel = createActualProgressCellContent(
  { id: 'task-2', task: '배포', actualProgressStatus: '완료(100%)' },
  { plannedDateWarning: '', actualDateWarning: '' },
);
assert.equal(warningLabel.children.length, 3, 'warning clone includes validation text');
assert.equal(cleanLabel.children.length, 2, 'clean clone has no stale validation node');
assert.equal(cleanLabel.children[1].getAttribute('aria-invalid'), null);
assert.equal(cleanLabel.children[1].getAttribute('aria-describedby'), null);

const createCountAfterWarmup = [...createCounts.values()].reduce((sum, count) => sum + count, 0);
for (let index = 0; index < 100; index += 1) {
  createOwnerCellContent(`Owner ${index}`);
  createStatusCellContent({ label: `State ${index}`, className: 'active', description: '' });
  createActualProgressCellContent(
    { id: `task-${index + 10}`, task: `Task ${index}`, actualProgressStatus: '미착수(0%)' },
    { plannedDateWarning: '', actualDateWarning: '' },
  );
}
const createCountAfterHotLoop = [...createCounts.values()].reduce((sum, count) => sum + count, 0);
assert.equal(
  createCountAfterHotLoop,
  createCountAfterWarmup,
  'hot render calls clone cached templates instead of allocating new element templates',
);

console.log('✓ render template cache tests passed');
