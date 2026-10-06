# TaktRO — Project Compendium & Documentation Library

This folder contains all background architecture notes, design specs, workflow guides, integration strategies, and release history for the **TaktRO Repair Order Command Engine**.

---

## 📚 Document Index

### 1. Workflow & Operations
- **[PORTFOLIO_DEMO.md](PORTFOLIO_DEMO.md)**: Reproducible fictional-data inventory and repair-order lifecycle, expected totals, and test commands.
- **[DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md)**: Portable insight layer — the throughput worldview, design filter, capacity separation model, C/W/I/G line-level payer model, status vocabulary, conservation-law-as-workflow, advisor/dispatch boundary, self-observation layer, and the deliberate scope boundaries of the experiment. The artifact that survives independent of the codebase.
- **[STORYBOARD.md](STORYBOARD.md)**: One-page visual workflow storyboard (13 frames + closing) of the PoC's throughput-first philosophy — written for delivery as an animated walkthrough, with built-in motion between frames and an open-ended future (product, migrated insight, or documents).
- **[WORKFLOW_GUIDE_v1.md](WORKFLOW_GUIDE_v1.md)**: End-to-end shop workflow guide (Customer Intake -> Appointment Time-Pool -> RO Line Item Write-up -> Parts Procurement -> Counter Sale -> Cashout).
- **[KEYBINDINGS.md](KEYBINDINGS.md)**: Sitewide keyboard shortcut reference map (<kbd>ALT+S</kbd>, <kbd>ALT+A</kbd>, <kbd>ALT+P</kbd>, <kbd>ALT+C</kbd>, <kbd>ALT+G</kbd>, <kbd>ALT+I</kbd>, <kbd>ALT+O</kbd>).

### 2. Product & Architecture Specs
- **[PRODUCT_NOTES.md](PRODUCT_NOTES.md)**: Product vision, architecture decisions, database models, and service boundary definitions.
- **[PRICING_AND_POSITIONING.md](PRICING_AND_POSITIONING.md)**: Commercial strategy, feature tiers, and shop positioning analysis.

### 3. Integrations & Setup
- **[SETUP_INTEGRATION.md](SETUP_INTEGRATION.md)**: Initial environment setup, database migrations, and system configuration instructions.
- **[PARTSTECH_INTEGRATION.md](PARTSTECH_INTEGRATION.md)**: PartsTech e-procurement API integration spec and live supplier catalog punchout.

### 4. Development, Diagnostics & Releases
- **[DEVELOPMENT.md](DEVELOPMENT.md)**: System Intelligence Compiler v2.0, Developer Diagnostic Suite (`[ ● 18ms | DIAG ]`), LM Studio local Qwen3-Coder-30B AI pre-analysis, draggable UI windows, rolling flight recorder, testing procedures, and database architecture.
- **[SELF_DIAGNOSTIC.md](SELF_DIAGNOSTIC.md)**: Three-tier self-diagnostic blueprint & portable script template for search-space compression, semantic target routing, and cloud-agent patching.
- **[RELEASE.md](RELEASE.md)**: Version history, changelogs, and milestone release notes.
