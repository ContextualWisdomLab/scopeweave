#!/usr/bin/env python3
"""Regression tests for ScopeWeave workflow ownership."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = REPO_ROOT / ".github" / "workflows"
K8S_DEPLOYMENT = REPO_ROOT / "infra" / "k8s" / "deployment.yaml"
K8S_SERVICE = REPO_ROOT / "infra" / "k8s" / "service.yaml"


def test_central_review_workflows_are_not_copied_into_this_repository() -> None:
    central_only_paths = [
        WORKFLOW_DIR / "dependency-review.yml",
        WORKFLOW_DIR / "osvscanner.yml",
        REPO_ROOT / ".github" / "workflows" / "opencode-review.yml",
        REPO_ROOT / ".github" / "workflows" / "pr-review-merge-scheduler.yml",
        REPO_ROOT / ".github" / "workflows" / "strix-selftest.yml",
        REPO_ROOT / ".github" / "workflows" / "strix.yml",
        REPO_ROOT / "requirements-strix-ci.txt",
        REPO_ROOT / "requirements-strix-ci-hashes.txt",
        REPO_ROOT / "scripts" / "ci" / "collect_failed_check_evidence.sh",
        REPO_ROOT / "scripts" / "ci" / "emit_opencode_failed_check_fallback_findings.sh",
        REPO_ROOT / "scripts" / "ci" / "opencode_review_approve_gate.sh",
        REPO_ROOT / "scripts" / "ci" / "opencode_review_normalize_output.py",
        REPO_ROOT / "scripts" / "ci" / "pr_review_merge_scheduler.py",
        REPO_ROOT / "scripts" / "ci" / "strix_model_utils.sh",
        REPO_ROOT / "scripts" / "ci" / "strix_quick_gate.sh",
        REPO_ROOT / "scripts" / "ci" / "test_opencode_fact_gate_contract.sh",
        REPO_ROOT / "scripts" / "ci" / "test_strix_quick_gate.sh",
        REPO_ROOT / "scripts" / "ci" / "validate_opencode_failed_check_review.sh",
    ]

    for central_only_path in central_only_paths:
        assert not central_only_path.exists(), central_only_path


def test_kubernetes_deployment_uses_non_root_versioned_runtime() -> None:
    deployment_source = K8S_DEPLOYMENT.read_text(encoding="utf-8")
    service_source = K8S_SERVICE.read_text(encoding="utf-8")

    assert 'image: scopeweave:latest' not in deployment_source
    assert 'image: scopeweave:1.0.0' in deployment_source
    assert 'namespace: scopeweave' in deployment_source
    assert 'namespace: scopeweave' in service_source
    assert 'runAsNonRoot: true' in deployment_source
    assert 'runAsUser: 10001' in deployment_source
    assert 'runAsGroup: 10001' in deployment_source
    assert 'allowPrivilegeEscalation: false' in deployment_source
    assert 'readOnlyRootFilesystem: true' in deployment_source
    assert 'drop:' in deployment_source
    assert '- ALL' in deployment_source
    assert 'seccompProfile:' in deployment_source
    assert 'livenessProbe:' in deployment_source
    assert 'readinessProbe:' in deployment_source
    assert 'kind: PodDisruptionBudget' in deployment_source
    assert 'targetPort: 8080' in service_source


def test_workflow_concurrency_is_trigger_aware() -> None:
    pull_request_workflows = ("codeql.yml", "fuzz.yml", "server-tests.yml")
    expected_group = (
        "${{ github.workflow }}-${{ github.repository }}-"
        "${{ github.event.pull_request.number || github.run_id }}"
    )

    for workflow_name in pull_request_workflows:
        source = (WORKFLOW_DIR / workflow_name).read_text(encoding="utf-8")
        assert f"group: {expected_group}" in source
        assert "cancel-in-progress: ${{ github.event_name == 'pull_request' }}" in source

    deploy_source = (WORKFLOW_DIR / "pages.yml").read_text(encoding="utf-8")
    assert "group: ${{ github.workflow }}-${{ github.repository }}-${{ github.run_id }}" in deploy_source
    assert "cancel-in-progress: false" in deploy_source
