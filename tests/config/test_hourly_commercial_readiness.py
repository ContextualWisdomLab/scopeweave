"""Contracts for the hourly RCA-driven commercial-readiness scheduler."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "ci" / "hourly_commercial_readiness_contract.py"
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "hourly-opencode-commercial-readiness.yml"
PROMPT_PATH = ROOT / ".github" / "prompts" / "hourly-commercial-readiness.md"


def load_contract_module():
    """Load the production contract module from its repository path."""

    spec = importlib.util.spec_from_file_location("hourly_contract", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError("unable to load hourly commercial-readiness contract module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkflowContractTests(unittest.TestCase):
    """Verify schedule, provider, authority, recovery, and safety contracts."""

    def test_checked_in_workflow_and_prompt_satisfy_contract(self) -> None:
        """The permanent scheduler must satisfy every static safety boundary."""

        module = load_contract_module()
        module.verify_repository_contract(ROOT)

    def test_repository_contract_rejects_prohibited_copilot_credential(self) -> None:
        """A Copilot model credential must fail the scheduler contract."""

        module = load_contract_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".github/workflows").mkdir(parents=True)
            (root / ".github/prompts").mkdir(parents=True)
            workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
            prompt = PROMPT_PATH.read_text(encoding="utf-8")
            (root / ".github/workflows/hourly-opencode-commercial-readiness.yml").write_text(
                workflow + "\n# COPILOT_GITHUB_TOKEN\n", encoding="utf-8"
            )
            (root / ".github/prompts/hourly-commercial-readiness.md").write_text(
                prompt, encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "Copilot credential"):
                module.verify_repository_contract(root)

    def test_repository_contract_rejects_blind_retry_and_missing_realism_gate(self) -> None:
        """The assignment must require hypothesis-changing retries and feasibility."""

        module = load_contract_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".github/workflows").mkdir(parents=True)
            (root / ".github/prompts").mkdir(parents=True)
            (root / ".github/workflows/hourly-opencode-commercial-readiness.yml").write_text(
                WORKFLOW_PATH.read_text(encoding="utf-8"), encoding="utf-8"
            )
            prompt = PROMPT_PATH.read_text(encoding="utf-8")
            prompt = prompt.replace(
                "Do not repeat the same failed command without a changed hypothesis, changed input, or evidence that the failure was transient.",
                "Retry until it works.",
            ).replace("realism gate", "feasibility suggestion")
            (root / ".github/prompts/hourly-commercial-readiness.md").write_text(
                prompt, encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "RCA/realism"):
                module.verify_repository_contract(root)


class RcaContractTests(unittest.TestCase):
    """Verify machine-readable RCA and practical-feasibility decisions."""

    def setUp(self) -> None:
        """Load the production module once for each isolated test."""

        self.module = load_contract_module()
        self.valid = {
            "schema_version": 1,
            "target_kind": "pull_request",
            "target_id": "scopeweave#123",
            "exact_head_sha": "a" * 40,
            "symptom": "Server Tests failed in a deterministic unit test.",
            "evidence": ["npm run test:unit exited 1 at test_x"],
            "causal_chain": ["stale state", "wrong validation order", "test failure"],
            "falsification_test": "Run the new test against the predecessor implementation.",
            "candidate_actions": [
                {
                    "action": "validate current input before the submit guard",
                    "expected_effect": "the realistic immediate-submit case passes",
                    "risk": "low",
                    "reversible": True,
                }
            ],
            "chosen_action": "validate current input before the submit guard",
            "realism": {
                "repository_scope_confirmed": True,
                "single_writer_confirmed": True,
                "permissions_available": True,
                "dependencies_available": True,
                "secrets_not_required_for_tests": True,
                "estimated_minutes": 40,
                "budget_minutes": 105,
                "verification_commands": ["npm run test:unit"],
                "rollback": "revert the bounded commit",
                "external_approval_needed_to_implement": False,
                "realistic": True,
                "reason": "all inputs and verification are available in this run",
            },
        }

    def test_valid_rca_is_accepted(self) -> None:
        """A complete evidence-backed and executable RCA must pass."""

        self.module.validate_rca(self.valid)

    def test_false_realism_boolean_is_rejected(self) -> None:
        """An unavailable implementation dependency makes the action unrealistic."""

        self.valid["realism"]["dependencies_available"] = False
        with self.assertRaisesRegex(ValueError, "not realistic"):
            self.module.validate_rca(self.valid)

    def test_time_budget_overrun_is_rejected(self) -> None:
        """An action that cannot finish inside the run budget must be rejected."""

        self.valid["realism"]["estimated_minutes"] = 106
        with self.assertRaisesRegex(ValueError, "time budget"):
            self.module.validate_rca(self.valid)

    def test_empty_verification_or_rollback_is_rejected(self) -> None:
        """Unverifiable or irreversible actions must be rejected."""

        self.valid["realism"]["verification_commands"] = []
        with self.assertRaisesRegex(ValueError, "verification"):
            self.module.validate_rca(self.valid)
        self.valid["realism"]["verification_commands"] = ["npm test"]
        self.valid["realism"]["rollback"] = ""
        with self.assertRaisesRegex(ValueError, "rollback"):
            self.module.validate_rca(self.valid)

    def test_external_implementation_approval_is_rejected(self) -> None:
        """The loop must move on when implementation itself needs external approval."""

        self.valid["realism"]["external_approval_needed_to_implement"] = True
        with self.assertRaisesRegex(ValueError, "external approval"):
            self.module.validate_rca(self.valid)

    def test_noncanonical_identity_and_unknown_fields_are_rejected(self) -> None:
        """Stale heads and schema drift must fail closed."""

        self.valid["exact_head_sha"] = "ABC"
        with self.assertRaisesRegex(ValueError, "head SHA"):
            self.module.validate_rca(self.valid)
        self.valid["exact_head_sha"] = "b" * 40
        self.valid["unexpected"] = True
        with self.assertRaisesRegex(ValueError, "unknown RCA fields"):
            self.module.validate_rca(self.valid)

    def test_file_validation_uses_strict_json(self) -> None:
        """The CLI boundary must reject malformed JSON before publication."""

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rca.json"
            path.write_text("{not-json", encoding="utf-8")
            with self.assertRaises(json.JSONDecodeError):
                self.module.validate_rca_file(path)


if __name__ == "__main__":
    unittest.main()
