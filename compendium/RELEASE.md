# TaktRO Release Packaging Checklist

Before building, staging, or compiling a production-ready release package of **TaktRO**, execute these steps to ensure local development metrics and operational credentials are not accidentally shipped.

---

## 📋 Release Checklist

### 1. Close Open Sessions & Stop Server
- Terminate the local `server.py` process to close all active SQLite database connections and flush write-ahead log files (`-shm` and `-wal` files).

### 2. Clean Local Working Copies
Remove the local development databases and import cache directories from your packaging folder:
- **Remove**: `taktro.db` (Operational DB)
- **Remove**: `taktro.db-shm` (WAL shared memory file)
- **Remove**: `taktro.db-wal` (WAL write-ahead log file)
- **Remove**: `nhtsa_reference.db` (Static safety TSB database; downloadable on-demand)
- **Remove**: `perf.log` (Local latency/keystroke performance logs)
- **Remove**: `.local/nhtsa/` (Temporary zip archives downloaded during testing)

### 3. Verify Package Integrity
Inspect your package manifest or archive contents to ensure the files in step 2 are excluded.
- Running a clean startup in a target test environment must create a new, empty SQLite transaction database (`taktro.db`) with the default admin PIN (`1042`).

---

## 📦 Production Deployment Considerations

Before deploying TaktRO for production use in a shop:
1. **Reset Admin PIN**: Change the default `1042` PIN to a secure employee PIN immediately.
2. **Setup Backups**: Create a scheduled cron task or back up the `taktro.db` file daily using a SQLite-safe procedure (`sqlite3 taktro.db ".backup 'backup.db'"`). Do not copy the raw DB file while the database has open connections.
3. **Power Protection**: Run the hosting machine on an Uninterruptible Power Supply (UPS) to protect the WAL database files from corruption during sudden shop power losses.

---

## 🏷️ Recent Release Milestones

### Version 2.5.0 — August 20, 2026
- **Unified Interaction Layer**: Built `DropdownRegistry`, `ModalStack` (with native `inert` background isolation and focus trapping), and `EditorStack` (with normalized snapshot dirty comparison).
- **6-Tier Synchronous Escape Priority Stack**: Synchronously captures `e.preventDefault()` and `e.stopPropagation()` before any `await`. Enforces 6-tier priority order: Dropdown -> Modal -> Editor -> Task Memory Stack -> Workspace Overlay -> Dashboard Session Security Lock.
- **`e.repeat` Protection & Single Navigation Router**: Protected against held-down Escape key repetition. Routed all mouse, hotkey, and navigation actions through `requestNavigation()`.
- **Keyboard Control Activation**: Preserved native browser activation on native `<button>` and `<a>` controls; normalized custom `<tr tabindex="0">` rows while ignoring nested button propagation.
- **Playwright WebKit Interaction Suite**: Created `scripts/interaction_tests.py` using Playwright Python to test DOM focus restoration, dropdown closing, typeahead focus, workspace closing, and 6-tier Escape session lock against an isolated test server.

### Version 2.4.1 — August 20, 2026
- **Performance & Range Windowing Refactor**: Implemented `start_date` and `end_date` date windowing for `/api/appointments`, $O(1)$ appointment map indexing by date, and sequence cancellation for async navigation requests.
- **Session Cache Isolation & Retry Safety**: Scoped API cache by `sessionToken`, added session cache clearance on login/logout, and eliminated promise-cycle deadlocks on failed GET retries.
- **Top-Level Opt-In Diagnostic Mode**: Gated `perf.js` setup behind `window.TAKTRO_DIAG_ENABLED` so normal shop operation incurs 0 key listener, PerformanceObserver, or POST logging overhead.
- **GTK WebKit CSS Containment**: Replaced row-level `content-visibility` with WebKit-safe container `contain: layout style;`.
- **Customer Card Hotkey Preservation**: Removed auto-focus on `editCustName` input fields during customer card editing to prevent hotkey focus capture.
- **Settings & Business Hotkey Routing**: Bound `S` and `B` sub-commands in `COMMAND_REGISTRY`, added `B` to Shift+Warp jump list, updated workspace header to **SHOP SETTINGS**, and removed redundant Vendor card.
- **Automated Regression Test Suite**: Created `scripts/regression_tests.py` verifying range coverage, session cache clearing, perf.js opt-in gating, and CSS containment.

### Version 2.4.0 — August 20, 2026
- **Shop Management Setup Integration**: Integrated Canadian business identity, tax registrations, base labor rates, standard shop fees, customer types, and payer programs under Task `B` in Settings.
- **Local AI Pre-Analysis Engine**: Upgraded local LM Studio integration to support lightweight local models (`google/gemma-4-e4b`) with configurable timeouts (15s) and dynamic model detection.
- **Parts Indentation & RO Workflows**: Implemented indented part sublines (`↳ PART: ...`), open RO search filtering in the parts modal, and automatic active RO editor table refreshes when parts are applied.
- **Open RO Board Navigation**: Removed left-column `<kbd>1-9</kbd>` badges from the Open RO Board and enabled keyboard arrow (Up/Down) selection with `ENTER` key execution.
- **Vehicle & Customer Integrity**: Corrected default `shop_fleet_type` fallback for regular automotive vehicles and enabled customer auto-population on `N` hotkey from Customer Directory.
- **UI Column Alignment**: Standardized `th` header styling and vertical alignment across all workspace tables.
- **Test Data Reset**: Executed clean database reset clearing test transactional data while preserving master part numbers, op codes, staff, and shop setup.
