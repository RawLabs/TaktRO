"""
Incident Diagnostic Compiler & Symptom Relevance Engine
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from pathlib import Path

REPAIR_INSTRUCTIONS_MD = """## Repair Instructions for Coding Model

1. **Diagnose from Evidence**: Diagnose the reported behavior from the supplied evidence capsule above.
2. **Do Not Assume Root Cause**: Do not assume the human symptom description is the exact root cause; investigate the underlying contract failure.
3. **Prefer Existing Utilities**: Check the **Relevant Existing Utilities** list before creating any new helper function.
4. **Make the Smallest Repair**: Write the smallest targeted repair that restores correct behavior and preserves existing architecture.
5. **No Unrelated Refactoring**: Do not refactor unrelated code, style, or formatting.
6. **No New Dependencies**: Do not introduce external third-party libraries or packages unless unavoidable.
7. **No Unnecessary Abstraction**: Do not create a second abstraction layer when an existing one performs the same role.
8. **Preserve Schema & Audit**: Do not alter database schema or bypass audit event logging unless the defect specifically requires it.
9. **Preserve Permissions & Hotkeys**: Retain position-based access control checks and keyboard-first navigation hotkeys.
10. **Verify Repair**: After making the code repair, run `python3 scripts/system_audit.py` to confirm all configured checks pass cleanly.
"""


def sanitize_ai_packet(text: str) -> str:
    """
    Redacts sensitive identifiers (VINs, customer IDs, emails, phones, tokens)
    from AI-bound incident capsules while preserving route structure.
    """
    if not text:
        return ""

    # VINs (17-char alphanumeric standard format)
    text = re.sub(r'\b[A-HJ-NPR-Z0-9]{17}\b', '[VIN_REDACTED]', text)

    # Route parameters: /api/customers/123 -> /api/customers/{id}
    text = re.sub(r'/api/customers/\d+', '/api/customers/{id}', text)
    text = re.sub(r'/api/vehicles/\d+', '/api/vehicles/{id}', text)
    text = re.sub(r'/api/repair-orders/\d+', '/api/repair-orders/{id}', text)
    text = re.sub(r'/api/appointments/\d+', '/api/appointments/{id}', text)
    text = re.sub(r'/api/parts/\d+', '/api/parts/{id}', text)

    # Emails
    text = re.sub(r'\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b', '[EMAIL_REDACTED]', text)

    # Phone numbers (US/CAN 10-digit formats)
    text = re.sub(r'\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b', '[PHONE_REDACTED]', text)

    # Authorization Tokens
    text = re.sub(r'Bearer\s+[A-Za-z0-9._-]+', 'Bearer [TOKEN_REDACTED]', text)

    return text


def tokenize_symptom(text: str) -> set[str]:
    tokens = re.findall(r'[a-zA-Z0-9_-]+', text.lower())
    stop_words = {"a", "an", "the", "in", "on", "at", "to", "for", "of", "and", "or", "is", "are", "was", "were", "be", "been", "with", "from", "by", "this", "that", "it", "but"}
    return {t for t in tokens if len(t) > 1 and t not in stop_words}


def rank_relevant_files(
    symptom_tokens: set[str],
    manifest: dict,
    git_info: dict,
    runtime_routes: set[str] = None,
    root: Path | None = None,
) -> list[tuple[str, float]]:
    scores = {}
    changed_files = set(git_info.get("changed_files", []))
    runtime_routes = runtime_routes or set()

    for record in manifest.get("files", []):
        fpath = record["path"]
        if any(part.startswith(".") for part in Path(fpath).parts):
            continue
        score = 0.0
        fpath_lower = fpath.lower()

        # 1. Symptom token match (+10)
        for token in symptom_tokens:
            if token in fpath_lower:
                score += 10.0

        # 2. Runtime API endpoint involved (+8)
        for rroute in runtime_routes:
            clean_route = rroute.replace('/api/', '').split('/')[0]
            if clean_route and clean_route in fpath_lower:
                score += 8.0

        # 3. Modified since baseline (+6)
        if fpath in changed_files:
            score += 6.0

        # 4. Core workspace component (+4)
        if any(comp in fpath_lower for comp in ("orders", "appointments", "customers", "vehicles", "parts", "staff", "setup")):
            score += 4.0

        # 5. Source-content evidence. Cap the contribution so a large generated
        # file cannot outrank a direct path/symbol match by repetition alone.
        if root is not None and symptom_tokens:
            abs_path = root / fpath
            try:
                source = abs_path.read_text(encoding="utf-8", errors="ignore").lower()
                content_hits = sum(1 for token in symptom_tokens if token in source)
                score += min(12.0, content_hits * 2.0)
            except (OSError, UnicodeError):
                pass

        if score > 0:
            scores[fpath] = score

    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


def extract_file_excerpts(
    root: Path,
    file_scores: list[tuple[str, float]],
    max_lines: int = 500,
    symptom_tokens: set[str] | None = None,
) -> tuple[list[dict], list[str]]:
    excerpts = []
    omitted = []
    lines_used = 0

    for rel_path, score in file_scores:
        abs_path = root / rel_path
        if not abs_path.exists():
            continue

        try:
            with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
                file_lines = f.readlines()

            total_file_lines = len(file_lines)
            if total_file_lines == 0:
                continue

            if lines_used + total_file_lines <= max_lines and total_file_lines < 80:
                # Include full small file
                snippet = "".join(file_lines)
                excerpts.append({
                    "path": rel_path,
                    "start_line": 1,
                    "end_line": total_file_lines,
                    "content": snippet
                })
                lines_used += total_file_lines
            else:
                # Include a bounded window around the strongest matching line,
                # rather than the beginning of a large file.
                take_count = min(120, max_lines - lines_used)
                if take_count > 20:
                    tokens = symptom_tokens or set()
                    line_scores = [
                        sum(1 for token in tokens if token in line.lower())
                        for line in file_lines
                    ]
                    best_index = max(range(total_file_lines), key=line_scores.__getitem__) if line_scores else 0
                    start_index = max(0, min(best_index - (take_count // 3), total_file_lines - take_count))
                    end_index = min(total_file_lines, start_index + take_count)
                    snippet = "".join(file_lines[start_index:end_index])
                    excerpts.append({
                        "path": rel_path,
                        "start_line": start_index + 1,
                        "end_line": end_index,
                        "content": snippet
                    })
                    lines_used += take_count
                else:
                    omitted.append(rel_path)

            if lines_used >= max_lines:
                # Remaining files omitted
                for o_path, _ in file_scores[file_scores.index((rel_path, score)) + 1:]:
                    omitted.append(o_path)
                break
        except Exception:
            pass

    return excerpts, omitted


def estimate_tokens(text: str) -> int:
    return len(text) // 4


def _detect_loaded_lm_studio_model(chat_url: str, timeout: float) -> str | None:
    """Return LM Studio's loaded LLM identifier without triggering a model load."""
    configured = os.environ.get("LM_STUDIO_MODEL", "").strip()
    if configured:
        return configured
    base_url = chat_url.split("/v1/", 1)[0].rstrip("/")
    try:
        with urllib.request.urlopen(f"{base_url}/api/v0/models", timeout=min(timeout, 2.0)) as resp:
            models = json.loads(resp.read().decode("utf-8")).get("data", [])
        for model in models:
            if model.get("state") == "loaded" and model.get("type") in (None, "llm", "vlm"):
                return str(model.get("id") or "").strip() or None
    except Exception:
        return None
    return None


def query_local_lm_studio(symptom: str, excerpts: list[dict], timeout: float = 35.0) -> dict | None:
    """
    Queries local LM Studio server (http://localhost:1234/v1/chat/completions).
    Measures exact token generation latency and parses structured semantic routing predictions.
    """
    lm_url = os.environ.get("LM_STUDIO_URL", "http://localhost:1234/v1/chat/completions")
    lm_timeout = float(os.environ.get("LM_STUDIO_TIMEOUT", str(timeout)))
    lm_model = _detect_loaded_lm_studio_model(lm_url, lm_timeout)
    if not lm_model:
        return None

    snippet_parts = []
    for ex in excerpts[:2]:
        snippet_parts.append(f"File: {ex['path']} (L{ex['start_line']}-L{ex['end_line']})\n{ex['content'][:450]}")
    combined_excerpts = "\n\n".join(snippet_parts)

    prompt = (
        f"SYMPTOM REPORT:\n{symptom}\n\n"
        f"CODE EXCERPTS:\n{combined_excerpts}\n\n"
        'Choose one supplied target. Return raw JSON only: '
        '{"file":null,"symbol":null,"hypothesis":"max 12 words","confidence":0.0}. '
        "Use null targets and confidence below 0.5 when unsure."
    )

    payload = {
        "model": lm_model,
        "messages": [
            {"role": "system", "content": "Route this TaktRO incident. Return raw JSON only; do not reason aloud."},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.1,
        "max_tokens": 70,
        "reasoning_effort": "none",
        "chat_template_kwargs": {"enable_thinking": False},
    }

    start_time = time.time()
    try:
        req = urllib.request.Request(
            lm_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=lm_timeout) as resp:
            total_latency_ms = (time.time() - start_time) * 1000.0
            res_data = json.loads(resp.read().decode("utf-8"))
            content = res_data.get("choices", [{}])[0].get("message", {}).get("content", "")
            usage = res_data.get("usage", {})
            completion_tokens = usage.get("completion_tokens", len(content) // 4)
            prompt_tokens = usage.get("prompt_tokens", len(prompt) // 4)
            gen_tok_per_sec = (completion_tokens / max(0.001, total_latency_ms / 1000.0)) if total_latency_ms > 0 else 0.0

            parsed_json = {}
            if content:
                match = re.search(r"\{.*\}", content, re.DOTALL)
                if match:
                    try:
                        parsed_json = json.loads(match.group(0))
                    except Exception:
                        pass
                if not parsed_json:
                    clean_content = re.sub(r"^```json\s*", "", content.strip())
                    clean_content = re.sub(r"\s*```$", "", clean_content)
                    try:
                        parsed_json = json.loads(clean_content)
                    except Exception:
                        parsed_json = {}

            valid_output = bool(parsed_json)
            candidate_file = parsed_json.get("file") or parsed_json.get("target_file")
            candidate_symbol = parsed_json.get("symbol") or parsed_json.get("target_symbol")
            supplied = {ex["path"]: ex["content"] for ex in excerpts}
            if candidate_file not in supplied:
                candidate_file = None
                candidate_symbol = None
            elif candidate_symbol and candidate_symbol not in supplied[candidate_file]:
                candidate_symbol = None

            try:
                confidence = max(0.0, min(1.0, float(parsed_json.get("confidence", 0.0))))
            except (TypeError, ValueError):
                confidence = 0.0
            status = parsed_json.get("status")
            if not valid_output:
                status = "invalid_output"
            elif status not in {"candidate", "insufficient_evidence"}:
                status = "candidate" if candidate_file and confidence >= 0.5 else "insufficient_evidence"

            return {
                "model": lm_model,
                "status": status,
                "hypothesis": parsed_json.get("hypothesis") or "Local model returned invalid or truncated JSON.",
                "target_file": candidate_file,
                "target_symbol": candidate_symbol,
                "evidence": "",
                "confidence": confidence,
                "latency_ms": total_latency_ms,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "tok_per_sec": gen_tok_per_sec
            }
    except Exception:
        return None


def generate_incident_capsule(
    symptom: str,
    expected: str,
    location: str,
    repeatable: str,
    manifest: dict,
    git_info: dict,
    findings: list[dict],
    utilities: dict,
    routes: dict,
    db_meta: dict,
    root: Path,
    max_context_lines: int = 500
) -> str:

    symptom_tokens = tokenize_symptom(f"{symptom} {expected} {location}")
    ranked_files = rank_relevant_files(symptom_tokens, manifest, git_info, set(routes), root)

    # Fallback to recent changed files or core JS files if no symptom token matched
    if not ranked_files:
        fallback_paths = git_info.get("changed_files", []) or ["parts/parts.js", "orders/orders.js", "appointments/appointments.js", "server.py"]
        ranked_files = [(p, 1.0) for p in fallback_paths if (root / p).exists()]

    excerpts, omitted = extract_file_excerpts(
        root, ranked_files, max_lines=max_context_lines, symptom_tokens=symptom_tokens
    )

    lines = []
    lines.append("# TaktRO Diagnostic Incident Capsule")
    lines.append("")
    lines.append(f"**Generated**: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"**Git Commit**: `{git_info.get('commit', 'unknown')}` | **Branch**: `{git_info.get('branch', 'unknown')}` | **Dirty State**: `{git_info.get('dirty', False)}`")
    lines.append("")

    lines.append("## 1. Human Report")
    lines.append(f"**Symptom**: {symptom}")
    if expected:
        lines.append(f"**Expected**: {expected}")
    if location:
        lines.append(f"**Location / Workspace**: {location}")
    if repeatable:
        lines.append(f"**Repeatable**: {repeatable}")
    lines.append("")

    # Local AI Pre-Analysis
    local_analysis = query_local_lm_studio(symptom, excerpts)
    if local_analysis:
        model_name = local_analysis.get('model', 'Local AI')
        lines.append(f"### 🤖 Local AI Preliminary Analysis ({model_name} @ LM Studio)")
        lines.append(f"- **Advisory Status**: `{local_analysis.get('status', 'insufficient_evidence').upper()}` — verify against source and tests")
        lines.append(f"- **Hypothesis**: {local_analysis.get('hypothesis', '')}")
        if local_analysis.get("evidence"):
            lines.append(f"- **Supplied Evidence Used**: {local_analysis['evidence']}")
        if local_analysis.get("target_file"):
            lines.append(f"- **Predicted Target File**: `{local_analysis['target_file']}`")
        if local_analysis.get("target_symbol"):
            lines.append(f"- **Predicted Target Symbol**: `{local_analysis['target_symbol']}`")
        lines.append(f"- **Routing Confidence**: {local_analysis.get('confidence', 0.7):.2f}")
        lines.append(f"- **Inference Telemetry**: {local_analysis.get('latency_ms', 0):.1f} ms | {local_analysis.get('completion_tokens', 0)} tokens generated @ {local_analysis.get('tok_per_sec', 0):.1f} tok/s")
        lines.append("")
    else:
        lines.append("### 🤖 Local AI Pre-Analysis")
        lines.append("- *Local LM Studio (http://localhost:1234/v1) offline or not responding within timeout. Proceeding with static compiler capsule.*")
        lines.append("")

    lines.append("## 2. Flight Recorder Runtime Black Box Timeline")
    fr_path = root / ".taktro" / "flight_recorder.json"
    if fr_path.exists():
        try:
            with open(fr_path, "r", encoding="utf-8") as f:
                fr_data = json.load(f)

            lines.append(f"**Captured At**: `{fr_data.get('capturedAt', '')}` | **Active Workspace**: `{fr_data.get('activeWorkspace', 'GENERAL')}` | **Focused Element**: `{fr_data.get('focusedElementId', 'none')}` | **Last Key**: `{fr_data.get('lastKey', '')}`")

            # Anomalies
            anomalies = fr_data.get("anomalies", [])
            if anomalies:
                lines.append("\n**⚠️ Detected Runtime Anomalies**:")
                for an in anomalies:
                    lines.append(f"- [{an.get('type')}] {an.get('message')}")

            # Recent API Calls Timeline
            api_calls = fr_data.get("apiCalls", [])
            if api_calls:
                lines.append("\n**Recent API Calls Timeline (Last 15)**:")
                for call in api_calls[-15:]:
                    conf = f" ({call.get('confidence')})" if call.get('confidence') != 'HIGH' else ""
                    lines.append(f"- `{call.get('route')}` → Status {call.get('status')} in {call.get('durationMs', 0):.1f}ms{conf}")

            # Recent Key Actions
            keys = fr_data.get("keys", [])
            if keys:
                recent_keys_str = " → ".join([f"`{k.get('key')}`" for k in keys[-15:]])
                lines.append(f"\n**Recent Key Sequences**: {recent_keys_str}")
        except Exception:
            lines.append("- *Flight recorder data unreadable.*")
    else:
        lines.append("- *No flight recorder runtime data attached.*")
    lines.append("")

    lines.append("## 3. Relevant Recent Changes & Audit Findings")
    changed = git_info.get("changed_files", [])
    if changed:
        lines.append("**Recently Modified Files**:")
        for c in changed:
            lines.append(f"- `{c}`")
    else:
        lines.append("- *No uncommitted git changes.*")

    if findings:
        lines.append("**Current System Audit Findings**:")
        for find in findings:
            lines.append(f"- [{find['category']}] `{find['file']}:{find['line']}`: {find['message']}")
    lines.append("")

    lines.append("## 4. Relevant Reusable Utilities (DO NOT DUPLICATE)")
    lines.append("Check these existing functions before writing any new helpers:")
    for uname, uinfo in utilities.items():
        if any(t in uname.lower() for t in symptom_tokens) or uinfo["file"] in [r[0] for r in ranked_files]:
            lines.append(f"- `{uname}()` in `{uinfo['file']}:{uinfo['line']}`: {uinfo['description']}")
    lines.append("")

    lines.append("## 5. Targeted Source Excerpts")
    for ex in excerpts:
        lines.append(f"### `{ex['path']}` (Lines {ex['start_line']}-{ex['end_line']})")
        lines.append("```")
        lines.append(ex["content"].rstrip())
        lines.append("```")
        lines.append("")

    if omitted:
        lines.append(f"**Additional potentially relevant files omitted to stay within context budget ({max_context_lines} lines)**:")
        for om in omitted:
            lines.append(f"- `{om}`")
        lines.append("")

    lines.append(REPAIR_INSTRUCTIONS_MD)

    capsule_text = sanitize_ai_packet("\n".join(lines))

    # Token Metrics Estimation
    total_repo_bytes = manifest.get("metrics", {}).get("total_bytes", 100000)
    full_repo_tokens = total_repo_bytes // 4
    capsule_tokens = estimate_tokens(capsule_text)
    reduction = max(0.0, (1.0 - (capsule_tokens / max(1, full_repo_tokens))) * 100.0)

    token_summary = f"""
---
### Context Token Metrics
- **Full Repository Estimated Context**: {full_repo_tokens:,} tokens
- **Incident Capsule Context**: {capsule_tokens:,} tokens
- **Context Size Reduction**: {reduction:.1f}%
"""
    return capsule_text + token_summary
