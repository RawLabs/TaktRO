#!/usr/bin/env python3
"""Single compact verification entry point for TaktRO."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = ROOT / ".taktro" / "test-results"
PASS, FAIL, BLOCKED, HARNESS = "PASS", "FAIL", "BLOCKED", "HARNESS"


@dataclass(frozen=True)
class Check:
    name: str
    command: tuple[str, ...]
    timeout: int = 120


@dataclass
class Result:
    name: str
    status: str
    seconds: float
    exit_code: int | None
    summary: str
    log: str
    warnings: int = 0


STATIC = {
    "architecture": Check("architecture", (sys.executable, "scripts/architecture_guard.py", "--all")),
    "workflow": Check("workflow", (sys.executable, "scripts/workflow_tests.py")),
    "regression": Check("regression", (sys.executable, "scripts/regression_tests.py")),
    "audit-unit": Check("audit-unit", (sys.executable, "scripts/audit_test.py")),
    "system-audit": Check("system-audit", (sys.executable, "scripts/system_audit.py"), 180),
    "health": Check("health", (sys.executable, "scripts/health_check.py")),
    "database-performance": Check("database-performance", (sys.executable, "scripts/performance_check.py")),
    "synthetic-performance": Check("synthetic-performance", (sys.executable, "scripts/seed_perf_benchmark.py")),
}

WORKSPACE_BROWSER = Check("workspace-browser", (sys.executable, "scripts/workspace_browser_tests.py"), 120)

BROWSER = (
    WORKSPACE_BROWSER,
    Check("boot", (sys.executable, "scripts/boot_smoke_test.py"), 120),
    Check("interaction", (sys.executable, "scripts/interaction_tests.py"), 180),
    Check("rendering", (sys.executable, "scripts/rendering_benchmarks.py"), 240),
)

PROFILES = {
    "quick": ("architecture", "regression", "workflow", "audit-unit"),
    "changed": ("architecture", "regression", "workflow", "audit-unit"),
    "full": tuple(STATIC),
    "browser": (),
    "workspaces": ("architecture", "regression", "workflow", "audit-unit"),
}


def first_reason(output: str, fallback: str) -> str:
    for raw in output.splitlines():
        line = raw.strip()
        if line and any(word in line.lower() for word in ("error", "failed", "blocked", "missing", "unavailable")):
            return line[:180]
    return fallback


def classify(code: int, output: str) -> tuple[str, str]:
    lower = output.lower()
    if code == 0:
        return PASS, "completed"
    if code == 2 or "status: blocked" in lower or "engine missing" in lower:
        return BLOCKED, first_reason(output, "environment dependency unavailable")
    if "server failed to respond" in lower or "harness timeout" in lower:
        return HARNESS, first_reason(output, "test harness failed")
    return FAIL, first_reason(output, "check failed")


def count_warnings(output: str) -> int:
    values = re.findall(r"(?:warnings?|warning\(s\))\s*[:=]\s*(\d+)", output, re.IGNORECASE)
    values += re.findall(r"(\d+)\s+warnings?(?:\(s\))?", output, re.IGNORECASE)
    return max((int(value) for value in values), default=0)


def run_check(check: Check, run_dir: Path, changed: bool, timeout_override: int) -> Result:
    command = list(check.command)
    if changed and check.name == "architecture":
        command[-1] = "--changed"
    env = os.environ.copy()
    if check.name == "regression":
        env["TAKTRO_SKIP_ARCHITECTURE"] = "1"
    timeout = timeout_override or check.timeout
    log_path = run_dir / f"{check.name}.log"
    started = time.monotonic()
    try:
        proc = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout)
        output = (proc.stdout or "") + (proc.stderr or "")
        status, summary = classify(proc.returncode, output)
        code = proc.returncode
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        output = stdout + stderr + f"\nHARNESS TIMEOUT after {timeout}s\n"
        status, summary, code = HARNESS, f"timeout after {timeout}s", None
    except Exception as exc:
        output = f"{type(exc).__name__}: {exc}\n"
        status, summary, code = HARNESS, str(exc)[:180], None
    log_path.write_text(output, encoding="utf-8")
    return Result(check.name, status, round(time.monotonic() - started, 2), code,
                  summary, log_path.relative_to(ROOT).as_posix(), count_warnings(output))


def execute(profile: str, timeout: int) -> tuple[list[Result], Path]:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = RESULTS_DIR / stamp
    run_dir.mkdir(parents=True, exist_ok=True)
    selected = [STATIC[name] for name in PROFILES[profile]]
    results: list[Result] = []
    # audit-unit launches system_audit internally; running it beside another audit
    # creates avoidable CPU contention and false 15-second timeouts.
    nested = [check for check in selected if check.name == "audit-unit"]
    parallel = [check for check in selected if check.name != "audit-unit"]
    if parallel:
        with ThreadPoolExecutor(max_workers=min(4, len(parallel))) as pool:
            futures = [pool.submit(run_check, check, run_dir, profile == "changed", timeout) for check in parallel]
            results.extend(future.result() for future in as_completed(futures))
    results.extend(run_check(check, run_dir, profile == "changed", timeout) for check in nested)
    # Browser checks remain sequential so their temporary servers cannot collide.
    if profile == "workspaces":
        results.append(run_check(WORKSPACE_BROWSER, run_dir, False, timeout))
    if profile in {"full", "browser"}:
        results.extend(run_check(check, run_dir, False, timeout) for check in BROWSER)
    return sorted(results, key=lambda result: result.name), run_dir


def overall(results: list[Result], strict: bool) -> tuple[str, int]:
    if any(result.status == HARNESS for result in results):
        return HARNESS, 3
    if any(result.status == FAIL for result in results):
        return FAIL, 1
    if any(result.status == BLOCKED for result in results):
        return BLOCKED, 2
    if strict and any(result.warnings for result in results):
        return FAIL, 1
    return PASS, 0


def save_report(profile: str, status: str, results: list[Result], run_dir: Path) -> dict:
    report = {
        "status": status,
        "profile": profile,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "counts": {state: sum(result.status == state for result in results) for state in (PASS, FAIL, BLOCKED, HARNESS)},
        "warnings": sum(result.warnings for result in results),
        "results": [asdict(result) for result in results],
        "run_directory": run_dir.relative_to(ROOT).as_posix(),
    }
    encoded = json.dumps(report, indent=2)
    (run_dir / "report.json").write_text(encoded, encoding="utf-8")
    (RESULTS_DIR / "latest.json").write_text(encoded, encoding="utf-8")
    combined = "\n".join(
        f"===== {result.name} [{result.status}] =====\n" +
        (ROOT / result.log).read_text(encoding="utf-8", errors="replace")
        for result in results
    )
    (RESULTS_DIR / "latest.log").write_text(combined, encoding="utf-8")
    return report


def print_report(report: dict, json_mode: bool, verbose: bool) -> None:
    if json_mode:
        view = dict(report)
        if not verbose:
            view["results"] = [item for item in view["results"] if item["status"] != PASS]
        print(json.dumps(view, indent=2))
        return
    counts = report["counts"]
    print(f"TAKTRO CHECK: {report['status']}")
    print(f"Passed: {counts[PASS]}  Failed: {counts[FAIL]}  Blocked: {counts[BLOCKED]}  Harness: {counts[HARNESS]}  Warnings: {report['warnings']}")
    shown = report["results"] if verbose else [item for item in report["results"] if item["status"] != PASS]
    for item in shown:
        print(f"{item['status']:7} {item['name']}: {item['summary']} [{item['log']}]")
    print(f"Report: {report['run_directory']}/report.json")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run consolidated TaktRO checks")
    parser.add_argument("profile", nargs="?", choices=tuple(PROFILES), default="quick")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--timeout", type=int, default=0, help="override each suite timeout")
    args = parser.parse_args()
    results, run_dir = execute(args.profile, args.timeout)
    status, exit_code = overall(results, args.strict)
    report = save_report(args.profile, status, results, run_dir)
    print_report(report, args.json, args.verbose)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
