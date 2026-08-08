#!/usr/bin/env node
/**
 * Validate ScopeWeave's hourly commercial-readiness workflow and RCA evidence.
 *
 * The module is dependency-free so it can run before repository-controlled
 * packages are installed and inside the secret-free verification boundary.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKFLOW_RELATIVE_PATH = '.github/workflows/hourly-opencode-commercial-readiness.yml';
const PROMPT_RELATIVE_PATH = '.github/prompts/hourly-commercial-readiness.md';
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RCA_FIELDS = Object.freeze([
  'schema_version',
  'target_kind',
  'target_id',
  'exact_head_sha',
  'symptom',
  'evidence',
  'causal_chain',
  'falsification_test',
  'candidate_actions',
  'chosen_action',
  'realism',
]);
const REALISM_FIELDS = Object.freeze([
  'repository_scope_confirmed',
  'single_writer_confirmed',
  'permissions_available',
  'dependencies_available',
  'secrets_not_required_for_tests',
  'estimated_minutes',
  'budget_minutes',
  'verification_commands',
  'rollback',
  'external_approval_needed_to_implement',
  'realistic',
  'reason',
]);
const REQUIRED_TRUE_REALISM_FIELDS = Object.freeze([
  'repository_scope_confirmed',
  'single_writer_confirmed',
  'permissions_available',
  'dependencies_available',
  'secrets_not_required_for_tests',
  'realistic',
]);
const CANDIDATE_FIELDS = Object.freeze([
  'action',
  'expected_effect',
  'risk',
  'reversible',
]);

/**
 * Return a plain JSON object or reject arrays, null, and class instances.
 *
 * @param {unknown} value Candidate value.
 * @param {string} label Human-readable field label.
 * @returns {Record<string, unknown>} Validated object.
 */
function requirePlainObject(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
  return value;
}

/**
 * Return a non-blank string without coercing caller-controlled values.
 *
 * @param {unknown} value Candidate value.
 * @param {string} label Human-readable field label.
 * @returns {string} Validated text.
 */
function requireNonBlankString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be non-empty text`);
  }
  return value;
}

/**
 * Return a non-empty array containing only non-blank strings.
 *
 * @param {unknown} value Candidate value.
 * @param {string} label Human-readable field label.
 * @returns {string[]} Validated string array.
 */
function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must contain at least one entry`);
  }
  value.forEach((item, index) => {
    requireNonBlankString(item, `${label}[${index}]`);
  });
  return value;
}

/**
 * Require exact object keys so schema drift never receives guessed semantics.
 *
 * @param {Record<string, unknown>} value Validated plain object.
 * @param {readonly string[]} expected Expected keys.
 * @param {string} label Human-readable schema label.
 */
function requireExactKeys(value, expected, label) {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  const actual = actualKeys.join('\u0000');
  const wanted = expectedKeys.join('\u0000');
  if (actual !== wanted) {
    const unknown = actualKeys.filter((key) => !expectedKeys.includes(key));
    const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
    const details = [
      unknown.length ? `unknown=${unknown.join(',')}` : '',
      missing.length ? `missing=${missing.join(',')}` : '',
    ].filter(Boolean).join(' ');
    throw new TypeError(`${label} fields are invalid: ${details}`);
  }
}

/**
 * Validate one candidate corrective action.
 *
 * @param {unknown} value Candidate action value.
 * @param {number} index Action index.
 * @returns {string} Canonical action name.
 */
function validateCandidateAction(value, index) {
  const candidate = requirePlainObject(value, `candidate_actions[${index}]`);
  requireExactKeys(candidate, CANDIDATE_FIELDS, `candidate_actions[${index}]`);
  const action = requireNonBlankString(candidate.action, 'candidate action');
  requireNonBlankString(candidate.expected_effect, 'candidate expected_effect');
  if (!['low', 'medium', 'high'].includes(candidate.risk)) {
    throw new TypeError('candidate risk must be low, medium, or high');
  }
  if (typeof candidate.reversible !== 'boolean') {
    throw new TypeError('candidate reversible must be boolean');
  }
  return action;
}

/**
 * Validate one evidence-backed RCA and its practical-feasibility gate.
 *
 * @param {unknown} document Parsed JSON document.
 */
export function validateRca(document) {
  const rca = requirePlainObject(document, 'RCA');
  requireExactKeys(rca, RCA_FIELDS, 'RCA');
  if (rca.schema_version !== 1) {
    throw new TypeError('unsupported RCA schema_version');
  }
  if (!['pull_request', 'product_gap'].includes(rca.target_kind)) {
    throw new TypeError('target_kind must be pull_request or product_gap');
  }
  requireNonBlankString(rca.target_id, 'target_id');
  if (typeof rca.exact_head_sha !== 'string' || !SHA_PATTERN.test(rca.exact_head_sha)) {
    throw new TypeError('exact head SHA must be 40 lowercase hexadecimal characters');
  }
  requireNonBlankString(rca.symptom, 'symptom');
  requireStringArray(rca.evidence, 'evidence');
  requireStringArray(rca.causal_chain, 'causal_chain');
  requireNonBlankString(rca.falsification_test, 'falsification_test');
  const chosenAction = requireNonBlankString(rca.chosen_action, 'chosen_action');

  if (!Array.isArray(rca.candidate_actions) || rca.candidate_actions.length === 0) {
    throw new TypeError('candidate_actions must contain at least one action');
  }
  const actionNames = rca.candidate_actions.map(validateCandidateAction);
  if (!actionNames.includes(chosenAction)) {
    throw new TypeError('chosen_action must exactly match one candidate action');
  }

  const realism = requirePlainObject(rca.realism, 'realism');
  requireExactKeys(realism, REALISM_FIELDS, 'realism');
  for (const field of REQUIRED_TRUE_REALISM_FIELDS) {
    if (realism[field] !== true) {
      throw new TypeError(`chosen action is not realistic: ${field} is not true`);
    }
  }
  if (realism.external_approval_needed_to_implement !== false) {
    throw new TypeError('external approval is required to implement the chosen action');
  }
  if (
    !Number.isInteger(realism.estimated_minutes)
    || realism.estimated_minutes < 1
    || !Number.isInteger(realism.budget_minutes)
    || realism.budget_minutes < 1
  ) {
    throw new TypeError('realism time values must be positive integers');
  }
  if (realism.estimated_minutes > realism.budget_minutes) {
    throw new TypeError('chosen action exceeds the available time budget');
  }
  requireStringArray(realism.verification_commands, 'verification commands');
  requireNonBlankString(realism.rollback, 'rollback');
  requireNonBlankString(realism.reason, 'realism reason');
}

/**
 * Load one strict UTF-8 JSON RCA file and validate its complete contract.
 *
 * @param {string} path File path.
 */
export function validateRcaFile(path) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  validateRca(document);
}

/**
 * Require every static workflow or assignment marker used as a safety contract.
 *
 * @param {string} source Source text.
 * @param {readonly string[]} fragments Required literal fragments.
 * @param {string} label Human-readable contract label.
 */
function requireFragments(source, fragments, label) {
  const missing = fragments.filter((fragment) => !source.includes(fragment));
  if (missing.length) {
    throw new TypeError(`${label} is incomplete: ${missing.join(', ')}`);
  }
}

/**
 * Verify the checked-in hourly workflow and authoritative assignment.
 *
 * @param {string} root Repository root.
 */
export function verifyRepositoryContract(root) {
  const workflow = readFileSync(resolve(root, WORKFLOW_RELATIVE_PATH), 'utf8');
  const prompt = readFileSync(resolve(root, PROMPT_RELATIVE_PATH), 'utf8');
  if (workflow.includes('COPILOT_GITHUB_TOKEN')) {
    throw new TypeError('Copilot credential is prohibited in the hourly workflow');
  }
  requireFragments(workflow, [
    'cron: "17 * * * *"',
    'cancel-in-progress: false',
    'NVIDIA_NIM_API_KEY',
    'opencode run',
    '.opencode/target.json',
    '.opencode/rca.json',
    'hourly_commercial_readiness_contract.mjs rca',
    'persist-credentials: false',
    'enable_auto_merge',
    'build_candidate:',
    'verify_candidate:',
    'publish_candidate:',
    '"bash":"deny"',
    'external_directory',
  ], 'hourly workflow contract');
  requireFragments(prompt, [
    'realism gate',
    'falsification_test',
    'single_writer_confirmed',
    'estimated_minutes',
    'budget_minutes',
    'Do not repeat the same failed operation without a changed hypothesis, changed input, or evidence that the failure was transient.',
    'Waiting for review or checks is not a blocker',
    'Do not run shell commands, commit, push, approve, merge, release',
  ], 'RCA/realism assignment contract');
}

/**
 * Execute the dependency-free command-line interface.
 *
 * @param {string[]} argv Command-line arguments excluding node and script path.
 * @returns {number} Process status.
 */
export function main(argv) {
  const [command, argument, ...extra] = argv;
  if (extra.length || !['contract', 'rca'].includes(command) || !argument) {
    throw new TypeError('usage: hourly_commercial_readiness_contract.mjs contract <root> | rca <path>');
  }
  if (command === 'contract') {
    verifyRepositoryContract(argument);
  } else {
    validateRcaFile(argument);
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'unknown validation failure');
    process.exitCode = 1;
  }
}
