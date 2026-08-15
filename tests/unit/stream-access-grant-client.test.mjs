import assert from 'node:assert/strict';

import {
  createStreamGrantConnection,
  validateStreamGrantUrl,
} from '../../stream-access-grant.js';

const SESSION_TOKEN = 'session.jwt.with-sensitive-authority';
const FIRST_GRANT = 'A'.repeat(43);
const SECOND_GRANT = 'B'.repeat(43);

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emitOpen() {
    this.onopen?.({ type: 'open' });
  }

  emitMessage(data) {
    this.onmessage?.({ data });
  }

  emitError() {
    this.onerror?.({ type: 'error' });
  }
}

const requests = [];
const scheduled = [];
const cancelled = [];
let grantIndex = 0;
const grants = [FIRST_GRANT, SECOND_GRANT];
const messages = [];
const statuses = [];

const fetchImpl = async (url, options) => {
  requests.push({ url, options });
  const grant = grants[Math.min(grantIndex, grants.length - 1)];
  grantIndex += 1;
  return new Response(JSON.stringify({
    purpose: 'stream',
    url: `/api/projects/42/stream?grant=${grant}`,
  }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
};

const connection = createStreamGrantConnection({
  projectId: 42,
  getSessionToken: () => SESSION_TOKEN,
  fetchImpl,
  EventSourceImpl: FakeEventSource,
  origin: 'https://scopeweave.example',
  onMessage: (event) => messages.push(event.data),
  onStatus: (status) => statuses.push(status),
  schedule: (callback, delayMs) => {
    const handle = { callback, delayMs };
    scheduled.push(handle);
    return handle;
  },
  cancelSchedule: (handle) => cancelled.push(handle),
  retryDelayMs: 750,
});

await connection.ready;
assert.equal(requests.length, 1, 'initial connection exchanges the broad session for a stream grant');
assert.equal(requests[0].url, '/api/projects/42/access-grants');
assert.equal(requests[0].options.method, 'POST');
assert.equal(requests[0].options.headers.authorization, `Bearer ${SESSION_TOKEN}`);
assert.equal(requests[0].options.headers['content-type'], 'application/json');
assert.deepEqual(JSON.parse(requests[0].options.body), { purpose: 'stream' });
assert.equal(requests[0].url.includes(SESSION_TOKEN), false, 'broad session credential never enters the exchange URL');
assert.equal(FakeEventSource.instances.length, 1);
assert.equal(FakeEventSource.instances[0].url, `/api/projects/42/stream?grant=${FIRST_GRANT}`);
assert.equal(FakeEventSource.instances[0].url.includes('token='), false, 'EventSource never receives the legacy token query parameter');
assert.equal(FakeEventSource.instances[0].url.includes(SESSION_TOKEN), false, 'EventSource URL never contains the broad session credential');

FakeEventSource.instances[0].emitOpen();
FakeEventSource.instances[0].emitMessage('{"type":"update","version":7}');
assert.deepEqual(messages, ['{"type":"update","version":7}']);
assert.ok(statuses.includes('connected'));

FakeEventSource.instances[0].emitError();
assert.equal(FakeEventSource.instances[0].closed, true, 'native EventSource auto-reconnect is disabled after a one-time grant is consumed');
assert.equal(scheduled.length, 1, 'a failed stream schedules a fresh grant exchange');
assert.equal(scheduled[0].delayMs, 750);
assert.ok(statuses.includes('retrying'));

await scheduled[0].callback();
assert.equal(requests.length, 2, 'reconnect exchanges for a new one-time grant');
assert.equal(FakeEventSource.instances.length, 2);
assert.equal(FakeEventSource.instances[1].url, `/api/projects/42/stream?grant=${SECOND_GRANT}`);
assert.notEqual(FakeEventSource.instances[1].url, FakeEventSource.instances[0].url, 'reconnect does not replay a consumed grant');

connection.close();
assert.equal(FakeEventSource.instances[1].closed, true, 'closing the connection closes the active EventSource');
assert.ok(statuses.includes('closed'));

assert.equal(
  validateStreamGrantUrl(`/api/projects/42/stream?grant=${FIRST_GRANT}`, {
    origin: 'https://scopeweave.example',
    projectId: 42,
  }),
  `/api/projects/42/stream?grant=${FIRST_GRANT}`,
);
for (const unsafeUrl of [
  `https://evil.example/api/projects/42/stream?grant=${FIRST_GRANT}`,
  `/api/projects/7/stream?grant=${FIRST_GRANT}`,
  `/api/projects/42/stream?grant=${FIRST_GRANT}&next=/admin`,
  `/api/projects/42/stream?grant=short`,
  `/api/projects/42/stream?token=${SESSION_TOKEN}`,
  `/api/projects/42/stream?grant=${FIRST_GRANT}#fragment`,
]) {
  assert.throws(
    () => validateStreamGrantUrl(unsafeUrl, { origin: 'https://scopeweave.example', projectId: 42 }),
    /stream grant url invalid/,
    `reject unsafe stream URL: ${unsafeUrl}`,
  );
}

const noTokenStatuses = [];
let noTokenFetchCalls = 0;
const noTokenConnection = createStreamGrantConnection({
  projectId: 42,
  getSessionToken: () => '',
  fetchImpl: async () => { noTokenFetchCalls += 1; throw new Error('should not fetch'); },
  EventSourceImpl: FakeEventSource,
  origin: 'https://scopeweave.example',
  onStatus: (status) => noTokenStatuses.push(status),
});
await noTokenConnection.ready;
assert.equal(noTokenFetchCalls, 0, 'logged-out clients do not request grants');
assert.deepEqual(noTokenStatuses, ['closed']);

console.log('stream access-grant client contract ok');
