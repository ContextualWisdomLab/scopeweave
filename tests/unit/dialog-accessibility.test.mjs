import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const serverDockerfile = readFileSync(new URL('../../Dockerfile.server', import.meta.url), 'utf8');
const pagesWorkflow = readFileSync(
  new URL('../../.github/workflows/pages.yml', import.meta.url),
  'utf8',
);

assert.match(
  dockerfile,
  /^COPY\s+[^\n]*\bdialog-accessibility\.js\b[^\n]*\/usr\/share\/nginx\/html\/\s*$/m,
  'the static Docker image must ship the dialog accessibility module referenced by index.html',
);
assert.match(
  serverDockerfile,
  /^COPY\s+[^\n]*\bdialog-accessibility\.js\b[^\n]*\.\/\s*$/m,
  'the SaaS server image must ship the dialog accessibility module served by the runtime app',
);
assert.match(
  pagesWorkflow,
  /^\s*cp\s+[^\n]*\bdialog-accessibility\.js\b[^\n]*_site\/\s*$/m,
  'the GitHub Pages artifact must stage the dialog accessibility module referenced by index.html',
);

const unnamedSelector = '[role="dialog"]:not([aria-label]):not([aria-labelledby])';

class FakeDialog {
  constructor({ heading = null, ariaLabel = '', ariaLabelledby = '' } = {}) {
    this.heading = heading;
    this.attributes = new Map([['role', 'dialog']]);
    if (ariaLabel) this.attributes.set('aria-label', ariaLabel);
    if (ariaLabelledby) this.attributes.set('aria-labelledby', ariaLabelledby);
  }

  matches(selector) {
    assert.equal(selector, unnamedSelector);
    return !this.getAttribute('aria-label') && !this.getAttribute('aria-labelledby');
  }

  querySelector(selector) {
    assert.equal(selector, 'h1,h2,h3,h4,h5,h6');
    return this.heading;
  }

  querySelectorAll(selector) {
    assert.equal(selector, unnamedSelector);
    return [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
}

const dialogs = [];
let documentQueryCount = 0;
const fakeDocument = {
  documentElement: { nodeName: 'HTML' },
  querySelectorAll(selector) {
    assert.equal(selector, unnamedSelector);
    documentQueryCount += 1;
    return dialogs.filter((dialog) => !dialog.getAttribute('aria-label') && !dialog.getAttribute('aria-labelledby'));
  },
};

class FakeMutationObserver {
  static latest = null;

  constructor(callback) {
    this.callback = callback;
    this.observed = null;
    FakeMutationObserver.latest = this;
  }

  observe(target, options) {
    this.observed = { target, options };
  }
}

globalThis.document = fakeDocument;
globalThis.MutationObserver = FakeMutationObserver;

const initialDialog = new FakeDialog({ heading: { textContent: '초기 프로젝트 대화상자' } });
dialogs.push(initialDialog);

const { labelUnnamedDialogs } = await import(`../../dialog-accessibility.js?test=${Date.now()}`);

assert.equal(
  initialDialog.getAttribute('aria-label'),
  '초기 프로젝트 대화상자',
  'module initialization labels dialogs that already exist in the document',
);
assert.deepEqual(FakeMutationObserver.latest.observed, {
  target: fakeDocument.documentElement,
  options: { childList: true, subtree: true },
});

const teamDialog = new FakeDialog({ heading: { textContent: '  팀 멤버  ' } });
const nestedDialog = new FakeDialog({ heading: { textContent: '읽기 전용 공유' } });
const blankHeadingDialog = new FakeDialog({ heading: { textContent: '   ' } });
const missingHeadingDialog = new FakeDialog();
const alreadyNamedDialog = new FakeDialog({ heading: { textContent: '기존 이름' }, ariaLabel: '명시 이름' });
const alreadyLabelledbyDialog = new FakeDialog({ heading: { textContent: '제목 참조' }, ariaLabelledby: 'existing-title' });
const mutationSubtree = {
  matches(selector) {
    assert.equal(selector, unnamedSelector);
    return false;
  },
  querySelectorAll(selector) {
    assert.equal(selector, unnamedSelector);
    return [nestedDialog, blankHeadingDialog, missingHeadingDialog, alreadyNamedDialog, alreadyLabelledbyDialog]
      .filter((dialog) => !dialog.getAttribute('aria-label') && !dialog.getAttribute('aria-labelledby'));
  },
};
const documentScansBeforeMutation = documentQueryCount;

FakeMutationObserver.latest.callback([{ addedNodes: [teamDialog, mutationSubtree, { nodeType: 3 }] }]);
assert.equal(teamDialog.getAttribute('aria-label'), '팀 멤버');
assert.equal(nestedDialog.getAttribute('aria-label'), '읽기 전용 공유');
assert.equal(blankHeadingDialog.getAttribute('aria-label'), null);
assert.equal(missingHeadingDialog.getAttribute('aria-label'), null);
assert.equal(alreadyNamedDialog.getAttribute('aria-label'), '명시 이름');
assert.equal(alreadyLabelledbyDialog.getAttribute('aria-labelledby'), 'existing-title');
assert.equal(
  documentQueryCount,
  documentScansBeforeMutation,
  'mutation batches must scan only added subtrees instead of rescanning the full document',
);

const delayedDialog = new FakeDialog();
FakeMutationObserver.latest.callback([{ addedNodes: [delayedDialog] }]);
assert.equal(delayedDialog.getAttribute('aria-label'), null);
const delayedHeading = {
  textContent: '나중에 추가된 제목',
  parentElement: {
    closest(selector) {
      assert.equal(selector, unnamedSelector);
      return delayedDialog;
    },
  },
};
delayedDialog.heading = delayedHeading;
FakeMutationObserver.latest.callback([{ addedNodes: [delayedHeading] }]);
assert.equal(
  delayedDialog.getAttribute('aria-label'),
  '나중에 추가된 제목',
  'a dialog inserted before its heading must be labeled when that heading is added later',
);
assert.equal(
  documentQueryCount,
  documentScansBeforeMutation,
  'delayed dialog labeling must remain bounded to the mutated subtree and ancestor dialog',
);

const anotherDialog = new FakeDialog({ heading: { textContent: '추가 프로젝트 대화상자' } });
dialogs.push(anotherDialog);
assert.equal(labelUnnamedDialogs(fakeDocument), 1);
assert.equal(anotherDialog.getAttribute('aria-label'), '추가 프로젝트 대화상자');
assert.equal(labelUnnamedDialogs(fakeDocument), 0);

delete globalThis.document;
delete globalThis.MutationObserver;

console.log('dialog accessibility unit tests passed');
