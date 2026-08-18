import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupWorkflowRegistry } from '../../scripts/ci/workflow_registry_cleanup.mjs';

const API = 'https://api.github.test';
const REPO = 'ContextualWisdomLab/scopeweave';
const SHA = 'a'.repeat(40);
const TARGET_PATH = '.github/workflows/legacy-repair.yml';
const PRESENT_PATH = '.github/workflows/server-tests.yml';

function response(status, body = null, headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) ?? null },
    async json() { return body; },
  };
}

test('cleanup rejects an applied result when the fresh postcondition audit becomes unresolved', async () => {
  const branchUrl = `${API}/repos/${REPO}/branches/develop`;
  const workflowsUrl = `${API}/repos/${REPO}/actions/workflows?per_page=100`;
  const contentsUrl = `${API}/repos/${REPO}/contents/.github/workflows?ref=${SHA}`;
  const workflowUrl = `${API}/repos/${REPO}/actions/workflows/11`;
  const disableUrl = `${workflowUrl}/disable`;
  let disabled = false;

  const fetchImpl = async (url, init = {}) => {
    if (url === branchUrl) return response(200, { commit: { sha: SHA } });
    if (url === workflowsUrl) {
      return response(200, {
        total_count: 2,
        workflows: [
          { id: 11, path: TARGET_PATH, state: disabled ? 'disabled_manually' : 'active' },
          { id: 12, path: PRESENT_PATH, state: disabled ? 'unknown_future_state' : 'active' },
        ],
      });
    }
    if (url === contentsUrl) {
      return response(200, [{ type: 'file', path: PRESENT_PATH }]);
    }
    if (url === workflowUrl && (init.method ?? 'GET') === 'GET') {
      return response(200, { id: 11, path: TARGET_PATH, state: disabled ? 'disabled_manually' : 'active' });
    }
    if (url === disableUrl && init.method === 'PUT') {
      disabled = true;
      return response(204);
    }
    return response(404, { private: 'must not surface' });
  };

  await assert.rejects(
    () => cleanupWorkflowRegistry({
      fetchImpl,
      apiBase: API,
      repository: REPO,
      branch: 'develop',
      expectedSha: SHA,
      reviewedWorkflowIds: [11],
      apply: true,
      token: 'secret-token',
      sleepImpl: async () => {},
      now: () => new Date('2026-08-18T01:00:00.000Z'),
    }),
    /cleanup postcondition failed: unresolved workflow identities remain/,
  );
  assert.equal(disabled, true);
});
