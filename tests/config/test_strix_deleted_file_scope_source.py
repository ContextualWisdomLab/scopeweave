#!/usr/bin/env python3
"""Regression tests for Strix deleted-file scope handling."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
STRIX_GATE = REPO_ROOT / "scripts/ci/strix_quick_gate.sh"


def test_strix_scope_normalizer_skips_deleted_changed_files_without_tracebacks() -> (
    None
):
    source = STRIX_GATE.read_text(encoding="utf-8")

    assert "candidate = (repo_root / relative_path).resolve(strict=False)" in source
    assert "candidate.relative_to(repo_root)" in source
    assert "if not src_path.exists():" not in source
