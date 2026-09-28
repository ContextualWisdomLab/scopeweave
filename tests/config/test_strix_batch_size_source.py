#!/usr/bin/env python3
"""Regression tests for Strix trusted PR-scope guardrails."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "strix.yml"


def test_strix_workflow_uses_trusted_pr_scope_sentinel() -> None:
    workflow_source = WORKFLOW_PATH.read_text(encoding="utf-8")

    assert "pull_request_target:" in workflow_source
    assert "STRIX_TARGET_PATH:" in workflow_source
    assert "'__PR_SCOPE__'" in workflow_source


def test_strix_workflow_enables_pr_scoping_only_for_trusted_pr_evidence() -> None:
    workflow_source = WORKFLOW_PATH.read_text(encoding="utf-8")

    assert (
        "STRIX_DISABLE_PR_SCOPING: ${{ (github.event_name == 'pull_request_target' || github.event.inputs.pr_number != '') && '0' || '1' }}"
        in workflow_source
    )
