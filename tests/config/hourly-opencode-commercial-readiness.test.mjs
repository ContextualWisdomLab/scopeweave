import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflowPath = new URL(
  '../../.github/workflows/hourly-opencode-commercial-readiness.yml',
  import.meta.url,
);
const workflow = readFileSync(workflowPath, 'utf8');
const agentJob = workflow.split('\n  agent:\n', 2)[1]?.split('\n  verify:\n', 1)[0] || '';
const verifyJob = workflow.split('\n  verify:\n', 2)[1]?.split('\n  publish:\n', 1)[0] || '';
const publishJob = workflow.split('\n  publish:\n', 2)[1] || '';
assert.ok(agentJob && verifyJob && publishJob, 'all three trust-zone jobs exist');

assert.match(
  workflow,
  /cron:\s*["']41 \* \* \* \*["']/,
  'the product-development heartbeat runs once per hour',
);
assert.match(workflow, /group:\s*scopeweave-hourly-opencode-commercial-readiness/);
assert.match(
  workflow,
  /cancel-in-progress:\s*false/,
  'a new hourly tick cannot interrupt a running product-development session',
);
assert.match(workflow, /permissions:\n\s+contents:\s+read/);
assert.match(workflow, /OPENCODE_RUN_TIMEOUT_SECONDS:\s*["']3600["']/);
assert.match(workflow, /AGENT_EXECUTION_BUDGET_SECONDS:\s*["']10800["']/);
assert.match(agentJob, /timeout-minutes:\s*200/);
assert.match(agentJob, /deadline=.*AGENT_EXECUTION_BUDGET_SECONDS/);
assert.match(agentJob, /fair_share=.*remaining.*remaining_candidates/);
assert.match(agentJob, /candidate_timeout=.*OPENCODE_RUN_TIMEOUT_SECONDS/);

assert.match(agentJob, /permissions:\n\s+contents:\s+read/);
assert.doesNotMatch(agentJob, /contents:\s+write|pull-requests:\s+write/);
assert.match(verifyJob, /permissions:\n\s+contents:\s+read/);
assert.doesNotMatch(verifyJob, /contents:\s+write|pull-requests:\s+write/);
assert.match(publishJob, /contents:\s+write/);
assert.match(publishJob, /pull-requests:\s+write/);
assert.doesNotMatch(
  publishJob,
  /opencode run|npm (?:ci|run)|NVIDIA_NIM_API_KEY|NVIDIA_API_KEY/,
  'the fresh write-authorized publisher never executes product code or receives the model key',
);

assert.match(workflow, /NVIDIA_API_KEY:\s*\$\{\{ secrets\.NVIDIA_NIM_API_KEY \}\}/);
assert.doesNotMatch(
  workflow,
  /secrets\.COPILOT_GITHUB_TOKEN|\/agents\/repos\/|create_pull_request/,
  'the workflow never reads a Copilot token or calls the Agent Tasks API',
);
assert.match(workflow, /OPENCODE_VERSION:\s*["']1\.18\.18["']/);
assert.match(
  workflow,
  /OPENCODE_SHA256:\s+0cddc222418b8553669905a8980c0cda7088f00da24d83d6ac76b01c9fdb2aaf/,
);
assert.match(workflow, /sha256sum -c -/);
assert.match(workflow, /@ai-sdk\/openai-compatible/);
assert.match(
  workflow,
  /^(\s*)"baseURL":\s*"https:\/\/integrate\.api\.nvidia\.com\/v1",?$/m,
);
assert.match(workflow, /"apiKey":\s*"\{env:NVIDIA_API_KEY\}"/);
assert.match(workflow, /"enabled_providers":\s*\["nvidia-nim"\]/);
for (const model of [
  'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'nvidia/nemotron-3-super-120b-a12b',
  'deepseek-ai/deepseek-v4-pro',
]) {
  assert.match(workflow, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

assert.match(
  workflow,
  /env -u GH_TOKEN -u GITHUB_TOKEN -u REPOSITORY_TOKEN[\s\S]*-u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL/,
);
assert.match(
  workflow,
  /"bash":\s*\{[\s\S]*"\*":\s*"deny"[\s\S]*"scopeweave-agent-check all":\s*"allow"/,
);
for (const denied of [
  'external_directory',
  'task',
  'skill',
  'question',
  'webfetch',
  'websearch',
  'lsp',
  'doom_loop',
]) {
  assert.match(workflow, new RegExp(`"${denied}":\\s*"deny"`));
}
assert.match(workflow, /"\.github\/\*\*":\s*"deny"/);
for (const protectedEdit of [
  '.trivyignore',
  '.semgrepignore',
  '.gitleaksignore',
  'package.json',
  'package-lock.json',
  'scripts/ci/**',
  'tests/config/hourly-opencode-commercial-readiness.test.mjs',
]) {
  assert.ok(
    workflow.includes(`"${protectedEdit}": "deny"`),
    `${protectedEdit} is denied during model editing`,
  );
}
assert.match(workflow, /env -i HOME=.*CI=true/);
assert.doesNotMatch(
  workflow,
  /exec run_clean/,
  'shell functions cannot be launched through exec; allowlisted checks must invoke run_clean directly',
);
assert.match(workflow, /unit\) run_clean .* run test:unit/);
assert.match(workflow, /api\) run_clean .* run test:api/);

assert.match(
  workflow,
  /pull-request-first single-flight gate[\s\S]*gh pr list[\s\S]*--state open/,
);
assert.doesNotMatch(
  workflow,
  /--json[^\n]*\bbody\b/,
  'untrusted issue and pull-request bodies are excluded from model context',
);
assert.match(workflow, /PROTECTED_EXACT_PATHS:\s*\|-/);
for (const protectedPath of [
  'package.json',
  'package-lock.json',
  'tests/config/hourly-opencode-commercial-readiness.test.mjs',
  'docs/doctoring/hourly-opencode-commercial-readiness.md',
  'docs/operations/hourly-opencode-commercial-readiness.md',
]) {
  assert.ok(workflow.includes(`    ${protectedPath}`), `${protectedPath} stays protected`);
}
assert.match(workflow, /PROTECTED_PATH_PREFIXES:\s*\|-[\s\S]*\.github\/[\s\S]*scripts\/ci\//);
assert.equal(
  (workflow.match(/os\.environ\["PROTECTED_EXACT_PATHS"\]/g) || []).length,
  2,
  'agent and publisher share the same exact-path boundary',
);
assert.equal(
  (workflow.match(/os\.environ\["PROTECTED_PATH_PREFIXES"\]/g) || []).length,
  2,
  'agent and publisher share the same prefix boundary',
);
assert.doesNotMatch(workflow, /cache:\s*npm/);
assert.match(workflow, /MAX_CHANGED_FILES:\s*["']40["']/);
assert.match(workflow, /MAX_PATCH_BYTES:\s*["']2097152["']/);
assert.match(workflow, /PR_MESSAGE\.md exceeds the 50 KiB metadata limit/);
assert.match(workflow, /PR_MESSAGE\.md must be a regular in-worktree file/);
assert.match(workflow, /if \[ -n "\$candidate_title" \]; then[\s\S]*title="\$candidate_title"/);
assert.doesNotMatch(workflow, /\[ -n "\$candidate_title" \] &&/);
assert.match(workflow, /--numstat[\s\S]*--no-renames[\s\S]*opaque binary change is not permitted/);
assert.match(workflow, /startswith\(protected_prefixes\)/);
assert.match(workflow, /symbolic links are not permitted/);
assert.match(workflow, /opaque binary file is not permitted/);
assert.match(workflow, /credential-like literal detected/);
assert.match(
  workflow,
  /\.trivyignore[\s\S]*\.semgrepignore[\s\S]*\.gitleaksignore/,
);

assert.match(
  workflow,
  /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/,
);
assert.match(
  workflow,
  /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/,
);
assert.match(workflow, /git diff --cached --binary --full-index --no-ext-diff/);
assert.match(workflow, /bundle\.sha256/);
assert.match(workflow, /EXPECTED_PATCH_SHA/);
assert.match(workflow, /EXPECTED_BUNDLE_SHA/);
assert.match(workflow, /cmp .*changes\.patch[\s\S]*recomputed\.patch/);

assert.match(
  verifyJob,
  /npm ci --ignore-scripts --no-audit --no-fund[\s\S]*npm run test:unit[\s\S]*npm run test:api[\s\S]*npm run coverage[\s\S]*npm run check:python-docstrings[\s\S]*npx --no-install playwright install --with-deps chromium[\s\S]*npm run test:e2e:cloud/,
);
assert.equal(
  (workflow.match(/ref:\s*develop/g) || []).length,
  3,
  'agent, verifier, and publisher check out the trusted protected branch',
);
assert.doesNotMatch(workflow, /ref:\s*\$\{\{ needs\.agent\.outputs\.start_sha \}\}/);
assert.match(verifyJob, /EXPECTED_START_SHA:\s*\$\{\{ needs\.agent\.outputs\.start_sha \}\}/);
assert.match(verifyJob, /git rev-parse HEAD[\s\S]*EXPECTED_START_SHA/);
assert.doesNotMatch(verifyJob, /"\$\{\{ needs\.agent\.outputs\.start_sha \}\}"/);
assert.match(publishJob, /live_base[\s\S]*EXPECTED_START_SHA/);
assert.match(publishJob, /git rev-parse HEAD[\s\S]*EXPECTED_START_SHA/);
assert.match(publishJob, /refusing duplicate publication/);
assert.match(publishJob, /deleted the duplicate branch/);
assert.match(publishJob, /A competing PR won after create; closed this duplicate/);
assert.match(publishJob, /--base "\$DEFAULT_BRANCH"/);
assert.doesNotMatch(workflow, /gh pr merge|enablePullRequestAutoMerge/);
assert.match(workflow, /Do not commit,[\s\S]*push,[\s\S]*merge/);
assert.match(
  workflow,
  /Central PR governance owns review, repair, exact-head checks,[\s\S]*independent approval, and merge/,
);

console.log('✓ hourly OpenCode commercial-readiness workflow contract passed');
