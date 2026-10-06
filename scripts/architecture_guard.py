#!/usr/bin/env python3
"""Read-only architectural boundary guard for TaktRO.

Usage:
    python3 scripts/architecture_guard.py
    python3 scripts/architecture_guard.py --changed
    python3 scripts/architecture_guard.py --json
    python3 scripts/architecture_guard.py --strict

The guard reports all findings in one run. Errors always produce a non-zero exit
status; warnings do so only with --strict. It never edits project files.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]

# Keep policy declarative. Exceptions must be narrow, justified, and temporary.
POLICY = {
    "excluded_dirs": {
        ".git", ".taktro", ".pytest_cache", "__pycache__", "node_modules",
        "vendor", "dist", "build", "coverage",
    },
    "command_owner": "command_registry.js",
    "navigation_owner": "app.js",
    # perf.js may observe keys only inside its mandatory diagnostic opt-in gate.
    "event_owners": {"app.js", "event_delegator.js", "accessibility_manager.js", "perf.js"},
    "request_owners": {"app.js", "perf.js"},
    "keycap_owner": "ui_components.js",
    "diagnostic_owner": "perf.js",
    "exceptions": {},
}


@dataclass(frozen=True)
class Finding:
    rule: str
    severity: str
    file: str
    line: int
    message: str
    correction: str


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def is_owned(path: Path) -> bool:
    try:
        parts = path.resolve().relative_to(ROOT.resolve()).parts
    except ValueError:
        return False
    return not any(part in POLICY["excluded_dirs"] for part in parts)


def all_javascript() -> list[Path]:
    return sorted(path for path in ROOT.rglob("*.js") if is_owned(path))


def changed_paths() -> set[str]:
    names: set[str] = set()
    commands = (
        ["git", "diff", "--name-only", "--diff-filter=ACMR", "HEAD"],
        ["git", "ls-files", "--others", "--exclude-standard"],
    )
    for command in commands:
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        if result.returncode == 0:
            names.update(line.strip() for line in result.stdout.splitlines() if line.strip())
    return names


def selected_javascript(changed_only: bool) -> list[Path]:
    files = all_javascript()
    if not changed_only:
        return files
    changed = changed_paths()
    return [path for path in files if relative(path) in changed]


def exception_key(rule: str, path: str) -> str:
    return f"{rule}:{path}"


def valid_exception(rule: str, path: str) -> dict | None:
    entry = POLICY["exceptions"].get(exception_key(rule, path))
    if not entry or not entry.get("reason") or not entry.get("remove_by"):
        return None
    try:
        if date.fromisoformat(entry["remove_by"]) < date.today():
            return None
        if not isinstance(entry.get("max_findings"), int) or entry["max_findings"] < 1:
            return None
        return entry
    except ValueError:
        return None


def add(
    findings: list[Finding], rule: str, severity: str, path: str, line: int,
    message: str, correction: str,
) -> None:
    findings.append(Finding(rule, severity, path, line, message, correction))


def apply_migration_baseline(findings: list[Finding]) -> tuple[list[Finding], list[dict]]:
    """Accept only the capped amount of valid, temporary migration debt."""
    remaining: list[Finding] = []
    used: dict[str, int] = {}
    for finding in findings:
        entry = valid_exception(finding.rule, finding.file)
        key = exception_key(finding.rule, finding.file)
        count = used.get(key, 0)
        if entry and finding.severity == "warn" and count < entry["max_findings"]:
            used[key] = count + 1
        else:
            remaining.append(finding)
    baseline = []
    for key, count in sorted(used.items()):
        entry = POLICY["exceptions"][key]
        baseline.append({"key": key, "accepted": count, "cap": entry["max_findings"],
                         "reason": entry["reason"], "remove_by": entry["remove_by"]})
    return remaining, baseline


def matching_lines(text: str, pattern: str, flags: int = 0) -> Iterable[tuple[int, str]]:
    compiled = re.compile(pattern, flags)
    for number, line in enumerate(text.splitlines(), 1):
        if compiled.search(line):
            yield number, line.strip()


def check_syntax(files: list[Path], findings: list[Finding]) -> None:
    node = shutil.which("node")
    if not node:
        add(findings, "ARCH-SYNTAX-001", "error", "node", 0,
            "Node.js is unavailable; JavaScript syntax was not checked.",
            "Install Node.js and rerun the architecture guard.")
        return
    for path in files:
        result = subprocess.run(
            [node, "--check", str(path)], cwd=ROOT, capture_output=True, text=True
        )
        if result.returncode:
            output = (result.stderr or result.stdout).strip()
            line_match = re.search(rf"{re.escape(str(path))}:(\d+)", output)
            line = int(line_match.group(1)) if line_match else 1
            summary = output.splitlines()[-1] if output else "JavaScript syntax failure"
            add(findings, "ARCH-SYNTAX-001", "error", relative(path), line,
                summary, "Repair the syntax error before continuing development.")


def check_javascript(path: Path, findings: list[Finding]) -> None:
    rel = relative(path)
    text = path.read_text(encoding="utf-8", errors="replace")

    if rel != POLICY["command_owner"]:
        for line, _ in matching_lines(text, r"\bCOMMAND_REGISTRY\b"):
            add(findings, "ARCH-CMD-001", "error", rel, line,
                "Legacy or unauthorized COMMAND_REGISTRY access.",
                "Register and dispatch the command through window.CommandRegistry.")

    for line, _ in matching_lines(text, r"\bModalStack\.push\s*\("):
        add(findings, "ARCH-MODAL-001", "error", rel, line,
            "ModalStack.push() is not part of the modal contract.",
            "Use ModalStack.open(id, options) and ModalStack.close(id).")

    # Four positional values indicate the obsolete open(id, element, opener, closeFn) form.
    for line, snippet in matching_lines(text, r"\bModalStack\.open\s*\([^\n]*,[^\n]*,[^\n]*,"):
        add(findings, "ARCH-MODAL-002", "error", rel, line,
            f"ModalStack.open() appears to use positional arguments: {snippet[:120]}",
            "Pass a modal ID and one options object.")

    if rel != POLICY["navigation_owner"]:
        for line, _ in matching_lines(text, r"\bselectTask\s*\("):
            add(findings, "ARCH-NAV-001", "error", rel, line,
                "Direct selectTask() call outside the navigation owner.",
                "Route user navigation through requestNavigation().")
        for line, _ in matching_lines(text, r"\bstate\.activeTask\s*=(?!=)"):
            add(findings, "ARCH-NAV-002", "error", rel, line,
                "Direct activeTask mutation outside the navigation owner.",
                "Move task-state mutation into the authoritative navigation layer.")

    if rel not in POLICY["event_owners"]:
        for line, _ in matching_lines(text, r"(?:window|document)\.addEventListener\s*\(\s*['\"]keydown['\"]"):
            add(findings, "ARCH-EVENT-001", "error", rel, line,
                "Global keydown listener outside an authorized event owner.",
                "Dispatch keyboard input through the centralized event layer.")

    event_pattern = r"\bon[a-z]+\s*=\s*[\"']"
    for line, snippet in matching_lines(text, event_pattern):
        add(findings, "ARCH-EVENT-002", "error", rel, line,
            f"Inline interaction handler remains: {snippet[:120]}",
            "Bind the action through EventDelegator and CommandRegistry.")

    if rel != POLICY["keycap_owner"]:
        for line, _ in matching_lines(text, r"<kbd\b", re.IGNORECASE):
            add(findings, "ARCH-UI-001", "error", rel, line,
                "Raw <kbd> markup bypasses the keycap component.",
                "Render the key through UIComponent.Keycap with an explicit variant.")

    if rel not in POLICY["request_owners"]:
        for line, _ in matching_lines(text, r"\bfetch\s*\("):
            add(findings, "ARCH-ASYNC-001", "warn", rel, line,
                "Direct fetch() bypasses the approved API/request owner.",
                "Use the shared API layer and AsyncOrchestrator where appropriate.")

    if rel == POLICY["diagnostic_owner"]:
        sensitive = any(token in text for token in (
            "PerformanceObserver", "recordFlightKey", "queuePerfLog", "window.fetch ="
        ))
        if sensitive and "TAKTRO_DIAG_ENABLED" not in text:
            add(findings, "ARCH-DIAG-001", "error", rel, 1,
                "Diagnostic instrumentation lacks the required opt-in gate.",
                "Guard all instrumentation behind window.TAKTRO_DIAG_ENABLED.")


def check_shell_interactions(findings: list[Finding]) -> None:
    path = ROOT / "index.html"
    for line, snippet in matching_lines(path.read_text(), r"\bon[a-z]+\s*=\s*[\"']"):
        add(findings, "ARCH-EVENT-002", "error", "index.html", line,
            f"Inline shell interaction handler remains: {snippet[:120]}",
            "Use a registered action or command for the shell control.")


def check_project_contracts(findings: list[Finding]) -> None:
    interaction = ROOT / "scripts" / "interaction_tests.py"
    if interaction.exists():
        text = interaction.read_text(encoding="utf-8", errors="replace")
        if not re.search(r"\b(?:p\.)?webkit\.launch\s*\(", text):
            add(findings, "ARCH-TEST-001", "error", relative(interaction), 1,
                "Interaction suite does not explicitly launch Playwright WebKit.",
                "Launch playwright.webkit and report unavailable WebKit as blocked.")

    benchmark = ROOT / "scripts" / "rendering_benchmarks.py"
    if benchmark.exists():
        text = benchmark.read_text(encoding="utf-8", errors="replace")
        has_browser = "playwright" in text.lower() and "requestAnimationFrame" in text
        if not has_browser:
            add(findings, "ARCH-TEST-002", "error", relative(benchmark), 1,
                "Rendering benchmark does not demonstrate browser frame measurement.",
                "Measure repeated browser rAF intervals and real scroll interactions.")

    regression = ROOT / "scripts" / "regression_tests.py"
    if regression.exists():
        text = regression.read_text(encoding="utf-8", errors="replace")
        recursive = "rglob(" in text or "architecture_guard" in text
        if not recursive:
            add(findings, "ARCH-TEST-003", "error", relative(regression), 1,
                "Regression syntax discovery is not recursive or delegated to this guard.",
                "Use shared recursive discovery or invoke architecture_guard.py.")


def print_human(findings: list[Finding], baseline: list[dict], checked: int, strict: bool, verbose: bool) -> None:
    if not findings:
        print(f"Architecture guard passed: {checked} JavaScript files checked.")
        if baseline:
            accepted = sum(item["accepted"] for item in baseline)
            print(f"Migration baseline: {accepted} accepted finding(s) across {len(baseline)} capped bucket(s).")
        return
    errors = [item for item in findings if item.severity == "error"]
    warnings = [item for item in findings if item.severity == "warn"]
    displayed = findings if verbose else errors
    for finding in displayed:
        location = f"{finding.file}:{finding.line}" if finding.line else finding.file
        print(f"{finding.severity.upper():7} {finding.rule} {location}")
        print(f"        {finding.message}")
        print(f"        Correction: {finding.correction}")
    if warnings and not verbose:
        print("\nWarning inventory (use --verbose for every location):")
        grouped: dict[str, int] = {}
        for finding in warnings:
            grouped[finding.rule] = grouped.get(finding.rule, 0) + 1
        for rule, count in sorted(grouped.items()):
            print(f"  {rule}: {count}")
    error_count = len(errors)
    warning_count = len(warnings)
    status = "FAILED" if error_count or (strict and warning_count) else "PASSED WITH WARNINGS"
    print(f"\n{status}: {error_count} error(s), {warning_count} warning(s), {checked} JS file(s) checked.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Enforce TaktRO architectural boundaries")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--all", action="store_true", help="check all owned files (default)")
    scope.add_argument("--changed", action="store_true", help="check changed/untracked JS files")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument("--strict", action="store_true", help="treat warnings as failures")
    parser.add_argument("--verbose", action="store_true", help="show every warning location")
    args = parser.parse_args()

    files = selected_javascript(args.changed)
    findings: list[Finding] = []
    check_syntax(files, findings)
    for path in files:
        check_javascript(path, findings)
    # Project-wide test contracts matter even when only application JS changed.
    check_project_contracts(findings)
    check_shell_interactions(findings)
    findings, baseline = apply_migration_baseline(findings)

    errors = sum(item.severity == "error" for item in findings)
    warnings = sum(item.severity == "warn" for item in findings)
    if args.json:
        print(json.dumps({
            "status": "failed" if errors or (args.strict and warnings) else "passed",
            "root": str(ROOT),
            "scope": "changed" if args.changed else "all",
            "checked_javascript": len(files),
            "errors": errors,
            "warnings": warnings,
            "baselined_warnings": sum(item["accepted"] for item in baseline),
            "baseline": baseline,
            "findings": [asdict(item) for item in findings],
        }, indent=2))
    else:
        print_human(findings, baseline, len(files), args.strict, args.verbose)
    return 1 if errors or (args.strict and warnings) else 0


if __name__ == "__main__":
    sys.exit(main())
