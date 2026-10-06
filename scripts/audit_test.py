"""
Unit Tests for TaktRO System Intelligence Compiler & Diagnostic Audit Engine
Standard Python library unittest only.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from audit.scanner import compute_sha256
from audit.symbols import parse_python_file, parse_javascript_file, build_utility_index
from audit.routes_wiring import normalize_route, extract_backend_routes, extract_frontend_api_calls
from audit.database import inspect_database
from audit.compiler import generate_baseline, compare_baseline
from audit.incident import extract_file_excerpts, tokenize_symptom, rank_relevant_files, estimate_tokens, sanitize_ai_packet, generate_incident_capsule


class TestSystemAuditCompiler(unittest.TestCase):

    def test_route_normalization(self):
        self.assertEqual(normalize_route("/api/customers/123"), "/api/customers/{id}")
        self.assertEqual(normalize_route("/api/customers/${id}?sort=name"), "/api/customers/{id}")
        self.assertEqual(normalize_route("/api/repair-orders/481"), "/api/repair-orders/{id}")
        self.assertEqual(normalize_route("/api/parts"), "/api/parts")

    def test_ai_packet_sanitization(self):
        raw_text = """
        User report with VIN JTEBU5JR4A5025202 on RO /api/repair-orders/481 for customer /api/customers/123.
        Email: shop.owner@example.com Phone: 555-867-5309.
        Auth Header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.
        """
        sanitized = sanitize_ai_packet(raw_text)
        self.assertNotIn("JTEBU5JR4A5025202", sanitized)
        self.assertNotIn("shop.owner@example.com", sanitized)
        self.assertNotIn("555-867-5309", sanitized)
        self.assertIn("[VIN_REDACTED]", sanitized)
        self.assertIn("[EMAIL_REDACTED]", sanitized)
        self.assertIn("[PHONE_REDACTED]", sanitized)
        self.assertIn("[TOKEN_REDACTED]", sanitized)
        self.assertIn("/api/customers/{id}", sanitized)
        self.assertIn("/api/repair-orders/{id}", sanitized)

    def test_symptom_tokenization(self):
        tokens = tokenize_symptom("Pressing N from customer opens RO but customer is not populated")
        self.assertIn("customer", tokens)
        self.assertIn("populated", tokens)
        self.assertNotIn("is", tokens)
        self.assertIn("not", tokens)

    def test_excerpt_centers_on_matching_source_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lines = [f"ordinary line {index}\n" for index in range(200)]
            lines[150] = "function retryRequest() { clearInFlightBeforeRetry(); }\n"
            (root / "app.js").write_text("".join(lines), encoding="utf-8")
            excerpts, omitted = extract_file_excerpts(
                root, [("app.js", 10.0)], max_lines=60,
                symptom_tokens={"retry", "inflight"}
            )
        self.assertFalse(omitted)
        self.assertEqual(len(excerpts), 1)
        self.assertLessEqual(excerpts[0]["start_line"], 151)
        self.assertGreaterEqual(excerpts[0]["end_line"], 151)
        self.assertIn("clearInFlightBeforeRetry", excerpts[0]["content"])

    def test_token_estimation(self):
        sample_text = "a" * 400
        self.assertEqual(estimate_tokens(sample_text), 100)

    def test_sha256_computation(self):
        server_py = ROOT / "server.py"
        if server_py.exists():
            sha = compute_sha256(server_py)
            self.assertEqual(len(sha), 64)

    def test_baseline_refusal_when_dirty_or_failing(self):
        manifest = {"git": {"commit": "abc", "changed_files": ["app.js"]}, "files": []}
        base_data, msg = generate_baseline(manifest, {}, {}, {}, errors_count=0, force=False)
        self.assertIsNone(base_data)
        self.assertIn("BASELINE NOT RECORDED", msg)
        self.assertIn("Modified source files: 1", msg)

        # Baseline refusal on audit failures
        manifest_clean = {"git": {"commit": "abc", "changed_files": []}, "files": []}
        base_data_err, msg_err = generate_baseline(manifest_clean, {}, {}, {}, errors_count=2, force=False)
        self.assertIsNone(base_data_err)
        self.assertIn("Audit failures: 2", msg_err)

        # Forced baseline override
        base_data_forced, msg_forced = generate_baseline(manifest, {}, {}, {}, errors_count=2, force=True)
        self.assertIsNotNone(base_data_forced)
        self.assertIn("Baseline state recorded", msg_forced)

    def test_baseline_diff(self):
        manifest = {"git": {"commit": "abc"}, "files": [{"path": "a.js", "sha256": "111"}]}
        routes = {"/api/test": {}}
        symbols = {}
        db = {"tables": {"users": {"columns": [1, 2]}}}

        base_data, _ = generate_baseline(manifest, routes, symbols, db, errors_count=0, force=True)

        curr_manifest = {"git": {"commit": "def"}, "files": [{"path": "a.js", "sha256": "222"}, {"path": "b.js", "sha256": "333"}]}
        curr_routes = {"/api/test": {}, "/api/new": {}}
        curr_db = {"tables": {"users": {"columns": [1, 2]}}}

        diff = compare_baseline(curr_manifest, curr_routes, curr_db, base_data)
        self.assertIn("a.js", diff["file_changes"]["modified"])
        self.assertIn("b.js", diff["file_changes"]["added"])
        self.assertIn("/api/new", diff["route_changes"]["added"])

    def test_subprocess_argument_array_handling(self):
        # Verify CLI accepts array args safely without creating an incident or
        # depending on a live local model.
        proc = subprocess.run([sys.executable, str(ROOT / "scripts/system_audit.py"), "--json"], capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0)
        self.assertIn('"status"', proc.stdout)

    def test_dev_mode_environment_check(self):
        from server import check_dev_mode
        class DummyHandler:
            def __init__(self):
                self.resp = None
                self.status = None
            def json_response(self, payload, status):
                self.resp = payload
                self.status = status

        handler = DummyHandler()

        # Test disabled
        os.environ["TAKTRO_DEV_MODE"] = "0"
        self.assertFalse(check_dev_mode(handler))
        self.assertEqual(handler.status, 403)

        # Test enabled
        os.environ["TAKTRO_DEV_MODE"] = "1"
        self.assertTrue(check_dev_mode(handler))

    def test_role_permission_coverage_matrix(self):
        from server import TEMPLATES
        # Ensure all primary staff templates have visibility for key shop workspace APIs
        required_read_apis = ["customers", "appointments", "repair_orders", "parts"]
        for role_name, perms in TEMPLATES.items():
            for req_api in required_read_apis:
                self.assertIn(
                    req_api, perms,
                    f"Staff role template '{role_name}' is missing required workspace permission '{req_api}'"
                )


if __name__ == "__main__":
    unittest.main()
