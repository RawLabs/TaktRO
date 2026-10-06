# TaktRO — Product Edge & Migration Strategy Notes

> Living reference document. Captures strategic considerations, competitive positioning, and the migration preview commercial model. Not a roadmap — a thinking record.

---

## The Core Problem We're Solving

Most shops aren't looking for a new SMS. They're **afraid to leave the one they have.**

Fear of:
- Losing historical data
- Retraining staff on a new system mid-week
- A vendor lock-in trade where you escape one and fall into another
- A cloud migration where your data leaves the building

The incumbent platforms (Mitchell1, Tekmetric, Shop-Ware, MaxxTraxx) understand this. Their **retention strategy is friction**, not loyalty. Make it expensive and scary to leave, and shops stay.

TaktRO's edge isn't just the software. It's **removing those fears one by one.**

---

## Migration Preview — The Commercial Model

### What It Is

A prospective shop doesn't hand over ten years of data or commit to switching systems.

They choose a **small, representative export** — say 200 customers, their linked vehicles, and a batch of historical ROs — and TaktRO imports only that into a **disposable / isolated demo database**.

Then you show them:

> **Their customers → their vehicles → their history → a real new RO workflow**

Not generic placeholder records. Their actual data.

### The Deliverable

> **Migration Preview**
> We import a limited sample of your existing shop data and configure a temporary TaktRO workspace so you can test your actual workflow before making any decision.

### The Sales Model

| Step | What Happens |
|---|---|
| Export a sample | Shop exports a small batch from their existing SMS |
| Preview import | TaktRO ingests it into an isolated local DB |
| Live session | Shop runs real ROs, searches real customers, reviews real history |
| Compare | Side-by-side against Mitchell / current system |
| Decide | No blind commitment required |

A sensible commercial structure: **small dry-run fee** (filters tire-kickers) credited toward implementation if they proceed. The decision stays cheap. The commitment only comes after they've seen their own shop work inside the system.

**No sales pitch → no contract → no blind migration.**

---

## The Critical Distinction: Preview vs. Validation

These are **two different products with two different purposes.**

### Sales Preview (Small Dataset)
- Deliberately limited — 100–500 records
- Purpose: prove "your information can live here and you can work with it"
- Should run clean and fast — no edge cases, no data archaeology
- Local, done in a session, disposable DB

### Migration Validation (Full Dataset)
- Large or full dataset — everything the shop has
- Purpose: discover garbage, duplicates, and edge cases **before** go-live
- Expects `BOB` appearing 27 times, VINs containing `000000`, customer notes from 2007
- Produces a **migration report**: conflict count, resolution needed, estimated cleanup time

> You actively *don't* want the sales demo bogged down in migration mess. The preview proves viability. The validation test proves reliability.

---

## Local-First Is a Feature, Not an Architecture Choice

Because TaktRO runs locally:

- The shop's data **never leaves their building** during a preview
- There's no "upload your customer list to our startup's cloud" conversation
- The import/preview can run on their machine, on their lunch break, with zero network dependency
- If they don't proceed, the data disappears with the demo DB — nothing to audit, nothing to delete

This is a **considerably easier conversation** than any cloud-based SMS can have.

---

## What Shops Actually Dislike About Incumbent Systems

Research and patterns to stay sharp on. These are the friction points to explicitly address:

### Mitchell1 / Manager SE / ProDemand
- **Pricing opacity** — subscriptions that inflate without clear justification
- **Windows-dependent**, aging UI — feels like 2008
- **Slow** — loading screens between every action
- **Vendor lock-in on data exports** — painful to get your own data out
- **Phone support** is the only real help channel — long hold times

### Tekmetric
- Cloud-only — offline = dead
- **Slower than advertised** on weak shop WiFi
- Pricing tiers gate features shops expect to be standard
- Data export not straightforward for migration

### Shop-Ware
- Strong for large multi-location — **overkill and overpriced** for independent shops
- Setup complexity
- Steep learning curve for non-technical staff

### MaxxTraxx
- Dated UI
- Inconsistent cross-platform behavior
- Poor mobile experience

---

## TaktRO's Competitive Edge — Keep It Sharp

| What They Do | What TaktRO Does |
|---|---|
| Cloud-dependent | Local-first — works without internet |
| Mouse-driven UI | Keyboard-first — zero mouse required in flow |
| Subscription lock-in | Shop controls their data, runs locally |
| Opaque data export | Export/import is a first-class feature |
| Generic demo during sales | **Your data in the system on day one** |
| Fear-based retention | Low-risk entry via Migration Preview |
| Slow page transitions | Single-page, instant module switching |
| Generic help screens | Context-aware help per active module |

---

## Migration Tool as a Selling Feature

Migration isn't sexy. But **fear of migration is probably a larger barrier than the software price.**

A shop that has used Mitchell for 12 years isn't resisting because they love Mitchell. They're resisting because:
1. They don't know what moving costs
2. They don't trust that their data survives it
3. They've been burned before or heard stories

The migration preview directly attacks all three:
1. **Known cost** — small flat preview fee, credited if they proceed
2. **Visible proof** — their data, in front of them, working
3. **No commitment** — if it looks wrong or incomplete, they walk with no loss

The tool itself becomes a **trust mechanism**, not just a utility.

---

## Open Questions (for later)

- What format do the major SMS platforms export to? (CSV, XML, proprietary?) — determines import parser scope
- Do we build a universal parser or SMS-specific importers? (Mitchell vs. Tekmetric vs. Shop-Ware have different schemas)
- What is the minimum viable sample that proves the concept without revealing too much of a shop's data profile?
- Preview DB lifecycle — how long does the demo database persist? Who deletes it?
- Does the preview session get recorded / exported as a report the shop can keep?

---

## Master Friction Register v2 Product Alignment

The development of TaktRO is strictly governed by the **TaktRO Master Friction Register v2**:

- **Core Goal**: Eliminate shop-floor waste across 12 primary waste categories (Waiting, Motion, Duplicate Entry, Hunting, Rework, Defect, Interruption, Unclear Handoff, Training Burden, Downtime, Financial Leakage, Data Lock-In).
- **Core Rules**:
  1. *User Location is State*: Edits never shift scroll position or keyboard focus unpredictably.
  2. *Independent Dependency Failure*: External API outages (VIN, Parts, Accounting) never block local RO writing, counter sales, or printing.
  3. *Append-Only Financial History*: Posted invoices are never silently rewritten; corrections generate auditable adjustment records.
  4. *Dual Mouse & Keyboard Interactivity*: Every workflow supports 1-click mouse execution alongside fast single-key shortcuts.
