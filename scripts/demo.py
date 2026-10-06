#!/usr/bin/env python3
"""Prepare a fictional demo in a new database; never overwrite existing files."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from parts import service as stock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path)
    args = parser.parse_args()
    target = args.db.resolve()
    if target.exists():
        parser.error("Choose a new database path; existing databases are never overwritten.")
    target.parent.mkdir(parents=True, exist_ok=True)
    server.DB_PATH = target
    server.NHTSA_DB_PATH = target.with_name(target.stem + "-reference.db")
    if server.NHTSA_DB_PATH.exists():
        parser.error("The corresponding reference database already exists; choose a new path.")
    server.initialize_database()
    with server.connect() as db:
        parent = stock.create_or_update_part(db, {"part_number": "DEMO-OIL-5L", "description": "DEMO ENGINE OIL 5L CONTAINER", "category": "OIL & FLUIDS", "cost_price": 40, "retail_price": 60, "unit_of_measure": "JUG", "home_bin": "DEMO-A1"})
        now = server.utc_now()
        lines, totals = server.normalize_work_lines([{"line_id": "demo-oil-service", "pay": "C", "op_code": "OIL-SERVICE", "concern": "DEMO OIL SERVICE", "labor": 50, "booked": 0}])
        db.execute("INSERT INTO repair_orders(ro_number,customer_name,vehicle_info,status,lines_json,master_total,customer_total,created_at,updated_at) VALUES (?,?,?,'write-up',?,?,?,?,?)", ("RO-DEMO-0001", "PORTFOLIO DEMO CUSTOMER", "2020 DEMO TRUCK", json.dumps(lines), totals["master"], totals["C"], now, now))
    print(f"Demo database: {target}")
    print(f"Reference database: {server.NHTSA_DB_PATH}")
    print("PIN: 1042 | RO: RO-DEMO-0001 | PART: DEMO-OIL-5L (0 on hand)")
    print("Follow compendium/PORTFOLIO_DEMO.md to receive, split, bill, and post.")


if __name__ == "__main__":
    main()
