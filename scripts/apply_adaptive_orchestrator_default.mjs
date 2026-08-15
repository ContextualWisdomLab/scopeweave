#!/usr/bin/env node
/** Apply ScopeWeave's adaptive contextual-orchestrator request default. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedBranch = 'agent/adaptive-orchestrator-default';
const branch = process.env.GITHUB_REF_NAME ?? expectedBranch;
if (branch !== expectedBranch) {
  throw new Error(`refusing to mutate unexpected branch: ${branch}`);
}

function replaceOnce(text, oldText, newText, label) {
  const parts = text.split(oldText);
  if (parts.length !== 2) {
    throw new Error(`${label}: expected one match, found ${parts.length - 1}`);
  }
  return `${parts[0]}${newText}${parts[1]}`;
}

const clientPath = resolve(root, 'server/orchestrator.mjs');
let client = readFileSync(clientPath, 'utf8');
client = replaceOnce(
  client,
  '// orchestrator는 알 수 없는 필드를 거부(strict validation) — model+messages만 전송.',
  '// contextual-orchestrator가 품질 충족 실행 경로를 고르도록 model+messages+auto 정책만 전송.',
  'request policy comment',
);
client = replaceOnce(
  client,
  "body: JSON.stringify({ model: 'contextual-orchestrator', messages }),",
  "body: JSON.stringify({\n        model: 'contextual-orchestrator',\n        orchestration_mode: 'auto',\n        messages,\n      }),",
  'adaptive request body',
);
writeFileSync(clientPath, client, 'utf8');

const testPath = resolve(root, 'tests/unit/orchestrator-adaptive-mode.test.mjs');
if (existsSync(testPath)) {
  throw new Error(`refusing to replace existing regression test: ${testPath}`);
}
writeFileSync(
  testPath,
  `import assert from 'node:assert/strict';\nimport test from 'node:test';\n\ntest('contextual-orchestrator requests explicit adaptive mode', async () => {\n  const originalUrl = process.env.ORCHESTRATOR_URL;\n  const originalToken = process.env.ORCHESTRATOR_TOKEN;\n  const originalFetch = globalThis.fetch;\n  let observedUrl;\n  let observedInit;\n  process.env.ORCHESTRATOR_URL = 'https://orchestrator.example.test';\n  process.env.ORCHESTRATOR_TOKEN = 'test_token';\n  globalThis.fetch = async (url, init) => {\n    observedUrl = url;\n    observedInit = init;\n    return new Response(\n      JSON.stringify({\n        choices: [{ message: { content: 'adaptive result' } }],\n      }),\n      { status: 200, headers: { 'content-type': 'application/json' } },\n    );\n  };\n  try {\n    const { chat, orchestratorMock } = await import(\n      \\`../../server/orchestrator.mjs?adaptive-test=\\${Date.now()}\\`\n    );\n    assert.equal(orchestratorMock, false);\n    await assert.doesNotReject(() =>\n      chat([{ role: 'user', content: 'Analyze the critical path.' }]),\n    );\n    assert.equal(observedUrl, 'https://orchestrator.example.test/v1/chat/completions');\n    const body = JSON.parse(observedInit.body);\n    assert.deepEqual(Object.keys(body).sort(), [\n      'messages',\n      'model',\n      'orchestration_mode',\n    ]);\n    assert.equal(body.model, 'contextual-orchestrator');\n    assert.equal(body.orchestration_mode, 'auto');\n    assert.equal(body.messages[0].content, 'Analyze the critical path.');\n  } finally {\n    globalThis.fetch = originalFetch;\n    if (originalUrl === undefined) delete process.env.ORCHESTRATOR_URL;\n    else process.env.ORCHESTRATOR_URL = originalUrl;\n    if (originalToken === undefined) delete process.env.ORCHESTRATOR_TOKEN;\n    else process.env.ORCHESTRATOR_TOKEN = originalToken;\n  }\n});\n`,
  'utf8',
);

const packagePath = resolve(root, 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const regressionCommand = 'node tests/unit/orchestrator-adaptive-mode.test.mjs';
if (packageJson.scripts['test:unit'].includes(regressionCommand)) {
  throw new Error('adaptive orchestrator regression command already exists');
}
packageJson.scripts['test:unit'] = `${packageJson.scripts['test:unit']} && ${regressionCommand}`;
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

const changelogPath = resolve(root, 'CHANGELOG.md');
let changelog = readFileSync(changelogPath, 'utf8');
changelog = replaceOnce(
  changelog,
  '### Changed\n\n',
  '### Changed\n\n- ScopeWeave now explicitly requests contextual-orchestrator `auto` mode so the orchestration plane selects the least-cost route, checked response, or conducted workflow that meets the detected quality requirement instead of relying on a single-model default.\n',
  'changelog',
);
writeFileSync(changelogPath, changelog, 'utf8');

const adrPath = resolve(root, 'docs/adr/0001-adaptive-contextual-orchestrator-default.md');
if (existsSync(adrPath)) {
  throw new Error(`refusing to replace existing ADR: ${adrPath}`);
}
writeFileSync(
  adrPath,
  `# ADR-0001: Adaptive contextual-orchestrator mode is the planning-analysis default\n\n- Status: Accepted\n- Date: 2026-08-15\n\n## Context\n\nScopeWeave's production client sent only an OpenAI-compatible model and message list. Although the gateway currently treats an omitted mode as adaptive, the consumer contract did not make that behavior reviewable or regression-safe. ScopeWeave must not independently force one model or one fixed multi-agent topology.\n\n## Decision\n\nEvery production request includes \\`orchestration_mode: "auto"\\`.\n\n- contextual-orchestrator owns model/provider choice, reasoning effort, verification, workflow depth, and known-price optimization;\n- ScopeWeave owns the project-management prompt, authorization boundary, result presentation, and the deterministic non-LLM fallback;\n- cost is minimized only after the quality-sufficient execution tier is selected;\n- explicit route, verify, and conduct policies remain available for controlled ablation and emergency operator override, not as ordinary product defaults.\n\n## Consequences\n\nA request may use one worker or a deeper verified workflow. ScopeWeave must not infer cost or quality from trace width; operational evidence must use the returned orchestration telemetry. Models without valid price metadata are classified as unpriced rather than free.\n\n## References\n\nOmidvar, H., & Akhlaghi, V. (2026). *A communication-theoretic framework for LLM agents: Cost-aware adaptive reliability* [Preprint]. arXiv. https://doi.org/10.48550/arXiv.2605.09121\n\nTang, Y., Cetin, E., Xu, J., Sun, Q., Nielsen, S., Richard, V., Goda, H., Tymchenko, I., Nguyen, N., Lee, H., Ashiga, M., Kotyan, S., Kuroki, S., & Clanuwat, T. (2026). *Sakana Fugu technical report* [Technical report]. arXiv. https://doi.org/10.48550/arXiv.2606.21228\n`,
  'utf8',
);
