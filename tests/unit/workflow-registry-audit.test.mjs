import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditWorkflowRegistry,
  classifyWorkflows,
  listAllWorkflows,
  listProtectedWorkflowPaths,
  parseArgs,
  parseLinkHeader,
  requestJson,
  sleepMilliseconds,
  validateRepository,
} from '../../scripts/ci/workflow_registry_audit.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const API = 'https://api.github.test';
const REPO = 'ContextualWisdomLab/scopeweave';

function response(status, body, headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) ?? null },
    async json() { if (body instanceof Error) throw body; return body; },
  };
}

const branchBody = (sha) => ({ name: 'develop', commit: { sha } });
const directoryBody = (paths) => paths.map((path, index) => ({
  name: path.split('/').at(-1), path, sha: String(index).padStart(40, '0'), type: 'file',
}));
const workflow = (id, path, state = 'active') => ({ id, path, state, name: path });

test('repository and Link parsing reject ambiguity without normalizing paths', () => {
  assert.equal(validateRepository(REPO), REPO);
  assert.throws(() => validateRepository('scopeweave'), /owner\/name/);
  assert.throws(() => validateRepository('owner/repo/extra'), /owner\/name/);
  const links = parseLinkHeader('<https://api.github.test/page/2>; rel="next", <https://api.github.test/page/3>; rel="last"');
  assert.equal(links.get('next'), 'https://api.github.test/page/2');
  assert.equal(links.get('last'), 'https://api.github.test/page/3');
  assert.equal(parseLinkHeader('garbage').size, 0);
});

test('production retry delay uses a real timer and exposes a deterministic test seam', async () => {
  const scheduled = [];
  let released = false;
  const promise = sleepMilliseconds(125, (callback, delay) => {
    scheduled.push(delay);
    callback();
    return 1;
  }).then(() => { released = true; });
  assert.deepEqual(scheduled, [125]);
  await promise;
  assert.equal(released, true);
  await assert.rejects(() => sleepMilliseconds(-1), /delay/);
});

test('requestJson retries bounded transient 5xx responses but fails closed on permissions and malformed JSON', async () => {
  let attempts = 0;
  const delays = [];
  const recovered = await requestJson({
    fetchImpl: async () => { attempts += 1; return attempts < 3 ? response(503, { private: 'must not surface' }) : response(200, { ok: true }); },
    url: `${API}/probe`,
    sleepImpl: async (delay) => { delays.push(delay); },
  });
  assert.deepEqual(recovered.data, { ok: true });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);

  for (const status of [403, 404]) {
    await assert.rejects(
      () => requestJson({ fetchImpl: async () => response(status, { secret: 'private provider text' }), url: `${API}/probe` }),
      (error) => {
        assert.match(error.message, new RegExp(`status ${status}`));
        assert.doesNotMatch(error.message, /private provider text|secret/);
        return true;
      },
    );
  }
  await assert.rejects(
    () => requestJson({ fetchImpl: async () => response(200, new SyntaxError('raw parser detail')), url: `${API}/probe` }),
    /invalid JSON/,
  );
  await assert.rejects(
    () => requestJson({ fetchImpl: async () => response(500, {}), url: `${API}/probe`, maxAttempts: 2 }),
    /status 500/,
  );
  await assert.rejects(
    () => requestJson({ fetchImpl: async () => response(200, {}), url: `${API}/probe`, maxAttempts: 0 }),
    /maxAttempts/,
  );
});

test('workflow pagination must be complete, unique by ID, and unable to follow an untrusted next endpoint', async () => {
  const firstUrl = `${API}/repos/${REPO}/actions/workflows?per_page=100`;
  const secondUrl = `${API}/repos/${REPO}/actions/workflows?page=2&per_page=100`;
  const pages = new Map([
    [firstUrl, response(200, { total_count: 2, workflows: [workflow(1, '.github/workflows/a.yml')] }, { link: `<${secondUrl}>; rel="next"` })],
    [secondUrl, response(200, { total_count: 2, workflows: [workflow(2, '.github/workflows/b.yml')] })],
  ]);
  const complete = await listAllWorkflows({ fetchImpl: async (url) => pages.get(url) || response(404, {}), apiBase: API, repository: REPO });
  assert.deepEqual(complete.workflows.map((item) => item.id), [1, 2]);
  assert.equal(complete.totalCount, 2);
  assert.deepEqual(complete.receipts.map((item) => item.item_count), [1, 1]);

  await assert.rejects(
    () => listAllWorkflows({ fetchImpl: async () => response(200, { total_count: 2, workflows: [workflow(1, '.github/workflows/a.yml')] }), apiBase: API, repository: REPO }),
    /pagination incomplete/,
  );
  const duplicatePages = new Map([
    [firstUrl, response(200, { total_count: 2, workflows: [workflow(1, '.github/workflows/a.yml')] }, { link: `<${secondUrl}>; rel="next"` })],
    [secondUrl, response(200, { total_count: 2, workflows: [workflow(1, '.github/workflows/a-renamed.yml')] })],
  ]);
  await assert.rejects(
    () => listAllWorkflows({ fetchImpl: async (url) => duplicatePages.get(url) || response(404, {}), apiBase: API, repository: REPO }),
    /duplicate workflow id/,
  );
  await assert.rejects(
    () => listAllWorkflows({
      fetchImpl: async () => response(200, { total_count: 1, workflows: [workflow(1, '.github/workflows/a.yml')] }, { link: '<https://evil.example/steal>; rel="next"' }),
      apiBase: API,
      repository: REPO,
    }),
    /trusted GitHub endpoint/,
  );
});

test('missing protected workflow directory fails closed instead of becoming an empty tree', async () => {
  await assert.rejects(
    () => listProtectedWorkflowPaths({
      fetchImpl: async () => response(404, { message: 'not found but do not copy this body' }),
      apiBase: API,
      repository: REPO,
      sha: SHA_A,
    }),
    (error) => {
      assert.match(error.message, /status 404/);
      assert.doesNotMatch(error.message, /do not copy this body/);
      return true;
    },
  );
});

test('classification preserves exact case, known states, dynamic identities, exceptions, and reused paths', () => {
  const repeatedPath = '.github/workflows/reused.yml';
  const classified = classifyWorkflows([
    workflow(8, '.github/workflows/Case.yml'),
    workflow(2, '.github/workflows/current.yml'),
    workflow(3, 'dynamic/dependabot/update-graph'),
    workflow(4, '.github/workflows/kept-by-active-pr.yml'),
    workflow(5, '.github/workflows/old-disabled.yml', 'disabled_manually'),
    workflow(6, repeatedPath), workflow(7, repeatedPath),
  ], ['.github/workflows/current.yml', '.github/workflows/case.yml'], ['.github/workflows/kept-by-active-pr.yml']);
  const byId = new Map(classified.map((item) => [item.workflow_id, item]));
  assert.equal(byId.get(8).classification, 'active_orphan', 'path case is exact');
  assert.equal(byId.get(2).classification, 'present_active');
  assert.equal(byId.get(3).classification, 'github_dynamic');
  assert.equal(byId.get(4).classification, 'preserved_absent');
  assert.equal(byId.get(5).classification, 'inactive_absent');
  assert.equal(byId.get(6).classification, 'active_orphan');
  assert.equal(byId.get(7).classification, 'active_orphan');
  assert.equal(byId.get(6).duplicate_path_identity, true);
  assert.equal(byId.get(7).duplicate_path_identity, true);
  assert.throws(
    () => classifyWorkflows([workflow(9, '.github/workflows/future.yml', 'paused_by_future_api')], []),
    /unknown workflow state/,
  );
});

test('a present one-shot-like workflow is preserved by tree evidence without name heuristics', () => {
  const path = '.github/workflows/one-shot-legitimate-production-check.yml';
  const [entry] = classifyWorkflows([workflow(42, path)], [path]);
  assert.equal(entry.classification, 'present_active');
});

test('full audit binds registry evidence to one unchanged protected SHA and emits pagination receipts', async () => {
  const branchUrl = `${API}/repos/${REPO}/branches/develop`;
  const workflowsUrl = `${API}/repos/${REPO}/actions/workflows?per_page=100`;
  const contentsUrl = `${API}/repos/${REPO}/contents/.github/workflows?ref=${SHA_A}`;
  let branchReads = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['x-github-api-version'], '2026-03-10');
    if (url === branchUrl) { branchReads += 1; return response(200, branchBody(SHA_A)); }
    if (url === workflowsUrl) return response(200, { total_count: 4, workflows: [
      workflow(10, '.github/workflows/current.yml'), workflow(11, '.github/workflows/orphan.yml'),
      workflow(12, '.github/workflows/pr-owned.yml'), workflow(13, 'dynamic/github-code-scanning/codeql'),
    ] });
    if (url === contentsUrl) return response(200, directoryBody(['.github/workflows/current.yml']));
    return response(404, {});
  };
  const evidence = await auditWorkflowRegistry({
    fetchImpl, apiBase: API, repository: REPO, branch: 'develop',
    preservePaths: ['.github/workflows/pr-owned.yml'], now: () => new Date('2026-08-15T00:00:00.000Z'),
  });
  assert.equal(branchReads, 2);
  assert.equal(evidence.default_branch_sha, SHA_A);
  assert.equal(evidence.observed_at, '2026-08-15T00:00:00.000Z');
  assert.equal(evidence.registry_total_count, 4);
  assert.equal(evidence.pagination_receipts.length, 1);
  assert.equal(evidence.active_orphan_count, 1);
  assert.deepEqual(evidence.protected_workflow_paths, ['.github/workflows/current.yml']);
  assert.equal(evidence.classifications.find((item) => item.workflow_id === 11).classification, 'active_orphan');
});

test('branch movement invalidates the entire mixed-time observation', async () => {
  const branchUrl = `${API}/repos/${REPO}/branches/develop`;
  const workflowsUrl = `${API}/repos/${REPO}/actions/workflows?per_page=100`;
  const contentsUrl = `${API}/repos/${REPO}/contents/.github/workflows?ref=${SHA_A}`;
  let branchReads = 0;
  const fetchImpl = async (url) => {
    if (url === branchUrl) { branchReads += 1; return response(200, branchBody(branchReads === 1 ? SHA_A : SHA_B)); }
    if (url === workflowsUrl) return response(200, { total_count: 0, workflows: [] });
    if (url === contentsUrl) return response(200, []);
    return response(404, {});
  };
  await assert.rejects(() => auditWorkflowRegistry({ fetchImpl, apiBase: API, repository: REPO, branch: 'develop' }), /protected branch moved/);
});

test('CLI options require canonical workflow-file exceptions and reject write-like arguments', () => {
  assert.deepEqual(
    parseArgs(['--repo', REPO, '--branch', 'develop', '--preserve-path', '.github/workflows/hourly.yml'], {}),
    { repository: REPO, branch: 'develop', preservePaths: ['.github/workflows/hourly.yml'] },
  );
  for (const invalidPath of [
    'dynamic/agent',
    '.github/workflows/../security.yml',
    '.github/workflows/subdir/child.yml',
    '.github/workflows/',
    '.github\\workflows\\hourly.yml',
  ]) {
    assert.throws(() => parseArgs(['--repo', REPO, '--preserve-path', invalidPath], {}), /canonical workflow file/);
  }
  assert.throws(() => parseArgs(['--repo', REPO, '--write'], {}), /unsupported argument/);
});
