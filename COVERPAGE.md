# TaktRO — Proof of Concept Cover Page

> Historical concept document from August 2026. Some architecture and test-status descriptions below predate the current implementation. See the [current README](README.md) and [portfolio demo](compendium/PORTFOLIO_DEMO.md) for the published source and verified workflow.

> **Status**: Fancy Proof of Concept · Not Production Material  
> **Purpose**: Demonstrate that workflow software built around the user *can* exist  
> **Date**: August 2026  
> **Branch**: `master` (unstable, evolving)

---

## What This Is

TaktRO is a **keyboard-first automotive shop management prototype** built to validate a single hypothesis:

> **When software is designed around the technician's/advisor's actual motions — not around database schemas, not around management reports, not around "industry best practices" — throughput changes.**

This repository proves that hypothesis is testable. It does **not** prove the software is ready for a shop floor.

---

## What Was Validated

| Hypothesis | Evidence in This Repo |
|------------|----------------------|
| Single-keystroke navigation eliminates menu hunting | `O`, `A`, `C`, `V`, `P`, `H`, `S`, `J`, `M` from dashboard (see `compendium/KEYBINDINGS.md`) |
| Uppercase normalization prevents misreads on greasy screens | All text entry → uppercase at input layer (`app.js`, `server.py`) |
| Position templates > granular permissions | Advisor / Parts / Tech / Dispatcher / Manager templates (`staff.js`, `models.py`) |
| Capacity ≠ booking targets | Versioned setup resolver with reserve/preview (`compendium/SETUP_INTEGRATION.md`) |
| C/W/I/G split billing on one RO | Domain model supports four pay-types per line (`orders.js`, `schema.py`) |
| Local-first, no cloud dependency | SQLite + Electron-style desktop shell (`desktop.py`, `launch.sh`) |
| Keyboard-driven parts application | `ALT+O` (Parts workspace) opens "Apply Part to RO" modal; `ALT+Q` = stock qty adjust (`parts.js`, `KEYBINDINGS.md:68-70`) |

---

## What Was *Not* Built (Intentionally)

| Production Requirement | Status | Reason |
|------------------------|--------|--------|
| Automated test suite | ❌ | PoC validates UX flow, not regression safety |
| Migration / schema versioning | ❌ | SQLite schema lives in `models.py` — alter by hand |
| Multi-shop / multi-tenant | ❌ | Single-shop sovereignty was the design constraint |
| OEM repair data integration | ❌ | PartsTech spec exists (`PARTSTECH_INTEGRATION.md`) but not wired |
| Audit trail immutability | ⚠️ | `incident.py` logs exist; no tamper-evidence |
| Offline-first conflict resolution | ❌ | Single-user PoC assumption |
| Accessibility (screen readers, high-contrast) | ❌ | Keyboard-first ≠ accessible |
| Installer / auto-update pipeline | ❌ | `launch.sh` is the "installer" |
| Observability / structured logging | ❌ | `console.log` / `print()` only |

---

## Architecture That Scales (If You Decide To)

```
┌─────────────────────────────────────────────────────────────┐
│  Electron / Tauri shell (desktop.py)                        │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  React / Svelte / Solid frontend (index.html + .js)   │  │
│  │  • Single-keystroke router                             │  │
│  │  • Optimistic UI, server reconciliation                │  │
│  │  • Web Workers for search/indexing                     │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Python/FastAPI backend (server.py)                   │  │
│  │  • GraphQL (schema.py) or REST                        │  │
│  │  • SQLite (models.py) → PostgreSQL swap point         │  │
│  │  • Domain services: orders, parts, vehicles, staff    │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Key separation**: Frontend knows *workflows*. Backend knows *invariants*. They share only the GraphQL schema.

---

## The "AutoRO" Rebrand Note

The user intends to rename this codebase under the **AutoRO** product family.  
This PoC carries the **TaktRO** name throughout. A rebrand would touch:

- `index.html` title / manifest
- `desktop.py` window title
- `launch.sh` binary name
- All `TaktRO_*` assets in `media/TaktRO_media_package_2026-08-16/`
- Documentation cross-references (`compendium/*.md`)
- Package / distribution metadata (when one exists)

---

## How to Evaluate This PoC

1. **Run it**: `./launch.sh` — opens the desktop shell
2. **Drive a repair order**: `O` → create RO → `A` → book appointment → `P` → apply part with `ALT+O` (Parts workspace)
3. **Measure**: Keystrokes to complete a full write-up vs. your current DMS
4. **Stress**: Open 50 ROs, 200 customers, 500 parts — watch the search/index performance (`perf.js`)
5. **Break it**: Pull the network cable — does the UI degrade gracefully? (It won't — that's a known gap)

---

## Next Steps If This Becomes a Product

| Phase | Scope | Gate |
|-------|-------|------|
| **0. Hardening** | Test harness (Playwright + Vitest), CI, schema migrations, structured logging | 80% coverage on domain services |
| **1. Pilot** | Single-shop beta with signed NDA, weekly retrospectives | 4-week zero-data-loss run |
| **2. Platform** | Multi-shop tenancy, OEM data connectors, installer, auto-update | Paying pilot converts |
| **3. Scale** | Horizontal read replicas, event sourcing for audit, marketplace for op-codes | >20 shops on platform |

---

## Closing Frame

> **This is not "vibe code."**  
> It is a **structured experiment** that proves a keyboard-first, user-centric workflow for automotive shops is *buildable*, *measurable*, and *distinct* from the incumbent DMS paradigm.

The code is messy. The architecture has seams. The test coverage is zero.  
**But the workflow works.** That is the only metric that matters at this stage.

---

**Artifact**: `COVERPAGE.md` — attach to any handoff, investor deck, or internal review.  
**Do not ship this code.** Ship the *insight* it validates.