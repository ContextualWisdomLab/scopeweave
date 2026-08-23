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
const relabelableSelector = '[role="dialog"]:not([aria-label])';

function matchesDialogSelector(dialog, selector) {
  if (selector === unnamedSelector) {
    return !dialog.getAttribute('aria-label') && !dialog.getAttribute('aria-labelledby');
  }
  if (selector === relabelableSelector) {
    return !dialog.getAttribute('aria-label');
  }
  assert.fail(`unexpected dialog selector: ${selector}`);
}

class FakeDialog {
  constructor({ heading = null, ariaLabel = '', ariaLabelledby = '' } = {}) {
    this.heading = heading;
    this.attributes = new Map([['role', 'dialog']]);
    if (ariaLabel) this.attributes.set('aria-label', ariaLabel);
    if (ariaLabelledby) this.attributes.set('aria-labelledby', ariaLabelledby);
  }

  matches(selector) {
    return matchesDialogSelector(this, selector);
  }

  querySelector(selector) {
    assert.equal(selector, 'h1,h2,h3,h4,h5,h6');
    return this.heading;
  }

  querySelectorAll(selector) {
    assert.ok(selector === unnamedSelector || selector === relabelableSelector);
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
    assert.ok(selector === unnamedSelector || selector === relabelableSelector);
    documentQueryCount += 1;
    return dialogs.filter((dialog) => matchesDialogSelector(dialog, selector));
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

const initialHeading = { textContent: '초기 프로젝트 대화상자' };
const initialDialog = new FakeDialog({ heading: initialHeading });
dialogs.push(initialDialog);

const { labelUnnamedDialogs } = await import(`../../dialog-accessibility.js?test=${Date.now()}`);

assert.equal(initialDialog.getAttribute('aria-label'), null, 'derived names must not be copied into aria-label');
assert.match(
  initialDialog.getAttribute('aria-labelledby') ?? '',
  /^scopeweave-dialog-title-\d+$/,
  'module initialization links existing dialogs to their visible heading',
);
assert.equal(initialHeading.id, initialDialog.getAttribute('aria-labelledby'));
initialHeading.textContent = '수정된 프로젝트 대화상자';
assert.equal(
  initialDialog.getAttribute('aria-labelledby'),
  initialHeading.id,
  'heading text changes remain reflected through the live aria-labelledby relationship',
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
    assert.ok(selector === unnamedSelector || selector === relabelableSelector);
    return false;
  },
  querySelectorAll(selector) {
    assert.ok(selector === unnamedSelector || selector === relabelableSelector);
    return [nestedDialog, blankHeadingDialog, missingHeadingDialog, alreadyNamedDialog, alreadyLabelledbyDialog]
      .filter((dialog) => matchesDialogSelector(dialog, selector));
  },
};
const documentScansBeforeMutation = documentQueryCount;

FakeMutationObserver.latest.callback([{ addedNodes: [teamDialog, mutationSubtree, { nodeType: 3 }] }]);
assert.equal(teamDialog.getAttribute('aria-label'), null);
assert.equal(teamDialog.getAttribute('aria-labelledby'), teamDialog.heading.id);
assert.equal(nestedDialog.getAttribute('aria-label'), null);
assert.equal(nestedDialog.getAttribute('aria-labelledby'), nestedDialog.heading.id);
assert.equal(blankHeadingDialog.getAttribute('aria-label'), null);
assert.equal(blankHeadingDialog.getAttribute('aria-labelledby'), null);
assert.equal(missingHeadingDialog.getAttribute('aria-label'), null);
assert.equal(missingHeadingDialog.getAttribute('aria-labelledby'), null);
assert.equal(alreadyNamedDialog.getAttribute('aria-label'), '명시 이름');
assert.equal(alreadyLabelledbyDialog.getAttribute('aria-labelledby'), 'existing-title');
assert.equal(
  documentQueryCount,
  documentScansBeforeMutation,
  'mutation batches must scan only added subtrees instead of rescanning the full document',
);

const delayedDialog = new FakeDialog();
FakeMutationObserver.latest.callback([{ addedNodes: [delayedDialog] }]);
assert.equal(delayedDialog.getAttribute('aria-labelledby'), null);
const delayedHeading = {
  textContent: '나중에 추가된 제목',
  parentElement: {
    closest(selector) {
      assert.ok(selector === unnamedSelector || selector === relabelableSelector);
      return delayedDialog;
    },
  },
};
delayedDialog.heading = delayedHeading;
FakeMutationObserver.latest.callback([{ addedNodes: [delayedHeading] }]);
assert.equal(delayedDialog.getAttribute('aria-label'), null);
assert.equal(
  delayedDialog.getAttribute('aria-labelledby'),
  delayedHeading.id,
  'a dialog inserted before its heading must link to that heading when it is added later',
);
assert.equal(
  documentQueryCount,
  documentScansBeforeMutation,
  'delayed dialog labeling must remain bounded to the mutated subtree and ancestor dialog',
);

const reopeningDialog = new FakeDialog({ heading: { textContent: '첫 번째 제목' } });
FakeMutationObserver.latest.callback([{ addedNodes: [reopeningDialog] }]);
const firstHeadingId = reopeningDialog.getAttribute('aria-labelledby');
assert.match(firstHeadingId ?? '', /^scopeweave-dialog-title-\d+$/);
const rebuiltHeading = {
  textContent: '다시 열린 대화상자 제목',
  parentElement: {
    closest(selector) {
      if (selector === unnamedSelector) return null;
      if (selector === relabelableSelector) return reopeningDialog;
      assert.fail(`unexpected dialog selector: ${selector}`);
    },
  },
};
reopeningDialog.heading = rebuiltHeading;
FakeMutationObserver.latest.callback([{ addedNodes: [rebuiltHeading] }]);
assert.equal(
  reopeningDialog.getAttribute('aria-labelledby'),
  rebuiltHeading.id,
  'rebuilding a dialog panel must replace a stale generated aria-labelledby reference with the new visible heading',
);
assert.notEqual(
  reopeningDialog.getAttribute('aria-labelledby'),
  firstHeadingId,
  'a reopened dialog must not retain the generated id of a removed heading',
);

const anotherDialog = new FakeDialog({ heading: { textContent: '추가 프로젝트 대화상자' } });
dialogs.push(anotherDialog);
assert.equal(labelUnnamedDialogs(fakeDocument), 1);
assert.equal(anotherDialog.getAttribute('aria-label'), null);
assert.equal(anotherDialog.getAttribute('aria-labelledby'), anotherDialog.heading.id);
assert.equal(labelUnnamedDialogs(fakeDocument), 0);

delete globalThis.document;
delete globalThis.MutationObserver;

console.log('dialog accessibility unit tests passed');