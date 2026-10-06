# PartsTech Integration Readiness

## Status

TaktRO is structurally prepared for a PartsTech integration, but it is **not connected to PartsTech**. No private API paths, request fields, authentication flow, webhook behavior, or availability meanings have been guessed. Those details must be implemented from the current PartsTech developer contract and validated in its test environment.

## Domain boundary

The integration must translate provider payloads into TaktRO-owned records:

```text
PartsTech contract -> PartsTech adapter -> TaktRO canonical records
```

PartsTech field names must remain inside the future adapter. The rest of TaktRO works with stable internal concepts so a second catalog or ordering provider can be added without changing RO and inventory rules.

The model separates four facts that must not be collapsed:

1. **Canonical part** — the product identity and descriptive information.
2. **Local inventory** — what the shop physically owns, has reserved, and can consume.
3. **Vendor offer** — a supplier/location-specific price, availability statement, delivery estimate, and core charge at a point in time.
4. **RO or PO snapshot** — what was actually quoted or ordered, retained even after the external catalog changes.

Supplier availability must never change `qty_on_hand` or `qty_reserved`. Local quantities change only through TaktRO's receiving, reservation, consumption, adjustment, and count ledger.

## Prepared SQLite records

The existing `parts_inventory` table remains backward compatible with current workflows while adding canonical product fields:

- normalized manufacturer part number and brand identity
- long description, product class, unit of measure, and package quantity
- remanufactured/core flags
- warranty, image URL, flexible attributes, and retained external metadata
- interchange and supersession references
- preferred vendor reference, last cost, and weighted average cost

The old `supplier_name` and `supplier_part_number` columns remain temporarily for the current interface. They are compatibility/preferred-source fields only. An imported live supplier offer must be written to `part_vendor_offers`, not over the canonical part or local-stock quantity.

New integration-ready tables are:

| Table | Responsibility |
|---|---|
| `parts_vendors` | Supplier and supplier-location identity by source |
| `part_vendor_offers` | Time-sensitive price, core, availability, and delivery facts |
| `part_fitments` | Optional source-attributed vehicle applicability retained when useful |
| `ro_part_quote_snapshots` | Immutable commercial facts accepted onto an RO/job line |
| `parts_purchase_orders` | Quote/cart/order references and procurement lifecycle |
| `parts_purchase_order_lines` | Ordered, received, backordered, shipping, and core facts per line |
| `parts_integration_connections` | Provider status and references to externally managed credentials |
| `parts_integration_events` | Idempotent inbound-event staging if the contract uses callbacks |

Raw external JSON is retained only on provider-derived records where it protects against losing unmapped fields. It is not the authoritative source for posted RO, inventory, or accounting history.

## Intended workflow

```text
RO vehicle/job context
  -> supplier catalog search
  -> compare offers
  -> select offer
  -> snapshot quote onto RO line
  -> customer authorization
  -> create/submit purchase order
  -> partial or complete receiving
  -> local stock ledger and RO allocation
  -> core return and vendor credit reconciliation
```

Recommended procurement states are:

```text
QUOTE -> APPROVED -> ORDERED -> PARTIAL -> RECEIVED
                     |             |
                     +-> BACKORDER +-> CANCELLED / RETURNED
```

Provider status must be mapped explicitly; TaktRO should not persist an undocumented external status as its own workflow state.

## Historical and financial rules

- A quote snapshot retains part number, brand, description, vendor, quantity, cost, core, sell price, availability, ETA, external references, and quote time.
- A historical RO must never be reconstructed from current supplier pricing or catalog descriptions.
- PO receiving records the actual unit cost through TaktRO's stock ledger. Last cost and weighted average cost update at receiving time, not when an offer is merely viewed.
- Core expected, received, returned, credit expected, and credit received are distinct facts.
- Freight, core, tax, discounts, returns, and credits require explicit rounding and posting rules before accounting integration.

## Security and reliability requirements

- Do not store PartsTech passwords, API keys, access tokens, or refresh tokens in the SQLite connection row. `credential_reference` is for a secret-store or environment reference only.
- Server-side calls only; browser code must never receive provider credentials.
- Apply request timeouts, bounded retries with jitter, and rate-limit handling once contract limits are known.
- Redact credentials and unnecessary customer/vehicle data from logs and audit details.
- Treat external descriptions, images, URLs, and payloads as untrusted input.
- Use external event/order IDs for idempotency so retries cannot create duplicate POs, receipts, or RO lines.
- External downtime must not block local inventory, receiving, or previously saved RO work.

## Contract information still required

Before activation, obtain and record:

- production and test base URLs
- authentication and credential-rotation flow
- shop/account and supplier-location identifiers
- literal vehicle, search, offer, cart, quote, order, and core schemas
- whether results are synchronous, callback-based, polled, or mixed
- pagination, timeout, retry, throttling, and cache rules
- availability quantity/status semantics and freshness guarantees
- quote expiration and price-change behavior
- tax, freight, discount, package quantity, unit, and currency semantics
- partial fill, substitution, cancellation, return, core, and credit behavior
- webhook signature verification and replay rules, if applicable
- image/catalog-data retention and display rights
- certification, sandbox, support, and production-cutover requirements

Only after those points are confirmed should TaktRO add a PartsTech transport client, adapter mappings, configuration UI, and live workflow controls.
