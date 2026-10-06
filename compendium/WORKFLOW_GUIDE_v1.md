# TaktRO Operational Workflow Guide v1.0

**Purpose:** This document serves as the definitive guide for using and understanding the TaktRO Shop Management System. It translates core operational processes into structured workflows, balancing technical rigor (for administrators and developers) with clear instructions (for shop advisors).
***
## ⚙️ I. Executive Summary & Philosophy
### A. The Core Problem: Advisor Throughput
TaktRO is architected around one primary principle: **maximizing advisor throughput**. Every design choice—from the keyboard-first hotkey system to the separated financial ledgers—aims to minimize non-value-add activities (e.g., unnecessary decision points, searching for physical paperwork).

**Key Architectural Separation:**
*   **Operational Flow (`taktro.db`):** Contains ephemeral, high-transaction data (current RO line items, appointments, status). Designed for speed and concurrent use (SQLite WAL mode).
*   **Reference Data (`nhtsa_reference.db`, etc.):** Static or slow-changing historical data (NHTSA records, shop job codes, manufacturer bulletins). This separation keeps the core transactional database lightweight and fast.

### B. Operational Status Vocabulary
Understanding the status of a Repair Order (RO) is critical to understanding flow:
| Status | Meaning for Advisor | Technical Implication | Color Code |
| :--- | :--- | :--- | :--- |
| **Write-Up** | Work is being quoted/prepared. | Transactional state; amounts are preliminary estimates, not committed charges. | Amber (`#d9a74a`) |
| **Hold — Authorization** | Waiting for a client sign-off or policy confirmation (e.g., Warranty). | Requires manual approval or manager override to proceed past this point. | Yellow/Amber tint |
| **Ready to Dispatch** | All necessary work is authorized and quoted; ready for the tech bay. | The financial quote (`C+W+I`) is finalized and pending assignment of labor capacity. | Green/Teal (`#62d6b2`) |
| **In Progress** | Technician has started work on the vehicle. | Shifts operational focus from quoting to time tracking against allocated labor hours. | Cyan Outline (`#5ecfe3`) |
| **Hold — Parts** | Work is paused pending arrival of required parts inventory (Inventory Reservation). | The RO status is blocked until parts are received and linked via `[Alt+P]`. | Yellow/amber tint |
| **Work Complete** | All labor tasks are finished, awaiting final quality control or invoicing. | Requires mandatory sign-off/QC check before the billing module can finalize the transaction. | Green/teal (`#62d6b2`) |
| **Invoiced** | Billing is finalized; payment recorded against a specific Customer PO # or Fleet Account. | The transactional record is immutable (archived). | N/A |

***
## 🚀 II. Core Workflow Modules & User Flow (The Shop Advisor Journey)

The primary workflow involves the interaction between three core domains: **Customer $\rightarrow$ Vehicle $\rightarrow$ Appointment $\rightarrow$ Repair Order (RO)**.

### A. Module 1: Customer Directory (`Shift+C`)
**Goal:** Establish a canonical record for the vehicle owner or account entity.
*   **Technical Flow:** The system uses typeahead search against `Name`, `Phone`, `Email`, or linked `Plate` to identify an existing customer card.
*   **Data Points:** Captures both individual identity (Owner Name, Contact Person) and organizational context (`Company/Fleet Name`, `Account Type`: RETAIL, FLEET, COMPANY).
*   **Critical Feature: Fleet Unit # & PO Gate:** For B2B customers, the **Fleet Unit #** and **Customer PO #** are mandatory inputs. The system enforces a write-gate requiring these fields to be populated before an RO can be marked `INVOICED`, ensuring financial auditability against pre-approved billing structures.

### B. Module 2: Vehicle Directory (`Shift+V`)
**Goal:** Establish the specific physical asset (Vehicle or Equipment) that requires service.
*   **Asset Scope:** The system tracks four distinct, independent assets types: Automotive Vehicles (VIN required), Shop Fleet Assets (loaners/runners), Customer Equipment (generators/machinery), and permanent Shop Tools.
*   **Automotive Workflow (NHTSA Integration):**
    1.  User enters Year/Make/Model $\rightarrow$ System queries NHTSA Live API for recalls.
    2.  System searches the local, indexable `nhtsa_reference.db` for TSBs and Manufacturer Communications (MC).
    3.  *Technical Note:* The system distinguishes between a **Safety Recall** (live query) and a **Manufacturer Communication/TSB** (local archive search). A TSB is an advisory bulletin, not a guarantee of required repair or warranty coverage; the VIN must be verified against both sources.

### C. Module 3: Appointment Booking (`Shift+A`)
**Goal:** Schedule service time and calculate initial capacity constraints.
*   **Process Sequence (The "Write-Up" Precursor):**
    1.  User selects/creates Customer $\rightarrow$ User selects/creates Vehicle linked to that Customer.
    2.  System calculates the **Promised Time (PT)**, which is dynamically influenced by shop operating hours and current booked workload.
    3.  The Booking form validates: *Estimated Hours* must not exceed `Configured Capacity - Reserved Time`. If it does, the booking fails unless marked as **Carry-over/Overnight**.

### D. Module 4: Repair Order Write-Up Editor (`Shift+O`)
**Goal:** Convert the booked appointment into a billable, actionable service record (the RO). This is the system's core module.
*   **The Transactional Engine:** The process uses real-time data calculation to populate line items and totals.
    1.  **Line Item Entry (`Alt+A`):** User selects an Op-Code using typeahead search against the 80 defined house codes (e.g., `MA-OIL-SERV`). This auto-populates Description, Standard Hours, Parts $, and Labor $.
    2.  **Financial Allocation:** For each line item, the user must designate a pay type: **Customer (`C`)**, **Warranty (`W`)**, **Internal (`I`)**, or **Goodwill (`G`)**. *Technical Note:* This is purely an accounting tag; it does not alter the actual cost/value of the service.
    3.  **Financial Aggregation:** The system provides immediate, dynamic subtotals: Line Total (Parts + Labor), C/W/I/G Subtotals, and the Master RO Total ($\sum$ all line totals).
*   **The Parts Integration (`Alt+P`):** When parts are added to the RO line item, the system executes a **Reservation Transaction**. The `available quantity` is reduced by `quantity_reserved`, protecting it from subsequent counter-sales.

### E. Module 5: Parts & Inventory Control (`Shift+P`)
**Goal:** Manage physical stock and reconcile discrepancies between digital record and reality.
*   **Atomic Counter Sale (O-T/C):** Allows for over-the-counter cash sales, which must validate unreserved stock against the current physical count before committing to a single transaction ID (`INV-OTC-...`). This sale **only** reduces `quantity_on_hand`, leaving reserved RO allocations untouched.
*   **Cycle Counting:** When a manager performs a physical cycle count and discovers shortages (Physical Count < Reserved Demand), a critical workflow is triggered:
    1.  The system records the **truthful physical shortage**.
    2.  It retains the original reservation demand, flagging all affected RO allocations as **Shortage Exception**, requiring manual review and potential customer notification.

***
## 💻 III. Technical Deep Dive & Architecture (For Developers)

### A. Data Model Persistence Layer
| Component | Database/Schema | Purpose / Scope | Write Transaction Type |
| :--- | :--- | :--- | :--- |
| **Primary DB** | `taktro.db` (SQLite WAL) | All real-time operational data: ROs, Customers, Appointments, Staff Access Exceptions. High write concurrency required. | ACID Transactions |
| **Reference DB** | `nhtsa_reference.db` (SQLite) | Historical/Static external data: NHTSA TSB archives and Manufacturer Communications metadata. Read-only for core operations; read-write only for Manager Indexing. | Idempotent Upsert (on refresh) |
| **Configuration Schema** | `taktro.db` (`setup/schema.*`) | Global system parameters: Tax rates, labor base rates, tax jurisdictions, job code definitions (`GROUP-SYSTEM-ACTION`), company flags (e.g., Canadian legal requirements). | Versioned Publish/Drafting Model |

### B. Technical Principles
1.  **Transaction Integrity:** All complex financial actions (RO Write-Up save, Counter Sale) must complete in a single atomic SQLite transaction. The failure of any sub-component (e.g., reservation fails, tax calculation fails) MUST roll back the entire operation.
2.  **Data Separation for Reliability:** The use of separate physical domains (`customers/`, `vehicles/`, `parts/`) minimizes cross-dependency risks and allows modules to be versioned and deployed independently without breaking the core transaction path.

### C. Service Layer Boundaries (APIs)
The system exposes dedicated APIs corresponding to its major services:
*   `POST /api/customers`: Creates or updates customer master records. Handles PIN hashing (`PBKDF2`) and validation.
*   `GET /api/vehicles/{vin}`: Core lookup service. Orchestrates calls to NHTSA API (live) and local TSB index search.
*   `POST /api/ro/lines`: Adds a single line item. Requires inputs for Op-Code, Hours, Parts, and Pay Type; returns calculated C/W/I/G component values.
*   **Key Boundary Concept:** The `POST /api/parts/counter-sale` endpoint is isolated from the RO reservation logic to ensure that quick sales do not compromise inventory integrity required by active jobs.

***
## 🛠️ III. Operational Protocols & Edge Cases

### A. System Lifecycle Management (The "Setup" Process)
Before a shop can operate, two key setup wizards must be run:
1.  **Staff Access:** An Administrator seeds the initial employee profiles and sets default position templates (`Advisor`, `Technician`, etc.). Custom permissions are stored as *exceptions* to the base template, ensuring that future template updates do not silently revoke necessary access.
2.  **Shop Configuration:** Managers set global rates (labor rates per type), tax jurisdictions (GST/HST/Provincial breakdown), and operational rules (e.g., "A RO cannot be marked Invoiced if PO # is empty").

### B. Advanced Workflow: Multi-Domain Dependencies
*   **Example:** To create an Invoice, the system requires a completed **RO Write-Up** $\rightarrow$ which requires at least one **Line Item** with non-zero labor/parts $\rightarrow$ linked to a valid **Customer Master** $\rightarrow$ and must satisfy all **Financial Gate Checks** (e.g., PO # present, sufficient credit).
*   **Dependency Failure Handling:** If any gate fails (e.g., missing Tax Exempt #), the process halts at the earliest point of failure, displaying an explicit, actionable error message ("Cannot Invoice: Missing required tax jurisdiction code in setup.").

### C. Keyboard Navigation Map (The Primary Interface Contract)
| Key/Combo | Action | Module Scope | Description |
| :--- | :--- | :--- | :--- |
| `<kbd>N</kbd>` | New Repair Order | RO Board (`O`) | Starts a new write-up session, automatically setting focus to Customer search. |
| `Shift+A` / `Alt+A` | Book/Add Line Item | Appointment / RO Editor | The core entry point for adding service charges and labor time. |
| `Ctrl+[N]` | New Customer Card | Customer Directory (`C`) | Opens the full, editable customer profile form (requires unique name/contact info). |
| `Alt+P` | Apply Part to RO | RO Write-Up Editor | Triggers the inventory reservation check and adds the item to the line item list. |
| `<kbd>ESC</kbd>` | Back / Return Jump | Global | Pops the last saved form state, returning user to the previous workspace location seamlessly. |

---
***END OF WORKFLOW GUIDE v1.0***