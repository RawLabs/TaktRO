#!/usr/bin/env python3
"""Read-only timing probe for TaktRO's common SQLite request queries."""

from __future__ import annotations

import sqlite3
import statistics
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "taktro.db"
RUNS = 7
QUERIES = {
    "appointments board": "SELECT * FROM appointments WHERE status != 'CANCELLED' ORDER BY id DESC",
    "repair-orders board": "SELECT * FROM repair_orders ORDER BY updated_at DESC,id DESC",
    "job-code list": "SELECT * FROM custom_job_codes WHERE active=1 ORDER BY category,code",
    "recent history": "SELECT * FROM appointments ORDER BY id DESC LIMIT 50",
    "vehicle lookup": "SELECT * FROM vehicles WHERE UPPER(owner_name) LIKE '%PEEJ%' LIMIT 20",
}


def timed(db: sqlite3.Connection, sql: str) -> tuple[float, int]:
    started = time.perf_counter()
    rows = len(db.execute(sql).fetchall())
    return (time.perf_counter() - started) * 1000, rows


def main() -> int:
    if not DB_PATH.exists():
        print(f"FAIL database not found: {DB_PATH}")
        return 2
    slow = False
    with sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=5) as db:
        print(f"database: {DB_PATH} ({DB_PATH.stat().st_size / (1024 ** 3):.2f} GiB)")
        for name, sql in QUERIES.items():
            samples = [timed(db, sql) for _ in range(RUNS)]
            durations = [sample[0] for sample in samples]
            median = statistics.median(durations)
            worst = max(durations)
            rows = samples[-1][1]
            marker = "SLOW" if median > 100 else "OK"
            slow |= marker == "SLOW"
            print(f"{marker:4} {name:24} median={median:8.2f} ms worst={worst:8.2f} ms rows={rows}")
    return 1 if slow else 0


if __name__ == "__main__":
    raise SystemExit(main())
