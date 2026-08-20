import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GitHubApiError,
  auditWorkflowRegistry,
  classifyWorkflows,
  fetchBranchSha,
  listAllWorkflows,
  listProtectedWorkflowPaths,
  parseArgs,
  requestJson,
  sleepMilliseconds,
} from '../../scripts/ci/workflow_registry_audit.mjs';
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
const ROOT_TREE_SHA = 'c'.repeat(40);
const GITHUB_TREE_SHA = 'd'.repeat(40);
const WORKFLOW_TREE_SHA = 'e'.repeat(40);
const TARGET_PATH = '.github/workflows/legacy-repair.yml';

function response(status, body = null, headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) ?? null },
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function workflowIdentity(state = 'active', path = TARGET_PATH, id = 11) {
  return { id, path, state };
}

function activeOrphan(id = 11, path = TARGET_PATH) {
  return {
    workflow_id: id,
    path,
    state: 'active',
    classification: 'active_orphan',
    duplicate_path_identity: false,
  };
}

function cleanupEvidence(overrides = {}) {
  return {
    repository: REPO,
    branch: 'develop',
    default_branch_sha: SHA_A,
    unresolved_count: 0,
    classifications: [activeOrphan()],
    ...overrides,
  };
}

function branchBody(sha) {
  return { commit: { sha } };
}

test('audit primitives reject malformed dependencies, ranges, and response identities', async () => {
  const unknown = new GitHubApiError(undefined);
  assert.equal(unknown.status, undefined);
  assert.match(unknown.message, /unknown/);

  await assert.rejects(() => sleepMilliseconds(60_001), /retry delay/);
  await assert.rejects(() => sleepMilliseconds(1.5), /retry delay/);
  await assert.rejects(() => sleepMilliseconds(1, null), /setTimeoutImpl/);

  await assert.rejects(
    () => requestJson({ fetchImpl: null, url: `${API}/probe` }),
    /fetchImpl/,
  );
  await assert.rejects(
    () => requestJson({ fetchImpl: async () => response(200, {}), sleepImpl: null, url: `${API}/probe` }),
    /sleepImpl/,
  );
  await assert.rejects(
    () => requestJson({ fetchImpl: async () => response(200, {}), url: `${API}/probe`, maxAttempts: 6 }),
    /maxAttempts/,
  );
  const noLink = await requestJson({
    fetchImpl: async () => ({ status: 200, ok: true, headers: null, async json() { return { ok: true }; } }),
    url: `${API}/probe`,
  });
  assert.equal(noLink.linkHeader, null);
  await assert.rejects(
    () => requestJson({ fetchImpl: async () => ({ status: undefined, ok: false }), url: `${API}/probe`, maxAttempts: 1 }),
    (error) => error instanceof GitHubApiError && error.status === undefined,
  );
  await assert.rejects(
    () => fetchBranchSha({ fetchImpl: async () => response(200, { commit: { sha: 'not-a-sha' } }), apiBase: API, repository: REPO, branch: 'develop' }),
    /valid commit SHA/,
  );
});

test('workflow pagination rejects changing totals, invalid shapes, invalid IDs, and runaway next links', async () => {
  await assert.rejects(
    () => listAllWorkflows({ fetchImpl: async () => response(200, { total_count: 0, workflows: null }), apiBase: API, repository: REPO }),
    /invalid shape/,
  );

  let changingPage = 0;
  await assert.rejects(
    () => listAllWorkflows({
      fetchImpl: async (url) => {
        changingPage += 1;
        if (changingPage === 1) {
          return response(200, { total_count: 2, workflows: [workflowIdentity('active', '.github/workflows/a.yml', 1)] }, {
            link: `<${API}/repos/${REPO}/actions/workflows?page=2&per_page=100>; rel="next"`,
          });
        }
        return response(200, { total_count: 3, workflows: [workflowIdentity('active', '.github/workflows/b.yml', 2)] });
      },
      apiBase: API,
      repository: REPO,
    }),
    /total_count changed/,
  );

  await assert.rejects(
    () => listAllWorkflows({
      fetchImpl: async () => response(200, { total_count: 1, workflows: [{ id: '1', path: '.github/workflows/a.yml', state: 'active' }] }),
      apiBase: API,
      repository: REPO,
    }),
    /invalid workflow id/,
  );

  let pages = 0;
  await assert.rejects(
    () => listAllWorkflows({
      fetchImpl: async (url) => {
        pages += 1;
        const nextPage = pages + 1;
        return response(200, {
          total_count: 101,
          workflows: [workflowIdentity('active', `.github/workflows/${pages}.yml`, pages)],
        }, {
          link: `<${API}/repos/${REPO}/actions/workflows?page=${nextPage}&per_page=100>; rel="next"`,
        });
      },
      apiBase: API,
      repository: REPO,
    }),
    /100-page safety bound/,
  );
  assert.equal(pages, 100);
});

test('protected workflow path reads fail closed on ambiguous and malformed Contents responses', async () => {
  await assert.rejects(
    () => listProtectedWorkflowPaths({ fetchImpl: async () => response(403, { private: 'hidden' }), apiBase: API, repository: REPO, sha: SHA_A }),
    /status 403/,
  );
  await assert.rejects(
    () => listProtectedWorkflowPaths({ fetchImpl: async () => response(200, { path: 'not-an-array' }), apiBase: API, repository: REPO, sha: SHA_A }),
    /not an array/,
  );
  await assert.rejects(
    () => listProtectedWorkflowPaths({
      fetchImpl: async () => response(200, [{ type: 'file', path: '.github/workflows/nested/bad.yml' }]),
      apiBase: API,
      repository: REPO,
      sha: SHA_A,
    }),
    /non-canonical/,
  );
  assert.deepEqual(
    await listProtectedWorkflowPaths({
      fetchImpl: async () => response(200, [{ type: 'dir', path: '.github/workflows/not-a-file' }]),
      apiBase: API,
      repository: REPO,
      sha: SHA_A,
    }),
    [],
  );
});

test('immutable tree fallback rejects malformed, truncated, duplicate, and non-tree evidence', async () => {
  const contentsUrl = `${API}/repos/${REPO}/contents/.github/workflows?ref=${SHA_A}`;
  const commitUrl = `${API}/repos/${REPO}/git/commits/${SHA_A}`;
  const rootUrl = `${API}/repos/${REPO}/git/trees/${ROOT_TREE_SHA}`;
  const githubUrl = `${API}/repos/${REPO}/git/trees/${GITHUB_TREE_SHA}`;
  const workflowsUrl = `${API}/repos/${REPO}/git/trees/${WORKFLOW_TREE_SHA}`;

  await assert.rejects(
    () => listProtectedWorkflowPaths({
      fetchImpl: async (url) => {
        if (url === contentsUrl) return response(404, {});
        if (url === commitUrl) return response(200, { tree: { sha: 'bad' } });
        return response(404, {});
      },
      apiBase: API,
      repository: REPO,
      sha: SHA_A,
    }),
    /valid tree SHA/,
  );

  await assert.rejects(
    () => listProtectedWorkflowPaths({
      fetchImpl: async (url) => {
        if (url === contentsUrl) return response(404, {});
        if (url === commitUrl) return response(200, { tree: { sha: ROOT_TREE_SHA } });
        if (url === rootUrl) return response(200, { tree: [], truncated: true });
        return response(404, {});
      },
      apiBase: API,
      repository: REPO,
      sha: SHA_A,
    }),
    /incomplete or invalid/,
  );

  assert.deepEqual(
    await listProtectedWorkflowPaths({
      fetchImpl: async (url) => {
        if (url === contentsUrl) return response(404, {});
        if (url === commitUrl) return response(200, { tree: { sha: ROOT_TREE_SHA } });
        if (url === rootUrl) return response(200, { tree: [], truncated: false });
        return response(404, {});
      },
      apiBase: API,
      repository: REPO,
      sha: SHA_A,
    }),
    [],
  );

  for (const rootTree of [
    [
      { path: '.github', type: 'tree', sha: GITHUB_TREE_SHA },
      { path: '.github', type: 'tree', sha: GITHUB_TREE_SHA },
    ],
    [{ path: '.github', type: 'blob', sha: GITHUB_TREE_SHA }],
  ]) {
    await assert.rejects(
      () => listProtectedWorkflowPaths({
        fetchImpl: async (url) => {
          if (url === contentsUrl) return response(404, {});
          if (url === commitUrl) return response(200, { tree: { sha: ROOT_TREE_SHA } });
          if (url === rootUrl) return response(200, { tree: rootTree, truncated: false });
          return response(404, {});
        },
        apiBase: API,
        repository: REPO,
        sha: SHA_A,
      }),
      /duplicate path|\.github entry is not a tree/,
    );
  }

  await assert.rejects(
    () => listProtectedWorkflowPaths({
      fetchImpl: async (url) => {
        if (url === contentsUrl) return response(404, {});
        if (url === commitUrl) return response(200, { tree: { sha: ROOT_TREE_SHA } });
        if (url === rootUrl) return response(200, { tree: [{ path: '.github', type: 'tree', sha: GITHUB_TREE_SHA }], truncated: false });
        if (url === githubUrl) return response(200, { tree: [{ path: 'workflows', type: 'blob', sha: WORKFLOW_TREE_SHA }], truncated: false });
        return response(404, {});
      },
      apiBase: API,
      repository: REPO,
      sha: SHA_A,
    }),
    /workflows entry is not a tree/,
  );

  await assert.rejects(
    () => listProtectedWorkflowPaths({
      fetchImpl: async (url) => {
        if (url === contentsUrl) return response(404, {});
        if (url === commitUrl) return response(200, { tree: { sha: ROOT_TREE_SHA } });
        if (url === rootUrl) return response(200, { tree: [{ path: '.github', type: 'tree', sha: GITHUB_TREE_SHA }], truncated: false });
        if (url === githubUrl) return response(200, { tree: [{ path: 'workflows', type: 'tree', sha: WORKFLOW_TREE_SHA }], truncated: false });
        if (url === workflowsUrl) return response(200, { tree: [{ path: 'nested/bad.yml', type: 'blob', sha: 'f'.repeat(40) }], truncated: false });
        return response(404, {});
      },
      apiBase: API,
      repository: REPO,
      sha: SHA_A,
    }),
    /non-canonical/,
  );
});

test('classification and audit argument validation cover inactive-present and malformed identities', async () => {
  assert.throws(() => classifyWorkflows({}, []), /must be arrays/);
  assert.throws(() => classifyWorkflows([{ id: 1, path: null, state: 'active' }], []), /invalid identity/);
  assert.throws(() => classifyWorkflows([{ id: 0, path: '.github/workflows/a.yml', state: 'active' }], []), /invalid identity/);
  const [inactivePresent] = classifyWorkflows(
    [workflowIdentity('disabled_manually', '.github/workflows/present.yml', 7)],
    ['.github/workflows/present.yml'],
  );
  assert.equal(inactivePresent.classification, 'present_inactive');

  await assert.rejects(
    () => auditWorkflowRegistry({ repository: REPO, branch: '', fetchImpl: async () => response(500, {}) }),
    /branch must be/,
  );
  await assert.rejects(
    () => auditWorkflowRegistry({ repository: REPO, branch: 'x'.repeat(256), fetchImpl: async () => response(500, {}) }),
    /branch must be/,
  );
  await assert.rejects(
    () => auditWorkflowRegistry({ repository: REPO, now: null, fetchImpl: async () => response(500, {}) }),
    /now must be/,
  );

  assert.deepEqual(parseArgs([], { GITHUB_REPOSITORY: REPO }), { repository: REPO, branch: 'develop', preservePaths: [] });
  assert.throws(() => parseArgs(['--repo'], {}), /owner\/name/);
  assert.throws(() => parseArgs(['--branch'], { GITHUB_REPOSITORY: REPO }), /branch is required/);
  assert.throws(() => parseArgs(['--preserve-path'], { GITHUB_REPOSITORY: REPO }), /canonical workflow file/);
});

test('cleanup planning and CLI parsing reject malformed candidate and operator evidence', () => {
  assert.throws(() => buildWorkflowCleanupPlan({ evidence: null, expectedSha: SHA_A }), /audit evidence/);
  assert.throws(() => buildWorkflowCleanupPlan({ evidence: cleanupEvidence({ unresolved_count: '0' }), expectedSha: SHA_A }), /unresolved workflow identities/);
  assert.throws(() => buildWorkflowCleanupPlan({ evidence: cleanupEvidence({ classifications: null }), expectedSha: SHA_A }), /classifications/);
  assert.throws(() => buildWorkflowCleanupPlan({ evidence: cleanupEvidence(), expectedSha: SHA_A, reviewedWorkflowIds: null }), /reviewed workflow ids/);
  assert.throws(() => buildWorkflowCleanupPlan({ evidence: cleanupEvidence({ classifications: [activeOrphan(0)] }), expectedSha: SHA_A }), /invalid workflow id/);
  assert.throws(() => buildWorkflowCleanupPlan({ evidence: cleanupEvidence({ classifications: [activeOrphan(), activeOrphan()] }), expectedSha: SHA_A }), /duplicate workflow id/);
  assert.throws(() => buildWorkflowCleanupPlan({ evidence: cleanupEvidence({ classifications: [{ ...activeOrphan(), state: 'disabled_manually' }] }), expectedSha: SHA_A }), /is not active/);
  assert.throws(() => buildWorkflowCleanupPlan({ evidence: cleanupEvidence({ classifications: [activeOrphan(11, 'dynamic/not-canonical')] }), expectedSha: SHA_A }), /non-canonical/);
  assert.throws(() => buildWorkflowCleanupPlan({ evidence: cleanupEvidence(), expectedSha: SHA_A, reviewedWorkflowIds: ['01'] }), /positive safe integer/);
  assert.throws(() => buildWorkflowCleanupPlan({ evidence: cleanupEvidence(), expectedSha: SHA_A, reviewedWorkflowIds: ['99999999999999999999'] }), /positive safe integer/);

  assert.deepEqual(parseCleanupArgs([], { GITHUB_REPOSITORY: REPO }), {
    repository: REPO,
    branch: 'develop',
    expectedSha: '',
    preservePaths: [],
    reviewedWorkflowIds: [],
    apply: false,
  });
  assert.throws(() => parseCleanupArgs(['--branch'], { GITHUB_REPOSITORY: REPO }), /--branch requires a value/);
  assert.throws(() => parseCleanupArgs(['--branch', 'x'.repeat(256)], { GITHUB_REPOSITORY: REPO }), /branch must be/);
  assert.throws(() => parseCleanupArgs(['--preserve-path', 'dynamic/nope'], { GITHUB_REPOSITORY: REPO }), /canonical immediate workflow/);
});

test('apply cleanup validates dependencies and exact target identities before network traffic', async () => {
  const base = {
    apiBase: API,
    repository: REPO,
    branch: 'develop',
    expectedSha: SHA_A,
    targets: [{ workflow_id: 11, path: TARGET_PATH }],
    token: 'secret-token',
  };
  await assert.rejects(() => applyWorkflowCleanupPlan({ ...base, fetchImpl: null }), /fetchImpl/);
  await assert.rejects(() => applyWorkflowCleanupPlan({ ...base, fetchImpl: async () => response(500, {}), sleepImpl: null }), /sleepImpl/);
  await assert.rejects(() => applyWorkflowCleanupPlan({ ...base, fetchImpl: async () => response(500, {}), targets: [] }), /non-empty array/);
  await assert.rejects(() => applyWorkflowCleanupPlan({ ...base, fetchImpl: async () => response(500, {}), targets: [{ workflow_id: 0, path: TARGET_PATH }] }), /invalid workflow id/);
  await assert.rejects(() => applyWorkflowCleanupPlan({ ...base, fetchImpl: async () => response(500, {}), targets: [{ workflow_id: 11, path: 'dynamic/nope' }] }), /invalid workflow path/);
  await assert.rejects(() => applyWorkflowCleanupPlan({
    ...base,
    fetchImpl: async () => response(500, {}),
    targets: [{ workflow_id: 11, path: TARGET_PATH }, { workflow_id: 11, path: TARGET_PATH }],
  }), /duplicate workflow ids/);
});

test('cleanup preflight adopts concurrent manual disable but rejects unexpected states', async () => {
  const branchUrl = `${API}/repos/${REPO}/branches/develop`;
  const workflowUrl = `${API}/repos/${REPO}/actions/workflows/11`;
  const alreadyDisabled = await applyWorkflowCleanupPlan({
    fetchImpl: async (url) => {
      if (url === branchUrl) return response(200, branchBody(SHA_A));
      if (url === workflowUrl) return response(200, workflowIdentity('disabled_manually'));
      return response(404, {});
    },
    apiBase: API,
    repository: REPO,
    branch: 'develop',
    expectedSha: SHA_A,
    targets: [{ workflow_id: 11, path: TARGET_PATH }],
    token: 'secret-token',
    sleepImpl: async () => {},
  });
  assert.equal(alreadyDisabled.disabled.length, 0);
  assert.equal(alreadyDisabled.already_disabled.length, 1);

  await assert.rejects(
    () => applyWorkflowCleanupPlan({
      fetchImpl: async (url) => {
        if (url === branchUrl) return response(200, branchBody(SHA_A));
        if (url === workflowUrl) return response(200, workflowIdentity('disabled_inactivity'));
        return response(404, {});
      },
      apiBase: API,
      repository: REPO,
      branch: 'develop',
      expectedSha: SHA_A,
      targets: [{ workflow_id: 11, path: TARGET_PATH }],
      token: 'secret-token',
      sleepImpl: async () => {},
    }),
    /no longer an operator-disable candidate/,
  );
});

test('cleanup catches identity and state races after preflight without mutation', async () => {
  const branchUrl = `${API}/repos/${REPO}/branches/develop`;
  const workflowUrl = `${API}/repos/${REPO}/actions/workflows/11`;
  for (const secondIdentity of [
    workflowIdentity('active', '.github/workflows/reused.yml'),
    workflowIdentity('disabled_inactivity'),
  ]) {
    let workflowReads = 0;
    let puts = 0;
    await assert.rejects(
      () => applyWorkflowCleanupPlan({
        fetchImpl: async (url, init) => {
          if (url === branchUrl) return response(200, branchBody(SHA_A));
          if (url === workflowUrl) {
            workflowReads += 1;
            return response(200, workflowReads === 1 ? workflowIdentity('active') : secondIdentity);
          }
          if (init?.method === 'PUT') puts += 1;
          return response(404, {});
        },
        apiBase: API,
        repository: REPO,
        branch: 'develop',
        expectedSha: SHA_A,
        targets: [{ workflow_id: 11, path: TARGET_PATH }],
        token: 'secret-token',
        sleepImpl: async () => {},
      }),
      /workflow identity changed|no longer active/,
    );
    assert.equal(puts, 0);
  }
});

test('disable verification tolerates bounded propagation but fails closed on drift, bad state, or no transition', async () => {
  const branchUrl = `${API}/repos/${REPO}/branches/develop`;
  const workflowUrl = `${API}/repos/${REPO}/actions/workflows/11`;
  const disableUrl = `${workflowUrl}/disable`;
  let disabledRequested = false;
  let postDisableReads = 0;
  const delays = [];
  const success = await applyWorkflowCleanupPlan({
    fetchImpl: async (url, init) => {
      if (url === branchUrl) return response(200, branchBody(SHA_A));
      if (url === disableUrl && init.method === 'PUT') {
        disabledRequested = true;
        return response(204);
      }
      if (url === workflowUrl) {
        if (!disabledRequested) return response(200, workflowIdentity('active'));
        postDisableReads += 1;
        return response(200, workflowIdentity(postDisableReads < 3 ? 'active' : 'disabled_manually'));
      }
      return response(404, {});
    },
    apiBase: API,
    repository: REPO,
    branch: 'develop',
    expectedSha: SHA_A,
    targets: [{ workflow_id: 11, path: TARGET_PATH }],
    token: 'secret-token',
    sleepImpl: async (delay) => { delays.push(delay); },
  });
  assert.equal(success.disabled.length, 1);
  assert.deepEqual(delays, [100, 200]);

  for (const afterPut of [
    workflowIdentity('active', '.github/workflows/reused.yml'),
    workflowIdentity('disabled_inactivity'),
  ]) {
    let put = false;
    await assert.rejects(
      () => applyWorkflowCleanupPlan({
        fetchImpl: async (url, init) => {
          if (url === branchUrl) return response(200, branchBody(SHA_A));
          if (url === disableUrl && init.method === 'PUT') { put = true; return response(204); }
          if (url === workflowUrl) return response(200, put ? afterPut : workflowIdentity('active'));
          return response(404, {});
        },
        apiBase: API,
        repository: REPO,
        branch: 'develop',
        expectedSha: SHA_A,
        targets: [{ workflow_id: 11, path: TARGET_PATH }],
        token: 'secret-token',
        sleepImpl: async () => {},
      }),
      /workflow identity changed|entered unexpected state/,
    );
  }

  let put = false;
  await assert.rejects(
    () => applyWorkflowCleanupPlan({
      fetchImpl: async (url, init) => {
        if (url === branchUrl) return response(200, branchBody(SHA_A));
        if (url === disableUrl && init.method === 'PUT') { put = true; return response(204); }
        if (url === workflowUrl) return response(200, workflowIdentity('active'));
        return response(404, {});
      },
      apiBase: API,
      repository: REPO,
      branch: 'develop',
      expectedSha: SHA_A,
      targets: [{ workflow_id: 11, path: TARGET_PATH }],
      token: 'secret-token',
      sleepImpl: async () => {},
    }),
    /remained active/,
  );
  assert.equal(put, true);
});

test('disable retries exhaust bounded transient failures before returning a sanitized API error', async () => {
  const branchUrl = `${API}/repos/${REPO}/branches/develop`;
  const workflowUrl = `${API}/repos/${REPO}/actions/workflows/11`;
  const disableUrl = `${workflowUrl}/disable`;
  let puts = 0;
  const delays = [];
  await assert.rejects(
    () => applyWorkflowCleanupPlan({
      fetchImpl: async (url, init) => {
        if (url === branchUrl) return response(200, branchBody(SHA_A));
        if (url === workflowUrl) return response(200, workflowIdentity('active'));
        if (url === disableUrl && init.method === 'PUT') { puts += 1; return response(503, { private: 'hidden' }); }
        return response(404, {});
      },
      apiBase: API,
      repository: REPO,
      branch: 'develop',
      expectedSha: SHA_A,
      targets: [{ workflow_id: 11, path: TARGET_PATH }],
      token: 'secret-token',
      sleepImpl: async (delay) => { delays.push(delay); },
    }),
    (error) => {
      assert.match(error.message, /status 503/);
      assert.doesNotMatch(error.message, /hidden/);
      return true;
    },
  );
  assert.equal(puts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('high-level cleanup exposes dry-run evidence and validates apply requirements before audit', async () => {
  const branchUrl = `${API}/repos/${REPO}/branches/develop`;
  const workflowsUrl = `${API}/repos/${REPO}/actions/workflows?per_page=100`;
  const contentsUrl = `${API}/repos/${REPO}/contents/.github/workflows?ref=${SHA_A}`;
  const dryRun = await cleanupWorkflowRegistry({
    fetchImpl: async (url) => {
      if (url === branchUrl) return response(200, branchBody(SHA_A));
      if (url === workflowsUrl) return response(200, { total_count: 1, workflows: [workflowIdentity('active', TARGET_PATH, 11)] });
      if (url === contentsUrl) return response(200, []);
      return response(404, {});
    },
    apiBase: API,
    repository: REPO,
    branch: 'develop',
    now: () => new Date('2026-08-18T00:00:00.000Z'),
  });
  assert.equal(dryRun.mode, 'dry_run');
  assert.equal(dryRun.plan.candidates.length, 1);

  let requests = 0;
  await assert.rejects(
    () => cleanupWorkflowRegistry({
      fetchImpl: async () => { requests += 1; return response(500, {}); },
      apiBase: API,
      repository: REPO,
      apply: true,
      token: 'secret-token',
      reviewedWorkflowIds: [11],
    }),
    /expected-sha is required/,
  );
  await assert.rejects(
    () => cleanupWorkflowRegistry({
      fetchImpl: async () => { requests += 1; return response(500, {}); },
      apiBase: API,
      repository: REPO,
      expectedSha: SHA_A,
      apply: true,
      token: 'secret-token',
      reviewedWorkflowIds: [],
    }),
    /workflow-id is required/,
  );
  assert.equal(requests, 0);
});

test('postcondition rejects protected-SHA drift and a selected target that reappears active', async () => {
  const branchUrl = `${API}/repos/${REPO}/branches/develop`;
  const workflowsUrl = `${API}/repos/${REPO}/actions/workflows?per_page=100`;
  const contentsA = `${API}/repos/${REPO}/contents/.github/workflows?ref=${SHA_A}`;
  const contentsB = `${API}/repos/${REPO}/contents/.github/workflows?ref=${SHA_B}`;
  const workflowUrl = `${API}/repos/${REPO}/actions/workflows/11`;
  const disableUrl = `${workflowUrl}/disable`;

  let branchReads = 0;
  let disabled = false;
  await assert.rejects(
    () => cleanupWorkflowRegistry({
      fetchImpl: async (url, init = {}) => {
        if (url === branchUrl) {
          branchReads += 1;
          return response(200, branchBody(branchReads <= 5 ? SHA_A : SHA_B));
        }
        if (url === workflowsUrl) return response(200, { total_count: 1, workflows: [workflowIdentity(disabled ? 'disabled_manually' : 'active')] });
        if (url === contentsA || url === contentsB) return response(200, []);
        if (url === workflowUrl && (init.method ?? 'GET') === 'GET') return response(200, workflowIdentity(disabled ? 'disabled_manually' : 'active'));
        if (url === disableUrl && init.method === 'PUT') { disabled = true; return response(204); }
        return response(404, {});
      },
      apiBase: API,
      repository: REPO,
      branch: 'develop',
      expectedSha: SHA_A,
      reviewedWorkflowIds: [11],
      apply: true,
      token: 'secret-token',
      sleepImpl: async () => {},
    }),
    /protected branch moved before cleanup postcondition audit/,
  );

  let registryReads = 0;
  disabled = false;
  await assert.rejects(
    () => cleanupWorkflowRegistry({
      fetchImpl: async (url, init = {}) => {
        if (url === branchUrl) return response(200, branchBody(SHA_A));
        if (url === workflowsUrl) {
          registryReads += 1;
          return response(200, {
            total_count: 1,
            workflows: [workflowIdentity(registryReads === 1 ? 'active' : 'active')],
          });
        }
        if (url === contentsA) return response(200, []);
        if (url === workflowUrl && (init.method ?? 'GET') === 'GET') return response(200, workflowIdentity(disabled ? 'disabled_manually' : 'active'));
        if (url === disableUrl && init.method === 'PUT') { disabled = true; return response(204); }
        return response(404, {});
      },
      apiBase: API,
      repository: REPO,
      branch: 'develop',
      expectedSha: SHA_A,
      reviewedWorkflowIds: [11],
      apply: true,
      token: 'secret-token',
      sleepImpl: async () => {},
    }),
    /planned workflow remains active/,
  );
});

test('CLI entry points execute their main and sanitized catch paths in child processes', () => {
  for (const relative of [
    '../../scripts/ci/workflow_registry_audit.mjs',
    '../../scripts/ci/workflow_registry_cleanup.mjs',
  ]) {
    const script = fileURLToPath(new URL(relative, import.meta.url));
    const child = spawnSync(process.execPath, [script], {
      env: { ...process.env, GITHUB_REPOSITORY: 'invalid-repository', GITHUB_TOKEN: '' },
      encoding: 'utf8',
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /owner\/name|workflow registry cleanup failed/);
  }
});
