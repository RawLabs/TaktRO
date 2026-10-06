"""Parts & Inventory atomic transaction service layer.

Integrity Rule: Users DO NOT directly edit qty_on_hand. Every stock movement passes
through this service inside an atomic SQLite transaction (BEGIN...COMMIT/ROLLBACK).
Invalid consumption or negative inventory requests are explicitly rejected.
"""

from __future__ import annotations

from datetime import datetime, timezone
from contextlib import nullcontext, contextmanager
import uuid
import json
import math
import sqlite3
from parts.models import part_to_dict
from parts.queries import get_part_by_id


@contextmanager
def atomic(db):
    """Serialize stock decisions; nested services must never commit their caller."""
    nested = db.in_transaction
    name = "stock_" + uuid.uuid4().hex
    db.execute(f"SAVEPOINT {name}" if nested else "BEGIN IMMEDIATE")
    try:
        yield db
        db.execute(f"RELEASE SAVEPOINT {name}") if nested else db.commit()
    except Exception:
        if nested:
            db.execute(f"ROLLBACK TO SAVEPOINT {name}")
            db.execute(f"RELEASE SAVEPOINT {name}")
        else:
            db.rollback()
        raise


def require_open_ro(db, ro_number):
    row = db.execute("SELECT * FROM repair_orders WHERE ro_number=?", (ro_number.strip().upper(),)).fetchone()
    if not row:
        raise ValueError("Repair order not found.")
    if row["status"] == "invoiced":
        raise ValueError("Posted repair orders cannot be changed.")
    return row


def whole_quantity(value):
    """Reject fractional/boolean quantities rather than silently truncating stock."""
    if isinstance(value, bool):
        raise ValueError("Quantity must be a positive whole number.")
    number = float(value)
    if not math.isfinite(number) or number <= 0 or not number.is_integer():
        raise ValueError("Quantity must be a positive whole number.")
    return int(number)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _reduce_reservation_allocations(
    db: sqlite3.Connection,
    part_id: int,
    ro_number: str,
    qty: int,
    terminal_status: str,
    now: str,
) -> None:
    """Reduce explicit reservation demand for one RO, oldest allocation first."""
    ro_ref = ro_number.strip().upper()
    rows = db.execute(
        """SELECT * FROM parts_reservations
           WHERE part_id=? AND ro_number=? AND status IN ('ACTIVE','SHORT')
           ORDER BY created_at,id""",
        (part_id, ro_ref),
    ).fetchall()
    remaining = qty
    for row in rows:
        if remaining <= 0:
            break
        requested = int(row["requested_qty"])
        fulfilled = int(row["fulfilled_qty"])
        reduction = min(fulfilled if terminal_status == "CONSUMED" else requested, remaining)
        if reduction <= 0:
            continue
        new_requested = requested - reduction
        new_fulfilled = (
            fulfilled - reduction
            if terminal_status == "CONSUMED"
            else min(fulfilled, new_requested)
        )
        status = terminal_status if new_requested == 0 else ("SHORT" if new_fulfilled < new_requested else "ACTIVE")
        db.execute(
            """UPDATE parts_reservations
               SET requested_qty=?,fulfilled_qty=?,status=?,updated_at=? WHERE id=?""",
            (new_requested, new_fulfilled, status, now, row["id"]),
        )
        remaining -= reduction
    if remaining:
        raise ValueError(f"RO {ro_ref} has only {qty - remaining} explicitly reserved units for this part; requested {qty}.")


def receive_stock(
    db: sqlite3.Connection,
    part_id: int,
    qty: int,
    cost: float | None = None,
    bin_location: str | None = None,
    reference_id: str = "",
    actor_id: int | None = None,
    notes: str = "",
) -> dict:
    """Receive inventory into stock (1-pass receiving). Increases qty_on_hand."""
    if qty <= 0:
        raise ValueError("Quantity to receive must be greater than zero.")

    now = _utc_now()
    with atomic(db):
        part = db.execute("SELECT * FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
        if not part:
            raise ValueError(f"Part #{part_id} not found.")

        prev_qty = int(part["qty_on_hand"])
        new_qty = prev_qty + qty
        unit_cost = cost if cost is not None else float(part["cost_price"])
        if not math.isfinite(unit_cost) or unit_cost < 0:
            raise ValueError("Unit cost must be a finite, non-negative amount.")
        prior_average = part["average_cost"]
        if prior_average is None:
            prior_average = float(part["cost_price"])
        average_cost = (
            ((float(prior_average) * prev_qty) + (unit_cost * qty)) / new_qty
            if new_qty else unit_cost
        )
        new_bin = bin_location.strip().upper() if bin_location and bin_location.strip() else part["home_bin"]

        db.execute(
            """
            UPDATE parts_inventory
            SET qty_on_hand=?, cost_price=?, last_cost=?, last_cost_date=?, average_cost=?, home_bin=?, updated_at=?
            WHERE id=?
            """,
            (new_qty, unit_cost, unit_cost, now[:10], average_cost, new_bin, now, part_id),
        )

        # A replacement receipt restores explicit shortages in allocation order.
        remaining = new_qty
        for allocation in db.execute("SELECT * FROM parts_reservations WHERE part_id=? AND status IN ('ACTIVE','SHORT') ORDER BY created_at,id", (part_id,)).fetchall():
            requested = int(allocation["requested_qty"])
            fulfilled = min(requested, max(0, remaining))
            remaining -= fulfilled
            db.execute("UPDATE parts_reservations SET fulfilled_qty=?,status=?,updated_at=? WHERE id=?", (fulfilled, "ACTIVE" if fulfilled == requested else "SHORT", now, allocation["id"]))

        db.execute(
            """
            INSERT INTO parts_transactions (
                part_id, transaction_type, qty_change, previous_qty, new_qty,
                reference_type, reference_id, actor_employee_id, reason_code, notes, unit_cost, created_at
            ) VALUES (?, 'receive', ?, ?, ?, 'PO', ?, ?, 'RECEIVE_INTAKE', ?, ?, ?)
            """,
            (part_id, qty, prev_qty, new_qty, reference_id, actor_id, notes, unit_cost, now),
        )

        db.execute(
            """
            INSERT INTO audit_events(actor_employee_id, action, subject_type, subject_id, details_json, created_at)
            VALUES (?, 'parts.receive', 'parts_inventory', ?, ?, ?)
            """,
            (actor_id, str(part_id), f'{{"qty": {qty}, "prev": {prev_qty}, "new": {new_qty}}}', now),
        )

    return get_part_by_id(db, part_id)


def reserve_stock(
    db: sqlite3.Connection,
    part_id: int,
    qty: int,
    ro_number: str,
    actor_id: int | None = None,
    notes: str = "",
) -> dict:
    """Reserve inventory for a Repair Order. Increases qty_reserved. Rejects if available < qty."""
    if qty <= 0:
        raise ValueError("Quantity to reserve must be greater than zero.")
    if not ro_number.strip():
        raise ValueError("Repair Order reference is required for reservation.")

    now = _utc_now()
    with atomic(db):
        require_open_ro(db, ro_number)
        part = db.execute("SELECT * FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
        if not part:
            raise ValueError(f"Part #{part_id} not found.")

        on_hand = int(part["qty_on_hand"])
        reserved = int(part["qty_reserved"])
        available = on_hand - reserved

        if qty > available:
            raise ValueError(f"Insufficient available stock. Requested {qty}, but only {available} available.")

        new_reserved = reserved + qty
        db.execute(
            "UPDATE parts_inventory SET qty_reserved=?, updated_at=? WHERE id=?",
            (new_reserved, now, part_id),
        )
        db.execute(
            """INSERT INTO parts_reservations
               (part_id,ro_number,requested_qty,fulfilled_qty,status,notes,actor_employee_id,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (part_id, ro_number.strip().upper(), qty, qty, "ACTIVE", notes, actor_id, now, now),
        )

        db.execute(
            """
            INSERT INTO parts_transactions (
                part_id, transaction_type, qty_change, previous_qty, new_qty,
                reference_type, reference_id, actor_employee_id, reason_code, notes, unit_cost, created_at
            ) VALUES (?, 'reserve', ?, ?, ?, 'RO', ?, ?, 'RO_RESERVATION', ?, ?, ?)
            """,
            (part_id, qty, reserved, new_reserved, ro_number.strip().upper(), actor_id, notes, float(part["cost_price"]), now),
        )

    return get_part_by_id(db, part_id)


def release_stock(
    db: sqlite3.Connection,
    part_id: int,
    qty: int,
    ro_number: str,
    actor_id: int | None = None,
    notes: str = "",
) -> dict:
    """Release reserved inventory from an RO. Decreases qty_reserved."""
    if qty <= 0:
        raise ValueError("Quantity to release must be greater than zero.")

    now = _utc_now()
    with atomic(db):
        require_open_ro(db, ro_number)
        part = db.execute("SELECT * FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
        if not part:
            raise ValueError(f"Part #{part_id} not found.")

        reserved = int(part["qty_reserved"])
        if qty > reserved:
            raise ValueError(f"Cannot release {qty} units; only {reserved} units currently reserved.")

        billed = db.execute("SELECT COALESCE(SUM(qty),0) FROM ro_part_charges WHERE part_id=? AND ro_number=? AND status='CONFIRMED'", (part_id, ro_number.strip().upper())).fetchone()[0]
        demand = db.execute("SELECT COALESCE(SUM(requested_qty),0) FROM parts_reservations WHERE part_id=? AND ro_number=? AND status IN ('ACTIVE','SHORT')", (part_id, ro_number.strip().upper())).fetchone()[0]
        if demand - qty < billed:
            raise ValueError("Cannot release billed parts; the confirmed RO charge still requires this stock.")
        new_reserved = reserved - qty
        _reduce_reservation_allocations(db, part_id, ro_number, qty, "RELEASED", now)
        db.execute(
            "UPDATE parts_inventory SET qty_reserved=?, updated_at=? WHERE id=?",
            (new_reserved, now, part_id),
        )

        db.execute(
            """
            INSERT INTO parts_transactions (
                part_id, transaction_type, qty_change, previous_qty, new_qty,
                reference_type, reference_id, actor_employee_id, reason_code, notes, unit_cost, created_at
            ) VALUES (?, 'release', ?, ?, ?, 'RO', ?, ?, 'RO_RELEASE', ?, ?, ?)
            """,
            (part_id, -qty, reserved, new_reserved, ro_number.strip().upper(), actor_id, notes, float(part["cost_price"]), now),
        )

    return get_part_by_id(db, part_id)


def consume_stock(
    db: sqlite3.Connection,
    part_id: int,
    qty: int,
    ro_number: str,
    actor_id: int | None = None,
    notes: str = "",
    is_ro_consumption: bool = True,
    manage_transaction: bool = True,
) -> dict:
    """Consume part stock. For RO consumption, decreases both qty_on_hand and qty_reserved. For OTC counter sales, decreases only qty_on_hand from unreserved stock."""
    if qty <= 0:
        raise ValueError("Quantity to consume must be greater than zero.")

    now = _utc_now()
    with (atomic(db) if manage_transaction else nullcontext(db)):
        part = db.execute("SELECT * FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
        if not part:
            raise ValueError(f"Part #{part_id} not found.")

        on_hand = int(part["qty_on_hand"])
        reserved = int(part["qty_reserved"])

        if is_ro_consumption:
            if qty > on_hand:
                raise ValueError(f"Cannot consume {qty} units; only {on_hand} units on hand.")
            if qty > reserved:
                raise ValueError(f"Cannot consume {qty} reserved units; only {reserved} units are reserved.")
            _reduce_reservation_allocations(db, part_id, ro_number, qty, "CONSUMED", now)
            new_on_hand = on_hand - qty
            new_reserved = reserved - qty
            ref_type = "RO"
            reason_code = "RO_CONSUMPTION"
        else:
            unreserved = on_hand - reserved
            if qty > unreserved:
                raise ValueError(f"Cannot perform counter sale of {qty} units; only {unreserved} unreserved units available ({reserved} reserved for ROs).")
            new_on_hand = on_hand - qty
            new_reserved = reserved
            ref_type = "COUNTER_SALE"
            reason_code = "OTC_SALE"

        db.execute(
            "UPDATE parts_inventory SET qty_on_hand=?, qty_reserved=?, updated_at=? WHERE id=?",
            (new_on_hand, new_reserved, now, part_id),
        )

        db.execute(
            """
            INSERT INTO parts_transactions (
                part_id, transaction_type, qty_change, previous_qty, new_qty,
                reference_type, reference_id, actor_employee_id, reason_code, notes, unit_cost, created_at
            ) VALUES (?, 'consume', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (part_id, -qty, on_hand, new_on_hand, ref_type, ro_number.strip().upper(), actor_id, reason_code, notes, float(part["cost_price"]), now),
        )

    return get_part_by_id(db, part_id)


def adjust_stock(
    db: sqlite3.Connection,
    part_id: int,
    qty_change: int,
    reason_code: str,
    notes: str = "",
    actor_id: int | None = None,
) -> dict:
    """Adjust stock level for count variance, damage, lost, or returns. Restricted operation."""
    if qty_change == 0:
        raise ValueError("Adjustment quantity change cannot be zero.")

    valid_reasons = {"COUNT_VARIANCE", "DAMAGED", "LOST", "FOUND", "RETURNED", "OTHER"}
    reason = reason_code.strip().upper()
    if reason not in valid_reasons:
        raise ValueError(f"Invalid reason code. Must be one of: {', '.join(sorted(valid_reasons))}")
    if reason == "OTHER" and not notes.strip():
        raise ValueError("Notes are required when specifying reason 'OTHER'.")

    now = _utc_now()
    with atomic(db):
        part = db.execute("SELECT * FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
        if not part:
            raise ValueError(f"Part #{part_id} not found.")

        prev_qty = int(part["qty_on_hand"])
        new_qty = prev_qty + qty_change
        if new_qty < 0:
            raise ValueError(f"Adjustment resulting in negative stock ({new_qty}) is rejected.")
        reserved = int(part["qty_reserved"])
        if new_qty < reserved:
            raise ValueError(
                "Adjustment would put physical stock below reserved demand. "
                "Use the manager physical-shortage count workflow."
            )

        db.execute(
            "UPDATE parts_inventory SET qty_on_hand=?, updated_at=? WHERE id=?",
            (new_qty, now, part_id),
        )

        db.execute(
            """
            INSERT INTO parts_transactions (
                part_id, transaction_type, qty_change, previous_qty, new_qty,
                reference_type, reference_id, actor_employee_id, reason_code, notes, unit_cost, created_at
            ) VALUES (?, 'adjustment', ?, ?, ?, 'MANUAL', 'ADJUSTMENT', ?, ?, ?, ?, ?)
            """,
            (part_id, qty_change, prev_qty, new_qty, actor_id, reason, notes, float(part["cost_price"]), now),
        )

    return get_part_by_id(db, part_id)


def cycle_count(
    db: sqlite3.Connection,
    counts: list[dict],
    actor_id: int | None = None,
) -> list[dict]:
    """Process a batch of bin count entries. Discrepancies generate automatic COUNT_VARIANCE adjustments."""
    now = _utc_now()
    results = []
    with atomic(db):
        for item in counts:
            part_id = int(item.get("part_id", 0))
            counted_qty = int(item.get("counted_qty", 0))
            if counted_qty < 0:
                raise ValueError(f"Counted quantity cannot be negative (got {counted_qty}).")

            part = db.execute("SELECT * FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
            if not part:
                continue

            reserved = int(part["qty_reserved"])
            if counted_qty < reserved:
                raise ValueError(
                    f"Counted quantity ({counted_qty}) is below reserved demand ({reserved}). "
                    "A manager must use Record Physical Shortage so affected ROs are flagged."
                )

            prev_qty = int(part["qty_on_hand"])
            diff = counted_qty - prev_qty

            if diff != 0:
                db.execute(
                    "UPDATE parts_inventory SET qty_on_hand=?, updated_at=? WHERE id=?",
                    (counted_qty, now, part_id),
                )
                db.execute(
                    """
                    INSERT INTO parts_transactions (
                        part_id, transaction_type, qty_change, previous_qty, new_qty,
                        reference_type, reference_id, actor_employee_id, reason_code, notes, unit_cost, created_at
                    ) VALUES (?, 'adjustment', ?, ?, ?, 'COUNT', 'CYCLE_COUNT', ?, 'COUNT_VARIANCE', ?, ?, ?)
                    """,
                    (part_id, diff, prev_qty, counted_qty, actor_id, f"Bin count adjustment: counted {counted_qty}, system had {prev_qty}", float(part["cost_price"]), now),
                )

            results.append(get_part_by_id(db, part_id))

    return results


def reconcile_physical_shortage(
    db: sqlite3.Connection,
    counts: list[dict],
    actor_id: int,
    notes: str,
) -> dict:
    """Record truthful counts below reservation demand and flag short RO allocations."""
    if not notes.strip():
        raise ValueError("Manager shortage notes are required.")

    now = _utc_now()
    updated_parts = []
    shortage_rows = []
    with atomic(db):
        for item in counts:
            part_id = int(item.get("part_id", 0))
            counted_qty = int(item.get("counted_qty", 0))
            if counted_qty < 0:
                raise ValueError(f"Counted quantity cannot be negative (got {counted_qty}).")

            part = db.execute("SELECT * FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
            if not part:
                raise ValueError(f"Part #{part_id} not found.")

            prev_qty = int(part["qty_on_hand"])
            reserved = int(part["qty_reserved"])
            if counted_qty >= reserved:
                # Ordinary non-short counts retain the standard cycle-count behavior.
                diff = counted_qty - prev_qty
                if diff:
                    db.execute("UPDATE parts_inventory SET qty_on_hand=?, updated_at=? WHERE id=?", (counted_qty, now, part_id))
                    db.execute(
                        """INSERT INTO parts_transactions
                           (part_id,transaction_type,qty_change,previous_qty,new_qty,reference_type,reference_id,
                            actor_employee_id,reason_code,notes,unit_cost,created_at)
                           VALUES (?,'adjustment',?,?,?,'COUNT','CYCLE_COUNT',?,'COUNT_VARIANCE',?,?,?)""",
                        (part_id, diff, prev_qty, counted_qty, actor_id, notes, float(part["cost_price"]), now),
                    )
                updated_parts.append(get_part_by_id(db, part_id))
                continue

            diff = counted_qty - prev_qty
            db.execute("UPDATE parts_inventory SET qty_on_hand=?, updated_at=? WHERE id=?", (counted_qty, now, part_id))

            allocations = db.execute(
                """SELECT * FROM parts_reservations
                   WHERE part_id=? AND status IN ('ACTIVE','SHORT') ORDER BY created_at,id""",
                (part_id,),
            ).fetchall()
            remaining = counted_qty
            for allocation in allocations:
                requested = int(allocation["requested_qty"])
                fulfilled = min(requested, max(0, remaining))
                remaining -= fulfilled
                status = "ACTIVE" if fulfilled == requested else "SHORT"
                db.execute(
                    "UPDATE parts_reservations SET fulfilled_qty=?,status=?,updated_at=? WHERE id=?",
                    (fulfilled, status, now, allocation["id"]),
                )
                if status == "SHORT":
                    shortage_rows.append({
                        "part_id": part_id,
                        "part_number": part["part_number"],
                        "ro_number": allocation["ro_number"],
                        "requested_qty": requested,
                        "fulfilled_qty": fulfilled,
                        "short_qty": requested - fulfilled,
                    })

            db.execute(
                """INSERT INTO parts_transactions
                   (part_id,transaction_type,qty_change,previous_qty,new_qty,reference_type,reference_id,
                    actor_employee_id,reason_code,notes,unit_cost,created_at)
                   VALUES (?,'adjustment',?,?,?,'COUNT','PHYSICAL_SHORTAGE',?,'PHYSICAL_SHORTAGE',?,?,?)""",
                (part_id, diff, prev_qty, counted_qty, actor_id, notes, float(part["cost_price"]), now),
            )
            affected = [r for r in shortage_rows if r["part_id"] == part_id]
            db.execute(
                """INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at)
                   VALUES (?,'parts.physical_shortage','parts_inventory',?,?,?)""",
                (actor_id, str(part_id), json.dumps({
                    "previous_qty": prev_qty,
                    "physical_qty": counted_qty,
                    "reserved_demand": reserved,
                    "affected_reservations": affected,
                    "notes": notes,
                }), now),
            )
            updated_parts.append(get_part_by_id(db, part_id))

    return {"parts": updated_parts, "shortages": shortage_rows}


def update_part_metadata(
    db: sqlite3.Connection,
    part_id: int,
    home_bin: str,
    interchange_number: str,
    actor_id: int | None = None,
) -> dict:
    """Update part home_bin and interchange_number with server normalization and audit logging. Does not permit quantity changes."""
    norm_bin = str(home_bin or "").strip().upper() or "UNASSIGNED"
    norm_interchange = str(interchange_number or "").strip().upper()

    existing = db.execute("SELECT * FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
    if not existing:
        raise ValueError(f"Part #{part_id} not found.")

    now = _utc_now()
    with atomic(db):
        db.execute(
            "UPDATE parts_inventory SET home_bin=?, interchange_number=?, updated_at=? WHERE id=?",
            (norm_bin, norm_interchange, now, part_id),
        )
        db.execute(
            """INSERT INTO audit_events(
                   actor_employee_id,action,subject_type,subject_id,details_json,created_at
               ) VALUES (?,?,?,?,?,?)""",
            (actor_id, "parts.metadata_update", "parts_inventory", str(part_id), json.dumps({
                "previous_bin": existing["home_bin"],
                "new_bin": norm_bin,
                "previous_interchange": existing["interchange_number"],
                "new_interchange": norm_interchange,
            }), now),
        )

    return get_part_by_id(db, part_id)


def create_or_update_part(
    db: sqlite3.Connection,
    data: dict,
    actor_id: int | None = None,
) -> dict:
    """Create or update canonical part and local-stock defaults. Does not edit quantity directly.

    supplier_name and supplier_part_number remain compatibility fields for the
    existing UI. Live or imported supplier choices belong in part_vendor_offers.
    """
    part_id = data.get("id")
    part_number = str(data.get("part_number", "")).strip().upper()
    description = str(data.get("description", "")).strip().upper()
    category = str(data.get("category", "GENERAL")).strip().upper()
    home_bin = str(data.get("home_bin", "UNASSIGNED")).strip().upper()
    stock_type = str(data.get("stock_type", "STOCK")).strip().upper()
    cost_price = float(data.get("cost_price", 0.0))
    retail_price = float(data.get("retail_price", 0.0))
    reorder_point = int(data.get("reorder_point", 0))
    reorder_qty = int(data.get("reorder_qty", 0))
    supplier_name = str(data.get("supplier_name", "")).strip().upper()
    supplier_part_number = str(data.get("supplier_part_number", "")).strip().upper()
    normalized_part_number = "".join(ch for ch in part_number if ch.isalnum())
    brand_name = str(data.get("brand_name", "")).strip().upper()
    brand_external_id = str(data.get("brand_external_id", "")).strip()
    long_description = str(data.get("long_description", "")).strip()
    product_class_external_id = str(data.get("product_class_external_id", "")).strip()
    unit_of_measure = str(data.get("unit_of_measure", "EA")).strip().upper() or "EA"
    package_qty = float(data.get("package_qty", 1))
    is_remanufactured = int(bool(data.get("is_remanufactured", False)))
    has_core = int(bool(data.get("has_core", False)))
    warranty_text = str(data.get("warranty_text", "")).strip()
    image_url = str(data.get("image_url", "")).strip()
    attributes_json = json.dumps(data.get("attributes", {}), separators=(",", ":"))
    external_metadata_json = json.dumps(data.get("external_metadata", {}), separators=(",", ":"))
    interchange_number = str(data.get("interchange_number", "")).strip().upper()
    superseded_by = str(data.get("superseded_by", "")).strip().upper()

    line_code = str(data.get("line_code", "")).strip().upper()
    preferred_vendor_id = data.get("preferred_vendor_id")
    if preferred_vendor_id is not None:
        try:
            preferred_vendor_id = int(preferred_vendor_id)
        except (ValueError, TypeError):
            preferred_vendor_id = None
    last_cost_date = str(data.get("last_cost_date", "")).strip()
    parent_part_id = data.get("parent_part_id")
    if parent_part_id is not None:
        try:
            parent_part_id = int(parent_part_id)
        except (ValueError, TypeError):
            parent_part_id = None
    unit_yield_qty = float(data.get("unit_yield_qty", 1.0))
    is_pass_through = int(bool(data.get("is_pass_through", False)))

    if not part_number:
        raise ValueError("Part Number is required.")
    if not description:
        raise ValueError("Description is required.")
    if package_qty <= 0:
        raise ValueError("Package quantity must be greater than zero.")
    if not all(math.isfinite(value) for value in (cost_price, retail_price, package_qty)):
        raise ValueError("Part prices and package quantity must be finite numbers.")
    if cost_price < 0 or retail_price < 0 or reorder_point < 0 or reorder_qty < 0:
        raise ValueError("Part prices and reorder quantities cannot be negative.")

    now = _utc_now()
    if not last_cost_date:
        last_cost_date = now[:10]

    with atomic(db):
        if part_id:
            existing = db.execute("SELECT * FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
            if not existing:
                raise ValueError(f"Part #{part_id} not found.")
            brand_name = brand_name if "brand_name" in data else existing["brand_name"]
            brand_external_id = brand_external_id if "brand_external_id" in data else existing["brand_external_id"]
            long_description = long_description if "long_description" in data else existing["long_description"]
            product_class_external_id = (
                product_class_external_id
                if "product_class_external_id" in data
                else existing["product_class_external_id"]
            )
            unit_of_measure = unit_of_measure if "unit_of_measure" in data else existing["unit_of_measure"]
            package_qty = package_qty if "package_qty" in data else existing["package_qty"]
            is_remanufactured = (
                is_remanufactured if "is_remanufactured" in data else existing["is_remanufactured"]
            )
            has_core = has_core if "has_core" in data else existing["has_core"]
            warranty_text = warranty_text if "warranty_text" in data else existing["warranty_text"]
            image_url = image_url if "image_url" in data else existing["image_url"]
            attributes_json = attributes_json if "attributes" in data else existing["attributes_json"]
            external_metadata_json = (
                external_metadata_json
                if "external_metadata" in data
                else existing["external_metadata_json"]
            )
            interchange_number = (
                interchange_number if "interchange_number" in data else existing["interchange_number"]
            )
            superseded_by = superseded_by if "superseded_by" in data else existing["superseded_by"]
            is_pass_through = (
                is_pass_through if "is_pass_through" in data else existing["is_pass_through"]
            )
            line_code = line_code if "line_code" in data else existing["line_code"]
            preferred_vendor_id = preferred_vendor_id if "preferred_vendor_id" in data else existing["preferred_vendor_id"]
            last_cost_date = last_cost_date if "last_cost_date" in data else existing["last_cost_date"]

            db.execute(
                """
                UPDATE parts_inventory SET
                    part_number=?, description=?, category=?, home_bin=?, stock_type=?,
                    cost_price=?, retail_price=?, reorder_point=?, reorder_qty=?,
                    supplier_name=?, supplier_part_number=?, normalized_part_number=?,
                    brand_name=?,brand_external_id=?,long_description=?,product_class_external_id=?,
                    unit_of_measure=?,package_qty=?,is_remanufactured=?,has_core=?,warranty_text=?,
                    image_url=?,attributes_json=?,external_metadata_json=?,interchange_number=?,
                    superseded_by=?,is_pass_through=?,line_code=?,preferred_vendor_id=?,last_cost_date=?,updated_at=?
                WHERE id=?
                """,
                (part_number, description, category, home_bin, stock_type,
                 cost_price, retail_price, reorder_point, reorder_qty,
                 supplier_name, supplier_part_number, normalized_part_number,
                 brand_name, brand_external_id, long_description, product_class_external_id,
                 unit_of_measure, package_qty, is_remanufactured, has_core, warranty_text,
                 image_url, attributes_json, external_metadata_json, interchange_number,
                 superseded_by, is_pass_through, line_code, preferred_vendor_id, last_cost_date, now, part_id),
            )
        else:
            cur = db.execute(
                """
                INSERT INTO parts_inventory (
                    part_number, description, category, home_bin, stock_type,
                    cost_price, retail_price, qty_on_hand, qty_reserved, reorder_point,
                    reorder_qty, supplier_name, supplier_part_number, active, created_at, updated_at
                    , normalized_part_number, brand_name, brand_external_id, long_description,
                    product_class_external_id, unit_of_measure, package_qty, is_remanufactured,
                    has_core, warranty_text, image_url, attributes_json, external_metadata_json,
                    interchange_number, superseded_by, last_cost, average_cost, is_pass_through,
                    line_code, preferred_vendor_id, last_cost_date, parent_part_id, unit_yield_qty
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (part_number, description, category, home_bin, stock_type,
                 cost_price, retail_price, reorder_point, reorder_qty,
                 supplier_name, supplier_part_number, now, now,
                 normalized_part_number, brand_name, brand_external_id, long_description,
                 product_class_external_id, unit_of_measure, package_qty, is_remanufactured,
                 has_core, warranty_text, image_url, attributes_json, external_metadata_json,
                 interchange_number, superseded_by, cost_price, cost_price, is_pass_through,
                 line_code, preferred_vendor_id, last_cost_date, parent_part_id, unit_yield_qty),
            )
            part_id = cur.lastrowid

            db.execute(
                """
                INSERT INTO parts_transactions (
                    part_id, transaction_type, qty_change, previous_qty, new_qty,
                    reference_type, reference_id, actor_employee_id, reason_code, notes, unit_cost, created_at
                ) VALUES (?, 'adjustment', 0, 0, 0, 'MANUAL', 'CATALOG_CREATE', ?, 'PART_INITIALIZED', 'Catalog item created', ?, ?)
                """,
                (part_id, actor_id, cost_price, now),
            )

    return get_part_by_id(db, part_id)


def _record_transaction(
    db: sqlite3.Connection,
    part_id: int,
    trans_type: str,
    qty_change: int,
    unit_cost: float,
    notes: str,
    actor_id: int | None = None,
) -> None:
    now = _utc_now()
    part = db.execute("SELECT qty_on_hand FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
    current_qty = int(part["qty_on_hand"]) if part else 0
    prev_qty = current_qty - qty_change
    db.execute(
        """
        INSERT INTO parts_transactions (
            part_id, transaction_type, qty_change, previous_qty, new_qty,
            reference_type, reference_id, actor_employee_id, reason_code, notes, unit_cost, created_at
        ) VALUES (?, 'breakout', ?, ?, ?, 'MANUAL', ?, ?, ?, ?, ?, ?)
        """,
        (part_id, qty_change, prev_qty, current_qty, trans_type, actor_id, trans_type, notes, unit_cost, now),
    )


def breakout_child_unit_part(
    db: sqlite3.Connection,
    parent_part_id: int,
    data: dict,
    actor_id: int | None = None,
) -> dict:
    """Break down a bulk container SKU (e.g. 5L jug) into a per-unit child SKU (e.g. 1L SKU)."""
    with atomic(db):
        parent = db.execute("SELECT * FROM parts_inventory WHERE id=?", (parent_part_id,)).fetchone()
        if not parent:
            raise ValueError(f"Parent Part #{parent_part_id} not found.")

        parent_dict = dict(parent)
        yield_qty = float(data.get("unit_yield_qty", 5.0))
        if not math.isfinite(yield_qty) or yield_qty <= 0 or not yield_qty.is_integer():
            raise ValueError("Yield must be a positive whole number of child units.")

        unit_cost = float(parent_dict.get("average_cost") if parent_dict.get("average_cost") is not None else parent_dict.get("cost_price", 0.0)) / yield_qty
        unit_retail = float(data.get("retail_price", unit_cost * 1.5))

        child_part_number = str(data.get("part_number", f"{parent_dict['part_number']}-1L")).strip().upper()
        child_desc = str(data.get("description", f"{parent_dict['description']} (PER UNIT)")).strip().upper()

        child_data = {
            "part_number": child_part_number,
            "line_code": parent_dict.get("line_code", ""),
            "description": child_desc,
            "category": parent_dict.get("category", "OIL & FLUIDS"),
            "home_bin": parent_dict.get("home_bin", "BIN-A1"),
            "cost_price": unit_cost,
            "retail_price": unit_retail,
            "unit_of_measure": str(data.get("unit_of_measure", "L")).strip().upper(),
            "supplier_name": parent_dict.get("supplier_name", ""),
            "preferred_vendor_id": parent_dict.get("preferred_vendor_id"),
            "interchange_number": parent_dict.get("interchange_number", ""),
            "parent_part_id": parent_part_id,
            "unit_yield_qty": yield_qty,
            "is_pass_through": 0
        }

        # If parent container has stock on hand, break down 1 container into child units
        if parent_dict.get("qty_on_hand", 0) - parent_dict.get("qty_reserved", 0) < 1:
            raise ValueError("One unreserved parent container is required for splitting.")
        has_parent_stock = True
        if has_parent_stock:
            db.execute(
                "UPDATE parts_inventory SET qty_on_hand = MAX(0, qty_on_hand - 1) WHERE id=?",
                (parent_part_id,)
            )
            _record_transaction(
                db,
                part_id=parent_part_id,
                trans_type="BREAKOUT_OUT",
                qty_change=-1,
                unit_cost=float(parent_dict.get("cost_price", 0.0)),
                notes=f"BULK BREAKOUT TO CHILD SKU: {child_part_number}",
                actor_id=actor_id
            )

        existing_child = db.execute(
            "SELECT id FROM parts_inventory WHERE part_number=?",
            (child_part_number,)
        ).fetchone()
        previous_child_qty = 0
        previous_child_average = 0.0
        if existing_child:
            child = db.execute("SELECT * FROM parts_inventory WHERE id=?", (existing_child["id"],)).fetchone()
            if child["parent_part_id"] != parent_part_id or float(child["unit_yield_qty"]) != yield_qty:
                raise ValueError("Child SKU already exists with a different parent or yield.")
            previous_child_qty = int(child["qty_on_hand"])
            previous_child_average = float(child["average_cost"] if child["average_cost"] is not None else child["cost_price"])
            child_data["id"] = existing_child["id"]

        child_part = create_or_update_part(db, child_data, actor_id=actor_id)
    
        if has_parent_stock:
            db.execute(
                "UPDATE parts_inventory SET qty_on_hand = qty_on_hand + ?, average_cost=?, last_cost=?, updated_at=? WHERE id=?",
                (int(yield_qty), (previous_child_qty * previous_child_average + yield_qty * unit_cost) / (previous_child_qty + yield_qty), unit_cost, _utc_now(), child_part["id"])
            )
            _record_transaction(
                db,
                part_id=child_part["id"],
                trans_type="BREAKOUT_IN",
                qty_change=int(yield_qty),
                unit_cost=unit_cost,
                notes=f"INITIAL BULK YIELD FROM PARENT SKU: {parent_dict['part_number']}",
                actor_id=actor_id
            )

        return get_part_by_id(db, child_part["id"])
