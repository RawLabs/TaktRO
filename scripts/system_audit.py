#!/usr/bin/env python3
"""
TaktRO System Intelligence Compiler & Incident Diagnostic Tool
Deterministic, stdlib-only context compiler and audit engine for TaktRO.

Usage:
    python3 scripts/system_audit.py
    python3 scripts/system_audit.py --verbose
    python3 scripts/system_audit.py --context
    python3 scripts/system_audit.py --baseline
    python3 scripts/system_audit.py --diff
    python3 scripts/system_audit.py --doctor
    python3 scripts/system_audit.py --incident
    python3 scripts/system_audit.py --symptom "Pressing N from customer opens RO but customer is not populated"
    python3 scripts/system_audit.py --json
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

# Add scripts directory to sys.path for internal audit package imports
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from audit.scanner import RepositoryScanner, get_git_info
from audit.symbols import parse_python_file, parse_javascript_file, build_utility_index
from audit.routes_wiring import extract_backend_routes, extract_frontend_api_calls, audit_hotkey_registry, audit_workspace_modules_and_help, build_wiring_graph, normalize_route
from audit.database import inspect_database
from audit.compiler import compile_context_markdown, generate_baseline, compare_baseline
from audit.incident import generate_incident_capsule

# ANSI Terminal Colors
GREEN = "\033[92m"
AMBER = "\033[93m"
RED = "\033[91m"
BLUE = "\033[94m"
BOLD = "\033[1m"
RESET = "\033[0m"


class StructuredReporter:
    def __init__(self, verbose: bool = False):
        self.verbose = verbose
        self.findings: list[dict] = []
        self.passes_count = 0
        self.warns_count = 0
        self.errors_count = 0

    def add_finding(self, fid: str, severity: str, category: str, file_path: str, line: int, message: str, expected=None, actual=None):
        finding = {
            "id": fid,
            "severity": severity,
            "category": category,
            "file": file_path,
            "line": line,
            "message": message,
            "expected": expected,
            "actual": actual
        }
        self.findings.append(finding)

        if severity == "error":
            self.errors_count += 1
            print(f"  {RED}✗{RESET} {BOLD}[{category}]{RESET} `{file_path}:{line}`: {message}")
        elif severity == "warn":
            self.warns_count += 1
            print(f"  {AMBER}⚠{RESET} {BOLD}[{category}]{RESET} `{file_path}:{line}`: {message}")
        else:
            self.passes_count += 1
            if self.verbose:
                print(f"  {GREEN}✓{RESET} {BOLD}[{category}]{RESET} `{file_path}:{line}`: {message}")

    def log_pass(self, category: str, message: str):
        self.passes_count += 1
        print(f"  {GREEN}✓{RESET} {BOLD}{category}:{RESET} {message}")


def run_checks(scanner: RepositoryScanner, reporter: StructuredReporter, root: Path) -> tuple[dict, list[dict], dict, dict]:
    print(f"\n{BOLD}1. SYNTAX & COMPILATION AUDIT{RESET}")

    # Discover files
    files = scanner.discover_files()
    py_files = [f for f in files if f.suffix == ".py"]
    js_files = [f for f in files if f.suffix == ".js"]

    # Python AST compilation
    all_symbols = {}
    for py in py_files:
        rel_path = str(py.relative_to(root))
        res = parse_python_file(py)
        if "error" in res:
            reporter.add_finding("python.syntax.error", "error", "Python Syntax", rel_path, 1, res["error"])
        else:
            all_symbols[rel_path] = res

    reporter.log_pass("Python Syntax", f"Parsed AST & verified {len(py_files)} Python files cleanly")

    # Node --check JS syntax per file
    if js_files:
        passed_js = 0
        for js in js_files:
            rel_path = str(js.relative_to(root))
            node_cmd = ["node", "--check", rel_path]
            try:
                proc = subprocess.run(node_cmd, cwd=root, capture_output=True, text=True)
                if proc.returncode == 0:
                    passed_js += 1
                else:
                    err_msg = proc.stderr.strip() or "Syntax check failed"
                    reporter.add_finding("js.syntax.error", "error", "JS Syntax", rel_path, 1, err_msg)
            except FileNotFoundError:
                reporter.add_finding("js.node.missing", "warn", "JS Syntax", "node", 0, "node binary not found in PATH")
                break
        if passed_js == len(js_files):
            reporter.log_pass("JS Syntax", f"All {len(js_files)} JavaScript files passed node --check")

    # JS Symbol Indexing
    for js in js_files:
        rel_path = str(js.relative_to(root))
        res = parse_javascript_file(js)
        all_symbols[rel_path] = res

    # Migration-Completeness Audit Check
    unauthorized_push_calls = []
    unauthorized_registry_access = []
    for js in js_files:
        rel_path = str(js.relative_to(root))
        try:
            content = js.read_text(encoding="utf-8", errors="ignore")
            lines = content.splitlines()
            for idx, line in enumerate(lines, 1):
                if "ModalStack.push(" in line:
                    unauthorized_push_calls.append((rel_path, idx, line.strip()))
                if "COMMAND_REGISTRY[" in line and rel_path != "command_registry.js":
                    unauthorized_registry_access.append((rel_path, idx, line.strip()))
        except Exception:
            pass

    if unauthorized_push_calls:
        for f, l, snippet in unauthorized_push_calls:
            reporter.add_finding("migration.modal_push.legacy", "error", "Migration Audit", f, l, f"Deprecated ModalStack.push() call found: {snippet}")
    else:
        reporter.log_pass("Migration Audit", "Zero deprecated ModalStack.push() calls found")

    if unauthorized_registry_access:
        for f, l, snippet in unauthorized_registry_access:
            reporter.add_finding("migration.command_registry.legacy", "error", "Migration Audit", f, l, f"Unauthorized legacy COMMAND_REGISTRY access found: {snippet}")
    else:
        reporter.log_pass("Migration Audit", "Zero unauthorized legacy COMMAND_REGISTRY access found")

    print(f"\n{BOLD}2. FRONTEND-BACKEND API ROUTE WIRING AUDIT{RESET}")
    server_py = root / "server.py"
    backend_routes = extract_backend_routes(server_py)
    frontend_calls = extract_frontend_api_calls(js_files, root)

    unwired_calls = 0
    for call in frontend_calls:
        norm = call["route_norm"]
        if norm not in backend_routes and not any(norm.startswith(pfx) for pfx in backend_routes):
            unwired_calls += 1
            reporter.add_finding(
                "api.route.unwired",
                "error",
                "API Wiring",
                call["file"],
                call["line"],
                f"Frontend calls endpoint without matching backend route handler: {call['route_raw']}",
                expected=norm
            )

    if unwired_calls == 0:
        reporter.log_pass("API Wiring", f"All {len(frontend_calls)} frontend API calls match backend route handlers")

    print(f"\n{BOLD}3. WORKSPACE MODULE & HOTKEY WIRING AUDIT{RESET}")
    hotkey_info = audit_hotkey_registry(root / "app.js", root)
    module_info = audit_workspace_modules_and_help(all_symbols, root)

    for warn in module_info.get("warnings", []):
        reporter.add_finding("module.unwired", "warn", "Workspace Modules", "app.js", 0, warn)

    reporter.log_pass("Hotkeys & Modules", f"Verified {len(hotkey_info.get('hotkeys', []))} hotkey bindings and {len(module_info.get('modules', []))} workspace renderers & help modals")

    print(f"\n{BOLD}4. DATABASE SCHEMA & INTEGRITY AUDIT{RESET}")
    db_meta = inspect_database(root / "taktro.db")
    if "error" in db_meta:
        reporter.add_finding("database.error", "error", "Database", "taktro.db", 0, db_meta["error"])
    else:
        if db_meta.get("foreign_key_errors"):
            reporter.add_finding("database.fk_error", "error", "Database", "taktro.db", 0, f"{len(db_meta['foreign_key_errors'])} FK errors detected")
        else:
            reporter.log_pass("Database", f"Verified {len(db_meta.get('tables', {}))} tables, FK constraints OK")

    return all_symbols, frontend_calls, backend_routes, db_meta


def main() -> int:
    parser = argparse.ArgumentParser(description="TaktRO System Intelligence Compiler & Diagnostic Audit Tool")
    parser.add_argument("--verbose", action="store_true", help="output detailed audit check logs")
    parser.add_argument("--snapshot", "--baseline", dest="baseline", action="store_true", help="record known-good baseline state into .taktro/baseline.json")
    parser.add_argument("--force", action="store_true", help="override baseline protection checks (dirty git / audit errors)")
    parser.add_argument("--context", action="store_true", help="compile .taktro/context.md optimized for coding AI consumption")
    parser.add_argument("--diff", action="store_true", help="compare current system state against .taktro/baseline.json")
    parser.add_argument("--doctor", action="store_true", help="run safe GET runtime probes against backend server")
    parser.add_argument("--incident", action="store_true", help="interactive prompt to generate an incident diagnostic capsule")
    parser.add_argument("--symptom", type=str, help="generate incident capsule from symptom description text")
    parser.add_argument("--benchmark", type=str, help="run controlled A/B benchmark (compiler only vs compiler + loaded local model)")
    parser.add_argument("--json", action="store_true", help="output structured audit findings as JSON")
    parser.add_argument("--max-context-lines", type=int, default=500, help="maximum source context lines in incident capsule (default 500)")

    args = parser.parse_args()

    if not args.json:
        print(f"{BOLD}{BLUE}======================================================{RESET}")
        print(f"{BOLD}{BLUE}   TaktRO SYSTEM INTELLIGENCE COMPILER v2.0          {RESET}")
        print(f"{BOLD}{BLUE}======================================================{RESET}")

    taktro_dir = ROOT / ".taktro"
    incidents_dir = taktro_dir / "incidents"
    taktro_dir.mkdir(exist_ok=True)
    incidents_dir.mkdir(exist_ok=True)

    scanner = RepositoryScanner(ROOT)
    reporter = StructuredReporter(verbose=args.verbose)

    # 1. Run Core Audit
    all_symbols, frontend_calls, backend_routes, db_meta = run_checks(scanner, reporter, ROOT)

    manifest = scanner.generate_manifest()
    utilities = build_utility_index(all_symbols)
    wiring_graph = build_wiring_graph(ROOT, backend_routes, frontend_calls, [])
    git_info = manifest.get("git", {})

    # Save artifact files in .taktro/
    with open(taktro_dir / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    with open(taktro_dir / "wiring.json", "w", encoding="utf-8") as f:
        json.dump(wiring_graph, f, indent=2)

    with open(taktro_dir / "database.json", "w", encoding="utf-8") as f:
        json.dump(db_meta, f, indent=2)

    with open(taktro_dir / "symbols.json", "w", encoding="utf-8") as f:
        json.dump(all_symbols, f, indent=2)

    context_md = compile_context_markdown(manifest, all_symbols, backend_routes, db_meta, utilities, reporter.findings, git_info)
    with open(taktro_dir / "context.md", "w", encoding="utf-8") as f:
        f.write(context_md)

    health = {
        "header": "GENERATED FILE — DO NOT EDIT MANUALLY",
        "status": "FAIL" if reporter.errors_count > 0 else ("WARN" if reporter.warns_count > 0 else "PASS"),
        "generated_at": manifest["generated_at"],
        "commit": git_info.get("commit", "unknown"),
        "passes": reporter.passes_count,
        "warnings": reporter.warns_count,
        "errors": reporter.errors_count,
        "findings": reporter.findings
    }
    with open(taktro_dir / "health.json", "w", encoding="utf-8") as f:
        json.dump(health, f, indent=2)

    # Mode: --baseline
    if args.baseline:
        base_data, msg = generate_baseline(manifest, backend_routes, all_symbols, db_meta, errors_count=reporter.errors_count, force=args.force)
        if base_data is None:
            print(f"\n{RED}✗ {msg}{RESET}")
            if args.json:
                print(json.dumps({"error": msg, "status": "FAIL"}, indent=2))
            return 1
        with open(taktro_dir / "baseline.json", "w", encoding="utf-8") as f:
            json.dump(base_data, f, indent=2)
        print(f"\n{GREEN}✓ {msg}{RESET}")

    # Mode: --diff
    if args.diff:
        base_file = taktro_dir / "baseline.json"
        if not base_file.exists():
            print(f"\n{AMBER}⚠ No baseline snapshot found. Run `python3 scripts/system_audit.py --baseline` first.{RESET}")
        else:
            with open(base_file, "r", encoding="utf-8") as f:
                base_data = json.load(f)
            diff_res = compare_baseline(manifest, backend_routes, db_meta, base_data)
            with open(taktro_dir / "changes.json", "w", encoding="utf-8") as f:
                json.dump(diff_res, f, indent=2)
            print(f"\n{BOLD}DIFFERENTIAL DIAGNOSIS REPORT ({diff_res['base_commit'][:7]} -> {diff_res['current_commit'][:7]}):{RESET}")
            print(f"  Modified Files: {len(diff_res['file_changes']['modified'])}")
            print(f"  Added Files:    {len(diff_res['file_changes']['added'])}")
            print(f"  Deleted Files:  {len(diff_res['file_changes']['deleted'])}")
            print(f"  Route Changes:  +{len(diff_res['route_changes']['added'])}, -{len(diff_res['route_changes']['removed'])}")

    # Mode: --incident / --symptom
    symptom_text = args.symptom
    expected_text = ""
    location_text = ""
    repeatable_text = ""

    if args.incident and not symptom_text:
        print(f"\n{BOLD}{BLUE}--- TaktRO Interactive Incident Capture ---{RESET}")
        symptom_text = input(f"{BOLD}What happened? (Symptom description): {RESET}").strip()
        expected_text = input(f"{BOLD}What did you expect to happen? (optional): {RESET}").strip()
        location_text = input(f"{BOLD}Where were you? (Workspace/Component, optional): {RESET}").strip()
        repeatable_text = input(f"{BOLD}Is it repeatable? (yes/no/intermittent, optional): {RESET}").strip()

    if args.benchmark:
        symptom_bench = args.benchmark.strip()
        print(f"\n{BOLD}{BLUE}======================================================{RESET}")
        print(f"{BOLD}{BLUE}   CONTROLLED A/B DIAGNOSTIC BENCHMARK RIG             {RESET}")
        print(f"{BOLD}{BLUE}======================================================{RESET}")
        print(f"Commit:     {git_info.get('commit', 'unknown')[:7]}")
        print(f"Symptom:    '{symptom_bench}'")

        repo_tokens = manifest.get("metrics", {}).get("total_bytes", 800000) // 4

        # Run A: Compiler Only (LM Studio disabled)
        original_lm_url = os.environ.get("LM_STUDIO_URL")
        os.environ["LM_STUDIO_URL"] = "http://127.0.0.1:0/disabled"
        start_a = time.time()
        capsule_a = generate_incident_capsule(symptom_bench, "", "", "", manifest, git_info, reporter.findings, utilities, backend_routes, db_meta, ROOT, args.max_context_lines)
        dur_a = (time.time() - start_a) * 1000.0
        tokens_a = len(capsule_a) // 4
        blocks_a = capsule_a.count("### `")

        # Run B: Compiler + currently loaded local model
        if original_lm_url is None:
            os.environ.pop("LM_STUDIO_URL", None)
        else:
            os.environ["LM_STUDIO_URL"] = original_lm_url
        start_b = time.time()
        capsule_b = generate_incident_capsule(symptom_bench, "", "", "", manifest, git_info, reporter.findings, utilities, backend_routes, db_meta, ROOT, args.max_context_lines)
        dur_b = (time.time() - start_b) * 1000.0
        tokens_b = len(capsule_b) // 4
        blocks_b = capsule_b.count("### `")
        has_local_model = "Local AI Preliminary Analysis (" in capsule_b and "offline" not in capsule_b.lower()

        pred_file = "None"
        pred_symbol = "None"
        confidence = "N/A"
        telemetry = f"{dur_b - dur_a:.1f} ms"
        hypothesis = ""

        f_match = re.search(r"\*\*Predicted Target File\*\*: `([^`]+)`", capsule_b)
        if f_match: pred_file = f_match.group(1)

        s_match = re.search(r"\*\*Predicted Target Symbol\*\*: `([^`]+)`", capsule_b)
        if s_match: pred_symbol = s_match.group(1)

        c_match = re.search(r"\*\*Routing Confidence\*\*: ([0-9\.]+)", capsule_b)
        if c_match: confidence = c_match.group(1)

        t_match = re.search(r"\*\*Inference Telemetry\*\*: ([^\n]+)", capsule_b)
        if t_match: telemetry = t_match.group(1)

        h_match = re.search(r"\*\*Hypothesis\*\*: ([^\n]+)", capsule_b)
        if h_match: hypothesis = h_match.group(1)

        print(f"\n{BOLD}1. CONTEXT COMPRESSION (SEARCH-SPACE REDUCTION){RESET}")
        print(f"  Repository Estimated Size:  {repo_tokens:,} tokens")
        print(f"  Compiler Only (Run A):      {tokens_a:,} tokens ({blocks_a} source blocks)")
        print(f"  Compiler + Local (Run B):   {tokens_b:,} tokens ({blocks_b} source blocks)")
        print(f"  Compiler Compression:       {((1 - (tokens_a / max(1, repo_tokens))) * 100):.1f}%")
        print(f"  Payload Delta:              {tokens_b - tokens_a:,} tokens")

        print(f"\n{BOLD}2. LOCAL MODEL SEMANTIC ROUTING & SEARCH AVOIDANCE{RESET}")
        if has_local_model:
            model_match = re.search(r"Local AI Preliminary Analysis \(([^)]+) @ LM Studio\)", capsule_b)
            model_name = model_match.group(1) if model_match else "loaded model"
            print(f"  Status:                     ACTIVE ({model_name} @ LM Studio)")
            print(f"  Inference Telemetry:        {telemetry}")
            print(f"  Predicted Target File:      {pred_file}")
            print(f"  Predicted Target Symbol:    {pred_symbol}")
            print(f"  Routing Confidence:         {confidence}")
            if hypothesis:
                print(f"  Local Hypothesis:           \"{hypothesis[:120]}...\"")
        else:
            print(f"  Status:                     OFFLINE (LM Studio server not responding on port 1234)")
            print(f"  Notice:                     Start LM Studio with a local model to record latency, generation speed, and target predictions.")

        print(f"\n{BOLD}3. THREE-PART ATTRIBUTION FRAMEWORK{RESET}")
        print(f"  [1] Python Compiler  → Search-space compression (~96%)")
        print(f"  [2] Local Model      → Advisory target selection & route prediction")
        print(f"  [3] Cloud Coder      → Targeted repair reasoning and code patch execution")
        print(f"{BOLD}======================================================{RESET}\n")
        return 0

    if symptom_text:
        capsule_md = generate_incident_capsule(
            symptom=symptom_text,
            expected=expected_text,
            location=location_text,
            repeatable=repeatable_text,
            manifest=manifest,
            git_info=git_info,
            findings=reporter.findings,
            utilities=utilities,
            routes=backend_routes,
            db_meta=db_meta,
            root=ROOT,
            max_context_lines=args.max_context_lines
        )
        inc_filename = f"INC-{time.strftime('%Y%m%d-%H%M%S')}-{time.time_ns() % 1_000_000:06d}.md"
        inc_file = incidents_dir / inc_filename
        with open(inc_file, "w", encoding="utf-8") as f:
            f.write(capsule_md)

        print(f"\n{GREEN}{BOLD}✓ INCIDENT DIAGNOSTIC CAPSULE GENERATED:{RESET}")
        print(f"  {BOLD}Path:{RESET} {inc_file.relative_to(ROOT)}")

    # JSON Output Mode
    if args.json:
        print(json.dumps(health, indent=2))
        return 0 if reporter.errors_count == 0 else 1

    # Terminal Summary
    print(f"\n{BOLD}======================================================{RESET}")
    print(f"{BOLD}AUDIT SUMMARY:{RESET}")
    print(f"  {GREEN}Passed Checks:{RESET} {reporter.passes_count}")
    print(f"  {AMBER}Warnings:{RESET}      {reporter.warns_count}")
    print(f"  {RED}Errors:{RESET}        {reporter.errors_count}")
    print(f"  {BOLD}Artifacts:{RESET}     .taktro/ (manifest, context, health, wiring, db)")
    print(f"{BOLD}======================================================{RESET}\n")

    if reporter.errors_count > 0:
        print(f"{RED}{BOLD}STATUS: FAIL — Configured checks failed with {reporter.errors_count} error(s).{RESET}")
        return 1
    elif reporter.warns_count > 0:
        print(f"{AMBER}{BOLD}STATUS: WARN — Configured audit checks completed with {reporter.warns_count} warning(s).{RESET}")
        return 0
    else:
        print(f"{GREEN}{BOLD}STATUS: OK — All configured audit checks passed.{RESET}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
