"""
System Context Compiler, Baseline Manager, Diff Engine, and Health Reporter
"""

from __future__ import annotations

import json
import time
from pathlib import Path


CODEBASE_CONTRACT_MD = """## Codebase Repair Rules for Coding Models

1. **Smallest Viable Repair**: Make the smallest targeted change that restores correct behaviour.
2. **Search Existing Utilities**: Search the **Existing Utilities Index** below before creating any new helper function. Do NOT invent duplicate helpers (e.g. `apiRequest`, `cleanPhone`, `notifyUser`).
3. **Preserve Keyboard-First Navigation**: Do not intercept single-character typing inside input text fields (`isFormControl`). Preserve sitewide <kbd>ALT+&lt;KEY&gt;</kbd> hotkey bindings.
4. **Preserve Permissions & Audit Logging**: Respect position permissions (`repair_orders`, `appointments`, `customers`, `parts`, `shop_setup`, `staff_admin`, `cashout`).
5. **No Direct Schema Mutations**: Do not alter database schema or tables unless the bug explicitly requires it.
6. **Zero Customer Data Leakage**: Never output customer PII, phone numbers, or invoice contents in diagnostic logs.
"""


def compile_context_markdown(manifest: dict, symbols: dict, routes: dict, db_meta: dict, utilities: dict, findings: list[dict], git_info: dict) -> str:
    lines = []
    lines.append("# TaktRO System Intelligence Context")
    lines.append("")
    lines.append(f"**Generated**: {manifest.get('generated_at', '')}")
    lines.append(f"**Git Commit**: `{git_info.get('commit', 'unknown')}` | **Branch**: `{git_info.get('branch', 'unknown')}` | **Dirty State**: `{git_info.get('dirty', False)}`")
    lines.append(f"**Source File Count**: {manifest.get('metrics', {}).get('source_file_count', 0)} files")
    lines.append("")
    lines.append(CODEBASE_CONTRACT_MD)
    lines.append("")

    # Recently Changed Files
    lines.append("## Recently Changed Files (Git Status)")
    changed = git_info.get("changed_files", [])
    if changed:
        for f in changed:
            lines.append(f"- `{f}`")
    else:
        lines.append("- *No uncommitted changes detected (clean working tree).*")
    lines.append("")

    # Existing Utilities Index
    lines.append("## Existing Reusable Utilities (DO NOT DUPLICATE)")
    lines.append("Before creating helper functions, check if one of these existing utilities can be reused:")
    lines.append("")
    lines.append("| Utility Name | File | Description |")
    lines.append("| :--- | :--- | :--- |")
    for uname, uinfo in sorted(utilities.items()):
        lines.append(f"| `{uname}()` | `{uinfo['file']}:{uinfo['line']}` | {uinfo['description']} |")
    lines.append("")

    # API Map
    lines.append("## API Endpoint Map")
    lines.append("| Route | Type | Backend Source |")
    lines.append("| :--- | :--- | :--- |")
    for rnorm, rinfo in sorted(routes.items()):
        lines.append(f"| `{rnorm}` | {rinfo['type']} | `{rinfo['file']}:{rinfo['line']}` |")
    lines.append("")

    # Database Schema Map
    lines.append("## Database Schema Summary")
    tables = db_meta.get("tables", {})
    lines.append(f"**Database**: `{db_meta.get('database_file', 'taktro.db')}` | **Integrity**: `{db_meta.get('integrity_check', 'ok')}` | **FK Errors**: `{len(db_meta.get('foreign_key_errors', []))}`")
    lines.append("")
    for tname, tinfo in sorted(tables.items()):
        cols_str = ", ".join([f"{c['name']} ({c['type']})" for c in tinfo.get("columns", [])])
        lines.append(f"- **`{tname}`** ({tinfo.get('row_count', 0)} rows): {cols_str}")
    lines.append("")

    # Structured Audit Findings
    lines.append("## Audit Findings")
    if findings:
        for find in findings:
            icon = "🔴" if find["severity"] == "error" else "🟡"
            lines.append(f"- {icon} **[{find['category']}]** `{find['file']}:{find['line']}`: {find['message']}")
    else:
        lines.append("- 🟢 *All configured static & structural system audit checks passed cleanly.*")

    return "\n".join(lines)


def generate_baseline(manifest: dict, routes: dict, symbols: dict, db_meta: dict, errors_count: int = 0, force: bool = False) -> tuple[dict | None, str]:
    git_info = manifest.get("git", {})
    changed_count = len(git_info.get("changed_files", []))

    if not force:
        reasons = []
        if errors_count > 0:
            reasons.append(f"Audit failures: {errors_count}")
        if changed_count > 0:
            reasons.append(f"Modified source files: {changed_count}")

        if reasons:
            msg = "BASELINE NOT RECORDED\n" + "\n".join(reasons) + "\nCurrent state cannot be marked known-good (use --force or override)."
            return None, msg

    baseline = {
        "header": "GENERATED FILE — DO NOT EDIT MANUALLY",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "git_commit": git_info.get("commit", "unknown"),
        "files_hash": {f["path"]: f["sha256"] for f in manifest.get("files", [])},
        "routes": list(routes.keys()),
        "tables": {t: len(info.get("columns", [])) for t, info in db_meta.get("tables", {}).items()}
    }
    return baseline, "Baseline state recorded into .taktro/baseline.json"


def compare_baseline(current_manifest: dict, current_routes: dict, current_db: dict, baseline_data: dict) -> dict:
    diff_report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "base_commit": baseline_data.get("git_commit", "unknown"),
        "current_commit": current_manifest.get("git", {}).get("commit", "unknown"),
        "file_changes": {"added": [], "modified": [], "deleted": []},
        "route_changes": {"added": [], "removed": []},
        "schema_changes": {"added_tables": [], "removed_tables": []}
    }

    base_hashes = baseline_data.get("files_hash", {})
    curr_hashes = {f["path"]: f["sha256"] for f in current_manifest.get("files", [])}

    for p, h in curr_hashes.items():
        if p not in base_hashes:
            diff_report["file_changes"]["added"].append(p)
        elif h != base_hashes[p]:
            diff_report["file_changes"]["modified"].append(p)

    for p in base_hashes:
        if p not in curr_hashes:
            diff_report["file_changes"]["deleted"].append(p)

    base_routes = set(baseline_data.get("routes", []))
    curr_routes = set(current_routes.keys())

    diff_report["route_changes"]["added"] = sorted(list(curr_routes - base_routes))
    diff_report["route_changes"]["removed"] = sorted(list(base_routes - curr_routes))

    base_tables = set(baseline_data.get("tables", {}).keys())
    curr_tables = set(current_db.get("tables", {}).keys())

    diff_report["schema_changes"]["added_tables"] = sorted(list(curr_tables - base_tables))
    diff_report["schema_changes"]["removed_tables"] = sorted(list(base_tables - curr_tables))

    return diff_report
