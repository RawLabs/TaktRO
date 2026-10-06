#!/usr/bin/env python3
"""
TaktRO Performance Benchmarking Script
Seeds an isolated test database (taktro_perf_test.db) with realistic shop volume
(500 Repair Orders, 1,000 Appointments, 1,000 Parts, 500 Vehicles) and measures execution latencies.
"""

import os
import sys
import time
import json
import datetime
import sqlite3
from pathlib import Path

DB_PATH = Path("taktro_perf_test.db")

def seed_benchmark_db():
    if DB_PATH.exists():
        DB_PATH.unlink()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # Create tables matching taktro.db schema subset
    c.execute("""
        CREATE TABLE repair_orders (
            id INTEGER PRIMARY KEY, ro_number TEXT UNIQUE, customer_name TEXT, vehicle_info TEXT,
            promised_time TEXT, preassigned_technician_id INTEGER, status TEXT, lines_json TEXT,
            total_hours REAL, master_total REAL, created_at TEXT, updated_at TEXT
        );
    """)
    c.execute("""
        CREATE TABLE appointments (
            id INTEGER PRIMARY KEY, appointment_date TEXT, promised_time TEXT, customer_name TEXT,
            vehicle_info TEXT, preassigned_technician_id INTEGER, status TEXT, lines_json TEXT,
            estimated_hours REAL, concern TEXT, created_at TEXT, updated_at TEXT
        );
    """)
    c.execute("""
        CREATE TABLE parts_inventory (
            id INTEGER PRIMARY KEY, part_number TEXT UNIQUE, description TEXT, home_bin TEXT,
            cost_price REAL, retail_price REAL, qty_on_hand INTEGER, qty_reserved INTEGER,
            qty_available INTEGER, active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT
        );
    """)

    # Seed 1,000 Parts
    parts_data = []
    now = "2026-08-20T12:00:00Z"
    for i in range(1, 1001):
        parts_data.append((
            i, f"P-PART-{i:05d}", f"Synthetic Performance Test Part #{i}", f"BIN-{i % 50:02d}",
            15.0 + (i % 20), 30.0 + (i % 40), 100, 5, 95, 1, now, now
        ))
    c.executemany("INSERT INTO parts_inventory VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", parts_data)

    # Seed 1,000 Appointments across 60 distinct calendar dates
    appts_data = []
    base_date = datetime.date(2026, 7, 1)
    for i in range(1, 1001):
        day_str = (base_date + datetime.timedelta(days=i % 60)).isoformat()
        appts_data.append((
            i, day_str, "09:00 AM", f"Customer #{i}", f"2022 Vehicle #{i}", (i % 5) + 1,
            "SCHEDULED", "[]", 1.5, f"Synthetic Concern #{i}", now, now
        ))
    c.executemany("INSERT INTO appointments VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", appts_data)

    # Seed 500 Repair Orders
    ros_data = []
    for i in range(1, 501):
        ros_data.append((
            i, f"RO-{i:06d}", f"Customer #{i}", f"2021 Vehicle #{i}", "05:00 PM", (i % 5) + 1,
            "write-up", json.dumps([{"pay": "C", "op_code": "BRAKES", "hrs": 2.0, "labor": 300.0}]),
            2.0, 300.0, now, now
        ))
    c.executemany("INSERT INTO repair_orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", ros_data)

    conn.commit()
    conn.close()

def run_benchmarks():
    print("======================================================")
    print("   TaktRO PERFORMANCE BENCHMARK SUITE v2.4            ")
    print("======================================================")

    seed_start = time.time()
    seed_benchmark_db()
    seed_duration = (time.time() - seed_start) * 1000.0
    print(f"✓ Seeded 2,500 records into synthetic DB in {seed_duration:.2f}ms")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    # Benchmark 1: Un-indexed Full Appointments Fetch vs Windowed Date Query
    t0 = time.time()
    all_appts = [dict(r) for r in c.execute("SELECT * FROM appointments WHERE status != 'CANCELLED' ORDER BY id DESC").fetchall()]
    full_fetch_ms = (time.time() - t0) * 1000.0

    t0 = time.time()
    windowed_appts = [dict(r) for r in c.execute("SELECT * FROM appointments WHERE status != 'CANCELLED' AND appointment_date >= '2026-08-15' AND appointment_date <= '2026-08-22' ORDER BY id DESC").fetchall()]
    windowed_fetch_ms = (time.time() - t0) * 1000.0

    # Benchmark 2: Array Filtering vs Map Indexing Lookups
    t0 = time.time()
    for _ in range(100):
        [a for a in all_appts if a['appointment_date'] == '2026-08-15']
    array_filter_ms = (time.time() - t0) * 1000.0

    t0 = time.time()
    date_map = {}
    for a in all_appts:
        d = a['appointment_date']
        if d not in date_map: date_map[d] = []
        date_map[d].append(a)
    for _ in range(100):
        date_map.get('2026-08-15', [])
    map_lookup_ms = (time.time() - t0) * 1000.0

    # Benchmark 3: Parts Search Latency (1,000 SKUs)
    t0 = time.time()
    c.execute("SELECT * FROM parts_inventory WHERE part_number LIKE '%PART-005%' OR description LIKE '%PART-005%' LIMIT 50").fetchall()
    parts_search_ms = (time.time() - t0) * 1000.0

    conn.close()

    if DB_PATH.exists():
        DB_PATH.unlink()

    print(f"\nRESULTS:")
    print(f"  • Full Appointments Fetch (1,000 records across 60 days): {full_fetch_ms:.2f} ms")
    print(f"  • Windowed Date Range Fetch (7-day window):               {windowed_fetch_ms:.2f} ms  (Speedup: {full_fetch_ms / max(0.001, windowed_fetch_ms):.1f}x)")
    print(f"  • 100 Date Filter Iterations (Full Array Filter):        {array_filter_ms:.2f} ms")
    print(f"  • 100 Date Map Index Lookups ($O(1)$ Hash Map):            {map_lookup_ms:.2f} ms  (Speedup: {array_filter_ms / max(0.001, map_lookup_ms):.1f}x)")
    print(f"  • Parts Search Query Latency (1,000 SKUs):               {parts_search_ms:.2f} ms")
    print("======================================================\n")

if __name__ == "__main__":
    run_benchmarks()
