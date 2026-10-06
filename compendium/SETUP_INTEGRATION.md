# Shop Setup & Rules Integration Foundation

## Status

The backend foundation for `X — Shop Setup & Rules` is prepared. The setup editor and `X` navigation route are intentionally not active yet; TaktRO does not advertise the workspace until managers can complete and publish its workflow.

No tax, fee, labor-rate, deposit, skill, or resource rule created in these tables affects current RO or appointment calculations merely because the schema exists. Production workflows must be connected to the central resolvers and must snapshot their selected monetary values before Setup becomes operational.

## Ownership boundary

Setup owns operational rules and references existing employees, customers, appointments, locations, job codes, and future persistent RO records. Staff & Access continues to own identity, authentication, positions, permissions, and PINs.

The manager-only server permission is `shop_setup`. The Manager / Administrator template receives it automatically. Prepared read/preview boundaries are:

```text
GET  /api/setup/status
POST /api/setup/preview
```

Supported preview types are `LABOR_RATE`, `FEE`, `TAX`, and `CAPACITY`. These endpoints exist to ensure the future editor and production workflows call the same calculation layer.

## Configuration lifecycle

```text
DRAFT -> REVIEWED -> ACTIVE -> SUPERSEDED
```

- Only one active revision may exist for a shop and configuration scope.
- Configuration child records can be inserted, updated, or deleted only while their revision is `DRAFT`.
- Reviewed or published revisions cannot be deleted.
- An active revision can transition only to `SUPERSEDED`; it cannot be reopened.
- Editing active configuration requires a new draft based on the published revision.

SQLite triggers enforce these rules independently of the future interface.

## Prepared domains

- Typed shop profile and location ownership
- Business hours and closure/capacity exceptions
- Physical technician availability, booking target, and protected reserve capacity
- Technician operational profiles, skills, certifications, and scheduling eligibility
- Bays/equipment resources and availability
- Job skill, certification, and resource requirements
- Labor classes, company/location rates, and customer contracts
- Named, effective-dated tax profiles and charge-type rules
- Shop-supplies, hazardous-material, freight, and miscellaneous fee rules
- Payment-method configuration
- Customer deposit accounts and immutable deposit transactions
- Transaction-side calculation snapshots containing both source revision/rule IDs and actual input/result values

## Resolver rules

Labor-rate precedence is:

```text
RO-specific authorized override
  -> customer/fleet contract
  -> location + pay type + labor class
  -> company default
```

The resolver returns the selected rate, source type, source rule ID, configuration revision ID, and the rules checked. A future Test Rate screen must display this evidence rather than reproducing rate logic in JavaScript.

Capacity remains separated:

```text
physical productive hours
  x booking target percentage
  - protected reserve hours
  - already-booked hours
  = available-to-book hours
```

The booking target is management policy; it does not rewrite physical capacity.

Fee previews support disabled, flat, percentage, per-unit, and per-job calculations with optional minimum and maximum amounts. Tax preview currently provides additive, charge-type Decimal calculations with half-up cent rounding. Inclusive and compound tax fields are preserved in the schema but must not be activated until their resolver behavior and jurisdictional tests are implemented.

## Monetary snapshots

Every estimate/RO/invoice integration must retain:

1. the configuration revision and source rule that explain the selection; and
2. the actual rate, basis, fee, tax, and calculated amount used by the transaction.

Historical financial values must never be reconstructed from current Setup data. Authorized values freeze at authorization; later RO lines can use a newer active configuration. Posted invoices are immutable.

## Deposits

Deposits are not negative invoice lines. `deposit_transactions` is an append-only ledger supporting:

```text
REQUEST / PAYMENT / APPLICATION / REFUND / REVERSAL / FORFEITURE
```

Database triggers reject updates and deletes. Corrections require compensating transactions. Before the deposit workflow is exposed, accounting rules must define amount signs, balance calculation, receipt numbering, payment reconciliation, refund authorization, forfeiture authority, and posting/export treatment.

## Activation work still required

Before enabling the `S` workspace:

- Build draft creation/editing and derived-revision services.
- Implement validation, review, change-impact preview, publish, and audit events.
- Build the keyboard-first sections and `Shift+X` navigation.
- Connect appointments to the capacity and eligibility resolvers.
- Connect persistent estimate/RO lines to labor, fee, and tax resolvers.
- Add explicit authorization/recalculation snapshots and audit events.
- Complete inclusive/compound tax behavior and jurisdiction-specific verification.
- Complete deposit receipt, application, refund, reversal, and accounting-export services.
- Add concurrency tests for publishing, deposits, and financial snapshots.
