import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflowPath = new URL(
  '../../.github/workflows/hourly-opencode-commercial-readiness.yml',
  import.meta.url,
);
const workflow = readFileSync(workflowPath, 'utf8');

assert.match(
  workflow,
  /cron:\s*["']41 \* \* \* \*["']/,
  'the autonomous product loop runs once per hour',
);
assert.match(
  workflow,
  /group:\s*scopeweave-hourly-opencode-commercial-readiness/,
  'one repository-wide concurrency group prevents overlapping agents',
);
assert.match(
  workflow,
  /cancel-in-progress:\s*false/,
  'a later hourly tick never interrupts a running product-development session',
);
assert.match(
  workflow,
  /permissions:\n\s+contents:\s+read/,
  'the workflow-level token defaults to read-only repository contents',
);
assert.match(
  workflow,
  /NVIDIA_API_KEY:\s*\$\{\{ secrets\.NVIDIA_NIM_API_KEY \}\}/,
  'the coding agent uses the organization NVIDIA NIM secret',
);
assert.doesNotMatch(
  workflow,
  /COPILOT_GITHUB_TOKEN|\/agents\/repos\/|create_pull_request/,
  'the scheduler never uses Copilot Agent Tasks or a user-scoped Copilot token',
);
assert.match(
  workflow,
  /OPENCODE_VERSION:\s*["']1\.17\.13["']/,
  'OpenCode is pinned to a reviewed release rather than latest',
);
assert.match(
  workflow,
  /OPENCODE_SHA256:\s+[0-9a-f]{64}/,
  'the OpenCode archive has a pinned SHA-256 digest',
);
assert.match(
  workflow,
  /sha256sum -c -/,
  'the downloaded OpenCode archive is verified before execution',
);
assert.match(
  workflow,
  /https:\/\/integrate\.api\.nvidia\.com\/v1/,
  'OpenCode targets the NVIDIA hosted NIM OpenAI-compatible endpoint',
);
assert.match(
  workflow,
  /"apiKey":\s*"\{env:NVIDIA_API_KEY\}"/,
  'the provider reads its key from the environment instead of the repository',
);
assert.match(
  workflow,
  /@ai-sdk\/openai-compatible/,
  'the OpenCode provider uses the documented OpenAI-compatible adapter',
);
assert.match(
  workflow,
  /env -u GH_TOKEN -u GITHUB_TOKEN -u REPOSITORY_TOKEN/,
  'the OpenCode process cannot inherit GitHub mutation credentials',
);
assert.match(
  workflow,
  /pull-request-first single-flight gate[\s\S]*gh pr list[\s\S]*state open/,
  'an existing pull request prevents another autonomous development slice',
);
assert.match(
  workflow,
  /Revalidate queue ownership[\s\S]*gh pr list[\s\S]*refusing duplicate development/,
  'the trusted publisher rechecks queue ownership immediately before publication',
);
assert.match(
  workflow,
  /protected review-agent workflow/,
  'agent changes to reviewer-owned workflows fail closed',
);
assert.match(
  workflow,
  /\.trivyignore\|\\\.semgrepignore\|\\\.gitleaksignore/,
  'security-scan suppression files are explicitly prohibited',
);
assert.match(
  workflow,
  /npm ci[\s\S]*npm run test:unit[\s\S]*npm run test:api[\s\S]*npm run coverage[\s\S]*static_coverage_evidence\.mjs docstrings[\s\S]*git diff --check/,
  'the complete deterministic verification contract precedes publication',
);
assert.match(
  workflow,
  /--base "\$DEFAULT_BRANCH"/,
  'the trusted publisher opens exactly one PR against develop',
);
assert.match(
  workflow,
  /Do not merge, publish, release, push, or commit/,
  'the coding agent cannot own publication or merge decisions',
);
assert.match(
  workflow,
  /Central PR governance owns review, repair, revalidation, and merge/,
  'the existing organization review system remains authoritative',
);

console.log('✓ hourly OpenCode commercial-readiness workflow contract passed');
