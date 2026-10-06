# TaktRO Development, Diagnostics & Architecture Guide

This document describes the technical architecture, database layouts, local configuration, system requirements, developer diagnostic tools, and security procedures for running **TaktRO**.

---

## 💻 System Requirements

The core application uses only Python standard library components and SQLite. No external Python packages are required for normal server operation.

| Resource | Development/Testing Minimum | Recommended Shop Workstation |
| :--- | :--- | :--- |
| **Operating System** | 64-bit Linux with Python 3.10+ | Supported current 64-bit Linux distribution |
| **Processor** | Modern dual-core CPU | 4+ modern CPU cores |
| **Memory (RAM)** | 4 GB | 8 GB or more |
| **Display Resolution** | 1280 × 720 | 1920 × 1080 (extra width benefits dense layouts) |
| **Local Storage** | 2 GB free | 10 GB+ (required if indexing NHTSA communications) |
| **Browser Environment** | Modern Chrome, Firefox, or Safari | WebKit2GTK native shell (or modern browser) |
| **Network Connection** | Optional for offline operations | Required for live VIN decode, recalls, and updates |

---

## 🛠️ Local Server Execution

To launch the TaktRO local application server:

```bash
./launch.sh
```

### What happens on startup:
1. The launcher (`launch.sh`) checks for a local Python 3.10+ environment.
2. It attempts to load TaktRO inside a native **GTK/WebKit** application window wrapper (`desktop.py`).
3. If the GTK/WebKit bindings are missing, the server falls back to opening the interface in your default system browser.
4. On first boot, the server creates the SQLite database file `taktro.db` in the workspace root, initializes all schemas, and seeds default administrative identity.
5. Default administrative PIN is **`1042`**.

---

## 🔬 System Intelligence Compiler & Diagnostic Suite

TaktRO includes a deterministic stdlib-only context compiler and diagnostic framework designed to turn human-observed UI issues into compressed, evidence-rich incident capsules for AI coding models.

### 1. Terminal System Auditor (`scripts/system_audit.py`)
```bash
# Standard static, route, hotkey, and workspace module audit
python3 scripts/system_audit.py

# Compile AI-optimized codebase context file (.taktro/context.md)
python3 scripts/system_audit.py --context

# Record known-good baseline snapshot (.taktro/baseline.json)
python3 scripts/system_audit.py --baseline

# Differential diagnosis against baseline snapshot (.taktro/changes.json)
python3 scripts/system_audit.py --diff

# Generate diagnostic incident capsule from symptom text
python3 scripts/system_audit.py --symptom "Pressing N from customer opens RO but customer is not populated"

# Run auditor unit test suite (includes Role Permission Coverage Matrix)
python3 scripts/audit_test.py
```

### 2. Floating Developer Diagnostic UI Drawer, Performance Monitor & Local AI
- **Floating Widget (`[ ● 18ms | DIAG ]`)**: Anchored in the bottom-right corner of the web interface. Displays live health status (`●` Green/Amber/Red) and paint latency (in milliseconds).
- **Draggable UI Windows**:
  - **Diagnostic Suite Drawer (`#diagDrawerOverlay`)**: Mouse-draggable anywhere on screen using the top header bar handle (`⠿ DRAG`). Boosted `z-index` ensures it remains cleanly on top.
  - **Performance Monitor HUD (`#perf-hud`)**: Starts minimized in the bottom-left corner (`PERF: 18ms ▲`). Clicking `▲` expands the telemetry panel; clicking `▼` collapses it. Fully mouse-draggable by its top header bar (`cursor: move`).
- **Diagnostic Drawer Actions**:
  - Displays Health status, Baseline commit hash, Changed files count, and Anomalies count.
  - Symptom report input field with one-click **`⚡ CAPTURE INCIDENT CAPSULE`** button.
  - **`📋 COPY CODEX PACKET PATH`** button for instant clipboard prompt copying.
  - Quick action buttons: `🔍 AUDIT`, `📊 DIFF`, `🧪 TESTS`.
  - Confirmation-protected **Set Current State as Known Good Baseline** tool.
- **Local LM Studio AI Integration (`google/gemma-4-e4b` / `Qwen3-Coder-30B`)**:
  - Automatically queries local LM Studio server at `http://localhost:1234/v1/chat/completions` (or `LM_STUDIO_URL`) when generating incident capsules.
  - Uses `LM_STUDIO_MODEL` when configured; otherwise detects an already-loaded local model without loading one. `LM_STUDIO_TIMEOUT` overrides the inference timeout (35 seconds by default).
  - Pre-analyzes human symptoms against ranked code excerpts using local compute (0 cloud tokens).
  - Embeds local preliminary root-cause hypothesis and inference telemetry directly into Section 1 of `.taktro/incidents/INC-*.md`.
  - Automatically falls back to static compilation if LM Studio is offline or times out.
- **In-Memory Rolling Flight Recorder (`perf.js`)**:
  - Maintains a zero-disk-overhead black box ring buffer in browser memory (last 50 keys, 50 API calls, 30 route switches, 20 UI timings).
  - Detects duplicate fetches (`<500ms`), stale timer outliers (`>30s`), and distinguishes `KEY_HANDLER` paint latency from navigation rendering.

---

## 🗄️ Database Architecture

TaktRO maintains a dual-database design to separate lightweight, high-speed transactional logic from static, heavy-duty service archives:

```
TaktRO/
├── taktro.db          # Primary Transactional DB (<1MB, WAL mode, gitignored)
└── nhtsa_reference.db # Secondary Safety/TSB Reference DB (~3.5GB, gitignored)
```

### 1. Operational Database (`taktro.db`)
Operates in SQLite Write-Ahead Logging (WAL) mode for maximum transaction concurrency. Key tables include:
- `employees` & `employee_permissions`: PIN hashes, position templates, and exceptions.
- `customers`: Profiles, fleet billing notes, company links, and unit IDs.
- `vehicles`: Identifiers (VIN/Serial), trim details, engine, and custom fluid specifications.
- `appointments`: Schedules, capacity metrics, and technicians.
- `repair_orders` & `ro_lines`: Line items, C/W/I/G pay categories, totals, and statuses.
- `parts_inventory`: Catalog items, line codes, vendor links, cost date tracking, unit yield quantities, and parent/child per-unit SKU links.
- `audit_events`: User and system events for compliance tracking.

### 2. Safety/TSB Reference Database (`nhtsa_reference.db`)
Keeps massive external service files out of the daily transactional path:
- **Safety Recalls**: Requested live over HTTPS from the federal NHTSA Recalls API. Outages are handled gracefully without blocking daily workflows.
- **TSBs / Manufacturer Communications**: Stored in a local read-only SQLite table containing over 5.7 million records (~3.5 GB).

---

## ⚙️ Parts Engine & Bulk Unit Breakdown

- **Line Code / Make (`line_code`)**: Formatted as `[LINE_CODE] [PART_NUMBER]` (e.g. `[LMY] LM2259`). Fully searchable by line code, part number, or interchange number.
- **Preferred Vendor**: Linked to `parts_vendors` table.
- **Last Cost History**: Stores `cost_price` and `last_cost_date`, updated automatically on stock receipt.
- **Standardized Categories**: Prefilled category selection (`OIL & FLUIDS`, `FILTERS`, `BRAKES & WHEEL`, etc.).
- **Multi-Alternate Part Numbers**: Supports comma-separated alternate/interchange SKUs.
- **Bulk Per-Unit Container Breakdown (`ALT+B`)**: One-click action to create a child per-unit SKU from a bulk container (e.g., 5L jug `LM2259` -> 1L child SKU `LM2259-1L` @ $8.50/L).

---

## 🛡️ Security Protections & Binding

- **Host Restrictions**: By default, the server binds to `127.0.0.1` (localhost). To enable LAN access, set:
  ```bash
  export TAKTRO_HOST=0.0.0.0
  ```
- **File Access Rules**: The HTTP server returns `HTTP 403 Forbidden` for direct requests attempting to download `taktro.db`, `.py` source files, `.sh` shell scripts, or hidden files.
- **Developer Diagnostic Endpoints**: Served under `/api/dev/diagnostics/*` for status, incident generation, audits, diffs, and test runs.

---

## 🔗 Related Documentation
- [README.md](../README.md) - Main application overview.
- [compendium/INDEX.md](INDEX.md) - Documentation compendium index.
- [compendium/SELF_DIAGNOSTIC.md](SELF_DIAGNOSTIC.md) - Three-tier self-diagnostic and rapid patching blueprint.
- [compendium/KEYBINDINGS.md](KEYBINDINGS.md) - Master keyboard shortcut sheet.
- [compendium/WORKFLOW_GUIDE_v1.md](WORKFLOW_GUIDE_v1.md) - End-to-end shop workflow guide.

## Workspace browser regressions

All workspaces use the shared EventDelegator for clicks,
input/change/focusout events, field keyboard handling, and validated form submissions.
Action callbacks receive `(param, element, event)`; use `element` for the bound
row or form because native `event.currentTarget` is the document.
Toolbar actions use CommandRegistry; shortcut labels use UIComponent.Keycap.
The architecture guard treats inline handlers and raw keycap markup in all
JavaScript modules as errors. It also checks inline events in `index.html`;
static shell keycaps use the same canonical CSS classes. No migration allowances
remain. `opcode_picker.js` owns shared search, keyboard selection, and dropdown
rendering for RO and Appointments.

Shared builders take named actions: `SearchBar.inputAction`,
`ResultTable.rowAction/rowKeydownAction/sortAction`, `EditorForm.submitAction/cancelAction`,
`ModalDialog.confirmAction/cancelAction`, `StateMessage.retryAction`, and
`Pagination.pageAction`. Register callbacks with EventDelegator; never pass
JavaScript source strings. Modal cancellation must settle any pending result.

Warp history retains one live view frame per jump, including its domain context,
focus, scroll, and editor state. Escape restores that frame before routing further
back; repeated visits to a workspace have separate frames. These frames stay in
memory for the current session and are cleared on logout. They are not serialized
HTML snapshots in the compact workspace state store.

Use a development virtual environment for browser dependencies:

```bash
python3 -m venv .venv
.venv/bin/pip install playwright
# When system Chromium is installed:
TAKTRO_BROWSER_PATH=/usr/bin/chromium .venv/bin/python scripts/check.py workspaces
# Alternatively install Playwright's bundled Chromium:
.venv/bin/python -m playwright install chromium
.venv/bin/python scripts/check.py workspaces
```

The `workspaces` profile runs the quick checks plus eighteen Chromium browser cases.
Its browser tests create disposable operational and reference databases and use
an automatically allocated localhost port. They cover the complete receive,
split, RO allocation, booking and posting flow, both allocation entry points,
nested button clicks, keyboard activation, editor shortcuts, native form
validation, part metadata edits, quantity-adjustment entry, counter-sale fields,
new-part controls, and protection against stale search responses replacing a
parts detail view. Additional cases cover customer create/edit, equipment
create/edit and owner linking, opcode categories in both editors, appointment
views/create/defer, setup draft/publish, vendor contacts, staff profile and
permission forms, job-code editing, retries, pagination, and modal cancellation.
Warp tests also cover Parts → Vehicle → Escape, an open part detail, and
repeated visits to the same workspace. Logs are saved under `.taktro/test-results/`; the posted-RO
screenshot is saved in its `workspace-browser/` directory. The ordinary `quick`
profile remains independent of browser dependencies. Missing Playwright reports
BLOCKED instead of silently skipping browser validation.
