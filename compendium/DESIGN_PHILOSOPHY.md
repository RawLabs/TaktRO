# TaktRO Design Philosophy — Extracted Insight Layer

> Historical concept document from August 2026. Some architecture and test-status descriptions below predate the current implementation. See the [current README](../README.md) and [portfolio demo](PORTFOLIO_DEMO.md) for the published source and verified workflow.

**Source**: TaktRO experiment (PoC, keyboard-first automotive shop management prototype, August 2026)
**Status of this document**: portable artifact — the insight the experiment validated, independent of the codebase.

---

## The Testable Hypothesis

> **When software is designed around the technician's/advisor's actual motions — not around database schemas, not around management reports, not around "industry best practices" — throughput changes.**

TaktRO was built to prove this hypothesis is *testable*. It does not claim the software is ready for a shop floor. The artifact is the insight: that a throughput-first DMS design is buildable, measurable, and distinct from the incumbent paradigm.

---

## The Throughput Worldview

The project encodes the efficiency worldview as:

$$\large E_i = \frac{V}{M + W + R}$$

- **V** = value-adding work (wrench time, write-up completion, invoice posted, part applied)
- **M** = avoidable motion (menu hunting, mouse travel, visual scanning, re-finding a record)
- **W** = waiting (Hold — Authorization, Hold — Parts, waiting for a tech slot, waiting for a PO)
- **R** = rework (comebacks, denied warranty flipping to internal, misdiagnosis, duplicate entry)

The project's explicit design stance: **measure M, W, R as separate terms, not collapse them into one "overhead" bucket.** That's why the status vocabulary has named wait states instead of burying delay inside "in progress," and why the overbooking gate is a discrete decision (carry-over) rather than a hidden exception.

The humor in the README — the ideal state approaches π — is not a joke about the math. It is a joke about the fact that the target is irrational and therefore unreachable, but *measurable enough to start a conversation*. That is the philosophical posture: measure what you can, name what you can, reduce each term separately.

---

## The Workflow Reasoning Hierarchy

Every design choice in the project traces back to one of three questions:

1. **What motion does this eliminate?**
2. **What wait does this name or prevent?**
3. **What rework does this catch at the earliest possible point?**

If a feature can't answer at least one of those, it is suspect. If it answers none, it is a candidate for deletion. This is the Lean shop product philosophy stated as a design filter, not as a slogan.

---

## Motion Reduction — The Keyboard-First Decision

Single-keystroke warp from the dashboard (`O`, `A`, `C`, `V`, `P`, `H`, `S`, `J`, `M`) is not a "power user" feature. It is a deliberate motion-reduction move: a shop advisor with grease on their hands, under shop lighting, at arm's length from a screen, does not want to hunt a menu. They want to press a key and arrive.

Global `Shift+Key` warp from anywhere, with automatic form-state caching and `ESC` return, is the same reasoning at a higher level: the advisor should be able to context-switch without losing their place or re-entering data.

Typeahead search — op-code, customer name, part number, vehicle — is motion reduction against navigating a tree. The workflow assumption: the advisor knows roughly what they are looking for and can type it faster than they can click through categories.

All text entry normalized to uppercase at the input layer is a readability decision for greasy screens, not an aesthetic choice. It is M-reduction against visual misread.

**The measurement framing**: keystrokes to complete a full write-up in TaktRO vs. the incumbent DMS. This is a comparative, empirical ratio. It is not derived; it is measured. The project's "how to evaluate" section names this as the primary throughput validation.

---

## Wait Naming — The Status Vocabulary

The project defines RO statuses that name the *reason* for delay, not just the delay:

| Status | What it means | Why it matters |
|---|---|---|
| Write-Up | Work being quoted/prepared | Transactional state; amounts are preliminary |
| Hold — Authorization | Waiting for sign-off, policy confirmation, warranty auth | Named wait — often the dominant wait in warranty work |
| Ready to Dispatch | Authorized and quoted; pending tech capacity | The C+W+I+G financial quote is finalized |
| In Progress | Tech started work | Shift from quoting to time tracking |
| Hold — Parts | Paused for parts arrival | Named wait — reservation is active, RO blocked |
| Work Complete | Labor done, awaiting QC/invoicing | Mandatory sign-off before billing can finalize |
| Invoiced | Billing finalized, immutable | Transactional record archived |

The wait states are explicit so they can be measured — by timestamp if the system tracks status transitions, by cycle-time analysis otherwise. A shop that can't name its waits can't reduce them; it can only "improve throughput" by optimizing in the dark.

---

## Rework Prevention — Gates at the Earliest Failure Point

Rework is expensive in a shop because it is physical: a comeback means the vehicle is back, the tech is back, the bay is occupied again, the customer experience is degraded. The project builds gates that catch failures at the earliest possible point:

**Capacity gate**: booking form validates estimated hours against configured capacity minus reserved time. If it fails, the booking fails *unless* explicitly marked as carry-over/overnight. This is the conservation law enforced as workflow:

$$\large C_{bookable} - C_{reserved} - C_{booked} \geq 0 \quad \text{(unless carry-over declared)}$$

The overbooking escape hatch exists because real shops sometimes need to push past bookable — but the system makes the push a *declared decision*, not a silent accident.

**Promise protection**: promised times are calculated against real capacity, not targets. Technician workload stays visible during planning. The "Hold — Parts" status blocks the RO until parts arrive, so a promised part that isn't on hand is caught as a named wait, not silently consumed.

**Inventory reservation integrity**: RO part application reserves stock; counter sales touch only on-hand. The two sub-ledgers are independent by construction so a quick sale can't silently eat stock committed to an active job. The conservation equation is:

$$\large qty_{on\_hand}^{t+1} = qty_{on\_hand}^t + \Delta_{receive} - \Delta_{counter\_sale} - \Delta_{consume}$$

$$\large qty_{reserved}^{t+1} = qty_{reserved}^t + \Delta_{reserve} - \Delta_{release} - \Delta_{fulfill}$$

Shortage exceptions flag affected RO allocations when a physical count finds less stock than reserved demand — the shortage is recorded truthfully and the RO is flagged for manual review and customer notification, not silently adjusted.

**Financial conservation gate**: every line must carry one of C / W / I / G. The master total is the invariant:

$$\large C + W + I + G = Master\ Total$$

Any line without a pay type is a schema-level error, not a workflow opinion. Anything that breaks this is caught at the data level.

---

## Capacity Separation — Installed vs. Bookable vs. Protected

The project separates three concepts that most shop software collapses into one:

$$\large C_{installed} = \sum_{techs} daily\_productive\_hours$$

$$\large C_{bookable} = C_{installed} \cdot booking\_target\_percent$$

$$\large C_{protected} = C_{installed} - reserve\_hours$$

- **Installed capacity** is the physical reality — the productive hours the techs can actually put in.
- **Booking target** is a management policy — what percent of installed capacity you aim to book. Setting it to 100% is a choice, not a law. A shop that sets booking_target_percent = 100% with no reserve is trading W and R for apparent utilization.
- **Reserve hours** are deliberate inefficiency — idle capacity held so a late vehicle or an overrun doesn't cascade into the next day's 약속. Reserve *reduces* utilization by construction; it is there to reduce W (wait days) and R (comeback/overbook rework). A shop that measures utilization without measuring reserve is optimizing a number at the expense of the actual loop.

The project's code materializes this directly:

```
server.py — bookable = daily_capacity_hours * booking_target_percent / 100 - reserve_hours
```

That is not documentation. That is the equation in the behavior.

---

## The C/W/I/G Model — Line-Level Payer Assignment

Each line item on an RO carries one pay-type tag. The tag is a classification of *who absorbs the cost*, not a modifier of the line's cost. The four slices are:

- **C (Customer Pay)** — the customer is paying for this line. This is what gets invoiced. For B2B/fleet customers, the Fleet Unit # and Customer PO # are mandatory before Invoiced — that gate is on the C portion, because it's the only slice billed to an external payer with a PO structure.
- **W (Warranty)** — the money comes from a warranty payer — manufacturer, third-party, extended warranty. Warranty work typically requires authorization before it proceeds, which is why the status vocabulary has a distinct authorization hold state.
- **I (Internal)** — the shop absorbs the cost. Comebacks, warranty denial fallout, shop mistakes, training/lab time, internal service. I is a real cost the shop needs to see at the RO level so it knows what it's eating on a given job. I is not the same as a discount on a C line — a discount is still a C line at a lower price; I means the customer is not the payer at all.
- **G (Goodwill)** — intentional relationship expenditure, with a narrative. G and I both end up as shop cost, but they carry different accounting narratives: I is "we had to eat this," G is "we chose to give this." That distinction matters for management review, for tax treatment in some jurisdictions, and for the story the advisor tells the customer.

**Why line-item level, not RO level**: a single line has a single payer. A brake-pad replacement is either warranty stock or it isn't; the labor is either warranty time or customer-pay time. The pay type attaches to the line because that's the granularity at which the reality exists. The RO-level subtotals are aggregations upward from that truth. The advisor makes the pay-type decision *while writing the line*, not after — the C/W/I/G subtotals update live, and reclassifying after the fact is extra motion.

**What the tag is not**: not a price modifier (the labor/parts value doesn't change based on the tag — rate rules are a separate decision); not a discount (a discount reduces a C line's price; G is a whole line the customer doesn't pay for); not a tax bucket by itself (tax treatment is a separate concern wired through tax_profiles / tax_rules and the shop's jurisdiction config; the pay type informs which slices are customer-facing and therefore taxable in the usual sense, but it isn't the tax engine).

---

## Conservation Laws as Workflow — The Underlying Pattern

The project's deeper design move is to treat conservation laws not as accounting constraints but as *workflow gates*. The way the system behaves is dictated by what must be true for the numbers to be true:

- **Financial conservation** → every line must have a pay type; master total is C+W+I+G.
- **Capacity conservation** → booking fails if projected hours exceed bookable minus reserved, unless carry-over is declared.
- **Inventory conservation** → on-hand and reserved are separate sub-ledgers; counter sales can't touch reserved, RO applications can't touch on-hand directly.

These are the invariants. The workflow follows from them, not the other way around. When a shop's DMS behavior is built around the invariants instead of around "what reports look nice," the system stops lying to the people running it.

---

## The Dispatch / Advisor Separation — Where Information Lives

The project recognizes that not every role needs every calculation:

- The advisor sees promised time and workload — enough to write the RO without breaking the promise — but not the full must-start computation.
- The dispatch role sees the calendar-aware must-start calculation, which is reserved for dispatch and only shown when active. For each RO, there is a latest feasible start time $T_{start}^{max}$ such that $T_{start} + T_{duration} \leq T_{promised}$. Dispatch acts on that; the advisor doesn't need to.

This is an information-design decision: show each role the minimum information that lets them do their job without breaking the next role's job. Over-sharing creates noise; under-sharing creates handoff failures. The project's stance is that the boundary between advisor and dispatch is a real boundary, and the UI should honor it.

---

## Self-Observation — The System Should See Its Own Waste

Even in PoC form, the project embeds a surprising amount of self-observation:

- **Audit events** (277 rows) — actor, action, subject type/id, details JSON, timestamp. Every write path leaves a trail. This is the raw material for "who did what to whom and when," which feeds both financial audit (reconcile I/G lines to actors) and operational review (comeback rate per tech).
- **Incident logging** — the system's own failures, the gap between what the workflow promised and what it delivered. Each incident is a data point in M (UI mismatch → motion/searching), W (workflow blocked → wait), R (data corruption/mispost → rework).
- **Health checks** — pass/warning/error gates. The system has a notion of "healthy" and can observe when it isn't.
- **UI conformance scoring** — an 117-control, 67-key-handler scan that measures its own interface consistency against its own keyboard contract. A falling conformance score is a signal that motion waste is creeping back in — the UI is drifting from what it promised to be.
- **Performance monitoring** — browser-side responsiveness + `/api/perf/log` endpoint. Stress-test intent is documented: open 50 ROs, 200 customers, 500 parts, watch the search/index performance.

The self-correction loop is the intended mature state, articulated as:

$$\large System\ State_{t+1} = f(System\ State_t, Observed\ Waste_t, Correction_t)$$

Observed waste → classified as M/W/R → correction → re-measure. The PoC has the *data layer* for this loop (audit, incidents, health, conformance) but not the *closed-loop correction*. The philosophy is that a throughput-first system should eventually reduce its own waste, not just let a human read the trail and decide.

---

## The Omissions Are Deliberate

The gaps in the PoC are not accidents; they are the boundaries of the experiment:

| Omitted | Why — the boundary being drawn |
|---|---|
| Automated test suite | PoC validates UX flow, not regression safety |
| Migration / schema versioning | SQLite schema lives in one file — alter by hand at this stage |
| Multi-shop / multi-tenant | Single-shop sovereignty was the design constraint |
| OEM repair data integration | PartsTech spec exists but isn't wired — the workflow hypothesis doesn't depend on it yet |
| Audit trail immutability | Incident logs exist; tamper-evidence isn't built |
| Offline-first conflict resolution | Single-user PoC assumption |
| Accessibility (screen readers, high-contrast) | Keyboard-first ≠ accessible — admitted honestly |
| Installer / auto-update pipeline | `launch.sh` is the "installer" |
| Observability / structured logging | `console.log` / `print()` only — acknowledged as a gap |

The honesty here is part of the insight: **this is a structured experiment that proves the hypothesis is testable.** It does not pretend to be a product. The COVERPAGE says: *"The code is messy. The architecture has seams. The test coverage is zero. But the workflow works. That is the only metric that matters at this stage."* And: *"Do not ship this code. Ship the insight it validates."*

---

## The Mature-State Picture This Points Toward

The experiment's implied mature-state architecture separates concerns cleanly:

- **Frontend owns workflows** — keyboard-first navigation, warp jumps, typeahead, optimistic UI, workspace state, ESC return stack. The workflow layer evolves without destabilizing the accounting layer.
- **Backend owns invariants** — C+W+I+G conservation, capacity conservation, inventory conservation, audit trail, financial gates. The backend's job is to enforce what must be true.
- **They share only the schema/API boundary** — the GraphQL or REST surface is the contract, not a shared codebase.

The schema is designed to be large enough to carry the real shop's complexity (NHTSA reference DB separate from operational DB, versioned setup resolver, effective-dated tax profiles, customer rate contracts, capacity policies with booking target and reserve, technician operational profiles, skills, certifications, fee rules, deposit accounts with immutable transactions, transaction-side calculation snapshots) and small enough to stay one shop's problem. The multi-shop / multi-tenant step is explicitly future — the experiment's constraint is single-shop sovereignty, and the decision is deliberate.

---

## The Portable Artifact

What survives independent of the codebase:

1. **The throughput worldview** — Ei = V / (M + W + R), with M, W, R as separable, nameable terms.
2. **The design filter** — every feature must eliminate motion, name/prevent wait, or catch rework at the earliest possible point. If it can't answer one, it's suspect; if it answers none, it's a deletion candidate.
3. **The capacity separation model** — installed vs. bookable vs. protected, with booking target and reserve as management policies layered on top of physical capacity, not as the capacity itself.
4. **The C/W/I/G line-level payer model** — pay type as classification of who absorbs cost, at line-item granularity, not as a price modifier or discount. The master total is the invariant.
5. **The status vocabulary** — named wait states (Hold — Authorization, Hold — Parts) that let a shop name and measure its waits instead of burying them inside "in progress."
6. **Conservation-law-as-workflow** — financial, capacity, and inventory conservation enforced as workflow gates at the earliest failure point, not as post-hoc accounting.
7. **The advisor/dispatch information boundary** — each role sees the minimum needed to do its job without breaking the next role's job.
8. **Self-observation as a first-class layer** — audit trail, incident logging, health checks, UI conformance scoring, performance monitoring. The system should see its own waste.
9. **The self-correction loop framing** — observed waste → classify as M/W/R → correct → re-measure. The data layer is needed before the loop can close.
10. **The honesty about scope** — a throughput-first design can be tested before it's production-ready; the insight is the artifact, not the code.

---

## How to Use This Outside the Codebase

This document is the portable layer. It can inform:

- A spec for a new build that carries the throughput-first design without carrying TaktRO's code.
- A teardown of the incumbent DMS paradigm — the incumbent has its own motion/wait/rework profile; this document gives you the vocabulary to name it.
- A pilot design doc — what to measure, what gates to build, what waits to name, what conservation laws to enforce.
- A pitch that talks about throughput and waste, not features and screens.
- A post-mortem framework — when a shop's DMS fails, classify the failure as M, W, or R and ask which term the system was blind to.

The experiment's verdict — that the hypothesis is testable and the workflow works — is the durable claim. Everything else in the codebase is the scaffolding for proving it.
