#!/usr/bin/env python3
"""Fast, read-only TaktRO database health check. Use --deep for quick_check."""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "taktro.db"
NHTSA_DB_PATH = ROOT / "nhtsa_reference.db"

CORE_TABLES = (
    "appointments", "repair_orders", "customers", "vehicles",
    "parts_inventory", "audit_events",
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--deep", action="store_true", help="run SQLite quick_check (slow on large databases)")
    args = parser.parse_args()
    if not DB_PATH.exists():
        print(f"FAIL database not found: {DB_PATH}")
        return 2

    failures: list[str] = []
    
    # 1. Check operational database
    size_gib = DB_PATH.stat().st_size / (1024 ** 3)
    with sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=5) as db:
        db.row_factory = sqlite3.Row
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        missing = [name for name in CORE_TABLES if name not in tables]
        if missing:
            failures.append("missing tables in taktro.db: " + ", ".join(missing))

        print(f"database: {DB_PATH} ({size_gib * 1024:.2f} MiB)")
        for table in CORE_TABLES:
            if table in tables:
                count = db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
                print(f"{table:24} {count:>10,} rows")

        orphaned = db.execute(
            """SELECT COUNT(*) FROM appointments a
               WHERE a.status='CONVERTED'
                 AND NOT EXISTS (SELECT 1 FROM repair_orders r WHERE r.appointment_id=a.id)"""
        ).fetchone()[0]
        print(f"orphaned conversions      {orphaned:>10,}")
        if orphaned:
            failures.append(f"{orphaned} converted appointment(s) have no repair order")

        fk_errors = list(db.execute("PRAGMA foreign_key_check"))
        print(f"foreign-key errors        {len(fk_errors):>10,}")
        if fk_errors:
            failures.append(f"{len(fk_errors)} foreign-key error(s)")

        if args.deep:
            result = db.execute("PRAGMA quick_check").fetchone()[0]
            print(f"taktro.db quick_check: {result}")
            if result != "ok":
                failures.append(f"taktro.db quick_check: {result}")

    # 2. Check reference database
    if NHTSA_DB_PATH.exists():
        nhtsa_size_gib = NHTSA_DB_PATH.stat().st_size / (1024 ** 3)
        with sqlite3.connect(f"file:{NHTSA_DB_PATH}?mode=ro", uri=True, timeout=5) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            print(f"database: {NHTSA_DB_PATH} ({nhtsa_size_gib:.2f} GiB)")
            if "nhtsa_communications" not in tables:
                failures.append("missing nhtsa_communications table in nhtsa_reference.db")
            else:
                count = db.execute('SELECT COUNT(*) FROM "nhtsa_communications"').fetchone()[0]
                print(f"nhtsa_communications     {count:>10,} rows")
            
            if args.deep:
                result = db.execute("PRAGMA quick_check").fetchone()[0]
                print(f"nhtsa_reference.db quick_check: {result}")
                if result != "ok":
                    failures.append(f"nhtsa_reference.db quick_check: {result}")
    else:
        failures.append("missing nhtsa_reference.db database file")

    if failures:
        print("HEALTH: WARN — " + "; ".join(failures))
        return 1
    print("HEALTH: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
