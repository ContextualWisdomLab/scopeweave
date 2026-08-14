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
  statusBadgeTemplateMap,
  ownerBadgeTemplateMap,
};
`;

  class DummyNode {
    constructor(name) {
      this.name = name;
      this.attributes = Object.create(null);
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
      node.style = { ...this.style };
      node.titleAttribute = this.titleAttribute;
      if (deep) node.text = this.text;
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
  statusBadgeTemplateMap,
  ownerBadgeTemplateMap,
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
assert.equal(statusBadgeTemplateMap.size, 1);

const equivalentDoneCell = createStatusCellContent({ ...doneState });
assert.notEqual(firstDoneCell, equivalentDoneCell);
assert.equal(equivalentDoneCell.text, '완료');
assert.equal(
  statusBadgeTemplateMap.size,
  1,
  'equivalent rendered status values share one semantic cache entry',
);

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
assert.equal(
  statusBadgeTemplateMap.size,
  2,
  'different accessible descriptions cannot reuse stale cached text',
);

for (let index = 0; index < 300; index += 1) {
  createStatusCellContent({
    label: `status-${index}`,
    className: `state-${index}`,
    description: `description-${index}`,
  });
}
assert.ok(
  statusBadgeTemplateMap.size <= 256,
  'status badge templates stay within the bounded cache budget',
);

const emptyState = { label: '', className: '', description: '' };
const emptyCell = createStatusCellContent(emptyState);
assert.equal(emptyCell.name, 'span');
assert.equal(emptyCell.className, 'empty-cell');

const firstOwnerCell = createOwnerCellContent('홍길동');
assert.equal(firstOwnerCell.text, '홍길동');
assert.equal(firstOwnerCell.className, 'owner-badge');
assert.ok(firstOwnerCell.style.background);
assert.equal(ownerBadgeTemplateMap.has('홍길동'), true);

const secondOwnerCell = createOwnerCellContent('홍길동');
assert.notEqual(firstOwnerCell, secondOwnerCell);
assert.equal(secondOwnerCell.text, '홍길동');
assert.equal(secondOwnerCell.className, 'owner-badge');
assert.equal(firstOwnerCell.style.background, secondOwnerCell.style.background);

for (let index = 0; index < 300; index += 1) {
  createOwnerCellContent(`owner-${index}`);
}
assert.ok(
  ownerBadgeTemplateMap.size <= 256,
  'owner badge templates stay within the bounded cache budget',
);

ownerBadgeTemplateMap.clear();
const createElementCallsBeforeVolume = getCreateElementCalls();
for (let rowIndex = 0; rowIndex < 5_000; rowIndex += 1) {
  createOwnerCellContent('same-owner');
}
assert.equal(
  getCreateElementCalls() - createElementCallsBeforeVolume,
  1,
  '5,000 identical owner rows create one DOM template and clone it thereafter',
);
assert.equal(
  ownerBadgeTemplateMap.size,
  1,
  '5,000 identical owner rows retain one bounded cache entry',
);

const emptyOwner = createOwnerCellContent('');
assert.equal(emptyOwner.className, 'empty-cell');

console.log('✓ bounded DOM template caching tests passed');
