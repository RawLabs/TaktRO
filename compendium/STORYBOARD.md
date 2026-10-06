# TaktRO — Visual Workflow Storyboard (One-Page PoC → Open Future)

> Historical concept document from August 2026. Some architecture and test-status descriptions below predate the current implementation. See the [current README](../README.md) and [portfolio demo](PORTFOLIO_DEMO.md) for the published source and verified workflow.

> For delivery as a visual walkthrough / animation. Each block is a frame. Leave room between frames for motion — this is a story about *waste leaving the system*, not a feature list.

---

## Frame 0 — The Shop Floor, Unfiltered

A car comes in. Advisor greases their hands. Stands at a screen.

What happens between *"this vehicle needs work"* and *"the RO is written, the appointment is booked, the part is reserved"*?

The answer is **motion**, **waiting**, and **rework** — and most shop software doesn't name any of them. It just grows.

TaktRO's first frame is simple: **name the waste before you pretend it doesn't exist.**

Animation idea: a single car entering a bay; the advisor's hands; the screen; the subtle wasted motion — a menu opened and closed, a record re-found, a form re-entered, a wait hidden inside "in progress." Label the waste, don't hide it.

---

## Frame 1 — The Throughput Equation

$$\large E_i = \frac{V}{M + W + R}$$

Three terms below the line:

- **M — Motion**: menu hunting, mouse travel, visual scanning, re-finding records, re-entering data.
- **W — Waiting**: Hold — Authorization, Hold — Parts, waiting for a tech slot, waiting for a PO, waiting for a promised part that isn't on hand.
- **R — Rework**: comebacks, denied warranty flipping to internal, misdiagnosis, duplicate entry, a job done twice.

One term above the line:

- **V — Value-adding work**: wrench time, write-up completion, part applied, invoice posted.

The joke in the README — the ideal state approaches π — is not a joke about math. It's a joke about the fact that the target is irrational and unreachable, but *measurable enough to start a conversation*.

Animation idea: the equation appearing one term at a time. As each term below the line is named, show the wasted motion/wait/rework leaving the shop floor — fading out, shrinking. The line above (V) stays. The frame ends with the equation alone, and the promise: **measure each term separately; reduce each term separately.**

---

## Frame 2 — Motion Reduction: One Keystroke to Anywhere

The advisor needs to get to the RO board, the appointment board, the customer directory, the vehicle lookup, the parts workspace, the history, the settings, the job codes, the staff screen.

Most DMS: menus. Submenus. Search. Click. Wait for the screen to load. Find the right item. Click again.

TaktRO: **one key, one destination.**

From the dashboard:

```
O — Repair Orders Board
A — Appointment Booking
C — Customer Directory
V — Vehicle & Equipment Lookup
P — Parts & Inventory
H — Repair Order History
S — Shop Settings
J — Job Op Code Catalog
M — Staff & Access
ESC — Lock Session
```

From anywhere, `Shift+Key` warps instantly to another screen, **caching the active form state** before jumping. Press `ESC` and you return to the exact previous location, input restored.

Animation idea: a hand at the keyboard. One keypress. The screen wipes to the destination. No menu tree, no loading spin, no re-entry. `Shift+Key` cross-cut to another workspace. `ESC` returns, and the previously-typed input is still there. The motion waste — the hunting, the scrolling, the clicking — is visibly gone.

The underlying claim: **keyboard-first is not a power-user feature for people who like shortcuts. It is a motion-reduction move for people whose hands are busy and whose screens are greasy.**

---

## Frame 3 — Uppercase, Readable from Arm's Length

All text entry normalizes to uppercase at the input layer.

Not an aesthetic choice. A shop-floor readability choice: the advisor is standing back from the screen, under shop lighting, with shop-grease on their hands, and they need to read the screen at arm's length.

Animation idea: typed text flowing in, lowercase converting to uppercase at the input boundary. The screen showing clear, high-contrast uppercase where a greasy-screen misread would have been costly. The point: **reduce visual misread as a form of motion waste.**

---

## Frame 4 — Waits, Named

A repair order goes through states. Most shop software gives you "open," "in progress," "closed," and buries the delay inside the labels.

TaktRO names the wait:

```
Write-Up          — work being quoted / prepared
Hold — Authorization — waiting for sign-off, warranty auth, policy confirmation
Ready to Dispatch — authorized and quoted; pending tech capacity
In Progress       — tech started work; shift to time tracking
Hold — Parts      — paused for parts arrival; reservation is active, RO blocked
Work Complete     — labor done; awaiting QC / invoicing
Invoiced          — billing finalized; transactional record immutable
```

The wait states are explicit so they can be **seen**, and once seen, they can be **measured** and **reduced**. A shop that can't name its waits can't reduce them; it can only "improve throughput" in the dark.

Animation idea: an RO card moving through states. When it hits `Hold — Authorization`, a visible pause tag appears with the reason. When it hits `Hold — Parts`, the reservation line lights up and the RO is blocked — the promised part that isn't on hand is caught, not silently consumed. The waits are visible as *named* things, not fog.

---

## Frame 5 — The Parts Reservation Integrity

A counter sale happens. A part is applied to an RO. A stock count is done.

Three movements; two separate ledgers.

- **Counter sale** → reduces `qty_on_hand` only.
- **RO part application** → reserves stock; `qty_reserved` goes up; available goes down.
- **Cycle count** finds physical < reserved demand → records the truthful shortage; flags affected RO allocations as **Shortage Exception**; requires manual review and customer notification.

The two sub-ledgers are independent by construction so a quick sale can't silently eat stock committed to an active job. The conservation equation holds:

$$\large qty_{on\_hand}^{t+1} = qty_{on\_hand}^t + \Delta_{receive} - \Delta_{counter\_sale} - \Delta_{consume}$$

$$\large qty_{reserved}^{t+1} = qty_{reserved}^t + \Delta_{reserve} - \Delta_{release} - \Delta_{fulfill}$$

Animation idea: a parts workspace with two stacked bars — on-hand and reserved. A counter sale drops the on-hand bar. An RO application lifts the reserved bar and lowers the available gap. A cycle count shows a shortage — the reserved bar is taller than the physical bar — and the affected RO lights up with a shortage flag, waiting for review. The two ledgers never cross; the integrity is visible.

---

## Frame 6 — Capacity: Installed, Bookable, Protected

A shop has real productive hours. It also has a management number it wants to book to. And it has a reason to hold some capacity in reserve.

TaktRO separates them:

```
C_installed  = sum of technician daily productive hours
C_bookable   = C_installed × booking_target_percent
C_protected  = C_installed − reserve_hours
```

The booking form validates: **estimated hours must not exceed bookable minus reserved**, unless the booking is explicitly marked as carry-over / overnight.

That is the conservation law enforced as workflow:

$$\large C_{bookable} - C_{reserved} - C_{booked} \geq 0 \quad \text{(unless carry-over declared)}$$

A shop that sets `booking_target_percent = 100` with no reserve is trading wait and rework for apparent utilization. The system doesn't stop the shop from making that choice — it makes the choice **visible** and **declared**. Overbooking is blocked unless you explicitly mark it carry-over. You can push past bookable, but you have to say so, and the system makes the push visible.

Animation idea: a capacity bar representing installed hours. A bookable overlay (target percentage). A reserved slice held back (amber). A booking attempt that exceeds bookable minus reserved bounces, unless a carry-over flag is explicitly flipped — then it goes through with a visible "carry-over / overnight" tag. The point: **the shop's utilization target is a management policy, not the capacity itself, and the reserve is deliberate inefficiency that buys wait and rework reduction.**

---

## Frame 7 — One RO, Four Payers: C / W / I / G

A vehicle comes in. The same vehicle, the same RO, can carry four payer slices at once:

```
C — Customer Pay        (the customer is paying; this is what gets invoiced)
W — Warranty            (manufacturer / third-party / extended warranty; needs authorization)
I — Internal            (the shop absorbs the cost: comebacks, warranty denial fallout, mistakes, training)
G — Goodwill            (intentional relationship spend, with a narrative)
```

Each line item carries one pay-type tag. The tag is a classification of **who absorbs the cost**, not a modifier of the line's cost. The labor and parts value of the line do not change based on the tag — rate rules are a separate decision.

The financial conservation equation holds:

$$\large C + W + I + G = Master\ Total$$

The customer invoice is only the **C** slice. The shop sees the full picture: the C slice it bills, the W slice it will chase reimbursement on, the I slice it's eating, the G slice it chose to give. A shop that only looks at C sees revenue; a shop that sees all four sees whether the job is actually producing throughput or just consuming operational expense.

Animation idea: a single RO card splitting into four color-coded lanes as line items are added — C, W, I, G. Each lane has its own subtotal. A W line waiting on authorization shows a "Hold — Authorization" tag. A W line that gets denied flips to I — the throughput expectation becomes operational expense, and the shop sees the delta. A G line shows a waiver narrative. The card ends with the master total and the customer-facing invoice as only the C slice. The point: **one vehicle, four payers, one RO, no fracturing into separate records.**

---

## Frame 8 — Rework Caught at the Earliest Failure Point

Rework is expensive because it is physical: the vehicle comes back, the tech is back, the bay is occupied again, the customer experience is degraded.

TaktRO doesn't promise to eliminate rework — nothing does. It builds gates that catch the failure at the earliest possible point:

- **Capacity gate**: booking fails if projected hours exceed bookable minus reserved, unless carry-over is declared.
- **Promise protection**: promised time is calculated against real capacity, not a target. Technician workload is visible during planning. The "Hold — Parts" status blocks the RO until parts arrive.
- **Parts shortage**: a physical count that finds less than reserved demand records the truthful shortage and flags affected RO allocations — the shortage propagates to the RO as named wait and possible rework, not silently adjusted.
- **Financial conservation**: every line must carry a pay type; the master total is the invariant. A line without a pay type is a schema-level error, not a workflow opinion.

Animation idea: a write-up moving forward; at each gate, if the condition fails, the workflow stops with a named, actionable error ("Overbooked by X hours unless carry-over," "Missing PO for fleet invoice," "Shortage exception on reserved part"). The gate is not a vague block — it says what failed and what to do. The point: **catch the failure where it is cheapest to fix it, not after the invoice is posted.**

---

## Frame 9 — Advisor / Dispatch: Where Information Lives

Not every role needs every calculation.

- The **advisor** sees promised time and workload — enough to write the RO without breaking the promise. The advisor does **not** see the full must-start computation.
- The **dispatch** role sees the calendar-aware must-start calculation — for each RO, the latest feasible start time $T_{start}^{max}$ such that $T_{start} + T_{duration} \leq T_{promised}$. Dispatch acts on that. The advisor doesn't need to.

This is an information-design decision: **show each role the minimum that lets them do their job without breaking the next role's job.** Over-sharing creates noise; under-sharing creates handoff failures. The boundary between advisor and dispatch is real; the UI honors it.

Animation idea: the advisor screen showing promised time and the booking workload. The dispatch screen, separately, showing the must-start timeline — the latest start time for each RO, the calendar-aware constraint. A switch cuts between the two, showing that the same RO is visible to both, but each sees what they need. The point: **information has a home, and the home is the role that uses it.**

---

## Frame 10 — The System Sees Its Own Waste

Even in PoC form, TaktRO embeds a surprising amount of self-observation:

- **Audit events** — actor, action, subject, details, timestamp. Every write path leaves a trail. This is the raw material for "who did what to whom and when" — which feeds financial audit (reconcile I/G lines to actors) and operational review (comeback rate per tech).
- **Incident logging** — the system's own failures, the gap between what the workflow promised and what it delivered. Each incident is a data point in M (UI mismatch → motion/searching), W (workflow blocked → wait), R (data mispost → rework).
- **Health checks** — pass/warning/error gates. The system has a notion of "healthy" and can observe when it isn't.
- **UI conformance scoring** — the interface is scanned against its own keyboard contract. A falling score is a signal that motion waste is creeping back in — the UI is drifting from what it promised to be.
- **Performance monitoring** — browser-side responsiveness plus `/api/perf/log`.

Animation idea: a small diagnostic pane appearing beside the main workflow — audit trail scrolling, incidents being captured, health status flashing green/amber/red, conformance score ticking, performance monitor showing responsiveness. The workflow keeps running; the system is quietly observing itself. The point: **a throughput-first system should see its own waste, not just let a human read the trail and decide.**

---

## Frame 11 — The Self-Correction Loop (Where the PoC Points)

The PoC has the data layer for a loop it hasn't closed yet:

$$\large System\ State_{t+1} = f(System\ State_t, Observed\ Waste_t, Correction_t)$$

The loop:

1. **Observe** — audit events, incidents, health checks, conformance scoring, performance monitoring.
2. **Classify** — which term is this? M (motion), W (wait), R (rework)?
3. **Correct** — the smallest targeted fix that restores correct behavior.
4. **Re-measure** — did the term move? Which way?

The mature-state aspiration: **the system eventually reduces its own waste, not just lets a human read the trail and decide.** The PoC validates that the terms are nameable and the data is carryable; the closed-loop correction is future work.

Animation idea: a loop graphic — observe → classify → correct → re-measure — cycling. Each cycle, one of the M/W/R bars shrinks a little. The frame ends with the loop spinning and the question hanging: **what happens when the system starts reducing its own waste?**

---

## Frame 12 — What the PoC Does Not Pretend to Be

Honesty is part of the insight.

The TaktRO PoC:

- Has **no automated test suite** — it validates UX flow, not regression safety.
- Has **no migration / schema versioning** — the SQLite schema lives in one file; alter by hand at this stage.
- Is **single-shop, single-user** by design — multi-shop / multi-tenant is future, not now.
- Has the **PartsTech spec** for OEM integration but it is **not wired** — the workflow hypothesis doesn't depend on it yet.
- Has **incident logs** but **no audit trail immutability** — tamper-evidence is future.
- Is **keyboard-first, not accessible** — admits that honestly.
- Has **`launch.sh` as its installer** — no real installer / auto-update pipeline yet.
- Has **`console.log` / `print()` only** — no structured logging, acknowledged as a gap.

These are boundaries, not accidents. The experiment's verdict: **the hypothesis is testable, the workflow works, the code is messy, the seams are visible, and the test coverage is zero — but that is the only honest state for this stage.**

Animation idea: a checklist with the gaps appearing one by one, not as failures but as boundaries. The frame closes on the COVERPAGE line: *"Do not ship this code. Ship the insight it validates."*

---

## Frame 13 — The Open Future

What survives, independent of the codebase:

1. **The throughput worldview** — `Ei = V / (M + W + R)`, with M, W, R as separable, nameable terms.
2. **The design filter** — every feature must eliminate motion, name/prevent wait, or catch rework at the earliest point. If it can't answer one, it's suspect. If it answers none, it's a deletion candidate.
3. **The capacity separation model** — installed vs. bookable vs. protected, with booking target and reserve as management policies layered on physical capacity, not as the capacity itself.
4. **The C/W/I/G line-level payer model** — pay type as classification of who absorbs cost, at line-item granularity; the master total as the invariant.
5. **The status vocabulary** — named wait states that let a shop name and measure its waits.
6. **Conservation-law-as-workflow** — financial, capacity, and inventory conservation enforced as workflow gates at the earliest failure point.
7. **The advisor/dispatch information boundary** — each role sees the minimum needed to do its job without breaking the next role's job.
8. **Self-observation as a first-class layer** — audit, incidents, health, conformance, performance. The system should see its own waste.
9. **The self-correction loop** — observed waste → classify → correct → re-measure. The data layer is needed before the loop can close.
10. **The honesty about scope** — a throughput-first design can be tested before it's production-ready; the insight is the artifact, not the code.

The future is open in more than one direction:

- **TaktRO becomes the product** — close the gaps: tests, concurrency, installer, audit immutability, OEM wiring, accessibility. The skeleton is there; the body is not.
- **The insight migrates into another build** — someone carries the capacity separation, the C/W/I/G line-level model, the keyboard-first warp navigation, the conservation-law workflow gates, and the self-observation layer into a different codebase. The insight is the durable artifact.
- **The insight stays in the documents** — the design philosophy, the math framings, the workflow reasoning, the status vocabulary, the conservation equations. These are standalone artifacts that can inform a spec, a pitch, a teardown of the incumbent paradigm, without this codebase ever running on a shop floor.

Animation idea: three paths fanning out from the PoC — product, insight-migration, documents. Each path has its own horizon. The frame ends with the PoC as one point on a larger map, and the claim that the durable artifact is the insight, not the code.

---

## Closing Frame

A shop advisor greases their hands. Stands at a screen. Presses one key and arrives.

The waste — motion, waiting, rework — is named. The waits are visible. The gates catch failure early. The parts ledgers stay independent. The capacity is separated from the booking target. The RO carries four payers at once. The system sees itself.

The throughput changes.

And the future — product, or migrated insight, or documents — is still being written.

---

*This storyboard is a visual walkthrough of the TaktRO experiment's throughput-first philosophy, designed to be presented frame-by-frame with motion between frames. The durable artifact is the insight — the codebase is the scaffolding that proved it testable.*
