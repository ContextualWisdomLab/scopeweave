import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflowPath = '.github/workflows/hourly-product-development.yml';
const workflow = readFileSync(workflowPath, 'utf8');

assert.match(
  workflow,
  /schedule:\s*\n\s*- cron: ["']41 \* \* \* \*["']/,
  'the bounded product-development gate runs once per hour at minute 41',
);
assert.match(workflow, /workflow_dispatch:/, 'operators can invoke the same gate manually');
assert.match(
  workflow,
  /group: scopeweave-hourly-product-development/,
  'one repository-wide concurrency group prevents overlapping product tasks',
);
assert.match(
  workflow,
  /cancel-in-progress: false/,
  'an active gate is not cancelled halfway through its duplicate-prevention checks',
);
assert.match(
  workflow,
  /COPILOT_GITHUB_TOKEN/,
  'agent-task creation requires a separately scoped user token',
);
assert.match(
  workflow,
  /\/pulls\?state=open&per_page=1/,
  'the workflow refuses development while any pull request owns the queue',
);
assert.match(
  workflow,
  /\/agents\/repos\/\$\{TARGET_REPOSITORY\}\/tasks\?per_page=100/,
  'the workflow inventories existing agent tasks before creating another',
);
assert.match(
  workflow,
  /active_states = \{"queued", "in_progress", "idle", "waiting_for_user"\}/,
  'known active task states remain fail-closed',
);
assert.match(
  workflow,
  /terminal_states = \{"completed", "failed", "timed_out", "cancelled"\}/,
  'only explicit terminal task states release the single-flight gate',
);
assert.match(
  workflow,
  /\/agents\/repos\/\$\{TARGET_REPOSITORY\}\/tasks["']/,
  'the eligible path creates exactly one repository-scoped agent task',
);
assert.match(
  workflow,
  /create_pull_request: true/,
  'the bounded task must return work through one reviewable pull request',
);
assert.match(
  workflow,
  /100% production statement, branch, function, and line coverage/,
  'the agent prompt preserves the production coverage contract',
);
assert.match(
  workflow,
  /complete beginner-readable JSDoc\/docstrings/,
  'the agent prompt preserves the documentation contract',
);
assert.match(
  workflow,
  /two-or-more-word snake_case database object names/,
  'the agent prompt preserves the canonical database naming contract',
);
assert.match(
  workflow,
  /APA 7th references under docs\/doctoring/,
  'the agent prompt preserves standards traceability',
);
assert.match(
  workflow,
  /NVIDIA_NIM_API_KEY/,
  'LLM-dependent validation is routed through the repository secret contract',
);
assert.match(
  workflow,
  /contextual-orchestrator/,
  'LLM work reuses the modular orchestration boundary when applicable',
);
assert.match(
  workflow,
  /Use Figma or Product Design only when the selected slice has an actual buyer-facing UI/,
  'visual tooling is required only for genuine product-interface work',
);
assert.match(
  workflow,
  /Do not merge your own pull request/,
  'the development agent cannot bypass independent review',
);
assert.doesNotMatch(
  workflow,
  /contents:\s*write|pull-requests:\s*write|secrets:\s*inherit/,
  'the scheduler itself keeps read-only repository permissions and does not inherit all secrets',
);
assert.doesNotMatch(
  workflow,
  /pr-review-merge-scheduler|pr-review-fix-scheduler/,
  'repository scheduling does not duplicate the organization-owned PR maintenance loops',
);

console.log('✓ hourly product-development workflow contract tests passed');
