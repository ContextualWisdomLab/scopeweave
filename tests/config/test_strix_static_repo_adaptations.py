#!/usr/bin/env python3
"""Regression tests for ScopeWeave-specific Strix adaptations."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
STRIX_GATE = REPO_ROOT / "scripts" / "ci" / "strix_quick_gate.sh"
STRIX_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "strix.yml"
DEPENDENCY_REVIEW_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "dependency-review.yml"
OSV_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "osvscanner.yml"


def test_strix_gate_keeps_workflow_and_script_changes_scannable() -> None:
    source = STRIX_GATE.read_text(encoding="utf-8")

    assert 'if [[ "$changed_file" == .github/workflows/* || "$changed_file" == scripts/ci/* ]]; then' not in source
    assert '*.html | *.css' in source


def test_strix_ci_dependencies_are_pinned_in_repo_manifest() -> None:
    workflow_source = STRIX_WORKFLOW.read_text(encoding="utf-8")
    requirements_source = (REPO_ROOT / "requirements-strix-ci.txt").read_text(encoding="utf-8")

    assert 'python3 -m pip install --no-cache-dir -r requirements-strix-ci.txt' in workflow_source
    assert 'Gate Strix secrets' in workflow_source
    assert 'STRIX_FALLBACK_MODELS:' in workflow_source
    assert 'STRIX_FAIL_ON_PROVIDER_SIGNAL: "1"' in workflow_source
    assert 'strix-agent==0.8.3' in requirements_source
    assert 'google-cloud-aiplatform==1.133.0' in requirements_source


def test_companion_workflows_cover_named_requirements_manifests_and_full_history() -> None:
    dependency_review_source = DEPENDENCY_REVIEW_WORKFLOW.read_text(encoding="utf-8")
    osv_source = OSV_WORKFLOW.read_text(encoding="utf-8")

    assert 'fetch-depth: 0' in dependency_review_source
    assert 'dependency_graph?.status || \'unknown\'' in dependency_review_source
    assert 'requirements(-[A-Za-z0-9._-]+)?\\.txt' in dependency_review_source
    assert 'requirements(-[A-Za-z0-9._-]+)?\\.txt' in osv_source
