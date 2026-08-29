import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  isBlockedWebhookAddress,
  postWebhook,
  validateWebhookUrl,
} from '../../server/webhook_security.mjs';

const publicV4 = [{ address: '8.8.8.8', family: 4 }];

function fakeRequestWithStatus(statusCode, onRequest = () => {}) {
  return (target, options, onResponse) => {
    onRequest(target, options);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => queueMicrotask(() => req.emit('error', error));
    req.end = () => {
      options.lookup(target.hostname, {}, (lookupError) => {
        if (lookupError) {
          queueMicrotask(() => req.emit('error', lookupError));
          return;
        }
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.resume = () => {};
        queueMicrotask(() => onResponse(res));
      });
    };
    return req;
  };
}

test('blocks IPv4 and IPv6 addresses that are not public webhook destinations', () => {
  for (const address of [
    '0.0.0.1',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ]) {
    assert.equal(isBlockedWebhookAddress(address), true, address);
  }
  assert.equal(isBlockedWebhookAddress('8.8.8.8'), false);
  assert.equal(isBlockedWebhookAddress('2606:4700:4700::1111'), false);
});

test('rejects localhost names, credentials, non-http schemes, and canonicalized numeric loopback', async () => {
  const mustNotResolve = async () => {
    throw new Error('resolver must not run');
  };
  await assert.rejects(validateWebhookUrl('http://localhost/hook', { resolver: mustNotResolve }));
  await assert.rejects(validateWebhookUrl('http://service.local/hook', { resolver: mustNotResolve }));
  await assert.rejects(validateWebhookUrl('https://user:pass@8.8.8.8/hook', { resolver: mustNotResolve }));
  await assert.rejects(validateWebhookUrl('ftp://8.8.8.8/hook', { resolver: mustNotResolve }));
  await assert.rejects(validateWebhookUrl('http://2130706433/hook', { resolver: mustNotResolve }));
});

test('rejects DNS answers containing any blocked destination', async () => {
  await assert.rejects(
    validateWebhookUrl('https://internal.example/hook', {
      resolver: async () => [{ address: '10.0.0.8', family: 4 }],
    }),
  );
  await assert.rejects(
    validateWebhookUrl('https://mixed.example/hook', {
      resolver: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    }),
  );
});

test('accepts a hostname only when every resolved address is public', async () => {
  const target = await validateWebhookUrl('https://hooks.example/path', {
    resolver: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ],
  });
  assert.equal(target.href, 'https://hooks.example/path');
});

test('pins and revalidates DNS at connection time to fail closed on rebinding', async () => {
  let resolverCalls = 0;
  const resolver = async () => {
    resolverCalls += 1;
    return resolverCalls === 1
      ? publicV4
      : [{ address: '127.0.0.1', family: 4 }];
  };

  await assert.rejects(
    postWebhook('https://hooks.example/path', {
      resolver,
      requestImpl: fakeRequestWithStatus(204),
      body: '{}',
    }),
  );
  assert.equal(resolverCalls, 2, 'target is checked at validation and at socket lookup');
});

test('does not follow redirects and reports non-2xx responses as failed', async () => {
  let requests = 0;
  const result = await postWebhook('https://hooks.example/path', {
    resolver: async () => publicV4,
    requestImpl: fakeRequestWithStatus(302, () => { requests += 1; }),
    body: '{}',
  });
  assert.deepEqual(result, { status: 302, ok: false });
  assert.equal(requests, 1, 'redirect response never creates a second request');
});

test('returns success for a 2xx response through the pinned public address', async () => {
  const result = await postWebhook('https://hooks.example/path', {
    resolver: async () => publicV4,
    requestImpl: fakeRequestWithStatus(204),
    body: '{}',
  });
  assert.deepEqual(result, { status: 204, ok: true });
});
