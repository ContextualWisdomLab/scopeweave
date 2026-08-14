#!/usr/bin/env node
/**
 * Read-only audit of GitHub Actions workflow registry identities against an exact
 * protected-branch tree. The detector performs GET requests only and emits
 * evidence for a separately authorized disable operation.
 * @module workflow_registry_audit
 */
import { pathToFileURL } from 'node:url';

export const GITHUB_API_VERSION = '2026-03-10';
export const WORKFLOW_DIRECTORY = '.github/workflows';
const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);
const KNOWN_WORKFLOW_STATES = new Set([
  'active',
  'deleted',
  'disabled_fork',
  'disabled_inactivity',
  'disabled_manually',
]);
const CANONICAL_WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;

/** GitHub API failure that retains only the numeric status, never response text. */
export class GitHubApiError extends Error {
  /**
   * @param {number|undefined} status - HTTP status if one was available.
   */
  constructor(status) {
    super(`GitHub API request failed with status ${Number.isFinite(status) ? status : 'unknown'}`);
    this.name = 'GitHubApiError';
    this.status = Number.isFinite(status) ? status : undefined;
  }
}

/** Validate and return an exact `owner/repository` identifier. */
export function validateRepository(value) {
  const repository = String(value || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new TypeError('repository must use exact owner/name form');
  }
  return repository;
}

/** Parse the GitHub pagination subset of an RFC 8288 Link header. */
export function parseLinkHeader(value) {
  const links = new Map();
  for (const segment of String(value || '').split(',')) {
    const match = segment.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (match) links.set(match[2], match[1]);
  }
  return links;
}

/**
 * Delay a bounded retry using the real runtime timer by default.
 *
 * The timer implementation is injectable only so unit tests can prove the
 * delay contract without sleeping. Production callers use `globalThis.setTimeout`.
 */
export function sleepMilliseconds(delayMs, setTimeoutImpl = globalThis.setTimeout) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    return Promise.reject(new RangeError('retry delay must be an integer from 0 through 60000 milliseconds'));
  }
  if (typeof setTimeoutImpl !== 'function') {
    return Promise.reject(new TypeError('setTimeoutImpl must be a function'));
  }
  return new Promise((resolve) => setTimeoutImpl(resolve, delayMs));
}

/** Perform a bounded JSON GET with retry only for transient 5xx responses. */
export async function requestJson({ fetchImpl, url, token = '', sleepImpl = sleepMilliseconds, maxAttempts = 3 }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof sleepImpl !== 'function') throw new TypeError('sleepImpl must be a function');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new RangeError('maxAttempts must be an integer from 1 through 5');
  }
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': GITHUB_API_VERSION };
  if (token) headers.authorization = `Bearer ${token}`;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error' });
    const status = Number(response?.status);
    if (response?.ok) {
      let data;
      try { data = await response.json(); } catch { throw new Error(`GitHub API returned invalid JSON (status ${status})`); }
      return { data, linkHeader: response.headers?.get?.('link') ?? null, status };
    }
    if (!TRANSIENT_STATUS.has(status) || attempt === maxAttempts) {
      throw new GitHubApiError(status);
    }
    await sleepImpl(100 * attempt);
  }
  throw new Error('unreachable GitHub API retry state');
}

/** Fetch and validate one protected branch commit identity. */
export async function fetchBranchSha({ fetchImpl, apiBase, repository, branch, token = '', sleepImpl }) {
  const url = `${apiBase}/repos/${repository}/branches/${encodeURIComponent(branch)}`;
  const { data } = await requestJson({ fetchImpl, url, token, sleepImpl });
  const sha = data?.commit?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error('GitHub branch response is missing a valid commit SHA');
  }
  return sha.toLowerCase();
}

/** Enumerate every workflow identity and prove pagination completeness. */
export async function listAllWorkflows({ fetchImpl, apiBase, repository, token = '', sleepImpl }) {
  const expectedOrigin = new URL(apiBase).origin;
  const endpointPath = `/repos/${repository}/actions/workflows`;
  let nextUrl = `${apiBase}${endpointPath}?per_page=100`;
  const workflows = [];
  const receipts = [];
  let totalCount = null;
  let page = 0;
  while (nextUrl) {
    page += 1;
    if (page > 100) throw new Error('workflow pagination exceeded the 100-page safety bound');
    const parsed = new URL(nextUrl);
    if (parsed.origin !== expectedOrigin || parsed.pathname !== endpointPath) {
      throw new Error('workflow pagination attempted to leave the trusted GitHub endpoint');
    }
    const { data, linkHeader, status } = await requestJson({ fetchImpl, url: parsed.href, token, sleepImpl });
    if (!data || !Array.isArray(data.workflows) || !Number.isSafeInteger(data.total_count)) {
      throw new Error('GitHub workflow response has an invalid shape');
    }
    if (totalCount === null) totalCount = data.total_count;
    if (totalCount !== data.total_count) throw new Error('GitHub workflow total_count changed during pagination');
    workflows.push(...data.workflows);
    receipts.push({ page, status, item_count: data.workflows.length, url: parsed.href });
    nextUrl = parseLinkHeader(linkHeader).get('next') || '';
  }
  if (workflows.length !== totalCount) {
    throw new Error(`workflow pagination incomplete: observed ${workflows.length} of ${totalCount}`);
  }
  const workflowIds = new Set();
  for (const item of workflows) {
    if (!Number.isSafeInteger(item?.id)) throw new Error('workflow registry contains an invalid workflow id');
    if (workflowIds.has(item.id)) throw new Error(`workflow registry contains duplicate workflow id ${item.id}`);
    workflowIds.add(item.id);
  }
  return { workflows, receipts, totalCount };
}

/**
 * Read and validate one non-recursive Git tree.
 *
 * @param {object} options - GitHub request dependencies and tree identity.
 * @returns {Promise<Array<object>>} Exact non-recursive tree entries.
 */
async function readGitTree({ fetchImpl, apiBase, repository, treeSha, token = '', sleepImpl }) {
  const url = `${apiBase}/repos/${repository}/git/trees/${treeSha}`;
  const { data } = await requestJson({ fetchImpl, url, token, sleepImpl });
  if (!data || !Array.isArray(data.tree) || data.truncated === true) {
    throw new Error('GitHub tree response is incomplete or invalid');
  }
  return data.tree;
}

/** Resolve a commit SHA to its exact root tree SHA. */
async function resolveCommitTreeSha({ fetchImpl, apiBase, repository, commitSha, token = '', sleepImpl }) {
  const url = `${apiBase}/repos/${repository}/git/commits/${commitSha}`;
  const { data } = await requestJson({ fetchImpl, url, token, sleepImpl });
  const treeSha = data?.tree?.sha;
  if (typeof treeSha !== 'string' || !/^[0-9a-f]{40}$/i.test(treeSha)) {
    throw new Error('GitHub commit response is missing a valid tree SHA');
  }
  return treeSha.toLowerCase();
}

/** Select at most one exact path entry from a Git tree. */
function exactTreeEntry(entries, path) {
  const matches = entries.filter((entry) => entry?.path === path);
  if (matches.length > 1) throw new Error(`GitHub tree contains duplicate path ${path}`);
  return matches[0] || null;
}

/**
 * Prove a genuinely absent workflow directory through immutable Git tree reads.
 *
 * This fallback is used only after the Contents API returns 404. Returning an
 * empty list requires successful commit/root/.github tree lookups that prove the
 * workflow directory entry does not exist. Any ambiguous Git Data failure stays
 * fail-closed.
 */
async function listProtectedWorkflowPathsFromTree({ fetchImpl, apiBase, repository, sha, token = '', sleepImpl }) {
  const rootTreeSha = await resolveCommitTreeSha({ fetchImpl, apiBase, repository, commitSha: sha, token, sleepImpl });
  const rootEntries = await readGitTree({ fetchImpl, apiBase, repository, treeSha: rootTreeSha, token, sleepImpl });
  const githubEntry = exactTreeEntry(rootEntries, '.github');
  if (!githubEntry) return [];
  if (githubEntry.type !== 'tree' || typeof githubEntry.sha !== 'string') {
    throw new Error('GitHub .github entry is not a tree');
  }

  const githubEntries = await readGitTree({ fetchImpl, apiBase, repository, treeSha: githubEntry.sha, token, sleepImpl });
  const workflowsEntry = exactTreeEntry(githubEntries, 'workflows');
  if (!workflowsEntry) return [];
  if (workflowsEntry.type !== 'tree' || typeof workflowsEntry.sha !== 'string') {
    throw new Error('GitHub workflows entry is not a tree');
  }

  const workflowEntries = await readGitTree({ fetchImpl, apiBase, repository, treeSha: workflowsEntry.sha, token, sleepImpl });
  const paths = workflowEntries
    .filter((entry) => entry?.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => `${WORKFLOW_DIRECTORY}/${entry.path}`);
  if (paths.some((path) => !CANONICAL_WORKFLOW_PATH.test(path))) {
    throw new Error('GitHub workflow tree contains a non-canonical workflow file path');
  }
  return paths;
}

/** Read exact case-sensitive workflow file paths from one protected commit. */
export async function listProtectedWorkflowPaths({ fetchImpl, apiBase, repository, sha, token = '', sleepImpl }) {
  const url = `${apiBase}/repos/${repository}/contents/${WORKFLOW_DIRECTORY}?ref=${sha}`;
  let data;
  try {
    ({ data } = await requestJson({ fetchImpl, url, token, sleepImpl }));
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
    return listProtectedWorkflowPathsFromTree({ fetchImpl, apiBase, repository, sha, token, sleepImpl });
  }
  if (!Array.isArray(data)) throw new Error('GitHub workflow-directory response is not an array');
  const paths = data.filter((entry) => entry?.type === 'file').map((entry) => entry.path);
  if (paths.some((path) => typeof path !== 'string' || !CANONICAL_WORKFLOW_PATH.test(path))) {
    throw new Error('GitHub workflow-directory response contains a non-canonical workflow file path');
  }
  return paths;
}

/** Classify exact workflow identities without collapsing reused paths. */
export function classifyWorkflows(workflows, protectedPaths, preservePaths = []) {
  if (!Array.isArray(workflows) || !Array.isArray(protectedPaths)) throw new TypeError('workflows and protectedPaths must be arrays');
  const present = new Set(protectedPaths);
  const preserved = new Set(preservePaths);
  const pathCounts = new Map();
  for (const workflow of workflows) {
    if (typeof workflow?.path === 'string') pathCounts.set(workflow.path, (pathCounts.get(workflow.path) || 0) + 1);
  }
  return workflows.map((workflow) => {
    const { id, path, state } = workflow || {};
    if (!Number.isSafeInteger(id) || typeof path !== 'string' || typeof state !== 'string') {
      throw new Error('workflow registry contains an invalid identity');
    }
    let classification;
    if (!KNOWN_WORKFLOW_STATES.has(state)) classification = 'unresolved';
    else if (path.startsWith('dynamic/')) classification = 'github_dynamic';
    else if (present.has(path)) classification = state === 'active' ? 'present_active' : 'present_inactive';
    else if (state !== 'active') classification = 'inactive_absent';
    else if (preserved.has(path)) classification = 'preserved_absent';
    else classification = 'active_orphan';
    return { workflow_id: id, path, state, classification, duplicate_path_identity: (pathCounts.get(path) || 0) > 1 };
  }).sort((left, right) => left.workflow_id - right.workflow_id);
}

/** Produce a pagination-complete audit bound to one unchanged protected SHA. */
export async function auditWorkflowRegistry({
  fetchImpl = globalThis.fetch,
  apiBase = 'https://api.github.com',
  repository,
  branch = 'develop',
  token = '',
  preservePaths = [],
  sleepImpl,
  now = () => new Date(),
}) {
  const checkedRepository = validateRepository(repository);
  if (typeof branch !== 'string' || branch.length < 1 || branch.length > 255) {
    throw new TypeError('branch must be a non-empty string no longer than 255 characters');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const startSha = await fetchBranchSha({ fetchImpl, apiBase, repository: checkedRepository, branch, token, sleepImpl });
  const registry = await listAllWorkflows({ fetchImpl, apiBase, repository: checkedRepository, token, sleepImpl });
  const protectedPaths = await listProtectedWorkflowPaths({ fetchImpl, apiBase, repository: checkedRepository, sha: startSha, token, sleepImpl });
  const endSha = await fetchBranchSha({ fetchImpl, apiBase, repository: checkedRepository, branch, token, sleepImpl });
  if (startSha !== endSha) throw new Error('protected branch moved during workflow registry audit');
  const classifications = classifyWorkflows(registry.workflows, protectedPaths, preservePaths);
  return {
    repository: checkedRepository,
    branch,
    default_branch_sha: startSha,
    observed_at: now().toISOString(),
    registry_total_count: registry.totalCount,
    pagination_receipts: registry.receipts,
    protected_workflow_paths: [...protectedPaths].sort(),
    classifications,
    active_orphan_count: classifications.filter((item) => item.classification === 'active_orphan').length,
    unresolved_count: classifications.filter((item) => item.classification === 'unresolved').length,
  };
}

/** Parse CLI arguments; no write or disable option exists. */
export function parseArgs(argv, environment = process.env) {
  let repository = environment.GITHUB_REPOSITORY || '';
  let branch = 'develop';
  const preservePaths = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo') repository = argv[++index] || '';
    else if (argument === '--branch') branch = argv[++index] || '';
    else if (argument === '--preserve-path') preservePaths.push(argv[++index] || '');
    else throw new Error(`unsupported argument: ${argument}`);
  }
  validateRepository(repository);
  if (!branch) throw new Error('branch is required');
  for (const path of preservePaths) {
    if (!CANONICAL_WORKFLOW_PATH.test(path)) {
      throw new Error(`preserved path must be a canonical workflow file under ${WORKFLOW_DIRECTORY}`);
    }
  }
  return { repository, branch, preservePaths };
}

/** Execute the read-only CLI and print one JSON evidence document. */
export async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = await auditWorkflowRegistry({ ...options, token: process.env.GITHUB_TOKEN || '' });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`workflow registry audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
