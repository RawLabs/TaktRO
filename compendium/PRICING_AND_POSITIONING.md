# TaktRO Pricing & Positioning

## Purpose

This document sets the initial market position for TaktRO and provides a pricing ladder that can be used to evaluate whether future features are priced appropriately.

## Product position

TaktRO is a local-first, keyboard-first repair order and shop capacity management system.

It should be positioned as:
- stronger than basic invoicing or simple shop management tools
- below full mature cloud shop operating systems
- well below enterprise collision systems with insurer/DRP lock-in

Its main value is throughput, data control, and migration confidence.

## Pricing recommendation

### Launch pricing
- $99 per location per month as an early-adopter / beta anchor
- $149 per location per month as the standard core price

### Growth pricing
- $249 to $349 per location per month for multi-location or advanced-support plans

### Implementation / migration
- Migration Preview: $250 to $750 one-time fee
- Credit the preview fee toward implementation if the shop converts

## Why this pricing fits

Current build strengths:
- repair order workflow
- appointment and shop capacity logic
- customer, vehicle, and asset records
- parts inventory
- staff and access control
- audit logging
- NHTSA recall / TSB lookup
- keyboard-first execution
- local data sovereignty

Missing features that would justify materially higher pricing:
- payments
- texting / messaging
- digital vehicle inspections
- mature accounting / GL integration
- deep parts ordering integrations
- insurer / DRP workflow
- broad third-party ecosystem
- proven migration tooling at scale

## Fair-market-value logic

### If the product replaces only workflow
Price against SMB shop management software.
Target band: $99 to $179 per month.

### If the product replaces workflow plus conversion tools
Price against modern shop OS platforms with DVI, texting, and payment features.
Target band: $179 to $349 per month.

### If the product also carries proprietary technical data or enterprise integrations
It can justify premium pricing.
Target band: $349+ or quote-based.

## Feature gate model

| Tier | Included | Suggested price |
|---|---|---:|
| Starter | RO workflow, customer/vehicle records, appointments, parts inventory, staff access | $99/mo |
| Core | Starter plus audit logging, capacity logic, NHTSA lookup, better reporting | $149/mo |
| Pro | Core plus multi-location controls, advanced permissions, priority support | $249/mo |
| Multi-Location | Pro plus centralized reporting and rollout support | $349/mo+ |
| Migration Preview | Limited imported sample data in isolated demo database | $250-$750 one-time |

## Add-on pricing candidates

These should be priced separately if they are built:
- DVI
- texting / customer communications
- payments
- accounting export / GL sync
- advanced reporting packs
- OEM data access connectors
- parts catalog integrations
- migration services

## Pricing principle

Do not price TaktRO like an enterprise collision platform unless it truly owns:
- insurer integrations
- proprietary data depth
- large-scale implementation support
- locked-in workflow infrastructure

If it mainly wins on speed, local control, and migration confidence, it should stay in SMB SaaS territory.

## Decision rule

If a shop can replace TaktRO with a $99-$179/month generic shop tool and lose little, TaktRO is priced too high.

If TaktRO reliably saves enough labor, friction, or migration fear to exceed that value, it is priced correctly.
