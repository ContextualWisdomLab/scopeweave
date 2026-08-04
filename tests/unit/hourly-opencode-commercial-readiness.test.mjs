import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = '.github/workflows/hourly-opencode-commercial-readiness.yml';

/**
 * Read the trusted hourly workflow exactly as GitHub Actions will consume it.
 *
 * The contract tests intentionally inspect source text instead of loading YAML
 * because YAML 1.1 parsers can coerce the top-level `on` key to a Boolean. The
 * assertions protect security-significant execution boundaries rather than a
 * parser implementation detail.
 *
 * @returns {Promise<string>} Complete UTF-8 workflow source.
 */
async function readWorkflow() {
  return readFile(workflowPath, 'utf8');
}

/**
 * Return one named step body, excluding the following step.
 *
 * @param {string} source Complete workflow source.
 * @param {string} name Exact visible step name.
 * @returns {string} Step source from its name through the line before the next step.
 */
function stepBody(source, name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const next = source.indexOf('\n      - name: ', start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test('the schedule is hourly and explicitly uses OpenCode with NVIDIA NIM', async () => {
  const source = await readWorkflow();

  assert.match(source, /schedule:\n\s+- cron: "17 \* \* \* \*"/u);
  assert.match(source, /opencode run/u);
  assert.match(source, /NVIDIA_NIM_API_KEY/u);
  assert.match(source, /https:\/\/integrate\.api\.nvidia\.com\/v1/u);
  assert.doesNotMatch(source, /copilot/iu);
  assert.doesNotMatch(source, /pull_request_target:/u);
});

test('model and GitHub publication credentials are separated by step scope', async () => {
  const source = await readWorkflow();
  const beforeSteps = source.slice(0, source.indexOf('    steps:\n'));
  const checkoutStep = stepBody(source, 'Check out the protected repository baseline');
  const agentStep = stepBody(source, 'Execute OpenCode with NVIDIA NIM');
  const verificationStep = stepBody(source, 'Run the complete product verification contract');
  const publishStep = stepBody(
    source,
    'Publish the verified exact head without exposing credentials to the agent',
  );

  assert.doesNotMatch(beforeSteps, /NVIDIA_NIM_API_KEY/u);
  assert.match(checkoutStep, /persist-credentials: false/u);
  assert.match(agentStep, /NVIDIA_NIM_API_KEY: \$\{\{ secrets\.NVIDIA_NIM_API_KEY \}\}/u);
  assert.doesNotMatch(agentStep, /GH_TOKEN:/u);
  assert.doesNotMatch(verificationStep, /NVIDIA_NIM_API_KEY/u);
  assert.doesNotMatch(verificationStep, /GH_TOKEN:/u);
  assert.match(publishStep, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(publishStep, /NVIDIA_NIM_API_KEY/u);
});

test('only trusted same-repository pull requests can reach the model', async () => {
  const source = await readWorkflow();
  const selectionStep = stepBody(
    source,
    'Select one trusted pull request or the next bounded product slice',
  );

  assert.match(selectionStep, /trusted_associations = \{"OWNER", "MEMBER", "COLLABORATOR"\}/u);
  assert.match(selectionStep, /head_repository\.get\("full_name"\) == repository/u);
  assert.match(selectionStep, /same_repository and trusted_author/u);
  assert.match(selectionStep, /dependabot\[bot\]/u);
  assert.match(selectionStep, /reviewThreads\(first:100\)/u);
  assert.match(selectionStep, /test "\$\(git rev-parse HEAD\)" = "\$head_sha"/u);
});

test('the agent cannot rewrite review automation, itself, or repository trust', async () => {
  const source = await readWorkflow();
  const boundaryStep = stepBody(
    source,
    'Enforce repository and review-agent safety boundaries',
  );

  assert.match(boundaryStep, /git merge-base --is-ancestor "\$START_SHA" HEAD/u);
  assert.match(boundaryStep, /git diff --check "\$START_SHA" --/u);
  assert.match(boundaryStep, /coderabbit\|noema\|opencode-review\|review-agent\|strix\|security-review/u);
  assert.match(boundaryStep, /hourly-opencode-commercial-readiness\.yml/u);
  assert.match(boundaryStep, /\.gitmodules/u);
  assert.match(boundaryStep, /pull_request_target:/u);
  assert.match(boundaryStep, /nvapi-/u);
  assert.match(boundaryStep, /PRIVATE KEY/u);
});

test('raw model output is kept off logs and destroyed on credential disclosure', async () => {
  const source = await readWorkflow();
  const agentStep = stepBody(source, 'Execute OpenCode with NVIDIA NIM');

  assert.match(agentStep, /> "\$output_path" 2>&1/u);
  assert.doesNotMatch(agentStep, /\|\s*tee/u);
  assert.match(agentStep, /grep -Fq "\$NVIDIA_NIM_API_KEY" "\$output_path"/u);
  assert.match(agentStep, /rm -f "\$output_path" "\$config_path"/u);
  assert.match(agentStep, /raw model output is not printed/u);
});

test('the complete repository verification contract runs before publication', async () => {
  const source = await readWorkflow();
  const verificationStep = stepBody(source, 'Run the complete product verification contract');
  const publishOffset = source.indexOf(
    '      - name: Publish the verified exact head without exposing credentials to the agent',
  );
  const verificationOffset = source.indexOf(
    '      - name: Run the complete product verification contract',
  );

  assert.ok(verificationOffset < publishOffset, 'verification must precede publication');
  assert.match(verificationStep, /npm ci/u);
  assert.match(verificationStep, /npm audit --omit=dev/u);
  assert.match(verificationStep, /npm run test:unit/u);
  assert.match(verificationStep, /npm run test:api/u);
  assert.match(verificationStep, /npm run coverage/u);
  assert.match(verificationStep, /static_coverage_evidence\.mjs docstrings/u);
  assert.match(verificationStep, /run_if_present test:e2e:cloud/u);
  assert.match(verificationStep, /git diff --check/u);
});

test('publication fails on head movement and preserves protected merge policy', async () => {
  const source = await readWorkflow();
  const publishStep = stepBody(
    source,
    'Publish the verified exact head without exposing credentials to the agent',
  );
  const reviewStep = stepBody(
    source,
    'Request current-head review and arm only protected auto-merge',
  );

  assert.match(publishStep, /current_remote_sha/u);
  assert.match(publishStep, /current_remote_sha" != "\$START_SHA/u);
  assert.match(publishStep, /refusing to overwrite newer work/u);
  assert.match(publishStep, /gh pr create[\s\S]*--draft/u);
  assert.match(publishStep, /trap 'git remote set-url origin/u);
  assert.match(reviewStep, /@coderabbitai review/u);
  assert.match(reviewStep, /if \[\[ "\$is_draft" == 'false' \]\]/u);
  assert.match(reviewStep, /gh pr merge[\s\S]*--squash --auto/u);
  assert.doesNotMatch(source, /--admin/u);
  assert.doesNotMatch(source, /gh pr ready/u);
  assert.doesNotMatch(source, /dismiss-review/u);
});

test('OpenCode installation resolves and records an auditable package version', async () => {
  const source = await readWorkflow();
  const installStep = stepBody(source, 'Install one resolved OpenCode release');

  assert.match(source, /OPENCODE_VERSION: \$\{\{ vars\.OPENCODE_VERSION \|\| 'latest' \}\}/u);
  assert.match(installStep, /npm view opencode-ai version/u);
  assert.match(installStep, /npm view "opencode-ai@\$\{resolved_version\}" dist\.integrity/u);
  assert.match(installStep, /npm install --global "opencode-ai@\$\{resolved_version\}"/u);
  assert.match(installStep, /opencode --version/u);
});
