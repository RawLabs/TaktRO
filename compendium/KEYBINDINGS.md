# TaktRO Workspace Keybindings & Keyboard Workflows

This document is the master cheat sheet for all keyboard shortcuts, navigation, and warp-jump commands inside the **TaktRO** system.

---

## 🖥️ 1. Main Dashboard Router

Use the same `Shift + Key` workspace warps from the dashboard. Plain letters are
always reserved for typing.

| Key | Action / Navigation Destination |
| :--- | :--- |
| **`Shift+O`** | Open **Repair Orders Board** |
| **`Shift+A`** | Open **Appointment Booking Board** |
| **`Shift+C`** | Open **Customer Directory** |
| **`Shift+V`** | Open **Vehicle & Equipment Lookup** |
| **`Shift+P`** | Open **Parts & Inventory Control Engine** |
| **`Shift+H`** | Open **Repair Order History & Audit Search** |
| **`Shift+K`** | Open **Vendor Directory & Contacts** |
| **`Shift+S`** | Open **Shop Settings** (Rates, Profile, Taxes, Fees) |
| **`Shift+J`** | Open **Job Op Code Catalog** |
| **`Shift+M`** | Open **Staff & Access Management** |
| **`Alt+?`** | Open **Help & Assistance Center** |
| **`ESC`** | **Lock Session** (Locks terminal immediately and displays PIN entry screen) |

---

## ⚡ 2. Global Warp Jumps (`Shift + Key`)

Use these global shortcut keys from anywhere inside the app to warp instantly to another screen. TaktRO automatically caches your active form input state before jumping.

| Warp Key | Target Workspace | Return Key |
| :---: | :--- | :---: |
| **`Shift+O`** | Repair Order Board | **`ESC`** |
| **`Shift+A`** | Appointment Booking | **`ESC`** |
| **`Shift+C`** | Customer Directory | **`ESC`** |
| **`Shift+V`** | Vehicle Lookup | **`ESC`** |
| **`Shift+P`** | Parts & Inventory | **`ESC`** |
| **`Shift+K`** | Vendor Directory | **`ESC`** |
| **`Shift+S`** | Shop Settings | **`ESC`** |

*Note: Pressing **`ESC`** (or clicking `ESC Return`) pops the memory stack and warps you straight back to your exact previous location, restoring all cached input text.*

---

## 🛠️ 3. Workspace Specific Commands

### Repair Orders Board (`O`)
- **`ALT+N`**: Open **New Repair Order Write-Up** editor.
- **`1` to `9`**: **Auto-Expand Row** by index number.
- **`ArrowDown` / `ArrowUp`**: Focus rows.
- **`Enter ↵`**: Open focused repair order.
- **`ESC`**: Close Board / Return to Dashboard.

### RO Write-Up Editor (`O` / `N`)
- **`ALT+G`**: **Generate RO** (promotes draft to `READY TO DISPATCH` queue and generates permanent sequential RO number).
- **`ALT+S`**: Save draft Repair Order details.
- **`ALT+A`**: Add new repair job line.
- **`ALT+P`**: Add part from inventory / Print hardcopy.
- **`ALT+C`**: Confirm & Lock Repair Order.
- **`ALT+H`**: Open RO Service History modal.
- **`ESC`**: Return to RO Board.

### Parts & Inventory Control (`P`)
- **`ALT+A`**: Open **Add Stock Inventory SKU** modal.
- **`ALT+P`**: Open **Add Pass-Through Buy-in Part** (special order) modal.
- **`ALT+I`**: Open **Invoice Counter Sale** modal.
- **`ALT+O`**: Open **Apply Part to Repair Order** line modal.
- **`ALT+R`**: Open **Quick Receive Stock** form.
- **`ALT+Q`** or **`Q`**: Open **Manual Stock Level Quantity Adjustment** modal (in part details).
- **`ALT+B`**: Open **Break Out Bulk Container Into Per-Unit Child SKU** modal (in part details).
- **`ESC`**: Return to Parts search table / Exit to Dashboard.

### Customer Directory (`C`)
- **`ALT+A`**: Open **New Customer** creation form.
- **`ALT+E`**: Edit the selected customer.
- **`ALT+S`**: Save customer profile.

### Appointments (`A`)
- **`ALT+A`**: Add appointment schedule line.
- **`ALT+C`**: Confirm appointment write-up.
- **`ALT+O`**: Convert appointment to Repair Order.
- **`ALT+H`**: Open appointment history search.
- **`ESC`**: Return to Schedule Board / Exit to Dashboard.

---

© **TaktRO Systems** — Keyboard-First Shop Execution Engine.

## 🎨 Contextual Help Modal (`?`)

Pressing **`ALT+?`** opens the Assistance Center. The system automatically reads the DOM state and places a highlighted **"YOU ARE IN: <WORKSPACE>"** cheat sheet at the top of the window displaying the most relevant quick-keys for your current view.
