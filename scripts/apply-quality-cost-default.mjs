#!/usr/bin/env node
/** Make contextual-orchestrator auto the ScopeWeave production default. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = resolve(root, 'server/orchestrator.mjs');
const packagePath = resolve(root, 'package.json');
const changelogPath = resolve(root, 'CHANGELOG.md');
const adrPath = resolve(root, 'docs/adr/0002-quality-cost-auto-default.md');

let client = readFileSync(clientPath, 'utf8');
const oldBody = "body: JSON.stringify({ model: 'contextual-orchestrator', messages }),";
const newBody = `body: JSON.stringify({
        model: 'contextual-orchestrator',
        orchestration_mode: 'auto',
        messages,
      }),`;
if (!client.includes("orchestration_mode: 'auto'")) {
  const matches = client.split(oldBody).length - 1;
  if (matches !== 1) {
    throw new Error(`expected one legacy request body, found ${matches}`);
  }
  client = client.replace(oldBody, newBody);
}
client = client.replace(
  '// orchestrator는 알 수 없는 필드를 거부(strict validation) — model+messages만 전송.',
  '// 품질-비용 정책은 contextual-orchestrator가 소유하므로 model+messages+auto만 전송.',
);
writeFileSync(clientPath, client, 'utf8');

const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const testCommand =
  'node tests/unit/orchestrator-quality-cost-default.test.mjs';
if (!packageJson.scripts['test:unit'].includes(testCommand)) {
  packageJson.scripts['test:unit'] = `${packageJson.scripts['test:unit']} && ${testCommand}`;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

if (!existsSync(adrPath)) {
  writeFileSync(
    adrPath,
    `# ADR-0002: Planning analysis explicitly uses quality-first, cost-aware auto orchestration

- Status: Accepted
- Date: 2026-08-16

## Context

ScopeWeave called the contextual-orchestrator endpoint with only a model alias and
messages. That depended on an implicit gateway default and did not make the product's
execution policy reviewable. ScopeWeave must own project-analysis semantics and
presentation while avoiding provider, model, or fixed workflow policy in the
application service.

## Decision

Every production request includes \\`orchestration_mode: "auto"\\`.
Contextual-orchestrator selects a direct route, worker-plus-verifier path, or bounded
conducted workflow according to the request's quality requirement. Model/provider
cost is minimized only after capability and safety requirements are satisfied, and
missing price metadata is not interpreted as free.

Explicit fixed modes remain orchestration-plane experiment and rollback controls;
they are not ScopeWeave defaults.

## Consequences

A simple planning question may still use one model when sufficient. Architecture,
critical-path, implementation, verification, and multi-step requests can receive
more test-time computation without changing ScopeWeave's client contract. The
existing deterministic non-LLM fallback remains available when no orchestrator is
configured.

## References

Omidvar, H., & Akhlaghi, V. (2026). *A communication-theoretic framework for LLM agents: Cost-aware adaptive reliability* [Preprint]. arXiv. https://doi.org/10.48550/arXiv.2605.09121

Tang, Y., Cetin, E., Xu, J., Sun, Q., Nielsen, S., Richard, V., Goda, H., Tymchenko, I., Nguyen, N., Lee, H., Ashiga, M., Kotyan, S., Kuroki, S., & Clanuwat, T. (2026). *Sakana Fugu technical report* [Technical report]. arXiv. https://doi.org/10.48550/arXiv.2606.21228
`,
    'utf8',
  );
}

let changelog = readFileSync(changelogPath, 'utf8');
const entry =
  '- ScopeWeave now explicitly requests contextual-orchestrator `auto`, delegating route, independent verification, conducted workflow, provider choice, and known-cost optimization to the central policy instead of relying on a single-model default.\n';
if (!changelog.includes(entry)) {
  const marker = '### Changed\n\n';
  const matches = changelog.split(marker).length - 1;
  if (matches < 1) {
    throw new Error('CHANGELOG Changed marker was not found');
  }
  changelog = changelog.replace(marker, `${marker}${entry}`, 1);
  writeFileSync(changelogPath, changelog, 'utf8');
}
