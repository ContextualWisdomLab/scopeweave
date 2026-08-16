// Execute the broad API smoke suite against the production orchestrator client
// boundary without depending on an external service. Non-orchestrator requests
// continue through Node's real fetch implementation.
process.env.ORCHESTRATOR_URL = 'http://127.0.0.1';
process.env.ORCHESTRATOR_TOKEN = 'scopeweave-smoke-provider-token';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) === 'http://127.0.0.1/v1/chat/completions') {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: 'mock-orchestrator deterministic authenticated provider response for the API smoke contract.',
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return originalFetch(input, init);
};

try {
  await import('./smoke.mjs');
} finally {
  globalThis.fetch = originalFetch;
}
