import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = JSON.parse(readFileSync(new URL('../../opencode.jsonc', import.meta.url), 'utf8'));

test('OpenCode development config uses only currently hosted NVIDIA NIM candidates', () => {
  assert.equal(config.model, 'nvidia-nim/nvidia/llama-3.3-nemotron-super-49b-v1.5');
  assert.equal(config.small_model, 'nvidia-nim/meta/llama-3.1-8b-instruct');
  assert.deepEqual(config.enabled_providers, ['nvidia-nim']);

  const provider = config.provider?.['nvidia-nim'];
  assert.ok(provider, 'NVIDIA NIM provider must be configured');
  assert.equal(provider.options?.baseURL, 'https://integrate.api.nvidia.com/v1');
  assert.equal(provider.options?.apiKey, '{env:NVIDIA_API_KEY}');
  assert.ok(provider.models?.['nvidia/llama-3.3-nemotron-super-49b-v1.5']);
  assert.ok(provider.models?.['meta/llama-3.1-8b-instruct']);
  assert.ok(provider.models?.['meta/llama-3.3-70b-instruct']);
  assert.equal(
    provider.models['meta/llama-3.3-70b-instruct'].limit?.output,
    4096,
    '70B output must stay within the NVIDIA NIM max_tokens range of 1-4096',
  );

  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /github-models/i);
  assert.doesNotMatch(serialized, /STRIX_GITHUB_MODELS_TOKEN/);
  assert.doesNotMatch(serialized, /COPILOT_GITHUB_TOKEN/);
});
