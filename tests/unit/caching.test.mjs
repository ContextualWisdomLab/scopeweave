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
    set className(val) { this.attributes.class = val; }
    get className() { return this.attributes.class; }
    set textContent(val) { this.text = val; }
    get textContent() { return this.text; }
    set title(val) { this.title_attr = val; }
    get title() { return this.title_attr; }
    setAttribute(key, val) { this.attributes[key] = val; }
    appendChild(child) { this.children.push(child); }
    append(...children) { this.children.push(...children); }
    cloneNode(deep) {
      const n = new DummyNode(this.name);
      n.attributes = { ...this.attributes };
      n.style = { ...this.style };
      n.title_attr = this.title_attr;
      if (deep) n.text = this.text;
      return n;
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
    get(target, prop) {
      if (prop === 'classList') return classList;
      if (prop in target) return target[prop];
      return () => proxyDummy;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  });


  const sandbox = {
    document: {
      createElement: (name) => new DummyNode(name),
      getElementById: () => proxyDummy,
      querySelector: () => proxyDummy,
      querySelectorAll: () => [],
      body: proxyDummy,
      addEventListener() {}
    },
    window: {
      addEventListener() {},
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      confirm: () => true
    },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined
    },
    console, setTimeout: () => 0, clearTimeout: () => undefined,
    Math, Object, Array, String, Number, Boolean, Map, Set, WeakMap, Symbol, Error, TypeError, Date, JSON, Proxy, Promise
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: appJsPath });

  return sandbox.__cachingExports;
}

const {
  createStatusCellContent,
  createOwnerCellContent,
  statusBadgeTemplateMap,
  ownerBadgeTemplateMap,
} = loadApp();

// --- createStatusCellContent Tests ---

const doneState = {
  label: '완료',
  className: 'done',
  description: '실적이 모두 입력되어 완료된 작업입니다.'
};

const cell1 = createStatusCellContent(doneState);
assert.equal(cell1.text, '완료');
assert.equal(cell1.className, 'status-badge done');
assert.equal(cell1.title, '실적이 모두 입력되어 완료된 작업입니다.');
assert.equal(cell1.attributes['aria-label'], '완료 - 실적이 모두 입력되어 완료된 작업입니다.');

assert.equal(statusBadgeTemplateMap.has('완료::done'), true);

const cell2 = createStatusCellContent({
  label: '완료',
  className: 'done',
  description: '다른 레퍼런스라도 캐시 히트'
});
assert.notEqual(cell1, cell2); // It should be cloned
assert.equal(cell2.text, '완료'); // From cached template
assert.equal(cell2.className, 'status-badge done');
assert.equal(cell2.title, '실적이 모두 입력되어 완료된 작업입니다.'); // Inherits original cached description
assert.equal(statusBadgeTemplateMap.size, 1, 'equivalent status values share one semantic cache entry');

const emptyState = { label: '', className: '', description: '' };
const emptyCell = createStatusCellContent(emptyState);
assert.equal(emptyCell.name, 'span');
assert.equal(emptyCell.className, 'empty-cell');

// --- createOwnerCellContent Tests ---

const owner1 = createOwnerCellContent('홍길동');
assert.equal(owner1.text, '홍길동');
assert.equal(owner1.className, 'owner-badge');
assert.ok(owner1.style.background);

assert.equal(ownerBadgeTemplateMap.has('홍길동'), true);

const owner2 = createOwnerCellContent('홍길동');
assert.notEqual(owner1, owner2);
assert.equal(owner2.text, '홍길동');
assert.equal(owner2.className, 'owner-badge');
assert.equal(owner1.style.background, owner2.style.background);

const emptyOwner = createOwnerCellContent('');
assert.equal(emptyOwner.className, 'empty-cell');

console.log('✓ caching tests passed');
