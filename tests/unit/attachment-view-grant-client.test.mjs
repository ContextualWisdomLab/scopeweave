import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAttachmentViewOpenBridge,
  installAttachmentViewGrantBridge,
  parseLegacyAttachmentViewUrl,
} from '../../attachment-view-grant-client.js';

const ORIGIN = 'https://scopeweave.test';
const VALID_GRANT = 'g'.repeat(43);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function response({ ok = true, payload = { grant: VALID_GRANT }, jsonError = null } = {}) {
  return {
    ok,
    json: async () => {
      if (jsonError) throw jsonError;
      return payload;
    },
  };
}

test('legacy attachment URL parser accepts only the exact same-origin token transport', () => {
  assert.deepEqual(
    parseLegacyAttachmentViewUrl('/api/projects/12/attachments/34/view?token=session-token', ORIGIN),
    { projectId: '12', attachmentId: '34', token: 'session-token' },
  );
  assert.deepEqual(
    parseLegacyAttachmentViewUrl('/api/projects/12/attachments/34/view?token=', ORIGIN),
    { projectId: '12', attachmentId: '34', token: '' },
  );
  assert.equal(parseLegacyAttachmentViewUrl('https://other.test/api/projects/12/attachments/34/view?token=x', ORIGIN), null);
  assert.equal(parseLegacyAttachmentViewUrl('/api/projects/not-an-id/attachments/34/view?token=x', ORIGIN), null);
  assert.equal(parseLegacyAttachmentViewUrl('/api/projects/12/attachments/34/view', ORIGIN), null);
  assert.equal(parseLegacyAttachmentViewUrl('/api/projects/12/attachments/34/view?token=x&grant=y', ORIGIN), null);
  assert.equal(parseLegacyAttachmentViewUrl('%', 'not-an-origin'), null);
});

test('bridge construction rejects missing browser capabilities', () => {
  const nativeOpen = () => null;
  const fetchImpl = async () => response();
  const notify = () => {};
  assert.throws(() => createAttachmentViewOpenBridge({ origin: '', nativeOpen, fetchImpl, notify }), TypeError);
  assert.throws(() => createAttachmentViewOpenBridge({ origin: ORIGIN, nativeOpen: null, fetchImpl, notify }), TypeError);
  assert.throws(() => createAttachmentViewOpenBridge({ origin: ORIGIN, nativeOpen, fetchImpl: null, notify }), TypeError);
  assert.throws(() => createAttachmentViewOpenBridge({ origin: ORIGIN, nativeOpen, fetchImpl, notify: null }), TypeError);
});

test('bridge delegates unrelated URLs and fails locally for missing token or popup permission', () => {
  const calls = [];
  const notices = [];
  const nativeOpen = (...args) => {
    calls.push(args);
    return { delegated: true };
  };
  const bridge = createAttachmentViewOpenBridge({
    origin: ORIGIN,
    nativeOpen,
    fetchImpl: async () => response(),
    notify: (message) => notices.push(message),
  });

  assert.deepEqual(bridge('/help', '_self', 'feature'), { delegated: true });
  assert.deepEqual(calls, [['/help', '_self', 'feature']]);
  assert.equal(bridge('/api/projects/1/attachments/2/view?token=', '_blank', 'noopener'), null);
  assert.equal(calls.length, 1, 'empty credentials never reach the native URL opener');
  assert.match(notices.at(-1), /다시 시도/);

  const blocked = createAttachmentViewOpenBridge({
    origin: ORIGIN,
    nativeOpen: () => null,
    fetchImpl: async () => response(),
    notify: (message) => notices.push(message),
  });
  assert.equal(blocked('/api/projects/1/attachments/2/view?token=session', '_blank', 'noopener'), null);
  assert.match(notices.at(-1), /팝업/);
});

test('bridge exchanges the broad credential only in a header and navigates with a one-time grant', async () => {
  const openCalls = [];
  const fetchCalls = [];
  const destinations = [];
  const popup = {
    opener: {},
    closed: false,
    location: { replace: (value) => destinations.push(value) },
    close() { throw new Error('should not close on success'); },
  };
  const bridge = createAttachmentViewOpenBridge({
    origin: ORIGIN,
    nativeOpen: (...args) => {
      openCalls.push(args);
      return popup;
    },
    fetchImpl: async (...args) => {
      fetchCalls.push(args);
      return response();
    },
    notify: () => assert.fail('success must not notify'),
  });

  assert.equal(
    bridge('/api/projects/7/attachments/9/view?token=wide-session', '_blank', 'noopener'),
    popup,
  );
  await tick();

  assert.deepEqual(openCalls, [['about:blank', '_blank', 'noopener']]);
  assert.equal(popup.opener, null);
  assert.equal(fetchCalls[0][0], '/api/projects/7/access-grants');
  assert.equal(fetchCalls[0][1].headers.authorization, 'Bearer wide-session');
  assert.equal(fetchCalls[0][1].cache, 'no-store');
  assert.equal(fetchCalls[0][1].credentials, 'same-origin');
  assert.deepEqual(JSON.parse(fetchCalls[0][1].body), {
    purpose: 'attachment_view',
    attachmentId: '9',
  });
  assert.deepEqual(destinations, [`/api/projects/7/attachments/9/view?grant=${VALID_GRANT}`]);
});

test('bridge does not navigate a popup that the user already closed', async () => {
  let replaced = false;
  const popup = {
    opener: null,
    closed: true,
    location: { replace: () => { replaced = true; } },
    close() {},
  };
  const bridge = createAttachmentViewOpenBridge({
    origin: ORIGIN,
    nativeOpen: () => popup,
    fetchImpl: async () => response(),
    notify: () => assert.fail('closed success does not notify'),
  });
  bridge('/api/projects/1/attachments/2/view?token=session');
  await tick();
  assert.equal(replaced, false);
});

test('bridge closes the blank popup and gives an actionable retry on exchange failures', async () => {
  const scenarios = [
    async () => response({ ok: false }),
    async () => response({ payload: { grant: 'too-short' } }),
    async () => response({ jsonError: new Error('bad json') }),
    async () => { throw new Error('offline'); },
  ];

  for (const fetchImpl of scenarios) {
    let closed = 0;
    const notices = [];
    const popup = {
      opener: null,
      closed: false,
      location: { replace: () => assert.fail('failed exchange must not navigate') },
      close: () => { closed += 1; },
    };
    const bridge = createAttachmentViewOpenBridge({
      origin: ORIGIN,
      nativeOpen: () => popup,
      fetchImpl,
      notify: (message) => notices.push(message),
    });
    bridge('/api/projects/1/attachments/2/view?token=session');
    await tick();
    assert.equal(closed, 1);
    assert.match(notices[0], /연결 상태.*다시 시도/);
  }

  const notices = [];
  const throwingPopup = {
    closed: false,
    location: { replace: () => {} },
    close: () => { throw new Error('already torn down'); },
  };
  Object.defineProperty(throwingPopup, 'opener', {
    set() { throw new Error('read only'); },
  });
  const bridge = createAttachmentViewOpenBridge({
    origin: ORIGIN,
    nativeOpen: () => throwingPopup,
    fetchImpl: async () => { throw new Error('offline'); },
    notify: (message) => notices.push(message),
  });
  bridge('/api/projects/1/attachments/2/view?token=session');
  await tick();
  assert.equal(notices.length, 1, 'read-only opener and close failures still surface the retry action');
});

test('installer validates, reports through the existing live-region toast, and restores native open', () => {
  const nativeCalls = [];
  assert.throws(() => installAttachmentViewGrantBridge(null), TypeError);
  assert.throws(() => installAttachmentViewGrantBridge({ open() {} }), TypeError);
  assert.throws(() => installAttachmentViewGrantBridge({ open: null, fetch() {} }), TypeError);

  const classes = new Set();
  let timerCallback;
  const toast = {
    textContent: '',
    classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
    },
  };
  const windowRef = {
    location: { origin: ORIGIN },
    open: (...args) => {
      nativeCalls.push(args);
      return null;
    },
    fetch: async () => response(),
    document: { getElementById: () => toast },
    setTimeout: (callback) => { timerCallback = callback; },
  };

  const restore = installAttachmentViewGrantBridge(windowRef);
  assert.equal(windowRef.open('/api/projects/1/attachments/2/view?token=', '_blank'), null);
  assert.match(toast.textContent, /다시 시도/);
  assert.equal(classes.has('show'), true);
  timerCallback();
  assert.equal(classes.has('show'), false);

  restore();
  windowRef.open('/delegated', '_blank');
  assert.deepEqual(nativeCalls.at(-1), ['/delegated', '_blank']);

  const noToastWindow = {
    location: { origin: ORIGIN },
    open: () => null,
    fetch: async () => response(),
    document: { getElementById: () => null },
    setTimeout: () => assert.fail('no toast means no timer'),
  };
  installAttachmentViewGrantBridge(noToastWindow);
  assert.equal(noToastWindow.open('/api/projects/1/attachments/2/view?token='), null);
});

test('browser module auto-installs when a window global exists', async () => {
  const fakeWindow = {
    location: { origin: ORIGIN },
    open: () => ({ closed: true, opener: null, location: { replace() {} }, close() {} }),
    fetch: async () => response(),
    document: { getElementById: () => null },
    setTimeout() {},
  };
  const originalOpen = fakeWindow.open;
  globalThis.window = fakeWindow;
  try {
    await import(`../../attachment-view-grant-client.js?auto=${Date.now()}`);
    assert.notEqual(fakeWindow.open, originalOpen);
  } finally {
    delete globalThis.window;
  }
});