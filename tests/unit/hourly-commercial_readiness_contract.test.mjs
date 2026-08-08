import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  main,
  validateRca,
  validateRcaFile,
  verifyRepositoryContract,
} from '../../scripts/ci/hourly_commercial_readiness_contract.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const MODULE_PATH = resolve(ROOT, 'scripts/ci/hourly_commercial_readiness_contract.mjs');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/hourly-opencode-commercial-readiness.yml');
const PROMPT_PATH = resolve(ROOT, '.github/prompts/hourly-commercial-readiness.md');

function validRca() {
  return {
    schema_version: 1,
    target_kind: 'pull_request',
    target_id: 'scopeweave#123',
    exact_head_sha: 'a'.repeat(40),
    symptom: 'A deterministic unit test fails on the exact head.',
    evidence: ['npm run test:unit exited 1 at the focused regression'],
    causal_chain: ['stale state', 'wrong validation order', 'observable failure'],
    falsification_test: 'Run the focused regression against the predecessor behavior.',
    candidate_actions: [
      {
        action: 'validate current input before the submit guard',
        expected_effect: 'the realistic immediate-submit case succeeds',
        risk: 'low',
        reversible: true,
      },
    ],
    chosen_action: 'validate current input before the submit guard',
    realism: {
      repository_scope_confirmed: true,
      single_writer_confirmed: true,
      permissions_available: true,
      dependencies_available: true,
      secrets_not_required_for_tests: true,
      estimated_minutes: 40,
      budget_minutes: 105,
      verification_commands: ['npm run test:unit'],
      rollback: 'revert the bounded commit',
      external_approval_needed_to_implement: false,
      realistic: true,
      reason: 'the source, dependencies, verifier, and rollback are available',
    },
  };
}

function temporaryContractRoot({ workflow, prompt }) {
  const root = mkdtempSync(join(tmpdir(), 'scopeweave-hourly-contract-'));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  mkdirSync(join(root, '.github/prompts'), { recursive: true });
  writeFileSync(
    join(root, '.github/workflows/hourly-opencode-commercial-readiness.yml'),
    workflow,
    'utf8',
  );
  writeFileSync(
    join(root, '.github/prompts/hourly-commercial-readiness.md'),
    prompt,
    'utf8',
  );
  return root;
}

function expectInvalid(mutator, pattern) {
  const rca = validRca();
  mutator(rca);
  assert.throws(() => validateRca(rca), pattern);
}

test('checked-in workflow and assignment satisfy the permanent contract', () => {
  assert.doesNotThrow(() => verifyRepositoryContract(ROOT));
});

test('repository contract rejects Copilot credentials', () => {
  const workflow = `${await import('node:fs').then(({ readFileSync }) => readFileSync(WORKFLOW_PATH, 'utf8'))}\n# COPILOT_GITHUB_TOKEN\n`;
  const prompt = await import('node:fs').then(({ readFileSync }) => readFileSync(PROMPT_PATH, 'utf8'));
  const root = temporaryContractRoot({ workflow, prompt });
  assert.throws(() => verifyRepositoryContract(root), /Copilot credential/u);
});

test('repository contract reports incomplete workflow and assignment fragments', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8').replace('build_candidate:', 'candidate_builder:');
  const prompt = readFileSync(PROMPT_PATH, 'utf8').replace('realism gate', 'feasibility hint');
  const workflowRoot = temporaryContractRoot({
    workflow,
    prompt: readFileSync(PROMPT_PATH, 'utf8'),
  });
  assert.throws(() => verifyRepositoryContract(workflowRoot), /hourly workflow contract is incomplete/u);
  const promptRoot = temporaryContractRoot({
    workflow: readFileSync(WORKFLOW_PATH, 'utf8'),
    prompt,
  });
  assert.throws(() => verifyRepositoryContract(promptRoot), /RCA\/realism assignment contract is incomplete/u);
});

test('valid pull-request and product-gap RCA documents are accepted', () => {
  const pullRequest = validRca();
  assert.doesNotThrow(() => validateRca(pullRequest));
  const productGap = validRca();
  productGap.target_kind = 'product_gap';
  productGap.candidate_actions.push({
    action: 'add a bounded buyer-visible vertical slice',
    expected_effect: 'the missing workflow becomes usable',
    risk: 'medium',
    reversible: false,
  });
  productGap.chosen_action = 'add a bounded buyer-visible vertical slice';
  assert.doesNotThrow(() => validateRca(productGap));
});

test('RCA root must be a plain JSON object', () => {
  for (const value of [null, 'text', [], new Date()]) {
    assert.throws(() => validateRca(value), /plain JSON object/u);
  }
});

test('RCA exact fields reject unknown, missing, and mixed schema drift', () => {
  expectInvalid((rca) => { rca.unknown = true; }, /unknown=unknown/u);
  expectInvalid((rca) => { delete rca.symptom; }, /missing=symptom/u);
  expectInvalid((rca) => { delete rca.symptom; rca.unknown = true; }, /unknown=unknown missing=symptom/u);
});

test('RCA version, target kind, identifier, and exact head are strict', () => {
  expectInvalid((rca) => { rca.schema_version = 2; }, /schema_version/u);
  expectInvalid((rca) => { rca.target_kind = 'issue'; }, /target_kind/u);
  expectInvalid((rca) => { rca.target_id = 1; }, /target_id/u);
  expectInvalid((rca) => { rca.target_id = '   '; }, /target_id/u);
  expectInvalid((rca) => { rca.exact_head_sha = 7; }, /head SHA/u);
  expectInvalid((rca) => { rca.exact_head_sha = 'A'.repeat(40); }, /head SHA/u);
});

test('RCA narrative, evidence, causal chain, and falsification fields are bounded', () => {
  expectInvalid((rca) => { rca.symptom = ''; }, /symptom/u);
  expectInvalid((rca) => { rca.evidence = 'one'; }, /evidence/u);
  expectInvalid((rca) => { rca.evidence = []; }, /evidence/u);
  expectInvalid((rca) => { rca.evidence = ['']; }, /evidence\[0\]/u);
  expectInvalid((rca) => { rca.causal_chain = []; }, /causal_chain/u);
  expectInvalid((rca) => { rca.falsification_test = false; }, /falsification_test/u);
  expectInvalid((rca) => { rca.chosen_action = ''; }, /chosen_action/u);
});

test('candidate action collection and fields fail closed', () => {
  expectInvalid((rca) => { rca.candidate_actions = {}; }, /candidate_actions/u);
  expectInvalid((rca) => { rca.candidate_actions = []; }, /candidate_actions/u);
  expectInvalid((rca) => { rca.candidate_actions = [null]; }, /plain JSON object/u);
  expectInvalid((rca) => { rca.candidate_actions[0].extra = true; }, /candidate_actions\[0\] fields/u);
  expectInvalid((rca) => { delete rca.candidate_actions[0].risk; }, /candidate_actions\[0\] fields/u);
  expectInvalid((rca) => { rca.candidate_actions[0].action = ''; }, /candidate action/u);
  expectInvalid((rca) => { rca.candidate_actions[0].expected_effect = 4; }, /expected_effect/u);
  expectInvalid((rca) => { rca.candidate_actions[0].risk = 'critical'; }, /candidate risk/u);
  expectInvalid((rca) => { rca.candidate_actions[0].reversible = 'yes'; }, /reversible/u);
  expectInvalid((rca) => { rca.chosen_action = 'different'; }, /chosen_action/u);
});

test('realism object fields and required true decisions are strict', () => {
  expectInvalid((rca) => { rca.realism = null; }, /plain JSON object/u);
  expectInvalid((rca) => { rca.realism.extra = true; }, /unknown=extra/u);
  expectInvalid((rca) => { delete rca.realism.reason; }, /missing=reason/u);
  for (const field of [
    'repository_scope_confirmed',
    'single_writer_confirmed',
    'permissions_available',
    'dependencies_available',
    'secrets_not_required_for_tests',
    'realistic',
  ]) {
    expectInvalid((rca) => { rca.realism[field] = false; }, new RegExp(field, 'u'));
  }
  expectInvalid(
    (rca) => { rca.realism.external_approval_needed_to_implement = true; },
    /external approval/u,
  );
  expectInvalid(
    (rca) => { rca.realism.external_approval_needed_to_implement = 'no'; },
    /external approval/u,
  );
});

test('realism time budget accepts integers and rejects every invalid boundary', () => {
  for (const [field, value] of [
    ['estimated_minutes', true],
    ['estimated_minutes', 1.5],
    ['estimated_minutes', 0],
    ['budget_minutes', false],
    ['budget_minutes', 1.5],
    ['budget_minutes', 0],
  ]) {
    expectInvalid((rca) => { rca.realism[field] = value; }, /positive integers/u);
  }
  expectInvalid((rca) => { rca.realism.estimated_minutes = 106; }, /time budget/u);
});

test('verification, rollback, and realism reason must be actionable', () => {
  expectInvalid((rca) => { rca.realism.verification_commands = []; }, /verification commands/u);
  expectInvalid((rca) => { rca.realism.verification_commands = [0]; }, /verification commands\[0\]/u);
  expectInvalid((rca) => { rca.realism.rollback = ''; }, /rollback/u);
  expectInvalid((rca) => { rca.realism.reason = null; }, /realism reason/u);
});

test('RCA file loading accepts strict JSON and rejects malformed JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scopeweave-rca-file-'));
  const validPath = join(directory, 'valid.json');
  writeFileSync(validPath, `${JSON.stringify(validRca())}\n`, 'utf8');
  assert.doesNotThrow(() => validateRcaFile(validPath));
  const invalidPath = join(directory, 'invalid.json');
  writeFileSync(invalidPath, '{not-json', 'utf8');
  assert.throws(() => validateRcaFile(invalidPath), SyntaxError);
});

test('main executes contract and RCA commands and rejects invalid invocation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scopeweave-main-'));
  const rcaPath = join(directory, 'rca.json');
  writeFileSync(rcaPath, JSON.stringify(validRca()), 'utf8');
  assert.equal(main(['contract', ROOT]), 0);
  assert.equal(main(['rca', rcaPath]), 0);
  for (const args of [[], ['unknown', ROOT], ['contract'], ['contract', ROOT, 'extra']]) {
    assert.throws(() => main(args), /usage/u);
  }
});

test('direct CLI reports success and bounded validation failure', () => {
  const success = spawnSync(process.execPath, [MODULE_PATH, 'contract', ROOT], {
    encoding: 'utf8',
  });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stderr, '');
  const failure = spawnSync(process.execPath, [MODULE_PATH, 'unknown', ROOT], {
    encoding: 'utf8',
  });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /usage/u);
});
