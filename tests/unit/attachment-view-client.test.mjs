import assert from 'node:assert/strict';
import {
  exchangeAttachmentViewGrant,
  installAttachmentViewGrantWindowOpen,
  parseLegacyAttachmentViewUrl,
} from '../../cloud-sync.js';

const origin = 'https://scopeweave.example';
const sessionToken = 'eyJhbGciOiJIUzI1NiJ9.scopeweave.signature';
const grantSecret = 'A'.repeat(43);
const validLegacyUrl = `/api/projects/7/attachments/9/view?token=${encodeURIComponent(sessionToken)}`;
const validGrantUrl = `/api/projects/7/attachments/9/view?grant=${grantSecret}`;

assert.deepEqual(parseLegacyAttachmentViewUrl(validLegacyUrl, origin), {
  projectId: '7',
  attachmentId: '9',
  sessionToken,
});
assert.equal(parseLegacyAttachmentViewUrl(new URL(validLegacyUrl, origin), origin), null, 'non-string navigation input is ignored');
assert.equal(parseLegacyAttachmentViewUrl(validLegacyUrl, 'file:///tmp/scopeweave'), null, 'non-HTTP origin is rejected');
assert.equal(parseLegacyAttachmentViewUrl('http://[::1', origin), null, 'malformed URL is ignored');
assert.equal(parseLegacyAttachmentViewUrl(`https://evil.example${validLegacyUrl}`, origin), null, 'cross-origin URL is ignored');
assert.equal(parseLegacyAttachmentViewUrl(`${validLegacyUrl}#fragment`, origin), null, 'fragment-bearing legacy URL is ignored');
assert.equal(parseLegacyAttachmentViewUrl(`${validLegacyUrl}&token=second`, origin), null, 'ambiguous duplicate token is ignored');
assert.equal(parseLegacyAttachmentViewUrl(`${validLegacyUrl}&extra=1`, origin), null, 'unexpected query data is ignored');
assert.equal(parseLegacyAttachmentViewUrl(`${validLegacyUrl}&grant=${grantSecret}`, origin), null, 'mixed legacy/grant credential is ignored');
assert.equal(parseLegacyAttachmentViewUrl('/api/projects/0/attachments/9/view?token=x', origin), null, 'invalid project id is ignored');
assert.equal(parseLegacyAttachmentViewUrl('/api/projects/7/attachments/9/view?token=', origin), null, 'empty session token is ignored');

let captured;
const successFetch = async (url, options) => {
  captured = { url, options };
  return {
    status: 201,
    async json() {
      return {
        purpose: 'attachment_view',
        grantId: 'agr_0123456789abcdef0123456789abcdef',
        expiresAtMs: Date.now() + 60_000,
        url: validGrantUrl,
      };
    },
  };
};
const exchanged = await exchangeAttachmentViewGrant({
  projectId: '7',
  attachmentId: '9',
  sessionToken,
  origin,
  fetchImpl: successFetch,
});
assert.equal(exchanged.url, validGrantUrl);
assert.equal(captured.url, '/api/projects/7/access-grants');
assert.equal(captured.options.method, 'POST');
assert.equal(captured.options.credentials, 'omit');
assert.equal(captured.options.cache, 'no-store');
assert.equal(captured.options.redirect, 'error');
assert.equal(captured.options.headers.authorization, `Bearer ${sessionToken}`);
assert.equal(captured.url.includes(sessionToken), false, 'session secret is absent from the exchange URL');
assert.equal(captured.options.body.includes(sessionToken), false, 'session secret is absent from the exchange body');
assert.deepEqual(JSON.parse(captured.options.body), { purpose: 'attachment_view', attachmentId: '9' });

await assert.rejects(
  exchangeAttachmentViewGrant({ projectId: '7', attachmentId: '9', sessionToken: '', origin, fetchImpl: successFetch }),
  /exchange unavailable/,
);
await assert.rejects(
  exchangeAttachmentViewGrant({ projectId: '7', attachmentId: '9', sessionToken, origin, fetchImpl: null }),
  /exchange unavailable/,
);
await assert.rejects(
  exchangeAttachmentViewGrant({ projectId: '7', attachmentId: '9', sessionToken, origin, fetchImpl: async () => null }),
  /exchange failed/,
);
await assert.rejects(
  exchangeAttachmentViewGrant({ projectId: '7', attachmentId: '9', sessionToken, origin, fetchImpl: async () => ({ status: 503 }) }),
  /exchange failed/,
);
await assert.rejects(
  exchangeAttachmentViewGrant({
    projectId: '7', attachmentId: '9', sessionToken, origin,
    fetchImpl: async () => ({ status: 201, json: async () => { throw new Error('bad json'); } }),
  }),
  /response invalid/,
);

const invalidPayloads = [
  null,
  [],
  { purpose: 'wrong', grantId: 'g', expiresAtMs: 1, url: validGrantUrl },
  { purpose: 'attachment_view', grantId: 7, expiresAtMs: 1, url: validGrantUrl },
  { purpose: 'attachment_view', grantId: 'g', expiresAtMs: 1.5, url: validGrantUrl },
  { purpose: 'attachment_view', grantId: 'g', expiresAtMs: 1, url: null },
  { purpose: 'attachment_view', grantId: 'g', expiresAtMs: 1, url: 'http://[::1' },
  { purpose: 'attachment_view', grantId: 'g', expiresAtMs: 1, url: `https://evil.example${validGrantUrl}` },
  { purpose: 'attachment_view', grantId: 'g', expiresAtMs: 1, url: `/api/projects/8/attachments/9/view?grant=${grantSecret}` },
  { purpose: 'attachment_view', grantId: 'g', expiresAtMs: 1, url: `${validGrantUrl}#x` },
  { purpose: 'attachment_view', grantId: 'g', expiresAtMs: 1, url: `${validGrantUrl}&grant=${'B'.repeat(43)}` },
  { purpose: 'attachment_view', grantId: 'g', expiresAtMs: 1, url: '/api/projects/7/attachments/9/view?grant=short' },
  { purpose: 'attachment_view', grantId: 'g', expiresAtMs: 1, url: `${validGrantUrl}&extra=1` },
];
for (const payload of invalidPayloads) {
  await assert.rejects(
    exchangeAttachmentViewGrant({
      projectId: '7',
      attachmentId: '9',
      sessionToken,
      origin,
      fetchImpl: async () => ({ status: 201, json: async () => payload }),
    }),
    /response invalid/,
  );
}
await assert.rejects(
  exchangeAttachmentViewGrant({
    projectId: '7', attachmentId: '9', sessionToken, origin: 'file:///tmp/x',
    fetchImpl: async () => ({ status: 201, json: async () => ({ purpose: 'attachment_view', grantId: 'g', expiresAtMs: 1, url: validGrantUrl }) }),
  }),
  /response invalid/,
);

assert.equal(installAttachmentViewGrantWindowOpen(null), false, 'missing window is unsupported');
assert.equal(installAttachmentViewGrantWindowOpen({ open: 7 }), false, 'non-callable open is unsupported');

const alerts = [];
const nativeCalls = [];
let replacement = null;
const popup = {
  closed: false,
  opener: { legacy: true },
  location: { replace(value) { replacement = value; } },
  close() { this.closed = true; },
};
const browser = {
  location: { origin },
  alert(message) { alerts.push(message); },
  open(value, target, features) {
    nativeCalls.push({ value, target, features });
    return value === 'about:blank' ? popup : { passthrough: true };
  },
};
assert.equal(installAttachmentViewGrantWindowOpen(browser, { fetchImpl: successFetch }), true);
assert.equal(installAttachmentViewGrantWindowOpen(browser, { fetchImpl: successFetch }), false, 'same window is never patched twice');
assert.deepEqual(browser.open('/pricing', '_self', 'width=500'), { passthrough: true }, 'unrelated navigation passes through unchanged');
const opened = browser.open(validLegacyUrl, '_blank', 'noopener,width=640,noreferrer');
assert.equal(opened, popup);
assert.equal(nativeCalls.at(-1).value, 'about:blank', 'session-bearing URL is never sent to native window.open');
assert.equal(nativeCalls.at(-1).features, 'width=640', 'opener-isolation flags are enforced programmatically rather than suppressing WindowProxy');
assert.equal(popup.opener, null, 'blank popup loses opener before grant exchange');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(replacement, validGrantUrl, 'only the one-time grant URL is navigated');
assert.deepEqual(alerts, []);

const blockedAlerts = [];
const blockedBrowser = {
  location: { origin },
  alert(message) { blockedAlerts.push(message); },
  open() { return null; },
};
assert.equal(installAttachmentViewGrantWindowOpen(blockedBrowser, { fetchImpl: successFetch }), true);
assert.equal(blockedBrowser.open(validLegacyUrl), null);
assert.match(blockedAlerts[0], /팝업을 허용/, 'popup blocker message tells the customer the next action');

let closedAfterFailure = false;
const failedAlerts = [];
const failedPopup = {
  closed: false,
  opener: {},
  location: { replace() { throw new Error('must not navigate'); } },
  close() { closedAfterFailure = true; },
};
const failedBrowser = {
  location: { origin },
  open() { return failedPopup; },
};
installAttachmentViewGrantWindowOpen(failedBrowser, {
  fetchImpl: async () => ({ status: 503 }),
  alertImpl: (message) => failedAlerts.push(message),
});
failedBrowser.open(validLegacyUrl);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(closedAfterFailure, true, 'failed exchange closes the unused blank popup');
assert.match(failedAlerts[0], /다시 시도/, 'exchange failure tells the customer the next action');

let closedPopupWasNavigated = false;
let releaseExchange;
const delayedFetch = () => new Promise((resolve) => { releaseExchange = resolve; });
const closedPopup = {
  closed: false,
  opener: {},
  location: { replace() { closedPopupWasNavigated = true; } },
  close() {},
};
const closedBrowser = { location: { origin }, open: () => closedPopup };
installAttachmentViewGrantWindowOpen(closedBrowser, { fetchImpl: delayedFetch, alertImpl: () => {} });
closedBrowser.open(validLegacyUrl);
closedPopup.closed = true;
releaseExchange({
  status: 201,
  json: async () => ({
    purpose: 'attachment_view',
    grantId: 'agr_0123456789abcdef0123456789abcdef',
    expiresAtMs: Date.now() + 60_000,
    url: validGrantUrl,
  }),
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(closedPopupWasNavigated, false, 'a user-closed popup is never resurrected');

let openerSetterObserved = false;
const hardenedPopup = {
  closed: false,
  set opener(_) { openerSetterObserved = true; throw new Error('blocked by browser'); },
  location: { replace() {} },
  close() {},
};
const hardenedBrowser = { location: { origin }, open: () => hardenedPopup };
installAttachmentViewGrantWindowOpen(hardenedBrowser, { fetchImpl: successFetch, alertImpl: () => {} });
hardenedBrowser.open(validLegacyUrl, undefined, '');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(openerSetterObserved, true, 'opener-hardening failure remains isolated from grant navigation');

let closeFailureAlert = '';
const closeThrowingPopup = {
  closed: false,
  opener: {},
  location: { replace() {} },
  close() { throw new Error('already inaccessible'); },
};
const closeThrowingBrowser = { location: { origin }, open: () => closeThrowingPopup };
installAttachmentViewGrantWindowOpen(closeThrowingBrowser, {
  fetchImpl: async () => ({ status: 500 }),
  alertImpl: (message) => { closeFailureAlert = message; },
});
closeThrowingBrowser.open(validLegacyUrl);
await new Promise((resolve) => setImmediate(resolve));
assert.match(closeFailureAlert, /다시 시도/, 'close errors do not suppress the customer recovery action');

console.log('attachment-view client grant bridge tests passed');
