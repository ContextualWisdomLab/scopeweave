import assert from 'node:assert/strict';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function restoreEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  globalThis.fetch = ORIGINAL_FETCH;
}

function configure({ url = 'https://orchestrator.example', token = 'secret-token', dev = false } = {}) {
  process.env.ORCHESTRATOR_URL = url;
  process.env.ORCHESTRATOR_TOKEN = token;
  process.env.ORCHESTRATOR_MODEL = 'contextual-orchestrator';
  if (dev) process.env.SCOPEWEAVE_DEV = '1';
  else delete process.env.SCOPEWEAVE_DEV;
}

async function freshModule(label) {
  return import(`../../server/orchestrator.mjs?coverage=${label}-${Date.now()}-${Math.random()}`);
}

async function expectCode(module, messages, code) {
  await assert.rejects(
    module.chat(messages),
    (error) => error?.code === code,
    `expected ${code}`,
  );
}

function streamResponse({ chunks = [], headers, ok = true, status = 200, cancel, releaseLock, readError } = {}) {
  let index = 0;
  return {
    ok,
    status,
    ...(headers === undefined ? {} : { headers }),
    body: {
      getReader() {
        return {
          async read() {
            if (readError) throw readError;
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = chunks[index];
            index += 1;
            return { done: false, value };
          },
          ...(cancel ? { cancel } : {}),
          ...(releaseLock ? { releaseLock } : {}),
        };
      },
    },
  };
}

try {
  configure({ url: 'not an absolute url' });
  await expectCode(
    await freshModule('invalid-url'),
    [{ role: 'user', content: 'status' }],
    'orchestrator_url_invalid',
  );

  configure({ url: 'ftp://orchestrator.example' });
  await expectCode(
    await freshModule('invalid-protocol'),
    [{ role: 'user', content: 'status' }],
    'orchestrator_url_invalid',
  );

  configure({ url: 'http://localhost:8080/' });
  globalThis.fetch = async (url) => {
    assert.equal(url, 'http://localhost:8080/v1/chat/completions');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'loopback ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  assert.equal(
    await (await freshModule('loopback-http')).chat([{ role: 'developer', content: 'status' }]),
    'loopback ok',
  );

  configure({ url: 'http://[::1]:8080/' });
  globalThis.fetch = async (url) => {
    assert.equal(url, 'http://[::1]:8080/v1/chat/completions');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ipv6 loopback ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  assert.equal(
    await (await freshModule('ipv6-loopback-http')).chat([{ role: 'developer', content: 'status' }]),
    'ipv6 loopback ok',
    'WHATWG IPv6 loopback hostname serialization must remain accepted by the documented local transport boundary',
  );

  configure();
  const configured = await freshModule('message-boundaries');
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  for (const invalidMessages of [
    null,
    Array.from({ length: 257 }, () => ({ role: 'user', content: 'x' })),
    [[]],
    [{ role: 'assistant', content: 42 }],
  ]) {
    await assert.rejects(
      configured.chat(invalidMessages),
      (error) => error?.code?.startsWith('orchestrator_message'),
    );
  }
  assert.equal(
    await configured.chat([
      { role: 'assistant', content: 'prior' },
      { role: 'developer', content: 'policy' },
      { role: 'user', content: 'status' },
    ]),
    'ok',
  );

  const responseCases = [
    {
      label: 'invalid-content-length',
      response: streamResponse({
        headers: new Headers({ 'content-length': '12x' }),
        chunks: [new TextEncoder().encode('{}')],
      }),
      code: 'orchestrator_response_invalid',
    },
    {
      label: 'unsafe-content-length',
      response: streamResponse({
        headers: new Headers({ 'content-length': '9007199254740992' }),
        chunks: [new TextEncoder().encode('{}')],
      }),
      code: 'orchestrator_response_size_invalid',
    },
    {
      label: 'zero-content-length',
      response: streamResponse({
        headers: new Headers({ 'content-length': '0' }),
        chunks: [],
      }),
      code: 'orchestrator_response_size_invalid',
    },
    {
      label: 'missing-body',
      response: { ok: true, status: 200, headers: new Headers(), body: null },
      code: 'orchestrator_response_invalid',
    },
    {
      label: 'missing-reader',
      response: { ok: true, status: 200, headers: new Headers(), body: {} },
      code: 'orchestrator_response_invalid',
    },
    {
      label: 'invalid-chunk',
      response: streamResponse({ headers: new Headers(), chunks: ['not-bytes'] }),
      code: 'orchestrator_response_invalid',
    },
    {
      label: 'read-error',
      response: streamResponse({ headers: new Headers(), readError: new Error('private stream failure') }),
      code: 'orchestrator_response_invalid',
    },
    {
      label: 'empty-stream',
      response: streamResponse({ headers: new Headers(), chunks: [] }),
      code: 'orchestrator_response_size_invalid',
    },
  ];

  for (const { label, response, code } of responseCases) {
    globalThis.fetch = async () => response;
    await expectCode(configured, [{ role: 'user', content: label }], code);
  }

  let cancelAttempted = false;
  globalThis.fetch = async () => streamResponse({
    headers: new Headers(),
    chunks: [new Uint8Array(1024 * 1024 + 1)],
    cancel: async () => {
      cancelAttempted = true;
      throw new Error('cancel cleanup failure');
    },
  });
  await expectCode(
    configured,
    [{ role: 'user', content: 'oversized cancel failure' }],
    'orchestrator_response_size_invalid',
  );
  assert.equal(cancelAttempted, true);

  let released = false;
  globalThis.fetch = async () => streamResponse({
    chunks: [new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: 'release ok' } }] }))],
    releaseLock() {
      released = true;
      throw new Error('release cleanup failure');
    },
  });
  assert.equal(
    await configured.chat([{ role: 'user', content: 'release cleanup' }]),
    'release ok',
  );
  assert.equal(released, true);

  globalThis.fetch = async () => new Response('{not-json', { status: 200 });
  await expectCode(
    configured,
    [{ role: 'user', content: 'non-json response' }],
    'orchestrator_response_invalid',
  );

  for (const [label, body] of [
    ['null-json', 'null'],
    ['primitive-json', '"string"'],
    ['array-json', '[]'],
  ]) {
    globalThis.fetch = async () => new Response(body, { status: 200 });
    await expectCode(configured, [{ role: 'user', content: label }], 'orchestrator_response_invalid');
  }

  globalThis.fetch = async () => streamResponse({
    chunks: [new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: 'no headers ok' } }] }))],
  });
  assert.equal(
    await configured.chat([{ role: 'user', content: 'missing headers object' }]),
    'no headers ok',
  );

  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
  await expectCode(
    configured,
    [{ role: 'user', content: 'missing choices' }],
    'orchestrator_response_invalid',
  );

  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '   ' } }],
  }), { status: 200 });
  await expectCode(
    configured,
    [{ role: 'user', content: 'blank assistant content' }],
    'orchestrator_response_invalid',
  );
} finally {
  restoreEnvironment();
}

console.log('✓ orchestrator residual branch coverage tests passed');
