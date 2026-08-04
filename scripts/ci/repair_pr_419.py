"""One-shot, fail-closed repair for ScopeWeave PR 419.

The script converts the repository's coverage entry point into a real Istanbul
producer, consolidates attachment-list prepared statements, and wires the
request-wide refresh budget into the Hono route. It is deleted by the repair
workflow after the exact tree passes the complete validation set.
"""

from __future__ import annotations

import json
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    """Replace one exact source fragment or fail before modifying the tree."""

    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one replacement target, found {count}")
    return text.replace(old, new, 1)


package_path = Path("package.json")
package = json.loads(package_path.read_text(encoding="utf-8"))
scripts = package["scripts"]
coverage_includes = (
    "--all --include=app.js --include=cloud-sync.js "
    "--include=scripts/ci/static_coverage_evidence.mjs "
    "--include=server/attachment_status.mjs --include=server/app.mjs "
    "--include=server/auth.mjs --include=server/clearfolio.mjs "
    "--reporter=json --reporter=json-summary"
)
coverage_cases = (
    "node tests/unit/coverage-script-contract.test.mjs && "
    "node tests/unit/attachment-status.test.mjs && "
    "node tests/unit/clearfolio-status-signal.test.mjs && "
    "node tests/unit/msproject.test.mjs && "
    "node tests/unit/auth-password.test.mjs && "
    "node tests/unit/editor-unsaved.test.mjs && "
    "node tests/unit/static-coverage-evidence.test.mjs && "
    "npm run test:api"
)
scripts["coverage"] = "npm run test:coverage"
scripts["test:coverage"] = f"c8 {coverage_includes} npm run test:coverage:cases"
scripts["test:coverage:cases"] = coverage_cases
contract_test = "node tests/unit/coverage-script-contract.test.mjs"
if contract_test not in scripts["test:unit"]:
    scripts["test:unit"] += f" && {contract_test}"
package_path.write_text(
    json.dumps(package, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)

app_path = Path("server/app.mjs")
app = app_path.read_text(encoding="utf-8")
app = replace_once(
    app,
    "import { normalizeAttachmentStatusConcurrency, normalizeAttachmentStatusTimeoutMs, refreshAttachmentStatuses } from './attachment_status.mjs';",
    "import { normalizeAttachmentStatusBudgetMs, normalizeAttachmentStatusConcurrency, normalizeAttachmentStatusTimeoutMs, refreshAttachmentStatuses } from './attachment_status.mjs';",
    "attachment-status import",
)
app = replace_once(
    app,
    """const ATTACH_STATUS_CONCURRENCY = normalizeAttachmentStatusConcurrency(
  process.env.SCOPEWEAVE_ATTACHMENT_STATUS_CONCURRENCY,
);
const ATTACH_STATUS_TIMEOUT_MS = normalizeAttachmentStatusTimeoutMs(
  process.env.SCOPEWEAVE_ATTACHMENT_STATUS_TIMEOUT_MS,
);
const updateAttachmentStatusStatement = db.prepare(
  'UPDATE attachments SET status = ? WHERE id = ?',
);""",
    """const ATTACH_STATUS_CONCURRENCY = normalizeAttachmentStatusConcurrency(
  process.env.SCOPEWEAVE_ATTACHMENT_STATUS_CONCURRENCY,
);
const ATTACH_STATUS_TIMEOUT_MS = normalizeAttachmentStatusTimeoutMs(
  process.env.SCOPEWEAVE_ATTACHMENT_STATUS_TIMEOUT_MS,
);
const ATTACH_STATUS_BUDGET_MS = normalizeAttachmentStatusBudgetMs(
  process.env.SCOPEWEAVE_ATTACHMENT_STATUS_BUDGET_MS,
);
const ATTACHMENT_LIST_COLUMNS = `a.id, a.task_id AS taskId, a.name, a.mime, a.size,
  a.job_id AS jobId, a.status, a.created_at AS createdAt, u.email AS uploadedBy`;
const ATTACHMENT_LIST_FROM =
  'FROM attachments a LEFT JOIN users u ON u.id = a.created_by';
const listAttachmentsStatement = db.prepare(
  `SELECT ${ATTACHMENT_LIST_COLUMNS} ${ATTACHMENT_LIST_FROM}
   WHERE a.project_id = ? ORDER BY a.id DESC`,
);
const listTaskAttachmentsStatement = db.prepare(
  `SELECT ${ATTACHMENT_LIST_COLUMNS} ${ATTACHMENT_LIST_FROM}
   WHERE a.project_id = ? AND a.task_id = ? ORDER BY a.id DESC`,
);
const updateAttachmentStatusStatement = db.prepare(
  'UPDATE attachments SET status = ? WHERE id = ?',
);""",
    "attachment-status constants",
)
route_start = app.index("app.get('/api/projects/:id/attachments', requireAuth, async (c) => {")
body_start = app.index("const taskId = c.req.query('taskId');", route_start)
body_end_marker = "return c.json({ attachments });"
body_end = app.index(body_end_marker, body_start) + len(body_end_marker)
new_body = """  const taskId = c.req.query('taskId');
  const rows = taskId
    ? listTaskAttachmentsStatement.all(p.id, taskId)
    : listAttachmentsStatement.all(p.id);
  await refreshAttachmentStatuses(rows, {
    orgId: p.org_id,
    userId: uid,
    jobStatus,
    updateStatus: (status, attachmentId) =>
      updateAttachmentStatusStatement.run(status, attachmentId),
    concurrency: ATTACH_STATUS_CONCURRENCY,
    timeoutMs: ATTACH_STATUS_TIMEOUT_MS,
    budgetMs: ATTACH_STATUS_BUDGET_MS,
    metrics,
  });
  const attachments = rows.map(({ jobId: _internalJobId, ...publicRow }) => publicRow);
  return c.json({ attachments });"""
app = app[:body_start] + new_body + app[body_end:]
app_path.write_text(app, encoding="utf-8")

Path("tests/unit/coverage-script-contract.test.mjs").write_text(
    """import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const scripts = packageJson.scripts;

assert.equal(scripts.coverage, 'npm run test:coverage');
assert.match(
  scripts['test:coverage'],
  /\\bc8\\b.*--reporter=json.*npm run test:coverage:cases/,
);
assert.match(scripts['test:coverage'], /--include=server\\/attachment_status\\.mjs/);
assert.match(scripts['test:coverage'], /--include=server\\/clearfolio\\.mjs/);
assert.match(
  scripts['test:coverage:cases'],
  /tests\\/unit\\/clearfolio-status-signal\\.test\\.mjs/,
);
assert.doesNotMatch(
  scripts['test:coverage:cases'],
  /npm run (?:coverage|test:coverage)(?:\\s|$)/,
);

console.log('✓ coverage script contract tests passed');
""",
    encoding="utf-8",
)
