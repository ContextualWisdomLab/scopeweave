import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
delete process.env.SCOPEWEAVE_DEV;
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const nativeCalls = [];
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const body = request.body ? await request.text() : '';
  nativeCalls.push({ method: request.method, url: request.url, body });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
};

await import('../../server/app.mjs');

const unrelated = new Request('https://unrelated.example.test/echo', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: 'preserve-this-body',
});
const response = await globalThis.fetch(unrelated);

assert.equal(response.status, 200, 'unrelated native fetch result is preserved');
assert.equal(await response.text(), 'preserve-this-body');
assert.deepEqual(nativeCalls, [{
  method: 'POST',
  url: 'https://unrelated.example.test/echo',
  body: 'preserve-this-body',
}], 'the facade must not consume a non-webhook Request before native fetch receives it');

console.log('webhook fetch boundary preserves unrelated Request bodies');
