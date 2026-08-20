#!/usr/bin/env node
/**
 * Fail-closed operator control for disabling GitHub Actions workflow identities
 * that a fresh ScopeWeave registry audit proves are active and absent from one
 * exact protected-branch tree.
 *
 * The command is dry-run by default. Mutation requires `--apply`, an exact
 * `--expected-sha`, at least one explicitly reviewed `--workflow-id`, and
 * `GITHUB_TOKEN`. Every target is re-read immediately before mutation, the
 * protected branch is rechecked throughout the operation, and every disable is
 * verified through GitHub's workflow metadata endpoint.
 *
 * @module workflow_registry_cleanup
 */
import { pathToFileURL } from 'node:url';
import {
  GITHUB_API_VERSION,
  GitHubApiError,
  auditWorkflowRegistry,
  fetchBranchSha,
  requestJson,
  sleepMilliseconds,
  validateRepository,
} from './workflow_registry_audit.mjs';

const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);
const CANONICAL_WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const WORKFLOW_DISABLE_REQUEST_TIMEOUT_MS = 10_000;

/** Validate one immutable Git commit identity. */
export function validateCommitSha(value) {
  const sha = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new TypeError('expected-sha must be a 40-character commit SHA');
  }
  return sha;
}

/** Validate a workflow ID without allowing coercive numeric spellings. */
function validateWorkflowId(value) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(text)) throw new TypeError('workflow-id must be a positive safe integer');
  const workflowId = Number(text);
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0) {
    throw new TypeError('workflow-id must be a positive safe integer');
  }
  return workflowId;
}

/**
 * Convert read-only audit evidence into candidate identities and the exact
 * reviewed subset eligible for an operator disable action.
 */
export function buildWorkflowCleanupPlan({ evidence, expectedSha, reviewedWorkflowIds = [] }) {
  if (!evidence || typeof evidence !== 'object') throw new TypeError('audit evidence is required');
  const checkedSha = validateCommitSha(expectedSha);
  if (String(evidence.default_branch_sha || '').toLowerCase() !== checkedSha) {
    throw new Error('audit evidence does not match the expected protected branch SHA');
  }
  if (!Number.isSafeInteger(evidence.unresolved_count) || evidence.unresolved_count !== 0) {
    throw new Error('workflow cleanup refuses to mutate while unresolved workflow identities exist');
  }
  if (!Array.isArray(evidence.classifications)) throw new Error('audit evidence classifications are missing');
  if (!Array.isArray(reviewedWorkflowIds)) throw new TypeError('reviewed workflow ids must be an array');

  const candidates = [];
  const candidateById = new Map();
  for (const item of evidence.classifications) {
    if (item?.classification !== 'active_orphan') continue;
    if (!Number.isSafeInteger(item.workflow_id) || item.workflow_id <= 0) {
      throw new Error('active orphan has an invalid workflow id');
    }
    if (candidateById.has(item.workflow_id)) {
      throw new Error(`cleanup plan contains duplicate workflow id ${item.workflow_id}`);
    }
    if (item.state !== 'active') throw new Error(`active orphan ${item.workflow_id} is not active`);
    if (typeof item.path !== 'string' || !CANONICAL_WORKFLOW_PATH.test(item.path)) {
      throw new Error(`active orphan ${item.workflow_id} has a non-canonical workflow path`);
    }
    const candidate = { workflow_id: item.workflow_id, path: item.path };
    candidates.push(candidate);
    candidateById.set(item.workflow_id, candidate);
  }
  candidates.sort((left, right) => left.workflow_id - right.workflow_id);

  const reviewedIds = [];
  const seenReviewed = new Set();
  for (const rawWorkflowId of reviewedWorkflowIds) {
    const workflowId = validateWorkflowId(rawWorkflowId);
    if (seenReviewed.has(workflowId)) throw new Error(`duplicate reviewed workflow id ${workflowId}`);
    seenReviewed.add(workflowId);
    reviewedIds.push(workflowId);
  }
  const targets = reviewedIds.map((workflowId) => {
    const candidate = candidateById.get(workflowId);
    if (!candidate) throw new Error(`reviewed workflow id ${workflowId} is not a current active orphan`);
    return candidate;
  }).sort((left, right) => left.workflow_id - right.workflow_id);

  return {
    repository: evidence.repository,
    branch: evidence.branch,
    default_branch_sha: checkedSha,
    candidates,
    targets,
  };
}

/** Parse dry-run/apply CLI arguments without accepting implicit mutation. */
export function parseCleanupArgs(argv, environment = process.env) {
  let repository = environment.GITHUB_REPOSITORY || '';
  let branch = 'develop';
  let expectedSha = '';
  let apply = false;
  const preservePaths = [];
  const reviewedWorkflowIds = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo') {
      const value = argv[index + 1];
      if (value?.startsWith('--') !== false) throw new Error('--repo requires a value');
      repository = value;
      index += 1;
    } else if (argument === '--branch') {
      const value = argv[index + 1];
      if (value?.startsWith('--') !== false) throw new Error('--branch requires a value');
      branch = value;
      index += 1;
    } else if (argument === '--expected-sha') {
      const value = argv[index + 1];
      if (value?.startsWith('--') !== false) throw new Error('--expected-sha requires a value');
      expectedSha = value;
      index += 1;
    } else if (argument === '--preserve-path') {
      const value = argv[index + 1];
      if (value?.startsWith('--') !== false) throw new Error('--preserve-path requires a value');
      preservePaths.push(value);
      index += 1;
    } else if (argument === '--workflow-id') {
      const value = argv[index + 1];
      if (value?.startsWith('--') !== false) throw new Error('--workflow-id requires a value');
      reviewedWorkflowIds.push(validateWorkflowId(value));
      index += 1;
    } else if (argument === '--apply') apply = true;
    else throw new Error(`unsupported argument: ${argument}`);
  }

  validateRepository(repository);
  if (typeof branch !== 'string' || branch.length < 1 || branch.length > 255) {
    throw new TypeError('branch must be a non-empty string no longer than 255 characters');
  }
  if (expectedSha) expectedSha = validateCommitSha(expectedSha);
  if (new Set(reviewedWorkflowIds).size !== reviewedWorkflowIds.length) throw new Error('duplicate workflow-id');
  if (apply && !expectedSha) throw new Error('expected-sha is required with --apply');
  if (apply && reviewedWorkflowIds.length === 0) throw new Error('workflow-id is required with --apply');
  for (const path of preservePaths) {
    if (!CANONICAL_WORKFLOW_PATH.test(path)) {
      throw new Error('preserved path must be a canonical immediate workflow YAML path');
    }
  }
  return { repository, branch, expectedSha, preservePaths, reviewedWorkflowIds, apply };
}

/** Read one workflow identity without exposing response bodies in failures. */
async function fetchWorkflowIdentity({ fetchImpl, apiBase, repository, workflowId, token, sleepImpl }) {
  const url = `${apiBase}/repos/${repository}/actions/workflows/${workflowId}`;
  const { data } = await requestJson({ fetchImpl, url, token, sleepImpl });
  if (!data || !Number.isSafeInteger(data.id) || typeof data.path !== 'string' || typeof data.state !== 'string') {
    throw new Error(`workflow ${workflowId} metadata has an invalid shape`);
  }
  return { workflow_id: data.id, path: data.path, state: data.state };
}

/** Perform one bounded GitHub workflow-disable request. */
async function requestWorkflowDisable({
  fetchImpl,
  apiBase,
  repository,
  workflowId,
  token,
  sleepImpl = sleepMilliseconds,
  maxAttempts = 3,
}) {
  const url = `${apiBase}/repos/${repository}/actions/workflows/${workflowId}/disable`;
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': GITHUB_API_VERSION,
    authorization: `Bearer ${token}`,
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, {
      method: 'PUT',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(WORKFLOW_DISABLE_REQUEST_TIMEOUT_MS),
    });
    const status = Number(response?.status);
    if (status === 204) return;
    if (!TRANSIENT_STATUS.has(status) || attempt === maxAttempts) throw new GitHubApiError(status);
    await sleepImpl(100 * attempt);
  }
  throw new Error('unreachable workflow-disable retry state');
}

/** Prove the protected branch is still the immutable branch used by the plan. */
async function assertExpectedBranchSha({ fetchImpl, apiBase, repository, branch, expectedSha, token, sleepImpl }) {
  const liveSha = await fetchBranchSha({ fetchImpl, apiBase, repository, branch, token, sleepImpl });
  if (liveSha !== expectedSha) throw new Error('protected branch moved during workflow cleanup');
}

/** Verify GitHub has transitioned one workflow identity to manual-disabled state. */
async function verifyDisabled({ fetchImpl, apiBase, repository, target, token, sleepImpl = sleepMilliseconds }) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const current = await fetchWorkflowIdentity({
      fetchImpl, apiBase, repository, workflowId: target.workflow_id, token, sleepImpl,
    });
    if (current.workflow_id !== target.workflow_id || current.path !== target.path) {
      throw new Error(`workflow identity changed for ${target.workflow_id}`);
    }
    if (current.state === 'disabled_manually') return current;
    if (current.state !== 'active') {
      throw new Error(`workflow ${target.workflow_id} entered unexpected state ${current.state}`);
    }
    if (attempt < 3) await sleepImpl(100 * attempt);
  }
  throw new Error(`workflow ${target.workflow_id} remained active after disable request`);
}

/**
 * Apply a precomputed exact-SHA cleanup plan with per-target optimistic
 * concurrency checks. Already-disabled targets are adopted rather than raced.
 */
export async function applyWorkflowCleanupPlan({
  fetchImpl = globalThis.fetch,
  apiBase = 'https://api.github.com',
  repository,
  branch = 'develop',
  expectedSha,
  targets,
  token,
  sleepImpl = sleepMilliseconds,
}) {
  const checkedRepository = validateRepository(repository);
  const checkedSha = validateCommitSha(expectedSha);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof sleepImpl !== 'function') throw new TypeError('sleepImpl must be a function');
  if (typeof token !== 'string' || token.length === 0) throw new Error('GitHub token is required for workflow cleanup');
  if (!Array.isArray(targets) || targets.length === 0) throw new TypeError('cleanup targets must be a non-empty array');

  const normalizedTargets = targets.map((target) => {
    if (!Number.isSafeInteger(target?.workflow_id) || target.workflow_id <= 0) throw new Error('cleanup target has invalid workflow id');
    if (typeof target.path !== 'string' || !CANONICAL_WORKFLOW_PATH.test(target.path)) throw new Error('cleanup target has invalid workflow path');
    return { workflow_id: target.workflow_id, path: target.path };
  });
  if (new Set(normalizedTargets.map((target) => target.workflow_id)).size !== normalizedTargets.length) {
    throw new Error('cleanup targets contain duplicate workflow ids');
  }

  await assertExpectedBranchSha({
    fetchImpl, apiBase, repository: checkedRepository, branch, expectedSha: checkedSha, token, sleepImpl,
  });

  // Preflight the whole explicitly reviewed plan before the first mutation so
  // identity drift cannot leave a partially applied cleanup.
  for (const target of normalizedTargets) {
    const current = await fetchWorkflowIdentity({
      fetchImpl, apiBase, repository: checkedRepository, workflowId: target.workflow_id, token, sleepImpl,
    });
    if (current.workflow_id !== target.workflow_id || current.path !== target.path) {
      throw new Error(`workflow identity changed for ${target.workflow_id}`);
    }
    if (!['active', 'disabled_manually'].includes(current.state)) {
      throw new Error(`workflow ${target.workflow_id} is no longer an operator-disable candidate`);
    }
  }

  const disabled = [];
  const alreadyDisabled = [];
  for (const target of normalizedTargets) {
    await assertExpectedBranchSha({
      fetchImpl, apiBase, repository: checkedRepository, branch, expectedSha: checkedSha, token, sleepImpl,
    });
    const current = await fetchWorkflowIdentity({
      fetchImpl, apiBase, repository: checkedRepository, workflowId: target.workflow_id, token, sleepImpl,
    });
    if (current.workflow_id !== target.workflow_id || current.path !== target.path) {
      throw new Error(`workflow identity changed for ${target.workflow_id}`);
    }
    if (current.state === 'disabled_manually') {
      alreadyDisabled.push(current);
      continue;
    }
    if (current.state !== 'active') throw new Error(`workflow ${target.workflow_id} is no longer active`);

    await requestWorkflowDisable({
      fetchImpl,
      apiBase,
      repository: checkedRepository,
      workflowId: target.workflow_id,
      token,
      sleepImpl,
    });
    const verified = await verifyDisabled({
      fetchImpl, apiBase, repository: checkedRepository, target, token, sleepImpl,
    });
    disabled.push(verified);
  }

  await assertExpectedBranchSha({
    fetchImpl, apiBase, repository: checkedRepository, branch, expectedSha: checkedSha, token, sleepImpl,
  });
  return { repository: checkedRepository, branch, expected_sha: checkedSha, disabled, already_disabled: alreadyDisabled };
}

/** Plan or apply cleanup from one fresh, pagination-complete registry audit. */
export async function cleanupWorkflowRegistry({
  fetchImpl = globalThis.fetch,
  apiBase = 'https://api.github.com',
  repository,
  branch = 'develop',
  expectedSha = '',
  preservePaths = [],
  reviewedWorkflowIds = [],
  apply = false,
  token = '',
  sleepImpl = sleepMilliseconds,
  now = () => new Date(),
}) {
  if (apply && (typeof token !== 'string' || token.length === 0)) {
    throw new Error('GitHub token is required for workflow cleanup');
  }
  if (apply && !expectedSha) throw new Error('expected-sha is required for apply mode');
  if (apply && (!Array.isArray(reviewedWorkflowIds) || reviewedWorkflowIds.length === 0)) {
    throw new Error('workflow-id is required for apply mode');
  }

  const evidence = await auditWorkflowRegistry({
    fetchImpl, apiBase, repository, branch, token, preservePaths, sleepImpl, now,
  });
  const boundSha = expectedSha ? validateCommitSha(expectedSha) : evidence.default_branch_sha;
  const plan = buildWorkflowCleanupPlan({ evidence, expectedSha: boundSha, reviewedWorkflowIds });
  if (!apply) return { mode: 'dry_run', plan, evidence };

  const result = await applyWorkflowCleanupPlan({
    fetchImpl,
    apiBase,
    repository,
    branch,
    expectedSha: boundSha,
    targets: plan.targets,
    token,
    sleepImpl,
  });
  const after = await auditWorkflowRegistry({
    fetchImpl, apiBase, repository, branch, token, preservePaths, sleepImpl, now,
  });
  if (after.default_branch_sha !== boundSha) throw new Error('protected branch moved before cleanup postcondition audit');
  if (!Number.isSafeInteger(after.unresolved_count) || after.unresolved_count !== 0) {
    throw new Error('cleanup postcondition failed: unresolved workflow identities remain');
  }
  const targetIds = new Set(plan.targets.map((target) => target.workflow_id));
  const stillActive = after.classifications.filter(
    (item) => targetIds.has(item.workflow_id) && item.classification === 'active_orphan',
  );
  if (stillActive.length > 0) throw new Error('cleanup postcondition failed: planned workflow remains active');
  return { mode: 'applied', plan, result, after };
}

/** Execute the operator CLI and emit non-secret JSON evidence. */
export async function main() {
  const options = parseCleanupArgs(process.argv.slice(2));
  const result = await cleanupWorkflowRegistry({
    ...options,
    token: process.env.GITHUB_TOKEN || '',
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || 'workflow registry cleanup failed'}\n`);
    process.exitCode = 1;
  });
}
