import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorkflowCleanupPlan,
  buildWorkflowCleanupPlan,
  cleanupWorkflowRegistry,
  parseCleanupArgs,
} from '../../scripts/ci/workflow_registry_cleanup.mjs';

const API = 'https://api.github.test';
const REPO = 'ContextualWisdomLab/scopeweave';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function response(status, body = null, headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) ?? null },
    async json() { return body; },
  };
}

function activeOrphan(id, path) {
  return {
    workflow_id: id,
    path,
    state: 'active',
    classification: 'active_orphan',
    duplicate_path_identity: false,
  };
}

function evidence(overrides = {}) {
  return {
    repository: REPO,
    branch: 'develop',
    default_branch_sha: SHA_A,
    unresolved_count: 0,
    classifications: [
      activeOrphan(11, '.github/workflows/legacy-repair.yml'),
      activeOrphan(13, '.github/workflows/retired-one-shot.yml'),
      {
        workflow_id: 12,
        path: '.github/workflows/server-tests.yml',
        state: 'active',
        classification: 'present_active',
        duplicate_path_identity: false,
      },
    ],
    ...overrides,
  };
}

test('cleanup plan is exact-SHA bound and mutates only explicitly reviewed active-orphan IDs', () => {
  const plan = buildWorkflowCleanupPlan({ evidence: evidence(), expectedSha: SHA_A, reviewedWorkflowIds: [11] });
  assert.equal(plan.default_branch_sha, SHA_A);
  assert.deepEqual(plan.candidates, [
    { workflow_id: 11, path: '.github/workflows/legacy-repair.yml' },
    { workflow_id: 13, path: '.github/workflows/retired-one-shot.yml' },
  ]);
  assert.deepEqual(plan.targets, [{ workflow_id: 11, path: '.github/workflows/legacy-repair.yml' }]);

  const dryRunPlan = buildWorkflowCleanupPlan({ evidence: evidence(), expectedSha: SHA_A });
  assert.equal(dryRunPlan.candidates.length, 2);
  assert.deepEqual(dryRunPlan.targets, []);

  assert.throws(
    () => buildWorkflowCleanupPlan({ evidence: evidence(), expectedSha: SHA_B, reviewedWorkflowIds: [11] }),
    /expected protected branch SHA/,
  );
  assert.throws(
    () => buildWorkflowCleanupPlan({ evidence: evidence({ unresolved_count: 1 }), expectedSha: SHA_A, reviewedWorkflowIds: [11] }),
    /unresolved workflow identities/,
  );
  assert.throws(
    () => buildWorkflowCleanupPlan({ evidence: evidence(), expectedSha: SHA_A, reviewedWorkflowIds: [12] }),
    /not a current active orphan/,
  );
  assert.throws(
    () => buildWorkflowCleanupPlan({ evidence: evidence(), expectedSha: SHA_A, reviewedWorkflowIds: [99] }),
    /not a current active orphan/,
  );
  assert.throws(
    () => buildWorkflowCleanupPlan({ evidence: evidence(), expectedSha: SHA_A, reviewedWorkflowIds: [11, 11] }),
    /duplicate reviewed workflow id/,
  );
});

test('cleanup CLI is dry-run by default and apply requires immutable SHA plus explicit reviewed workflow IDs', () => {
  assert.deepEqual(
    parseCleanupArgs(['--repo', REPO, '--branch', 'develop', '--expected-sha', SHA_A]),
    { repository: REPO, branch: 'develop', expectedSha: SHA_A, preservePaths: [], reviewedWorkflowIds: [], apply: false },
  );
  assert.deepEqual(
    parseCleanupArgs([
      '--repo', REPO,
      '--expected-sha', SHA_A,
      '--preserve-path', '.github/workflows/pr-owned.yml',
      '--workflow-id', '11',
      '--workflow-id', '13',
      '--apply',
    ]),
    {
      repository: REPO,
      branch: 'develop',
      expectedSha: SHA_A,
      preservePaths: ['.github/workflows/pr-owned.yml'],
      reviewedWorkflowIds: [11, 13],
      apply: true,
    },
  );
  assert.throws(() => parseCleanupArgs(['--repo', REPO, '--apply']), /expected-sha is required/);
  assert.throws(() => parseCleanupArgs(['--repo', REPO, '--expected-sha', SHA_A, '--apply']), /workflow-id is required/);
  assert.throws(
    () => parseCleanupArgs(['--repo', REPO, '--expected-sha', SHA_A, '--workflow-id', '0', '--apply']),
    /workflow-id must be a positive safe integer/,
  );
  assert.throws(
    () => parseCleanupArgs(['--repo', REPO, '--expected-sha', SHA_A, '--workflow-id', '11', '--workflow-id', '11', '--apply']),
    /duplicate workflow-id/,
  );
  assert.throws(() => parseCleanupArgs(['--repo', REPO, '--expected-sha', 'main', '--apply']), /40-character commit SHA/);
  assert.throws(() => parseCleanupArgs(['--repo', REPO, '--expected-sha', SHA_A, '--unknown']), /unsupported argument/);

  for (const flag of ['--repo', '--branch', '--expected-sha', '--preserve-path', '--workflow-id']) {
    const args = flag === '--repo' ? [flag, '--apply'] : ['--repo', REPO, flag, '--apply'];
    assert.throws(() => parseCleanupArgs(args), new RegExp(`${flag} requires a value`));
  }
});

test('high-level apply refuses missing authentication before audit or mutation traffic', async () => {
  let requests = 0;
  await assert.rejects(
    () => cleanupWorkflowRegistry({
      fetchImpl: async () => { requests += 1; return response(403, { private: 'must not surface' }); },
      apiBase: API,
      repository: REPO,
      branch: 'develop',
      expectedSha: SHA_A,
      reviewedWorkflowIds: [11],
      apply: true,
      token: '',
    }),
    /GitHub token is required/,
  );
  assert.equal(requests, 0);
});

test('apply preflights exact workflow identity, disables only the planned ID, and verifies disabled state', async () => {
  const branchUrl = `${API}/repos/${REPO}/branches/develop`;
  const workflowUrl = `${API}/repos/${REPO}/actions/workflows/11`;
  const disableUrl = `${workflowUrl}/disable`;
  let disabled = false;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, authorization: init.headers.authorization, signal: init.signal });
    if (url === branchUrl) return response(200, { commit: { sha: SHA_A } });
    if (url === workflowUrl && init.method === 'GET') {
      return response(200, {
        id: 11,
        path: '.github/workflows/legacy-repair.yml',
        state: disabled ? 'disabled_manually' : 'active',
      });
    }
    if (url === disableUrl && init.method === 'PUT') {
      disabled = true;
      return response(204);
    }
    return response(404, { private: 'must not surface' });
  };

  const result = await applyWorkflowCleanupPlan({
    fetchImpl,
    apiBase: API,
    repository: REPO,
    branch: 'develop',
    expectedSha: SHA_A,
    targets: [{ workflow_id: 11, path: '.github/workflows/legacy-repair.yml' }],
    token: 'secret-token',
    sleepImpl: async () => {},
  });

  assert.deepEqual(result.disabled, [{ workflow_id: 11, path: '.github/workflows/legacy-repair.yml', state: 'disabled_manually' }]);
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 1);
  const disableCall = calls.find((call) => call.method === 'PUT');
  assert.equal(disableCall.url, disableUrl);
  assert.ok(disableCall.signal instanceof AbortSignal, 'workflow disable request must carry a bounded AbortSignal');
  assert.ok(calls.every((call) => call.authorization === 'Bearer secret-token'));
});

test('protected-branch movement or workflow identity drift prevents mutation', async () => {
  let putCount = 0;
  await assert.rejects(
    () => applyWorkflowCleanupPlan({
      fetchImpl: async (url, init) => {
        if (init.method === 'PUT') putCount += 1;
        if (url.endsWith('/branches/develop')) return response(200, { commit: { sha: SHA_B } });
        return response(200, { id: 11, path: '.github/workflows/legacy-repair.yml', state: 'active' });
      },
      apiBase: API,
      repository: REPO,
      branch: 'develop',
      expectedSha: SHA_A,
      targets: [{ workflow_id: 11, path: '.github/workflows/legacy-repair.yml' }],
      token: 'secret-token',
    }),
    /protected branch moved/,
  );
  assert.equal(putCount, 0);

  await assert.rejects(
    () => applyWorkflowCleanupPlan({
      fetchImpl: async (url, init) => {
        if (init.method === 'PUT') putCount += 1;
        if (url.endsWith('/branches/develop')) return response(200, { commit: { sha: SHA_A } });
        return response(200, { id: 11, path: '.github/workflows/reused.yml', state: 'active' });
      },
      apiBase: API,
      repository: REPO,
      branch: 'develop',
      expectedSha: SHA_A,
      targets: [{ workflow_id: 11, path: '.github/workflows/legacy-repair.yml' }],
      token: 'secret-token',
    }),
    /workflow identity changed/,
  );
  assert.equal(putCount, 0);
});

test('disable retries bounded transient 5xx failures and never retries permission failures', async () => {
  const branchUrl = `${API}/repos/${REPO}/branches/develop`;
  const workflowUrl = `${API}/repos/${REPO}/actions/workflows/11`;
  const disableUrl = `${workflowUrl}/disable`;
  const delays = [];
  let putAttempts = 0;
  let disabled = false;
  const fetchImpl = async (url, init) => {
    if (url === branchUrl) return response(200, { commit: { sha: SHA_A } });
    if (url === workflowUrl) return response(200, { id: 11, path: '.github/workflows/legacy-repair.yml', state: disabled ? 'disabled_manually' : 'active' });
    if (url === disableUrl && init.method === 'PUT') {
      putAttempts += 1;
      if (putAttempts < 2) return response(503, { private: 'provider detail' });
      disabled = true;
      return response(204);
    }
    return response(404, {});
  };
  const result = await applyWorkflowCleanupPlan({
    fetchImpl,
    apiBase: API,
    repository: REPO,
    branch: 'develop',
    expectedSha: SHA_A,
    targets: [{ workflow_id: 11, path: '.github/workflows/legacy-repair.yml' }],
    token: 'secret-token',
    sleepImpl: async (delay) => { delays.push(delay); },
  });
  assert.equal(result.disabled.length, 1);
  assert.equal(putAttempts, 2);
  assert.deepEqual(delays, [100]);

  putAttempts = 0;
  await assert.rejects(
    () => applyWorkflowCleanupPlan({
      fetchImpl: async (url, init) => {
        if (url === branchUrl) return response(200, { commit: { sha: SHA_A } });
        if (url === workflowUrl && init.method === 'GET') return response(200, { id: 11, path: '.github/workflows/legacy-repair.yml', state: 'active' });
        if (url === disableUrl && init.method === 'PUT') { putAttempts += 1; return response(403, { private: 'secret response' }); }
        return response(404, {});
      },
      apiBase: API,
      repository: REPO,
      branch: 'develop',
      expectedSha: SHA_A,
      targets: [{ workflow_id: 11, path: '.github/workflows/legacy-repair.yml' }],
      token: 'secret-token',
      sleepImpl: async (delay) => { delays.push(delay); },
    }),
    (error) => {
      assert.match(error.message, /status 403/);
      assert.doesNotMatch(error.message, /secret response/);
      return true;
    },
  );
  assert.equal(putAttempts, 1);
});

test('apply requires explicit authentication before any network request', async () => {
  let requests = 0;
  await assert.rejects(
    () => applyWorkflowCleanupPlan({
      fetchImpl: async () => { requests += 1; return response(500, {}); },
      apiBase: API,
      repository: REPO,
      branch: 'develop',
      expectedSha: SHA_A,
      targets: [{ workflow_id: 11, path: '.github/workflows/legacy-repair.yml' }],
      token: '',
    }),
    /GitHub token is required/,
  );
  assert.equal(requests, 0);
});
