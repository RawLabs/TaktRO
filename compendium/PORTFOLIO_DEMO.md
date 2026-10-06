# RO and inventory portfolio demonstration

This local SQLite application demonstrates a transactionally connected repair-order and inventory workflow. Use fictional demo data rather than publishing the archived databases.

## Prepare

```bash
python3 scripts/demo.py --db /tmp/taktro-demo.db
TAKTRO_DB_PATH=/tmp/taktro-demo.db TAKTRO_NHTSA_DB_PATH=/tmp/taktro-demo-reference.db python3 server.py
```

Open http://127.0.0.1:8080 and use PIN `1042`. The initializer refuses to overwrite existing files. Choose another filename for a fresh demonstration.

## Walkthrough

1. Open Parts (`Shift+P`), find `DEMO-OIL-5L`, and receive **2 containers at $40 each** with reference `DEMO-PO-001`. On hand is 2 and reserved is 0.
2. Use bulk breakdown (`Alt+B`) to split **one container into 5 child units**, retail **$12/unit**. Parent on hand is 1; child on hand is 5, with unit cost $8. Whole child units are required.
3. Open Repair Orders (`Shift+O`) and edit `RO-DEMO-0001`. Its labor charge is $50. Generate/dispatch the RO, then save its progress through in-progress and work-complete as appropriate.
4. Add **4 child units** from inventory to the oil-service line. Save any editor changes first. Confirmed parts total is $48, labor is $50, and RO total is $98. Child on hand stays 5, reserved becomes 4, and available becomes 1. The confirmed-parts panel shows the SKU and quantity.
5. To demonstrate correction, use **REMOVE / RELEASE** in that panel. Parts billing returns to $0 and reserved returns to 0. Reapply 4 units.
6. Choose the line's C/W/I/G pay type. For warranty, choose W: warranty total becomes $98 and customer total $0. Parts are billed once.
7. Check **B** to book the completed job, then choose **POST / INVOICE RO**. Child on hand becomes 1 and reserved becomes 0. Confirmed charges become POSTED and the RO is read-only.
8. Open RO History (`Shift+H`) and inspect the posted RO. Refresh/retry cannot deduct stock again.

| Stage | Parent on hand | Child on hand | Child reserved | Child available | RO total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Receipt | 2 | — | — | — | $50 |
| Split | 1 | 5 | 0 | 5 | $50 |
| Confirm 4 units | 1 | 5 | 4 | 1 | $98 |
| Post | 1 | 1 | 0 | 1 | $98 |

## Evidence

```bash
python3 scripts/check.py quick
python3 scripts/workflow_tests.py
```

The stdlib HTTP tests create temporary databases and exercise receipt, split, billing, C/W/I/G totals, posting, repeat posting, charge removal, failed allocation, reserved-container protection, and multi-part posting rollback. They never open the archived shop database. Syntax, architecture, and diagnostic unit checks also run in the quick profile. Eighteen Chromium browser cases verify the workflow through the real UI, including both part-allocation entry points, field events, nested clicks, keyboard shortcuts and native validation. Run `python3 scripts/check.py workspaces` from a development environment with Playwright and Chromium; see [DEVELOPMENT.md](DEVELOPMENT.md#workspace-browser-regressions) for setup. Other browser suites require their own browser engines separately.

## Scope

RO posting here means finalizing billing and inventory consumption. Payment collection, general-ledger export, vendor invoice reconciliation, fractional child-unit dispensing, and post-invoice returns/credits are separate future workflows. Existing scalar parts allowances remain supported; imported historical ROs without confirmed part charges are not retroactively consumed. Legacy reservations must be reconciled and confirmed before their RO can post.

For a portfolio, describe this as a local automotive shop-management prototype with atomic SQLite inventory movements, durable line-linked part charges, split pay categories, audit trails, immutable posted ROs, and reproducible integration tests. Keep claims bounded to the demonstrated workflow.
