"""Parts & Inventory database query functions."""

from __future__ import annotations

import sqlite3
from parts.models import part_to_dict, transaction_to_dict


def get_top_frequent_sold_parts(db: sqlite3.Connection, limit: int = 10) -> list[dict]:
    """Fetch top N fast-moving inventory parts ordered by transaction count."""
    rows = db.execute(
        """
        SELECT p.*, COUNT(t.id) as sale_count
        FROM parts_inventory p
        LEFT JOIN parts_transactions t ON p.id = t.part_id AND t.transaction_type IN ('consume', 'reserve')
        WHERE p.active = 1
        GROUP BY p.id
        ORDER BY sale_count DESC, p.part_number ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [part_to_dict(row) for row in rows]


def search_parts(db: sqlite3.Connection, query: str = "", limit: int = 50) -> list[dict]:
    """Search parts catalog by part number, description, home bin, or supplier."""
    q = query.strip()
    if not q:
        rows = db.execute(
            "SELECT * FROM parts_inventory WHERE active=1 ORDER BY part_number LIMIT ?", (limit,)
        ).fetchall()
        return [part_to_dict(row) for row in rows]

    pattern = f"%{q}%"
    rows = db.execute(
        """
        SELECT * FROM parts_inventory
        WHERE active=1 AND (
            part_number LIKE ? COLLATE NOCASE
            OR line_code LIKE ? COLLATE NOCASE
            OR (line_code || ' ' || part_number) LIKE ? COLLATE NOCASE
            OR (line_code || part_number) LIKE ? COLLATE NOCASE
            OR description LIKE ? COLLATE NOCASE
            OR home_bin LIKE ? COLLATE NOCASE
            OR category LIKE ? COLLATE NOCASE
            OR supplier_name LIKE ? COLLATE NOCASE
            OR supplier_part_number LIKE ? COLLATE NOCASE
            OR interchange_number LIKE ? COLLATE NOCASE
        )
        ORDER BY part_number LIMIT ?
        """,
        (pattern,) * 10 + (limit,),
    ).fetchall()
    return [part_to_dict(row) for row in rows]


def get_part_by_id(db: sqlite3.Connection, part_id: int) -> dict | None:
    """Fetch part detail record with recent transaction history."""
    row = db.execute("SELECT * FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
    if not row:
        return None

    part = part_to_dict(row)
    tx_rows = db.execute(
        """
        SELECT t.*, e.name AS actor_name
        FROM parts_transactions t
        LEFT JOIN employees e ON e.id = t.actor_employee_id
        WHERE t.part_id=?
        ORDER BY t.id DESC LIMIT 30
        """,
        (part_id,),
    ).fetchall()
    part["transactions"] = [transaction_to_dict(r) for r in tx_rows]
    reservation_rows = db.execute(
        """SELECT id,ro_number,requested_qty,fulfilled_qty,status,notes,created_at,updated_at
           FROM parts_reservations WHERE part_id=? AND status IN ('ACTIVE','SHORT')
           ORDER BY created_at,id""",
        (part_id,),
    ).fetchall()
    part["reservations"] = [dict(r) for r in reservation_rows]
    offer_rows = db.execute(
        """SELECT o.*,v.name AS vendor_name,v.location_name AS vendor_location_name
           FROM part_vendor_offers o
           LEFT JOIN parts_vendors v ON v.id=o.vendor_id
           WHERE o.part_id=? ORDER BY o.last_checked_at DESC,o.id DESC""",
        (part_id,),
    ).fetchall()
    part["vendor_offers"] = [dict(r) for r in offer_rows]
    fitment_rows = db.execute(
        """SELECT id,integration_source,external_application_id,year_from,year_to,
                  make,model,trim,engine,drive_type,position,qualifier,fitment_notes,created_at
           FROM part_fitments WHERE part_id=? ORDER BY year_from,make,model,id""",
        (part_id,),
    ).fetchall()
    part["fitments"] = [dict(r) for r in fitment_rows]
    return part


def get_part_by_number(db: sqlite3.Connection, part_number: str) -> dict | None:
    """Fetch part by exact part number."""
    row = db.execute(
        "SELECT * FROM parts_inventory WHERE part_number=? COLLATE NOCASE", (part_number.strip(),)
    ).fetchone()
    return part_to_dict(row) if row else None


def get_low_stock_parts(db: sqlite3.Connection) -> list[dict]:
    """Return parts where (qty_on_hand - qty_reserved) <= reorder_point."""
    rows = db.execute(
        """
        SELECT * FROM parts_inventory
        WHERE active=1 AND stock_type='STOCK' AND (qty_on_hand - qty_reserved) <= reorder_point
        ORDER BY part_number
        """
    ).fetchall()
    return [part_to_dict(r) for r in rows]


def get_bin_parts(db: sqlite3.Connection, bin_name: str) -> list[dict]:
    """Fetch all parts assigned to a specific home bin location."""
    rows = db.execute(
        "SELECT * FROM parts_inventory WHERE active=1 AND home_bin=? COLLATE NOCASE ORDER BY part_number",
        (bin_name.strip(),),
    ).fetchall()
    return [part_to_dict(r) for r in rows]
