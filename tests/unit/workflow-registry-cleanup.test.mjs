import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorkflowCleanupPlan,
  buildWorkflowCleanupPlan,
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

test('cleanup plan is exact-SHA bound and selects only reviewed active orphans', () => {
  const plan = buildWorkflowCleanupPlan({ evidence: evidence(), expectedSha: SHA_A });
  assert.equal(plan.default_branch_sha, SHA_A);
  assert.deepEqual(plan.targets, [{ workflow_id: 11, path: '.github/workflows/legacy-repair.yml' }]);

  assert.throws(
    () => buildWorkflowCleanupPlan({ evidence: evidence(), expectedSha: SHA_B }),
    /expected protected branch SHA/,
  );
  assert.throws(
    () => buildWorkflowCleanupPlan({ evidence: evidence({ unresolved_count: 1 }), expectedSha: SHA_A }),
    /unresolved workflow identities/,
  );
});

test('cleanup CLI is dry-run by default and apply requires an immutable expected SHA', () => {
  assert.deepEqual(
    parseCleanupArgs(['--repo', REPO, '--branch', 'develop', '--expected-sha', SHA_A]),
    { repository: REPO, branch: 'develop', expectedSha: SHA_A, preservePaths: [], apply: false },
  );
  assert.deepEqual(
    parseCleanupArgs(['--repo', REPO, '--expected-sha', SHA_A, '--preserve-path', '.github/workflows/pr-owned.yml', '--apply']),
    { repository: REPO, branch: 'develop', expectedSha: SHA_A, preservePaths: ['.github/workflows/pr-owned.yml'], apply: true },
  );
  assert.throws(() => parseCleanupArgs(['--repo', REPO, '--apply']), /expected-sha is required/);
  assert.throws(() => parseCleanupArgs(['--repo', REPO, '--expected-sha', 'main', '--apply']), /40-character commit SHA/);
  assert.throws(() => parseCleanupArgs(['--repo', REPO, '--expected-sha', SHA_A, '--unknown']), /unsupported argument/);
});

test('apply preflights exact workflow identity, disables only the planned ID, and verifies disabled state', async () => {
  const branchUrl = `${API}/repos/${REPO}/branches/develop`;
  const workflowUrl = `${API}/repos/${REPO}/actions/workflows/11`;
  const disableUrl = `${workflowUrl}/disable`;
  let disabled = false;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, authorization: init.headers.authorization });
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
  assert.equal(calls.find((call) => call.method === 'PUT').url, disableUrl);
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
