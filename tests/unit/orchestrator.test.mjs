// contextual-orchestrator client: attribution forwarding + sanitization.
// Run: node tests/unit/orchestrator.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// orchestrator.mjs reads ORCHESTRATOR_URL at module load time, so the
// non-mock path can only be exercised in a fresh process with the env var
// already set — same pattern as tests/api/auth-secret.test.mjs. Stubs
// global fetch and prints the captured request body as JSON for this
// process to assert on.
function chatRequestBody(attribution) {
  const script = `
    globalThis.fetch = async (url, opts) => {
      console.log(JSON.stringify({ url, body: JSON.parse(opts.body) }));
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };
    const { chat } = await import('./server/orchestrator.mjs');
    await chat([{ role: 'user', content: 'hi' }], ${JSON.stringify(attribution)});
  `;
  const env = { ...process.env, ORCHESTRATOR_URL: 'http://orchestrator.test', ORCHESTRATOR_TOKEN: 'tok' };
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { cwd: process.cwd(), env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `chat() failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

// Known dimensions are forwarded, coerced to strings, exactly as given.
{
  const { url, body } = chatRequestBody({ service: 'scopeweave', account: 'org-123' });
  assert.equal(url, 'http://orchestrator.test/v1/chat/completions');
  assert.equal(body.model, 'contextual-orchestrator');
  assert.deepEqual(body.attribution, { service: 'scopeweave', account: 'org-123' });
}

// Unknown keys and null/empty values are dropped, never forwarded verbatim.
{
  const { body } = chatRequestBody({
    service: 'scopeweave',
    not_a_real_dimension: 'x',
    account: '',
    team: null,
  });
  assert.deepEqual(body.attribution, { service: 'scopeweave' });
}

// If nothing valid remains after sanitizing, the field is omitted entirely
// rather than sent as an empty object — matches orchestrator's contract of
// treating a present-but-empty attribution differently from an absent one.
{
  const { body } = chatRequestBody({ not_a_real_dimension: 'x' });
  assert.equal('attribution' in body, false);
}

// No attribution argument at all: unchanged pre-existing behavior.
{
  const { body } = chatRequestBody(undefined);
  assert.equal('attribution' in body, false);
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model']);
}

console.log('✓ orchestrator attribution tests passed');
