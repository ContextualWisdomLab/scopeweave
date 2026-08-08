#!/usr/bin/env python3
"""Validate the hourly commercial-readiness workflow and RCA evidence.

The module is deliberately dependency-free so pull-request contract checks and
scheduled publication guards can execute before installing repository code.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Mapping

WORKFLOW_RELATIVE_PATH = Path(
    ".github/workflows/hourly-opencode-commercial-readiness.yml"
)
PROMPT_RELATIVE_PATH = Path(".github/prompts/hourly-commercial-readiness.md")
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
RCA_FIELDS = frozenset(
    {
        "schema_version",
        "target_kind",
        "target_id",
        "exact_head_sha",
        "symptom",
        "evidence",
        "causal_chain",
        "falsification_test",
        "candidate_actions",
        "chosen_action",
        "realism",
    }
)
REALISM_FIELDS = frozenset(
    {
        "repository_scope_confirmed",
        "single_writer_confirmed",
        "permissions_available",
        "dependencies_available",
        "secrets_not_required_for_tests",
        "estimated_minutes",
        "budget_minutes",
        "verification_commands",
        "rollback",
        "external_approval_needed_to_implement",
        "realistic",
        "reason",
    }
)
REQUIRED_TRUE_REALISM_FIELDS = (
    "repository_scope_confirmed",
    "single_writer_confirmed",
    "permissions_available",
    "dependencies_available",
    "secrets_not_required_for_tests",
    "realistic",
)


def _require_mapping(value: Any, label: str) -> Mapping[str, Any]:
    """Return ``value`` as a mapping or raise a bounded schema error."""

    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _require_nonempty_text(value: Any, label: str) -> str:
    """Return one non-blank string without coercing caller-controlled values."""

    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be non-empty text")
    return value


def _require_text_list(value: Any, label: str) -> list[str]:
    """Return a non-empty list containing only non-blank strings."""

    if not isinstance(value, list) or not value:
        raise ValueError(f"{label} must contain at least one entry")
    for item in value:
        _require_nonempty_text(item, f"{label} entry")
    return value


def _reject_unknown_fields(
    value: Mapping[str, Any], allowed: frozenset[str], label: str
) -> None:
    """Reject schema drift so publication never guesses at new semantics."""

    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError(f"unknown {label} fields: {', '.join(unknown)}")
    missing = sorted(allowed - set(value))
    if missing:
        raise ValueError(f"missing {label} fields: {', '.join(missing)}")


def validate_rca(document: Mapping[str, Any]) -> None:
    """Validate one evidence-backed RCA and its practical feasibility gate.

    Validation is intentionally stricter than a descriptive incident report.
    The chosen action must be executable and verifiable in the current run;
    merge-time independent approval may still remain outside this boundary.
    """

    rca = _require_mapping(document, "RCA")
    _reject_unknown_fields(rca, RCA_FIELDS, "RCA")
    if rca["schema_version"] != 1:
        raise ValueError("unsupported RCA schema_version")
    if rca["target_kind"] not in {"pull_request", "product_gap"}:
        raise ValueError("target_kind must be pull_request or product_gap")
    _require_nonempty_text(rca["target_id"], "target_id")
    if not isinstance(rca["exact_head_sha"], str) or not SHA_PATTERN.fullmatch(
        rca["exact_head_sha"]
    ):
        raise ValueError("exact head SHA must be 40 lowercase hexadecimal characters")
    _require_nonempty_text(rca["symptom"], "symptom")
    _require_text_list(rca["evidence"], "evidence")
    _require_text_list(rca["causal_chain"], "causal_chain")
    _require_nonempty_text(rca["falsification_test"], "falsification_test")
    chosen_action = _require_nonempty_text(rca["chosen_action"], "chosen_action")

    actions = rca["candidate_actions"]
    if not isinstance(actions, list) or not actions:
        raise ValueError("candidate_actions must contain at least one action")
    action_names: set[str] = set()
    expected_action_fields = {"action", "expected_effect", "risk", "reversible"}
    for index, candidate in enumerate(actions):
        action = _require_mapping(candidate, f"candidate_actions[{index}]")
        if set(action) != expected_action_fields:
            raise ValueError("candidate action fields are incomplete or unknown")
        action_name = _require_nonempty_text(action["action"], "candidate action")
        _require_nonempty_text(action["expected_effect"], "candidate expected_effect")
        if action["risk"] not in {"low", "medium", "high"}:
            raise ValueError("candidate risk must be low, medium, or high")
        if not isinstance(action["reversible"], bool):
            raise ValueError("candidate reversible must be boolean")
        action_names.add(action_name)
    if chosen_action not in action_names:
        raise ValueError("chosen_action must exactly match one candidate action")

    realism = _require_mapping(rca["realism"], "realism")
    _reject_unknown_fields(realism, REALISM_FIELDS, "realism")
    for field in REQUIRED_TRUE_REALISM_FIELDS:
        if realism[field] is not True:
            raise ValueError(f"chosen action is not realistic: {field} is not true")
    if realism["external_approval_needed_to_implement"] is not False:
        raise ValueError("external approval is required to implement the chosen action")

    estimated = realism["estimated_minutes"]
    budget = realism["budget_minutes"]
    if (
        isinstance(estimated, bool)
        or not isinstance(estimated, int)
        or estimated < 1
        or isinstance(budget, bool)
        or not isinstance(budget, int)
        or budget < 1
    ):
        raise ValueError("realism time values must be positive integers")
    if estimated > budget:
        raise ValueError("chosen action exceeds the available time budget")
    _require_text_list(realism["verification_commands"], "verification commands")
    _require_nonempty_text(realism["rollback"], "rollback")
    _require_nonempty_text(realism["reason"], "realism reason")


def validate_rca_file(path: Path) -> None:
    """Load one strict UTF-8 JSON RCA file and validate its complete contract."""

    with path.open("r", encoding="utf-8") as source:
        document = json.load(source)
    validate_rca(document)


def verify_repository_contract(root: Path) -> None:
    """Verify the checked-in hourly workflow and authoritative assignment."""

    workflow_path = root / WORKFLOW_RELATIVE_PATH
    prompt_path = root / PROMPT_RELATIVE_PATH
    workflow = workflow_path.read_text(encoding="utf-8")
    prompt = prompt_path.read_text(encoding="utf-8")

    if "COPILOT_GITHUB_TOKEN" in workflow:
        raise ValueError("Copilot credential is prohibited in the hourly workflow")
    required_workflow_fragments = (
        'cron: "17 * * * *"',
        "cancel-in-progress: false",
        "NVIDIA_NIM_API_KEY",
        "opencode run",
        ".opencode/target.json",
        ".opencode/rca.json",
        "hourly_commercial_readiness_contract.py rca",
        "persist-credentials: false",
        "enable_auto_merge",
    )
    missing_workflow = [
        fragment for fragment in required_workflow_fragments if fragment not in workflow
    ]
    if missing_workflow:
        raise ValueError(
            "hourly workflow is missing required fragments: "
            + ", ".join(missing_workflow)
        )

    required_prompt_fragments = (
        "realism gate",
        "falsification_test",
        "single_writer_confirmed",
        "estimated_minutes",
        "budget_minutes",
        "Do not repeat the same failed command without a changed hypothesis, changed input, or evidence that the failure was transient.",
        "Waiting for review or checks is not a blocker",
    )
    missing_prompt = [
        fragment for fragment in required_prompt_fragments if fragment not in prompt
    ]
    if missing_prompt:
        raise ValueError(
            "RCA/realism assignment contract is incomplete: "
            + ", ".join(missing_prompt)
        )


def _build_parser() -> argparse.ArgumentParser:
    """Return the dependency-free command-line parser."""

    parser = argparse.ArgumentParser(
        description="Validate ScopeWeave hourly commercial-readiness evidence."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    contract = subparsers.add_parser("contract", help="verify checked-in files")
    contract.add_argument("--root", type=Path, default=Path.cwd())
    rca = subparsers.add_parser("rca", help="verify one RCA JSON document")
    rca.add_argument("path", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Execute the requested validation command and return a process status."""

    arguments = _build_parser().parse_args(argv)
    if arguments.command == "contract":
        verify_repository_contract(arguments.root)
    else:
        validate_rca_file(arguments.path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
