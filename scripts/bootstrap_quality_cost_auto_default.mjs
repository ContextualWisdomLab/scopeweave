#!/usr/bin/env node
/** Create the test-first adaptive contextual-orchestrator default patch. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const phase = process.argv[2];
if (!['test', 'implement'].includes(phase)) {
  throw new Error('usage: bootstrap_quality_cost_auto_default.mjs test|implement');
}

function replaceOnce(path, oldText, newText) {
  const text = readFileSync(path, 'utf8');
  const matches = text.split(oldText).length - 1;
  if (matches !== 1) {
    throw new Error(`${path}: expected one match, found ${matches}: ${oldText}`);
  }
  writeFileSync(path, text.replace(oldText, newText), 'utf8');
}

if (phase === 'test') {
  replaceOnce(
    'tests/unit/orchestrator.test.mjs',
    `  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'nvidia/nemotron-3-super-120b-a12b',
    messages: [{ role: 'user', content: 'status' }],
  });`,
    `  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'nvidia/nemotron-3-super-120b-a12b',
    orchestration_mode: 'auto',
    messages: [{ role: 'user', content: 'status' }],
  });`,
  );
  process.exit(0);
}

replaceOnce(
  'server/orchestrator.mjs',
  '      body: JSON.stringify({ model: OC_MODEL, messages: safeMessages }),',
  `      body: JSON.stringify({
        model: OC_MODEL,
        orchestration_mode: 'auto',
        messages: safeMessages,
      }),`,
);

replaceOnce(
  'CHANGELOG.md',
  '## [Unreleased]\n',
  '## [Unreleased]\n\n### Changed\n\n- Production AI briefing requests now explicitly select contextual-orchestrator `auto` mode, so the orchestration plane may allocate the quality-sufficient route or conducted workflow and then minimize known cost instead of relying on an implicit or single-model default.\n',
);

replaceOnce(
  'docs/orchestrator-production.md',
  '- **Model selection**: `ORCHESTRATOR_MODEL` defaults to `contextual-orchestrator` and can be overridden with another gateway-supported model identifier.\n',
  '- **Model selection**: `ORCHESTRATOR_MODEL` defaults to `contextual-orchestrator` and can be overridden with another gateway-supported model identifier.\n- **Execution policy**: every production briefing request includes `orchestration_mode: auto`; contextual-orchestrator owns model/provider choice, workflow depth, verification, fallback, and known-price optimization. Quality sufficiency is evaluated before cost minimization, and missing price metadata is not treated as zero cost.\n',
);

const adrPath = 'docs/adr/0001-adaptive-contextual-orchestrator-default.md';
if (existsSync(adrPath)) {
  throw new Error(`refusing to overwrite ${adrPath}`);
}
writeFileSync(
  adrPath,
  `# ADR-0001: Adaptive contextual-orchestrator mode is the briefing default

- Status: Accepted
- Date: 2026-08-16

## Context

ScopeWeave delegated AI briefing generation to contextual-orchestrator but omitted an explicit execution mode. The gateway currently interprets omission as adaptive `auto`, yet the consumer contract did not prevent a future default drift to one fixed worker or make the expected quality-cost policy reviewable.

## Decision

Every production briefing request includes \`orchestration_mode: "auto"\`.

Contextual-orchestrator owns model/provider selection, test-time compute, workflow depth, verification, fallback, and known-price optimization. Quality sufficiency is the first constraint; cost is minimized among paths that satisfy it. A model without trustworthy price metadata is unpriced, not free.

ScopeWeave continues to own message validation, origin and credential boundaries, response-size limits, stable error classification, and product-specific briefing prompts. Explicit fixed modes may be used only in a documented ablation or incident override and are not product defaults.

## Consequences

Simple briefings may still use one worker when adaptive policy finds that sufficient. More complex or risky analyses may use a deeper workflow without changing ScopeWeave's public API.

## References

Omidvar, H., & Akhlaghi, V. (2026). *A communication-theoretic framework for LLM agents: Cost-aware adaptive reliability* [Preprint]. arXiv. https://doi.org/10.48550/arXiv.2605.09121

Tang, Y., Cetin, E., Xu, J., Sun, Q., Nielsen, S., Richard, V., Goda, H., Tymchenko, I., Nguyen, N., Lee, H., Ashiga, M., Kotyan, S., Kuroki, S., & Clanuwat, T. (2026). *Sakana Fugu technical report* [Technical report]. arXiv. https://doi.org/10.48550/arXiv.2606.21228
`,
  'utf8',
);
