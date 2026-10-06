"""Parts & Inventory data models and dictionary row converters."""

from __future__ import annotations

import sqlite3


def part_to_dict(row: sqlite3.Row | dict) -> dict:
    """Convert parts_inventory row to standard serializable dictionary."""
    data = dict(row)
    qty_on_hand = int(data.get("qty_on_hand", 0))
    qty_reserved = int(data.get("qty_reserved", 0))
    qty_available = max(0, qty_on_hand - qty_reserved)
    reorder_point = int(data.get("reorder_point", 0))
    stock_type = data.get("stock_type", "STOCK")

    is_low_stock = stock_type == "STOCK" and qty_available <= reorder_point

    data["qty_on_hand"] = qty_on_hand
    data["qty_reserved"] = qty_reserved
    data["qty_available"] = qty_available
    data["reorder_point"] = reorder_point
    data["reorder_qty"] = int(data.get("reorder_qty", 0))
    data["cost_price"] = float(data.get("cost_price", 0.0))
    data["retail_price"] = float(data.get("retail_price", 0.0))
    data["package_qty"] = float(data.get("package_qty", 1.0))
    data["last_cost"] = float(data["last_cost"]) if data.get("last_cost") is not None else None
    data["average_cost"] = float(data["average_cost"]) if data.get("average_cost") is not None else None
    data["is_remanufactured"] = bool(data.get("is_remanufactured", 0))
    data["has_core"] = bool(data.get("has_core", 0))
    data["line_code"] = str(data.get("line_code", "")).strip().upper()
    data["last_cost_date"] = str(data.get("last_cost_date", "")).strip()
    data["parent_part_id"] = data.get("parent_part_id")
    data["unit_yield_qty"] = float(data.get("unit_yield_qty", 1.0))
    data["is_low_stock"] = is_low_stock
    return data


def transaction_to_dict(row: sqlite3.Row | dict) -> dict:
    """Convert parts_transactions row to standard serializable dictionary."""
    data = dict(row)
    data["qty_change"] = int(data.get("qty_change", 0))
    data["previous_qty"] = int(data.get("previous_qty", 0))
    data["new_qty"] = int(data.get("new_qty", 0))
    data["unit_cost"] = float(data.get("unit_cost", 0.0))
    return data
