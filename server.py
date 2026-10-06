"""TaktRO local application server: static UI, SQLite identity, and lean access APIs."""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import secrets
import sqlite3
import subprocess
import sys
import threading
import urllib.request
import urllib.error
import zipfile
from datetime import date, datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("TAKTRO_DB_PATH", ROOT / "taktro.db"))
SESSIONS: dict[str, int] = {}

from parts import queries as parts_queries, service as parts_service
from orders import service as orders_service
from setup.schema import initialize_setup_schema
from setup import resolvers as setup_resolvers
import nhtsa

PERMISSIONS = {
    "customers": "Customers & vehicles",
    "appointments": "Appointments",
    "repair_orders": "Repair orders",
    "dispatch": "Dispatch work",
    "parts": "Parts",
    "warranty": "Warranty & internal",
    "cashout": "Customer cashout",
    "staff_admin": "Employees & access",
    "shop_setup": "Shop setup & rules",
}

TEMPLATES = {
    "Advisor": ["customers", "appointments", "repair_orders", "parts", "cashout"],
    "Technician": ["customers", "appointments", "repair_orders", "parts"],
    "Dispatcher": ["customers", "appointments", "repair_orders", "parts", "dispatch"],
    "Parts": ["customers", "appointments", "repair_orders", "parts"],
    "Office / Warranty": ["customers", "appointments", "repair_orders", "parts", "warranty", "cashout"],
    "Manager / Administrator": list(PERMISSIONS),
}


DIAG_LOCK = threading.Lock()


def check_dev_mode(handler) -> bool:
    """
    Server-side gate for developer diagnostic routes.
    Disabled if TAKTRO_DEV_MODE=0 is set in environment.
    """
    dev_env = os.environ.get("TAKTRO_DEV_MODE", "1").strip()
    if dev_env == "0" or dev_env.lower() in ("false", "off", "no"):
        handler.json_response({"error": "Developer diagnostics disabled on this server"}, HTTPStatus.FORBIDDEN)
        return False
    return True


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_work_lines(raw_lines: object) -> tuple[list[dict], dict[str, float]]:
    """Validate work lines and calculate authoritative C/W/I/G totals."""
    if not isinstance(raw_lines, list):
        raise ValueError("Work lines must be a list.")
    if len(raw_lines) > 100:
        raise ValueError("A work record cannot contain more than 100 lines.")

    lines: list[dict] = []
    totals = {"hours": 0.0, "C": 0.0, "W": 0.0, "I": 0.0, "G": 0.0, "master": 0.0}
    for index, raw in enumerate(raw_lines, 1):
        if not isinstance(raw, dict):
            raise ValueError(f"Work line {index} must be an object.")
        pay = str(raw.get("pay", "C")).strip().upper()
        if pay not in {"C", "W", "I", "G"}:
            raise ValueError(f"Work line {index} pay type must be C, W, I, or G.")
        try:
            hours = float(raw.get("hrs", 0) or 0)
            parts = float(raw.get("parts", 0) or 0)
            labor = float(raw.get("labor", 0) or 0)
        except (TypeError, ValueError):
            raise ValueError(f"Work line {index} contains an invalid number.") from None
        if not all(math.isfinite(value) for value in (hours, parts, labor)):
            raise ValueError(f"Work line {index} contains a non-finite number.")
        if hours < 0 or parts < 0 or labor < 0:
            raise ValueError(f"Work line {index} hours and amounts cannot be negative.")

        op_code = str(raw.get("op_code", "")).strip().upper()
        concern = str(raw.get("concern", "")).strip().upper()
        if len(op_code) > 40 or len(concern) > 500:
            raise ValueError(f"Work line {index} text exceeds its maximum length.")
        line_total = round(parts + labor, 2)
        line = {
            "line_id": str(raw.get("line_id") or secrets.token_hex(16)),
            "pay": pay, "op_code": op_code, "concern": concern,
            "hrs": round(hours, 2), "parts": round(parts, 2),
            "labor": round(labor, 2), "total": line_total,
            "booked": 1 if raw.get("booked") else 0
        }
        lines.append(line)
        totals["hours"] += hours
        totals[pay] += line_total
        totals["master"] += line_total

    if len({line["line_id"] for line in lines}) != len(lines):
        raise ValueError("Work line identities must be unique.")
    return lines, {key: round(value, 2) for key, value in totals.items()}


def hash_pin(pin: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, 200_000)
    return f"{salt.hex()}:{digest.hex()}"


def verify_pin(pin: str, stored: str) -> bool:
    salt_hex, expected = stored.split(":", 1)
    actual = hash_pin(pin, bytes.fromhex(salt_hex)).split(":", 1)[1]
    return hmac.compare_digest(actual, expected)


NHTSA_DB_PATH = Path(os.environ.get("TAKTRO_NHTSA_DB_PATH", ROOT / "nhtsa_reference.db"))

class ManagedConnection(sqlite3.Connection):
    """Close request connections when their outermost context exits."""
    def __enter__(self):
        self._context_depth = getattr(self, "_context_depth", 0) + 1
        return super().__enter__()

    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self._context_depth -= 1
            if self._context_depth == 0:
                self.close()


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, factory=ManagedConnection)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA synchronous = NORMAL")
    db.execute("PRAGMA foreign_keys = ON")
    return db


def connect_nhtsa() -> sqlite3.Connection:
    db = sqlite3.connect(NHTSA_DB_PATH, factory=ManagedConnection)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA synchronous = NORMAL")
    return db


def technician_daily_capacity(db: sqlite3.Connection, employee_id: int, work_date: str) -> float:
    scheduled = db.execute(
        """SELECT ts.productive_hours FROM technician_schedules ts
           JOIN shop_config_revisions scr ON scr.id=ts.revision_id AND scr.status='ACTIVE'
           WHERE ts.employee_id=? AND ts.work_date=?
           ORDER BY ts.revision_id DESC,ts.id DESC LIMIT 1""",
        (employee_id, work_date),
    ).fetchone()
    if scheduled is not None:
        return max(0.0, float(scheduled["productive_hours"]))

    emp = db.execute("SELECT work_days, daily_productive_hours FROM employees WHERE id=?", (employee_id,)).fetchone()
    if emp and "work_days" in emp.keys():
        work_days = [d.strip().upper() for d in (emp["work_days"] or "MON,TUE,WED,THU,FRI").split(",") if d.strip()]
        try:
            dt = datetime.strptime(work_date, "%Y-%m-%d")
            day_name = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"][dt.weekday()]
            if day_name not in work_days:
                return 0.0
        except Exception:
            pass
        daily_hours = float(emp["daily_productive_hours"]) if emp["daily_productive_hours"] is not None else 8.0
        return max(0.0, daily_hours)

    profile = db.execute(
        """SELECT top.productive_target_percent FROM technician_operational_profiles top
           JOIN shop_config_revisions scr ON scr.id=top.revision_id AND scr.status='ACTIVE'
           WHERE top.employee_id=? AND top.scheduling_active=1
           ORDER BY top.revision_id DESC,top.id DESC LIMIT 1""",
        (employee_id,),
    ).fetchone()
    target = float(profile["productive_target_percent"]) if profile else 100.0
    return max(0.0, 8.0 * target / 100.0)


def initialize_database() -> None:
    with connect() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS locations (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS position_templates (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS template_permissions (
                template_id INTEGER NOT NULL REFERENCES position_templates(id) ON DELETE CASCADE,
                permission TEXT NOT NULL, PRIMARY KEY (template_id, permission)
            );
            CREATE TABLE IF NOT EXISTS employees (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS employee_locations (
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                location_id INTEGER NOT NULL REFERENCES locations(id),
                PRIMARY KEY (employee_id, location_id)
            );
            CREATE TABLE IF NOT EXISTS employee_templates (
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                template_id INTEGER NOT NULL REFERENCES position_templates(id),
                PRIMARY KEY (employee_id, template_id)
            );
            CREATE TABLE IF NOT EXISTS employee_permission_overrides (
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                permission TEXT NOT NULL, allowed INTEGER NOT NULL,
                PRIMARY KEY (employee_id, permission)
            );
            CREATE TABLE IF NOT EXISTS audit_events (
                id INTEGER PRIMARY KEY, actor_employee_id INTEGER REFERENCES employees(id),
                action TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT,
                details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS vehicles (
                id INTEGER PRIMARY KEY, owner_name TEXT NOT NULL DEFAULT '', owner_phone TEXT NOT NULL DEFAULT '',
                year INTEGER NOT NULL, make TEXT NOT NULL, model TEXT NOT NULL, color TEXT NOT NULL DEFAULT '',
                plate TEXT NOT NULL DEFAULT '', mileage INTEGER, vin TEXT NOT NULL UNIQUE,
                created_by INTEGER REFERENCES employees(id), created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS parts_inventory (
                id INTEGER PRIMARY KEY, part_number TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'GENERAL', home_bin TEXT NOT NULL DEFAULT 'UNASSIGNED',
                stock_type TEXT NOT NULL DEFAULT 'STOCK', cost_price REAL NOT NULL DEFAULT 0.0,
                retail_price REAL NOT NULL DEFAULT 0.0, qty_on_hand INTEGER NOT NULL DEFAULT 0,
                qty_reserved INTEGER NOT NULL DEFAULT 0, reorder_point INTEGER NOT NULL DEFAULT 0,
                reorder_qty INTEGER NOT NULL DEFAULT 0, supplier_name TEXT NOT NULL DEFAULT '',
                supplier_part_number TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS parts_transactions (
                id INTEGER PRIMARY KEY, part_id INTEGER NOT NULL REFERENCES parts_inventory(id),
                transaction_type TEXT NOT NULL, qty_change INTEGER NOT NULL,
                previous_qty INTEGER NOT NULL, new_qty INTEGER NOT NULL,
                reference_type TEXT NOT NULL DEFAULT 'MANUAL', reference_id TEXT NOT NULL DEFAULT '',
                actor_employee_id INTEGER REFERENCES employees(id), reason_code TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '', unit_cost REAL NOT NULL DEFAULT 0.0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS parts_reservations (
                id INTEGER PRIMARY KEY,
                part_id INTEGER NOT NULL REFERENCES parts_inventory(id),
                ro_number TEXT NOT NULL,
                requested_qty INTEGER NOT NULL,
                fulfilled_qty INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'ACTIVE',
                notes TEXT NOT NULL DEFAULT '',
                actor_employee_id INTEGER REFERENCES employees(id),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS parts_vendors (
                id INTEGER PRIMARY KEY,
                integration_source TEXT NOT NULL DEFAULT 'MANUAL',
                external_vendor_id TEXT NOT NULL DEFAULT '',
                name TEXT NOT NULL,
                location_external_id TEXT NOT NULL DEFAULT '',
                location_name TEXT NOT NULL DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(integration_source, name, location_name)
            );
            CREATE TABLE IF NOT EXISTS part_vendor_offers (
                id INTEGER PRIMARY KEY,
                part_id INTEGER NOT NULL REFERENCES parts_inventory(id),
                vendor_id INTEGER NOT NULL REFERENCES parts_vendors(id),
                integration_source TEXT NOT NULL,
                external_offer_id TEXT NOT NULL DEFAULT '',
                vendor_part_number TEXT NOT NULL DEFAULT '',
                vendor_line_code TEXT NOT NULL DEFAULT '',
                unit_cost REAL,
                list_price REAL,
                suggested_retail REAL,
                core_cost REAL,
                shipping_cost REAL,
                availability_status TEXT NOT NULL DEFAULT 'UNKNOWN',
                available_qty INTEGER,
                availability_location TEXT NOT NULL DEFAULT '',
                estimated_delivery_at TEXT,
                delivery_description TEXT NOT NULL DEFAULT '',
                cutoff_time TEXT,
                backordered INTEGER NOT NULL DEFAULT 0,
                discontinued INTEGER NOT NULL DEFAULT 0,
                raw_external_json TEXT NOT NULL DEFAULT '{}',
                last_checked_at TEXT NOT NULL,
                UNIQUE(part_id, integration_source, external_offer_id, vendor_id)
            );
            CREATE INDEX IF NOT EXISTS idx_part_vendor_offers_part
                ON part_vendor_offers(part_id, last_checked_at DESC);
            CREATE TABLE IF NOT EXISTS part_fitments (
                id INTEGER PRIMARY KEY,
                part_id INTEGER NOT NULL REFERENCES parts_inventory(id),
                integration_source TEXT NOT NULL,
                external_application_id TEXT NOT NULL DEFAULT '',
                year_from INTEGER,
                year_to INTEGER,
                make TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                trim TEXT NOT NULL DEFAULT '',
                engine TEXT NOT NULL DEFAULT '',
                drive_type TEXT NOT NULL DEFAULT '',
                position TEXT NOT NULL DEFAULT '',
                qualifier TEXT NOT NULL DEFAULT '',
                fitment_notes TEXT NOT NULL DEFAULT '',
                raw_external_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                UNIQUE(part_id, integration_source, external_application_id)
            );
            CREATE TABLE IF NOT EXISTS ro_part_quote_snapshots (
                id INTEGER PRIMARY KEY,
                ro_number TEXT NOT NULL,
                job_line_reference TEXT NOT NULL DEFAULT '',
                part_id INTEGER REFERENCES parts_inventory(id),
                integration_source TEXT NOT NULL DEFAULT 'MANUAL',
                external_offer_id TEXT NOT NULL DEFAULT '',
                external_quote_id TEXT NOT NULL DEFAULT '',
                part_number_snapshot TEXT NOT NULL,
                brand_snapshot TEXT NOT NULL DEFAULT '',
                description_snapshot TEXT NOT NULL,
                vendor_id INTEGER REFERENCES parts_vendors(id),
                vendor_name_snapshot TEXT NOT NULL DEFAULT '',
                quantity REAL NOT NULL,
                quoted_unit_cost REAL,
                quoted_core_cost REAL,
                quoted_sell_price REAL NOT NULL,
                availability_snapshot TEXT NOT NULL DEFAULT '',
                eta_snapshot TEXT NOT NULL DEFAULT '',
                raw_external_json TEXT NOT NULL DEFAULT '{}',
                quoted_at TEXT NOT NULL,
                CHECK(quantity > 0)
            );
            CREATE INDEX IF NOT EXISTS idx_ro_part_quote_snapshots_ro
                ON ro_part_quote_snapshots(ro_number, job_line_reference);
            CREATE TABLE IF NOT EXISTS parts_purchase_orders (
                id INTEGER PRIMARY KEY,
                vendor_id INTEGER REFERENCES parts_vendors(id),
                ro_number TEXT NOT NULL DEFAULT '',
                integration_source TEXT NOT NULL DEFAULT 'MANUAL',
                external_order_id TEXT NOT NULL DEFAULT '',
                external_quote_id TEXT NOT NULL DEFAULT '',
                external_cart_id TEXT NOT NULL DEFAULT '',
                shop_po_number TEXT NOT NULL UNIQUE,
                vendor_order_number TEXT NOT NULL DEFAULT '',
                vendor_invoice_number TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'QUOTE',
                ordered_at TEXT,
                expected_at TEXT,
                received_at TEXT,
                notes TEXT NOT NULL DEFAULT '',
                raw_external_json TEXT NOT NULL DEFAULT '{}',
                created_by INTEGER REFERENCES employees(id),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS parts_purchase_order_lines (
                id INTEGER PRIMARY KEY,
                purchase_order_id INTEGER NOT NULL REFERENCES parts_purchase_orders(id) ON DELETE CASCADE,
                part_id INTEGER REFERENCES parts_inventory(id),
                external_offer_id TEXT NOT NULL DEFAULT '',
                part_number_snapshot TEXT NOT NULL,
                brand_snapshot TEXT NOT NULL DEFAULT '',
                description_snapshot TEXT NOT NULL,
                ordered_qty REAL NOT NULL,
                received_qty REAL NOT NULL DEFAULT 0,
                backordered_qty REAL NOT NULL DEFAULT 0,
                unit_cost REAL NOT NULL,
                core_cost REAL NOT NULL DEFAULT 0,
                shipping_cost REAL NOT NULL DEFAULT 0,
                core_expected INTEGER NOT NULL DEFAULT 0,
                core_received INTEGER NOT NULL DEFAULT 0,
                core_returned INTEGER NOT NULL DEFAULT 0,
                core_credit_expected REAL NOT NULL DEFAULT 0,
                core_credit_received REAL NOT NULL DEFAULT 0,
                raw_external_json TEXT NOT NULL DEFAULT '{}',
                CHECK(ordered_qty > 0),
                CHECK(received_qty >= 0),
                CHECK(backordered_qty >= 0)
            );
            CREATE TABLE IF NOT EXISTS parts_integration_connections (
                id INTEGER PRIMARY KEY,
                provider TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
                external_account_reference TEXT NOT NULL DEFAULT '',
                credential_reference TEXT NOT NULL DEFAULT '',
                last_success_at TEXT,
                last_error_at TEXT,
                last_error_summary TEXT NOT NULL DEFAULT '',
                updated_by INTEGER REFERENCES employees(id),
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS parts_integration_events (
                id INTEGER PRIMARY KEY,
                provider TEXT NOT NULL,
                external_event_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'RECEIVED',
                error_summary TEXT NOT NULL DEFAULT '',
                received_at TEXT NOT NULL,
                processed_at TEXT,
                UNIQUE(provider, external_event_id)
            );
            CREATE TABLE IF NOT EXISTS custom_job_codes (
                id INTEGER PRIMARY KEY,
                code TEXT NOT NULL UNIQUE COLLATE NOCASE,
                description TEXT NOT NULL,
                category TEXT NOT NULL,
                default_hours REAL NOT NULL DEFAULT 0.0,
                default_parts REAL NOT NULL DEFAULT 0.0,
                active INTEGER NOT NULL DEFAULT 1,
                created_by INTEGER REFERENCES employees(id),
                modified_by INTEGER REFERENCES employees(id),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS appointments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_name TEXT NOT NULL,
                vehicle_info TEXT NOT NULL,
                concern TEXT NOT NULL DEFAULT '',
                pay_type TEXT NOT NULL DEFAULT 'C',
                promised_time TEXT NOT NULL,
                estimated_hours REAL NOT NULL DEFAULT 1.0,
                status TEXT NOT NULL DEFAULT 'SCHEDULED',
                actor_employee_id INTEGER REFERENCES employees(id),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS repair_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ro_number TEXT NOT NULL UNIQUE,
                appointment_id INTEGER UNIQUE REFERENCES appointments(id),
                customer_name TEXT NOT NULL,
                vehicle_info TEXT NOT NULL,
                license_plate TEXT NOT NULL DEFAULT '',
                vin TEXT NOT NULL DEFAULT '',
                mileage TEXT NOT NULL DEFAULT '',
                fleet_unit TEXT NOT NULL DEFAULT '',
                po_number TEXT NOT NULL DEFAULT '',
                promised_time TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'write-up',
                lines_json TEXT NOT NULL DEFAULT '[]',
                total_hours REAL NOT NULL DEFAULT 0,
                customer_total REAL NOT NULL DEFAULT 0,
                warranty_total REAL NOT NULL DEFAULT 0,
                internal_total REAL NOT NULL DEFAULT 0,
                goodwill_total REAL NOT NULL DEFAULT 0,
                master_total REAL NOT NULL DEFAULT 0,
                created_by INTEGER REFERENCES employees(id),
                updated_by INTEGER REFERENCES employees(id),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_repair_orders_status
                ON repair_orders(status,updated_at DESC);
            CREATE TABLE IF NOT EXISTS ro_part_charges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ro_number TEXT NOT NULL REFERENCES repair_orders(ro_number),
                line_id TEXT NOT NULL,
                part_id INTEGER NOT NULL REFERENCES parts_inventory(id),
                qty INTEGER NOT NULL CHECK(qty > 0),
                unit_price REAL NOT NULL CHECK(unit_price >= 0),
                unit_cost REAL NOT NULL CHECK(unit_cost >= 0),
                status TEXT NOT NULL DEFAULT 'CONFIRMED',
                created_at TEXT NOT NULL,
                posted_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_ro_part_charges_ro ON ro_part_charges(ro_number);
            CREATE TABLE IF NOT EXISTS counter_sale_invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_number TEXT NOT NULL UNIQUE,
                customer_name TEXT NOT NULL,
                customer_phone TEXT NOT NULL DEFAULT '',
                payment_method TEXT NOT NULL,
                total_amount REAL NOT NULL CHECK(total_amount >= 0),
                status TEXT NOT NULL DEFAULT 'POSTED',
                actor_employee_id INTEGER REFERENCES employees(id),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS counter_sale_invoice_lines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_id INTEGER NOT NULL REFERENCES counter_sale_invoices(id) ON DELETE RESTRICT,
                part_id INTEGER NOT NULL REFERENCES parts_inventory(id),
                part_number_snapshot TEXT NOT NULL,
                description_snapshot TEXT NOT NULL,
                quantity INTEGER NOT NULL CHECK(quantity > 0),
                unit_price REAL NOT NULL CHECK(unit_price >= 0),
                line_total REAL NOT NULL CHECK(line_total >= 0)
            );
        """)
        vehicle_columns = {row["name"] for row in db.execute("PRAGMA table_info(vehicles)")}
        for name, definition in {
            "customer_id": "INTEGER REFERENCES customers(id)",
            "trim": "TEXT NOT NULL DEFAULT ''",
            "engine": "TEXT NOT NULL DEFAULT ''",
            "transmission": "TEXT NOT NULL DEFAULT ''",
            "transmission_type": "TEXT NOT NULL DEFAULT 'unknown'",
            "drive_type": "TEXT NOT NULL DEFAULT ''",
            "body_class": "TEXT NOT NULL DEFAULT ''",
            "fuel_type": "TEXT NOT NULL DEFAULT ''",
            "decode_source": "TEXT NOT NULL DEFAULT ''",
            "decoded_at": "TEXT",
            "modifications": "TEXT NOT NULL DEFAULT ''",
            "notes": "TEXT NOT NULL DEFAULT ''",
            "asset_type": "TEXT NOT NULL DEFAULT 'VEHICLE'",
            "equipment_category": "TEXT NOT NULL DEFAULT ''",
            "serial_number": "TEXT NOT NULL DEFAULT ''",
            "hours_meter": "REAL",
            "is_shop_equipment": "INTEGER NOT NULL DEFAULT 0",
            "shop_fleet_type": "TEXT NOT NULL DEFAULT ''",
            "engine_oil_spec": "TEXT NOT NULL DEFAULT ''",
            "trans_fluid_spec": "TEXT NOT NULL DEFAULT ''",
            "coolant_spec": "TEXT NOT NULL DEFAULT ''",
            "fluid_notes": "TEXT NOT NULL DEFAULT ''",
        }.items():
            if name not in vehicle_columns:
                db.execute(f"ALTER TABLE vehicles ADD COLUMN {name} {definition}")
        customer_columns = {row["name"] for row in db.execute("PRAGMA table_info(customers)")}
        for name, definition in {
            "email": "TEXT NOT NULL DEFAULT ''", "address": "TEXT NOT NULL DEFAULT ''",
            "city": "TEXT NOT NULL DEFAULT ''", "state": "TEXT NOT NULL DEFAULT ''",
            "postal_code": "TEXT NOT NULL DEFAULT ''", "notes": "TEXT NOT NULL DEFAULT ''",
            "communication_preference": "TEXT NOT NULL DEFAULT ''",
            "customer_type": "TEXT NOT NULL DEFAULT 'RETAIL'",
            "company_name": "TEXT NOT NULL DEFAULT ''",
            "fleet_unit_number": "TEXT NOT NULL DEFAULT ''",
            "contact_person": "TEXT NOT NULL DEFAULT ''",
            "fleet_card_details": "TEXT NOT NULL DEFAULT ''",
            "reimbursement_details": "TEXT NOT NULL DEFAULT ''",
            "tax_exempt_number": "TEXT NOT NULL DEFAULT ''",
            "labor_rate": "REAL",
        }.items():
            if name not in customer_columns:
                db.execute(f"ALTER TABLE customers ADD COLUMN {name} {definition}")
        part_columns = {row["name"] for row in db.execute("PRAGMA table_info(parts_inventory)")}
        for name, definition in {
            "normalized_part_number": "TEXT NOT NULL DEFAULT ''",
            "brand_name": "TEXT NOT NULL DEFAULT ''",
            "brand_external_id": "TEXT NOT NULL DEFAULT ''",
            "long_description": "TEXT NOT NULL DEFAULT ''",
            "product_class_external_id": "TEXT NOT NULL DEFAULT ''",
            "unit_of_measure": "TEXT NOT NULL DEFAULT 'EA'",
            "package_qty": "REAL NOT NULL DEFAULT 1",
            "is_remanufactured": "INTEGER NOT NULL DEFAULT 0",
            "has_core": "INTEGER NOT NULL DEFAULT 0",
            "warranty_text": "TEXT NOT NULL DEFAULT ''",
            "image_url": "TEXT NOT NULL DEFAULT ''",
            "attributes_json": "TEXT NOT NULL DEFAULT '{}'",
            "external_metadata_json": "TEXT NOT NULL DEFAULT '{}'",
            "interchange_number": "TEXT NOT NULL DEFAULT ''",
            "superseded_by": "TEXT NOT NULL DEFAULT ''",
            "preferred_vendor_id": "INTEGER",
            "last_cost": "REAL",
            "average_cost": "REAL",
            "is_pass_through": "INTEGER NOT NULL DEFAULT 0",
            "line_code": "TEXT NOT NULL DEFAULT ''",
            "last_cost_date": "TEXT NOT NULL DEFAULT ''",
            "parent_part_id": "INTEGER REFERENCES parts_inventory(id)",
            "unit_yield_qty": "REAL NOT NULL DEFAULT 1",
        }.items():
            if name not in part_columns:
                db.execute(f"ALTER TABLE parts_inventory ADD COLUMN {name} {definition}")
        appt_columns = {row["name"] for row in db.execute("PRAGMA table_info(appointments)")}
        for name, definition in {
            "appointment_date": "TEXT NOT NULL DEFAULT ''",
            "drop_off_time": "TEXT NOT NULL DEFAULT ''",
            "preassigned_technician_id": "INTEGER REFERENCES employees(id)",
            "requires_carry_over": "INTEGER NOT NULL DEFAULT 0",
            "license_plate": "TEXT NOT NULL DEFAULT ''",
            "vin": "TEXT NOT NULL DEFAULT ''",
            "mileage": "TEXT NOT NULL DEFAULT ''",
            "fleet_unit": "TEXT NOT NULL DEFAULT ''",
            "po_number": "TEXT NOT NULL DEFAULT ''",
            "lines_json": "TEXT NOT NULL DEFAULT '[]'",
            "total_hours": "REAL NOT NULL DEFAULT 1.0",
            "master_total": "REAL NOT NULL DEFAULT 0.0",
        }.items():
            if name not in appt_columns:
                db.execute(f"ALTER TABLE appointments ADD COLUMN {name} {definition}")
        ro_columns = {row["name"] for row in db.execute("PRAGMA table_info(repair_orders)")}
        if "goodwill_total" not in ro_columns:
            db.execute("ALTER TABLE repair_orders ADD COLUMN goodwill_total REAL NOT NULL DEFAULT 0")
        if "preassigned_technician_id" not in ro_columns:
            db.execute("ALTER TABLE repair_orders ADD COLUMN preassigned_technician_id INTEGER REFERENCES employees(id)")
        vendor_columns = {row["name"] for row in db.execute("PRAGMA table_info(parts_vendors)")}
        for name, definition in {
            "address_line_1": "TEXT NOT NULL DEFAULT ''",
            "city": "TEXT NOT NULL DEFAULT ''",
            "region": "TEXT NOT NULL DEFAULT ''",
            "postal_code": "TEXT NOT NULL DEFAULT ''",
            "tax_id": "TEXT NOT NULL DEFAULT ''",
            "account_number": "TEXT NOT NULL DEFAULT ''",
            "category": "TEXT NOT NULL DEFAULT 'PARTS'",
            "ordering_phone": "TEXT NOT NULL DEFAULT ''",
            "ordering_email": "TEXT NOT NULL DEFAULT ''",
            "ordering_method": "TEXT NOT NULL DEFAULT ''",
            "cutoff_time": "TEXT NOT NULL DEFAULT ''",
            "delivery_note": "TEXT NOT NULL DEFAULT ''",
            "terms_note": "TEXT NOT NULL DEFAULT ''",
            "returns_core_note": "TEXT NOT NULL DEFAULT ''",
            "warranty_link": "TEXT NOT NULL DEFAULT ''",
            "operational_note": "TEXT NOT NULL DEFAULT ''",
            "country_code": "TEXT NOT NULL DEFAULT 'CA'",
            "currency_code": "TEXT NOT NULL DEFAULT 'CAD'",
        }.items():
            if name not in vendor_columns:
                db.execute(f"ALTER TABLE parts_vendors ADD COLUMN {name} {definition}")
        db.execute(
            """UPDATE parts_inventory
               SET normalized_part_number=UPPER(REPLACE(REPLACE(part_number, '-', ''), ' ', ''))
               WHERE normalized_part_number=''"""
        )
        initialize_setup_schema(db)
        db.execute("INSERT OR IGNORE INTO locations(name) VALUES (?)", ("Main Shop",))
        db.execute("INSERT OR IGNORE INTO shops(id,name,created_at) VALUES (1,?,?)", ("MAIN SHOP", utc_now()))
        db.execute("UPDATE locations SET code=COALESCE(NULLIF(code,''),'MAIN'),shop_id=COALESCE(shop_id,1),timezone_name=COALESCE(NULLIF(timezone_name,''),'America/Edmonton') WHERE name='Main Shop'")
        db.execute("INSERT OR IGNORE INTO labor_classes(code,name) VALUES ('GENERAL','GENERAL LABOUR')")
        if not db.execute("SELECT 1 FROM shop_config_revisions WHERE shop_id=1 LIMIT 1").fetchone():
            cur = db.execute(
                "INSERT INTO shop_config_revisions(shop_id,status,version_label,change_summary,created_at) VALUES (1,'DRAFT','INITIAL','INITIAL CANADIAN SHOP SETUP',?)",
                (utc_now(),),
            )
            db.execute(
                """INSERT INTO shop_profile_configs(revision_id,legal_name,invoice_name,country_code,currency_code,timezone_name,region)
                   VALUES (?,?,?,'CA','CAD','America/Edmonton','AB')""",
                (cur.lastrowid, "MAIN SHOP", "MAIN SHOP"),
            )
        for name, permissions in TEMPLATES.items():
            db.execute("INSERT OR IGNORE INTO position_templates(name) VALUES (?)", (name,))
            template_id = db.execute("SELECT id FROM position_templates WHERE name=?", (name,)).fetchone()["id"]
            for permission in permissions:
                db.execute("INSERT OR IGNORE INTO template_permissions VALUES (?, ?)", (template_id, permission))
        emp_columns = {row["name"] for row in db.execute("PRAGMA table_info(employees)")}
        for name, definition in {
            "phone": "TEXT NOT NULL DEFAULT ''",
            "address": "TEXT NOT NULL DEFAULT ''",
            "sin": "TEXT NOT NULL DEFAULT ''",
            "emergency_contact_name": "TEXT NOT NULL DEFAULT ''",
            "emergency_contact_phone": "TEXT NOT NULL DEFAULT ''",
            "medical_alert": "TEXT NOT NULL DEFAULT ''",
            "work_days": "TEXT NOT NULL DEFAULT 'MON,TUE,WED,THU,FRI'",
            "daily_productive_hours": "REAL NOT NULL DEFAULT 8.0",
        }.items():
            if name not in emp_columns:
                db.execute(f"ALTER TABLE employees ADD COLUMN {name} {definition}")

        if not db.execute("SELECT 1 FROM employees LIMIT 1").fetchone():
            cur = db.execute(
                "INSERT INTO employees(name, pin_hash, created_at) VALUES (?, ?, ?)",
                ("Shop Administrator", hash_pin("1042"), utc_now()),
            )
            employee_id = cur.lastrowid
            location_id = db.execute("SELECT id FROM locations WHERE name='Main Shop'").fetchone()["id"]
            template_id = db.execute("SELECT id FROM position_templates WHERE name='Manager / Administrator'").fetchone()["id"]
            db.execute("INSERT INTO employee_locations VALUES (?, ?)", (employee_id, location_id))
            db.execute("INSERT INTO employee_templates VALUES (?, ?)", (employee_id, template_id))

        if not db.execute("SELECT 1 FROM employees WHERE name='Wrench Hardy' LIMIT 1").fetchone():
            cur = db.execute(
                """INSERT INTO employees (name, pin_hash, phone, address, sin, emergency_contact_name, emergency_contact_phone, medical_alert, work_days, daily_productive_hours, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    "Wrench Hardy",
                    hash_pin("5555"),
                    "555-0199",
                    "742 Evergreen Terrace, Calgary AB",
                    "955-555-555",
                    "Sarah Hardy",
                    "555-0198",
                    "Penicillin Allergy / Wear Safety Glasses",
                    "MON,TUE,WED,THU,FRI",
                    8.0,
                    utc_now()
                ),
            )
            tech_emp_id = cur.lastrowid
            location_id = db.execute("SELECT id FROM locations WHERE name='Main Shop'").fetchone()["id"]
            tech_template_id = db.execute("SELECT id FROM position_templates WHERE name='Technician'").fetchone()["id"]
            db.execute("INSERT INTO employee_locations VALUES (?, ?)", (tech_emp_id, location_id))
            db.execute("INSERT INTO employee_templates VALUES (?, ?)", (tech_emp_id, tech_template_id))

        # Older databases tracked only aggregate reserved quantity. Preserve that
        # demand as an explicit legacy allocation until it is attached to an RO.
        now = utc_now()
        for row in db.execute("SELECT id, qty_reserved FROM parts_inventory WHERE qty_reserved > 0"):
            tracked = db.execute(
                "SELECT COALESCE(SUM(requested_qty), 0) total FROM parts_reservations WHERE part_id=? AND status IN ('ACTIVE','SHORT')",
                (row["id"],),
            ).fetchone()["total"]
            missing = int(row["qty_reserved"]) - int(tracked)
            if missing > 0:
                db.execute(
                    """INSERT INTO parts_reservations
                       (part_id,ro_number,requested_qty,fulfilled_qty,status,notes,created_at,updated_at)
                       VALUES (?,?,?,?,?,'Migrated aggregate reservation',?,?)""",
                    (row["id"], "LEGACY-UNATTRIBUTED", missing, missing, "ACTIVE", now, now),
                )

        # Initialize secondary nhtsa_reference.db schema if not exists
        with connect_nhtsa() as nhtsa_db:
            nhtsa_db.executescript("""
                CREATE TABLE IF NOT EXISTS nhtsa_communications (
                    id INTEGER PRIMARY KEY,
                    nhtsa_id TEXT NOT NULL,
                    replacement_id TEXT NOT NULL DEFAULT '',
                    date_added TEXT NOT NULL DEFAULT '',
                    document_id TEXT NOT NULL DEFAULT '',
                    communication_date TEXT NOT NULL DEFAULT '',
                    campaign_id TEXT NOT NULL DEFAULT '',
                    communication_type TEXT NOT NULL DEFAULT '',
                    make TEXT NOT NULL,
                    model TEXT NOT NULL,
                    model_year INTEGER NOT NULL,
                    nhtsa_component TEXT NOT NULL DEFAULT '',
                    manufacturer_system TEXT NOT NULL DEFAULT '',
                    manufacturer_subsystem TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL DEFAULT '',
                    pdf_url TEXT NOT NULL DEFAULT '',
                    source_archive TEXT NOT NULL,
                    imported_at TEXT NOT NULL,
                    UNIQUE(nhtsa_id,make,model,model_year,nhtsa_component)
                );
                CREATE INDEX IF NOT EXISTS idx_nhtsa_communications_vehicle
                    ON nhtsa_communications(model_year,make,model);
            """)


def employee_view(db: sqlite3.Connection, employee_id: int) -> dict:
    employee = db.execute("SELECT * FROM employees WHERE id=?", (employee_id,)).fetchone()
    if not employee:
        return {"id": employee_id, "name": "", "active": False, "templates": [], "locations": [], "permissions": [], "base_permissions": [], "overrides": {}}
    templates = [r["name"] for r in db.execute("""
        SELECT pt.name FROM position_templates pt
        JOIN employee_templates et ON et.template_id=pt.id WHERE et.employee_id=? ORDER BY pt.name
    """, (employee_id,))]
    locations = [r["name"] for r in db.execute("""
        SELECT l.name FROM locations l JOIN employee_locations el ON el.location_id=l.id
        WHERE el.employee_id=? ORDER BY l.name
    """, (employee_id,))]
    base_permissions = {r["permission"] for r in db.execute("""
        SELECT tp.permission FROM template_permissions tp
        JOIN employee_templates et ON et.template_id=tp.template_id WHERE et.employee_id=?
    """, (employee_id,))}
    permissions = set(base_permissions)
    overrides = {}
    for row in db.execute("SELECT permission, allowed FROM employee_permission_overrides WHERE employee_id=?", (employee_id,)):
        overrides[row["permission"]] = bool(row["allowed"])
        permissions.add(row["permission"]) if row["allowed"] else permissions.discard(row["permission"])
    emp_keys = employee.keys()
    return {
        "id": employee["id"],
        "name": employee["name"],
        "active": bool(employee["active"]),
        "phone": employee["phone"] if "phone" in emp_keys else "",
        "address": employee["address"] if "address" in emp_keys else "",
        "sin": employee["sin"] if "sin" in emp_keys else "",
        "emergency_contact_name": employee["emergency_contact_name"] if "emergency_contact_name" in emp_keys else "",
        "emergency_contact_phone": employee["emergency_contact_phone"] if "emergency_contact_phone" in emp_keys else "",
        "medical_alert": employee["medical_alert"] if "medical_alert" in emp_keys else "",
        "work_days": employee["work_days"] if "work_days" in emp_keys else "MON,TUE,WED,THU,FRI",
        "daily_productive_hours": float(employee["daily_productive_hours"]) if "daily_productive_hours" in emp_keys and employee["daily_productive_hours"] is not None else 8.0,
        "templates": templates,
        "locations": locations,
        "permissions": sorted(permissions),
        "base_permissions": sorted(base_permissions),
        "overrides": overrides
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def json_response(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def current_employee_id(self) -> int | None:
        auth = self.headers.get("Authorization", "")
        return SESSIONS.get(auth.removeprefix("Bearer ")) if auth.startswith("Bearer ") else None

    def require_permission(self, permission: str) -> int | None:
        employee_id = self.current_employee_id()
        if employee_id:
            with connect() as db:
                emp = employee_view(db, employee_id)
                if emp and emp.get("active") and permission in emp["permissions"]:
                    return employee_id
        self.json_response({"error": "Access denied"}, HTTPStatus.FORBIDDEN)
        return None

    def require_any_permission(self, *permissions: str) -> int | None:
        employee_id = self.current_employee_id()
        if employee_id:
            with connect() as db:
                emp = employee_view(db, employee_id)
                if emp and emp.get("active") and any(p in emp["permissions"] for p in permissions):
                    return employee_id
        self.json_response({"error": "Access denied"}, HTTPStatus.FORBIDDEN)
        return None

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        filename = path.rsplit("/", 1)[-1]
        if filename.startswith(".") or filename.endswith((".db", ".py", ".sh", ".db-journal", ".db-wal", ".sqlite")):
            self.json_response({"error": "Access denied"}, HTTPStatus.FORBIDDEN)
            return
        if path.startswith("/api/dev/diagnostics/"):
            if not check_dev_mode(self):
                return

        if path == "/api/dev/diagnostics/status":
            health_file = ROOT / ".taktro" / "health.json"
            base_file = ROOT / ".taktro" / "baseline.json"
            health_data = {}
            if health_file.exists():
                try:
                    with open(health_file, "r", encoding="utf-8") as f:
                        health_data = json.load(f)
                except Exception:
                    pass

            base_commit = "none"
            if base_file.exists():
                try:
                    with open(base_file, "r", encoding="utf-8") as f:
                        base_commit = json.load(f).get("git_commit", "unknown")
                except Exception:
                    pass

            proc = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, timeout=10)
            dirty_count = len([l for l in proc.stdout.splitlines() if l.strip()]) if proc.returncode == 0 else 0

            self.json_response({
                "health": health_data.get("status", "UNKNOWN"),
                "errors": health_data.get("errors", 0),
                "warnings": health_data.get("warnings", 0),
                "baseline_commit": base_commit[:7] if len(base_commit) >= 7 else base_commit,
                "changed_files_count": dirty_count
            })
            return

        if path == "/api/dev/diagnostics/diff":
            with DIAG_LOCK:
                try:
                    proc = subprocess.run([sys.executable, "scripts/system_audit.py", "--diff", "--json"], cwd=ROOT, capture_output=True, text=True, timeout=30)
                except subprocess.TimeoutExpired:
                    self.json_response({"error": "Diagnostic execution timed out"}, HTTPStatus.GATEWAY_TIMEOUT)
                    return
            changes_file = ROOT / ".taktro" / "changes.json"
            changes_data = {}
            if changes_file.exists():
                try:
                    with open(changes_file, "r", encoding="utf-8") as f:
                        changes_data = json.load(f)
                except Exception:
                    pass
            self.json_response(changes_data)
            return

        if path == "/api/management-setup":
            if self.require_permission("shop_setup") is None:
                return
            with connect() as db:
                revision = db.execute(
                    """SELECT * FROM shop_config_revisions WHERE shop_id=1
                       ORDER BY CASE status WHEN 'DRAFT' THEN 0 WHEN 'ACTIVE' THEN 1 ELSE 2 END,id DESC LIMIT 1"""
                ).fetchone()
                revision_id = int(revision["id"]) if revision else 0
                profile = db.execute("SELECT * FROM shop_profile_configs WHERE revision_id=?", (revision_id,)).fetchone()
                taxes = [dict(row) for row in db.execute(
                    "SELECT * FROM tax_profiles WHERE revision_id=? ORDER BY name", (revision_id,))]
                for tax in taxes:
                    tax["rules"] = [dict(row) for row in db.execute(
                        "SELECT * FROM tax_rules WHERE tax_profile_id=? ORDER BY compound_order,charge_type", (tax["id"],))]
                vendors = [dict(row) for row in db.execute("SELECT * FROM parts_vendors ORDER BY active DESC,name")]
                for vendor in vendors:
                    vendor["contacts"] = [dict(row) for row in db.execute(
                        "SELECT * FROM vendor_contacts WHERE vendor_id=? ORDER BY active DESC,is_primary DESC,name", (vendor["id"],))]
                payload = {
                    "revision": dict(revision) if revision else {},
                    "profile": dict(profile) if profile else {},
                    "taxes": taxes,
                    "fees": [dict(row) for row in db.execute("SELECT * FROM fee_rules WHERE revision_id=? ORDER BY fee_type", (revision_id,))],
                    "rates": [dict(row) for row in db.execute(
                        """SELECT r.*,lc.code AS labor_class_code FROM labor_rate_rules r
                           JOIN labor_classes lc ON lc.id=r.labor_class_id WHERE r.revision_id=? ORDER BY r.pay_type,lc.code""", (revision_id,))],
                    "payer_programs": [dict(row) for row in db.execute("SELECT * FROM payer_programs WHERE revision_id=? ORDER BY pay_type,name", (revision_id,))],
                    "customer_types": [dict(row) for row in db.execute("SELECT * FROM customer_type_rules WHERE revision_id=? ORDER BY name", (revision_id,))],
                    "vendors": vendors,
                }
            self.json_response(payload)
            return
        if path == "/api/setup/status":
            if self.require_permission("shop_setup") is None:
                return
            with connect() as db:
                revisions = [dict(row) for row in db.execute(
                    """SELECT r.*,s.name AS shop_name,l.name AS location_name
                       FROM shop_config_revisions r
                       JOIN shops s ON s.id=r.shop_id
                       LEFT JOIN locations l ON l.id=r.scope_location_id
                       ORDER BY r.id DESC"""
                )]
                counts = {
                    "shops": db.execute("SELECT COUNT(*) FROM shops WHERE active=1").fetchone()[0],
                    "locations": db.execute("SELECT COUNT(*) FROM locations WHERE active=1").fetchone()[0],
                    "active_revisions": db.execute(
                        "SELECT COUNT(*) FROM shop_config_revisions WHERE status='ACTIVE'"
                    ).fetchone()[0],
                    "draft_revisions": db.execute(
                        "SELECT COUNT(*) FROM shop_config_revisions WHERE status='DRAFT'"
                    ).fetchone()[0],
                }
            self.json_response({"status": "NOT_CONFIGURED" if not revisions else "CONFIGURED",
                                "counts": counts, "revisions": revisions})
            return
        if path == "/api/operational-config":
            employee_id = self.require_any_permission("appointments", "repair_orders")
            if employee_id is None:
                return
            config = {
                "labor_rate": 150.0,
                "daily_capacity_hours": 40.0,
                "booking_target_percent": 100.0,
                "reserve_hours": 0.0,
                "open_weekdays": [1, 2, 3, 4, 5],
                "source": "SAFE_DEFAULTS",
            }
            with connect() as db:
                location = db.execute(
                    """SELECT l.* FROM locations l JOIN employee_locations e ON e.location_id=l.id
                       WHERE e.employee_id=? ORDER BY l.id LIMIT 1""", (employee_id,),
                ).fetchone()
                if location and location["shop_id"]:
                    revision_id = setup_resolvers.active_revision_id(db, int(location["shop_id"]), int(location["id"]))
                    if revision_id:
                        rate = db.execute(
                            """SELECT hourly_rate FROM labor_rate_rules
                               WHERE revision_id=? AND pay_type='C'
                                 AND (location_id=? OR location_id IS NULL)
                               ORDER BY CASE WHEN location_id=? THEN 0 ELSE 1 END,id DESC LIMIT 1""",
                            (revision_id, location["id"], location["id"]),
                        ).fetchone()
                        policy = db.execute(
                            "SELECT * FROM capacity_policies WHERE revision_id=? AND location_id=?",
                            (revision_id, location["id"]),
                        ).fetchone()
                        hours = db.execute(
                            "SELECT weekday,closed FROM business_hours WHERE revision_id=? AND location_id=?",
                            (revision_id, location["id"]),
                        ).fetchall()
                        scheduled = db.execute(
                            """SELECT AVG(day_hours) FROM (
                                   SELECT work_date,SUM(productive_hours) day_hours FROM technician_schedules
                                   WHERE revision_id=? AND location_id=? GROUP BY work_date
                               )""", (revision_id, location["id"]),
                        ).fetchone()[0]
                        if rate:
                            config["labor_rate"] = float(rate["hourly_rate"])
                        if scheduled is not None:
                            config["daily_capacity_hours"] = float(scheduled)
                        if policy:
                            config["booking_target_percent"] = float(policy["booking_target_percent"])
                            config["reserve_hours"] = float(policy["reserve_hours"])
                            config["daily_capacity_hours"] = max(
                                0.0,
                                config["daily_capacity_hours"] * config["booking_target_percent"] / 100
                                - config["reserve_hours"],
                            )
                        if hours:
                            config["open_weekdays"] = [int(row["weekday"]) for row in hours if not row["closed"]]
                        config["source"] = "ACTIVE_SHOP_CONFIG"
            self.json_response({"config": config})
            return
        if path == "/api/customers":
            if self.require_permission("customers") is None:
                return
            query = parse_qs(urlparse(self.path).query).get("q", [""])[0].strip()
            with connect() as db:
                if not query:
                    customers = [dict(row) for row in db.execute("SELECT * FROM customers ORDER BY name LIMIT 50")]
                else:
                    pattern = f"%{query}%"
                    customers = [dict(row) for row in db.execute("""
                        SELECT DISTINCT c.* FROM customers c LEFT JOIN vehicles v ON v.customer_id=c.id
                        WHERE c.name LIKE ? COLLATE NOCASE OR c.phone LIKE ? COLLATE NOCASE
                           OR c.email LIKE ? COLLATE NOCASE OR c.company_name LIKE ? COLLATE NOCASE
                           OR c.fleet_unit_number LIKE ? COLLATE NOCASE OR c.contact_person LIKE ? COLLATE NOCASE
                           OR c.fleet_card_details LIKE ? COLLATE NOCASE OR v.plate LIKE ? COLLATE NOCASE
                        ORDER BY c.name LIMIT 50
                    """, (pattern,) * 8)]
            self.json_response({"customers": customers})
            return
        if path == "/api/customer-types":
            if self.require_permission("customers") is None:
                return
            with connect() as db:
                revision_id = setup_resolvers.active_revision_id(db, 1)
                rows = [dict(row) for row in db.execute(
                    "SELECT * FROM customer_type_rules WHERE revision_id=? AND active=1 ORDER BY name", (revision_id or 0,))]
            if not rows:
                rows = [{"code": code, "name": name} for code, name in (
                    ("RETAIL", "RETAIL"), ("FLEET", "FLEET"), ("COMPANY", "COMPANY"),
                    ("WHOLESALE", "WHOLESALE"), ("INTERNAL", "INTERNAL"),
                )]
            self.json_response({"customer_types": rows})
            return
        if path.startswith("/api/customers/"):
            if self.require_permission("customers") is None:
                return
            customer_id = int(path.rsplit("/", 1)[-1])
            with connect() as db:
                customer = db.execute("SELECT * FROM customers WHERE id=?", (customer_id,)).fetchone()
                if not customer:
                    self.json_response({"error": "Customer not found"}, HTTPStatus.NOT_FOUND)
                    return
                payload = dict(customer)
                payload["vehicles"] = [dict(row) for row in db.execute(
                    "SELECT * FROM vehicles WHERE customer_id=? ORDER BY year DESC,make,model", (customer_id,))]
            self.json_response({"customer": payload})
            return
        if path == "/api/vehicles":
            if self.require_permission("customers") is None:
                return
            query = parse_qs(urlparse(self.path).query).get("q", [""])[0].strip()
            if not query:
                self.json_response({"vehicles": []})
                return
            pattern = f"%{query}%"
            with connect() as db:
                vehicles = [dict(row) for row in db.execute("""
                    SELECT v.*, c.name AS customer_name, c.phone AS customer_phone
                    FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id
                    WHERE c.name LIKE ? COLLATE NOCASE
                       OR v.make LIKE ? COLLATE NOCASE
                       OR v.model LIKE ? COLLATE NOCASE
                       OR v.trim LIKE ? COLLATE NOCASE
                       OR v.vin LIKE ? COLLATE NOCASE
                       OR v.serial_number LIKE ? COLLATE NOCASE
                       OR v.equipment_category LIKE ? COLLATE NOCASE
                       OR v.asset_type LIKE ? COLLATE NOCASE
                       OR v.shop_fleet_type LIKE ? COLLATE NOCASE
                       OR v.plate LIKE ? COLLATE NOCASE
                       OR v.color LIKE ? COLLATE NOCASE
                       OR v.modifications LIKE ? COLLATE NOCASE
                       OR v.notes LIKE ? COLLATE NOCASE
                    ORDER BY is_shop_equipment DESC, owner_name, year DESC, make, model LIMIT 50
                """, (pattern,) * 13)]
            self.json_response({"vehicles": vehicles})
            return
        if path.startswith("/api/vehicles/") and path.endswith("/safety"):
            if self.require_permission("customers") is None:
                return
            try:
                vehicle_id = int(path.split("/")[3])
            except (IndexError, ValueError):
                self.json_response({"error": "Invalid vehicle ID"}, HTTPStatus.BAD_REQUEST)
                return
            with connect() as db:
                vehicle = db.execute("SELECT * FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
                if not vehicle:
                    self.json_response({"error": "Vehicle not found"}, HTTPStatus.NOT_FOUND)
                    return
            with connect_nhtsa() as nhtsa_db:
                communications = nhtsa.search_communications(
                    nhtsa_db, int(vehicle["year"]), vehicle["make"], vehicle["model"]
                )
            recalls = []
            recall_status = "available"
            try:
                recalls = nhtsa.fetch_recalls(int(vehicle["year"]), vehicle["make"], vehicle["model"])
            except Exception:
                recall_status = "unavailable"
            self.json_response({
                "vehicle": {"year": vehicle["year"], "make": vehicle["make"], "model": vehicle["model"]},
                "recalls": recalls,
                "recall_status": recall_status,
                "communications": communications,
            })
            return
        if path.startswith("/api/vin/"):
            if self.require_permission("customers") is None:
                return
            vin = path.rsplit("/", 1)[-1].strip().upper()
            if len(vin) != 17 or any(char in vin for char in "IOQ"):
                self.json_response({"error": "Enter a valid 17-character VIN"}, HTTPStatus.BAD_REQUEST)
                return
            url = f"https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{vin}?format=json"
            try:
                with urllib.request.urlopen(url, timeout=8) as response:
                    decoded = json.load(response)["Results"][0]
            except Exception:
                self.json_response({"error": "VIN decoder is unavailable; fields may be entered manually"}, HTTPStatus.BAD_GATEWAY)
                return
            engine_bits = [decoded.get("DisplacementL"), decoded.get("EngineConfiguration"),
                           f"{decoded.get('EngineCylinders')} CYL" if decoded.get("EngineCylinders") else "",
                           decoded.get("EngineModel")]
            transmission_style = decoded.get("TransmissionStyle", "")
            transmission_speeds = decoded.get("TransmissionSpeeds", "")
            
            # Additional NHTSA fields for transmission detection
            trans_info_bits = [bit for bit in (transmission_style, f"{transmission_speeds}-SPEED" if transmission_speeds else "") if bit]
            
            transmission_lower = transmission_style.lower()
            if "continuously" in transmission_lower or "cvt" in transmission_lower:
                transmission_type = "cvt"
            elif "dual" in transmission_lower or "dct" in transmission_lower:
                transmission_type = "dual-clutch"
            elif "automatic" in transmission_lower or transmission_speeds or "auto" in transmission_lower:
                transmission_type = "automatic"
            elif "manual" in transmission_lower:
                transmission_type = "manual"
            elif transmission_style:
                transmission_type = "other"
            else:
                # If no transmission style is returned by NHTSA, infer standard vehicle specs or mark UNKNOWN
                transmission_type = "unknown"

            drive_type_val = decoded.get("DriveType", "").upper()

            raw_trim = decoded.get("Trim", "").strip() if decoded.get("Trim") else ""
            raw_series = decoded.get("Series", "").strip() if decoded.get("Series") else ""

            # Map Toyota chassis frame codes (e.g. GRN280L/GRN285L/TRN280L/TRN285L) to exact transmission & fluid spec defaults
            if "GRN280" in raw_series or "GRN285" in raw_series or "TRN280" in raw_series or "TRN285" in raw_series:
                transmission_type = "automatic"
                is_4wd = "4WD" in drive_type_val or "4X4" in drive_type_val or "ALL" in drive_type_val
                exact_trans_code = "A750F (4WD)" if is_4wd else "A750E (2WD)"
                trans_info_bits = [f"5-SPEED AUTOMATIC ({exact_trans_code})"]

            clean_trim = raw_trim
            if not clean_trim and raw_series:
                if "GRN285" in raw_series or "GRN280" in raw_series:
                    clean_trim = "SR5 / TRAIL / LIMITED (5TH GEN)"
                elif "/" not in raw_series and not any(char.isdigit() for char in raw_series):
                    clean_trim = raw_series
                else:
                    clean_trim = ""

            # Auto-populate fluid specifications from previously saved shop records matching Year, Make, Model, Trim, Engine, & Transmission
            engine_oil_spec = ""
            trans_fluid_spec = ""
            coolant_spec = ""
            fluid_notes = ""

            model_yr = decoded.get("ModelYear", "")
            make_val = decoded.get("Make", "")
            model_val = decoded.get("Model", "")
            engine_str = " · ".join(bit for bit in engine_bits if bit)
            trans_str = " · ".join(trans_info_bits) if trans_info_bits else ""

            if model_yr and make_val and model_val:
                with connect() as db:
                    # 1. Try exact 6-way match (Year, Make, Model, Trim, Engine, Transmission)
                    match_row = db.execute(
                        """SELECT engine_oil_spec, trans_fluid_spec, coolant_spec, fluid_notes
                           FROM vehicles
                           WHERE year=? AND make=? COLLATE NOCASE AND model=? COLLATE NOCASE
                             AND (trim=? OR trim='') AND (engine=? OR engine='') AND (transmission=? OR transmission='')
                             AND (engine_oil_spec != '' OR trans_fluid_spec != '' OR coolant_spec != '')
                           ORDER BY (CASE WHEN trim=? THEN 4 ELSE 0 END + CASE WHEN engine=? THEN 2 ELSE 0 END + CASE WHEN transmission=? THEN 1 ELSE 0 END) DESC, id DESC LIMIT 1""",
                        (model_yr, make_val, model_val, clean_trim, engine_str, trans_str, clean_trim, engine_str, trans_str)
                    ).fetchone()
                    
                    # 2. Fallback to Year, Make, Model if specific trim/engine match not yet recorded
                    if not match_row:
                        match_row = db.execute(
                            """SELECT engine_oil_spec, trans_fluid_spec, coolant_spec, fluid_notes
                               FROM vehicles
                               WHERE year=? AND make=? COLLATE NOCASE AND model=? COLLATE NOCASE
                                 AND (engine_oil_spec != '' OR trans_fluid_spec != '' OR coolant_spec != '')
                               ORDER BY id DESC LIMIT 1""",
                            (model_yr, make_val, model_val)
                        ).fetchone()

                    if match_row:
                        engine_oil_spec = match_row["engine_oil_spec"] or ""
                        trans_fluid_spec = match_row["trans_fluid_spec"] or ""
                        coolant_spec = match_row["coolant_spec"] or ""
                        fluid_notes = match_row["fluid_notes"] or ""

            self.json_response({"vehicle": {
                "vin": vin, "year": model_yr, "make": make_val,
                "model": model_val, "trim": clean_trim,
                "engine": " · ".join(bit for bit in engine_bits if bit),
                "transmission_type": transmission_type,
                "transmission": " · ".join(trans_info_bits) if trans_info_bits else "",
                "drive_type": decoded.get("DriveType", ""), "body_class": decoded.get("BodyClass", ""),
                "fuel_type": decoded.get("FuelTypePrimary", ""), "error_text": decoded.get("ErrorText", ""),
                "engine_oil_spec": engine_oil_spec,
                "trans_fluid_spec": trans_fluid_spec,
                "coolant_spec": coolant_spec,
                "fluid_notes": fluid_notes,
                "source": "NHTSA vPIC + Shop Knowledge Base"
            }})
            return
        if path == "/api/staff/setup":
            if self.require_permission("staff_admin") is None:
                return
            with connect() as db:
                employees = [employee_view(db, row["id"]) for row in db.execute("SELECT id FROM employees ORDER BY name")]
                templates = [{"id": r["id"], "name": r["name"]} for r in db.execute("SELECT id,name FROM position_templates WHERE active=1 ORDER BY id")]
                locations = [{"id": r["id"], "name": r["name"]} for r in db.execute("SELECT id,name FROM locations WHERE active=1 ORDER BY name")]
            self.json_response({"employees": employees, "templates": templates, "locations": locations,
                                "permission_labels": PERMISSIONS})
            return
        if path == "/api/parts":
            if self.require_any_permission("parts", "repair_orders", "customers", "appointments", "shop_setup") is None:
                return
            params = parse_qs(urlparse(self.path).query)
            query = params.get("q", [""])[0].strip()
            fast_moving = params.get("fast_moving", [""])[0].strip() == "1"
            with connect() as db:
                if fast_moving:
                    parts = parts_queries.get_top_frequent_sold_parts(db)
                else:
                    parts = parts_queries.search_parts(db, query)
                self.json_response({"parts": parts})
                return
        if path.startswith("/api/parts/"):
            if self.require_any_permission("parts", "repair_orders", "customers", "appointments", "shop_setup") is None:
                return
            try:
                part_id = int(path.rsplit("/", 1)[-1])
            except ValueError:
                self.json_response({"error": "Invalid part ID"}, HTTPStatus.BAD_REQUEST)
                return
            with connect() as db:
                part = parts_queries.get_part_by_id(db, part_id)
                if not part:
                    self.json_response({"error": "Part not found"}, HTTPStatus.NOT_FOUND)
                    return
                self.json_response({"part": part})
                return
        if path == "/api/repair-orders":
            if self.require_permission("repair_orders") is None:
                return
            query_params = parse_qs(urlparse(self.path).query)
            limit_val = query_params.get("limit", [None])[0]
            offset_val = query_params.get("offset", ["0"])[0]

            with connect() as db:
                total_count = db.execute("SELECT COUNT(*) FROM repair_orders").fetchone()[0]
                if limit_val is not None:
                    try:
                        lim = int(limit_val)
                        off = int(offset_val)
                        orders = [dict(row) for row in db.execute(
                            """SELECT ro.*, COALESCE(ro.preassigned_technician_id, a.preassigned_technician_id) AS preassigned_technician_id
                               FROM repair_orders ro
                               LEFT JOIN appointments a ON ro.appointment_id = a.id
                               ORDER BY ro.updated_at DESC, ro.id DESC LIMIT ? OFFSET ?""", (lim, off)
                        ).fetchall()]
                    except ValueError:
                        orders = [dict(row) for row in db.execute(
                            """SELECT ro.*, COALESCE(ro.preassigned_technician_id, a.preassigned_technician_id) AS preassigned_technician_id
                               FROM repair_orders ro
                               LEFT JOIN appointments a ON ro.appointment_id = a.id
                               ORDER BY ro.updated_at DESC, ro.id DESC"""
                        ).fetchall()]
                else:
                    orders = [dict(row) for row in db.execute(
                        """SELECT ro.*, COALESCE(ro.preassigned_technician_id, a.preassigned_technician_id) AS preassigned_technician_id
                           FROM repair_orders ro
                           LEFT JOIN appointments a ON ro.appointment_id = a.id
                           ORDER BY ro.updated_at DESC, ro.id DESC"""
                    ).fetchall()]
            with connect() as db:
                charges = {}
                for charge in db.execute("SELECT c.*,p.part_number FROM ro_part_charges c JOIN parts_inventory p ON p.id=c.part_id"):
                    charges.setdefault(charge["ro_number"], []).append(dict(charge))
                for ro in orders:
                    ro["part_charges"] = charges.get(ro["ro_number"], [])
            self.json_response({"repair_orders": orders, "total_count": total_count})
            return
        if path.startswith("/api/repair-orders/"):
            if self.require_permission("repair_orders") is None:
                return
            try:
                ro_id = int(path.rsplit("/", 1)[-1])
            except ValueError:
                self.json_response({"error": "Invalid repair-order ID"}, HTTPStatus.BAD_REQUEST)
                return
            with connect() as db:
                row = db.execute(
                    """SELECT ro.*, COALESCE(ro.preassigned_technician_id, a.preassigned_technician_id) AS preassigned_technician_id
                       FROM repair_orders ro
                       LEFT JOIN appointments a ON ro.appointment_id = a.id
                       WHERE ro.id=?""", (ro_id,)
                ).fetchone()
            if not row:
                self.json_response({"error": "Repair order not found"}, HTTPStatus.NOT_FOUND)
                return
            self.json_response({"repair_order": dict(row)})
            return
        if path == "/api/appointments":
            if self.require_permission("appointments") is None:
                return
            
            # Extract query parameters for date-range windowing and deferred filtering
            query_params = parse_qs(urlparse(self.path).query)
            start_date = query_params.get("start_date", [None])[0]
            end_date = query_params.get("end_date", [None])[0]
            is_deferred = query_params.get("deferred", ["false"])[0] == "true" or query_params.get("status", [""])[0] == "DEFERRED"
            
            with connect() as db:
                if is_deferred:
                    appointments = [dict(row) for row in db.execute(
                        """SELECT * FROM appointments 
                           WHERE status = 'DEFERRED' 
                           ORDER BY id DESC"""
                    ).fetchall()]
                elif start_date and end_date:
                    appointments = [dict(row) for row in db.execute(
                        """SELECT * FROM appointments 
                           WHERE status != 'CANCELLED' 
                             AND appointment_date >= ? AND appointment_date <= ? 
                           ORDER BY id DESC""",
                        (start_date, end_date)
                    ).fetchall()]
                else:
                    appointments = [dict(row) for row in db.execute(
                        "SELECT * FROM appointments WHERE status != 'CANCELLED' ORDER BY id DESC"
                    ).fetchall()]

                # Pre-fetch operational profiles for ACTIVE shop configuration
                profiles = {}
                for r in db.execute(
                    """SELECT top.employee_id, top.productive_target_percent
                       FROM technician_operational_profiles top
                       JOIN shop_config_revisions scr ON scr.id=top.revision_id AND scr.status='ACTIVE'
                       WHERE top.scheduling_active=1"""
                ).fetchall():
                    profiles[int(r["employee_id"])] = float(r["productive_target_percent"])

                # Pre-fetch custom technician schedules for ACTIVE shop configuration
                schedules = {}
                for r in db.execute(
                    """SELECT ts.employee_id, ts.work_date, ts.productive_hours
                       FROM technician_schedules ts
                       JOIN shop_config_revisions scr ON scr.id=ts.revision_id AND scr.status='ACTIVE'"""
                ).fetchall():
                    schedules[(r["work_date"], int(r["employee_id"]))] = float(r["productive_hours"])

                # Pre-fetch total assigned hours per tech per date
                assigned_hours = {}
                if start_date and end_date:
                    ah_rows = db.execute(
                        """SELECT appointment_date, preassigned_technician_id, SUM(estimated_hours)
                           FROM appointments
                           WHERE preassigned_technician_id IS NOT NULL 
                             AND appointment_date >= ? AND appointment_date <= ?
                             AND status IN ('SCHEDULED','CONVERTED')
                           GROUP BY appointment_date, preassigned_technician_id""",
                        (start_date, end_date)
                    ).fetchall()
                else:
                    ah_rows = db.execute(
                        """SELECT appointment_date, preassigned_technician_id, SUM(estimated_hours)
                           FROM appointments
                           WHERE preassigned_technician_id IS NOT NULL AND appointment_date IS NOT NULL
                             AND status IN ('SCHEDULED','CONVERTED')
                           GROUP BY appointment_date, preassigned_technician_id"""
                    ).fetchall()

                for r in ah_rows:
                    assigned_hours[(r[0], int(r[1]))] = float(r[2])

                for appointment in appointments:
                    tech_id = appointment.get("preassigned_technician_id")
                    appt_date = appointment.get("appointment_date")
                    if tech_id and appt_date:
                        tech_id = int(tech_id)
                        # Determine daily capacity limit
                        if (appt_date, tech_id) in schedules:
                            limit = max(0.0, schedules[(appt_date, tech_id)])
                        else:
                            target = profiles.get(tech_id, 100.0)
                            limit = max(0.0, 8.0 * target / 100.0)
                        appointment["technician_daily_limit"] = limit
                        appointment["technician_assigned_hours"] = assigned_hours.get((appt_date, tech_id), 0.0)

                self.json_response({"appointments": appointments})
                return
        if path == "/api/technicians":
            if self.require_any_permission("appointments", "repair_orders") is None:
                return
            with connect() as db:
                technicians = [dict(row) for row in db.execute(
                    """SELECT DISTINCT e.id,e.name
                       FROM employees e
                       LEFT JOIN employee_templates et ON et.employee_id=e.id
                       LEFT JOIN position_templates pt ON pt.id=et.template_id
                       LEFT JOIN technician_operational_profiles top ON top.employee_id=e.id
                       LEFT JOIN shop_config_revisions tscr ON tscr.id=top.revision_id AND tscr.status='ACTIVE'
                       WHERE e.active=1
                         AND (pt.name='Technician' OR (top.scheduling_active=1 AND tscr.id IS NOT NULL))
                       ORDER BY e.name"""
                )]
            self.json_response({"technicians": technicians})
            return
        if path == "/api/history":
            if self.require_any_permission("appointments", "repair_orders", "cashout") is None:
                return
            qs = parse_qs(urlparse(self.path).query)
            query_str = str(qs.get("query", [""])[0]).strip().upper()
            job_type = str(qs.get("job_type", [""])[0]).strip().upper()
            status_param = str(qs.get("status", [""])[0]).strip().lower()
            start_date = str(qs.get("start_date", [""])[0]).strip()
            end_date = str(qs.get("end_date", [""])[0]).strip()
            sort_order = "ASC" if str(qs.get("sort", ["DESC"])[0]).strip().upper() == "ASC" else "DESC"

            with connect() as db:
                sql = """SELECT ro.*, COALESCE(ro.preassigned_technician_id, a.preassigned_technician_id) AS preassigned_technician_id
                         FROM repair_orders ro
                         LEFT JOIN appointments a ON ro.appointment_id = a.id
                         WHERE 1=1"""
                params = []

                if status_param:
                    sql += " AND LOWER(ro.status) = ?"
                    params.append(status_param)

                if query_str:
                    like_q = f"%{query_str}%"
                    sql += " AND (UPPER(ro.customer_name) LIKE ? OR UPPER(ro.vehicle_info) LIKE ? OR UPPER(ro.vin) LIKE ? OR UPPER(ro.license_plate) LIKE ? OR UPPER(ro.ro_number) LIKE ? OR UPPER(ro.lines_json) LIKE ?)"
                    params.extend([like_q, like_q, like_q, like_q, like_q, like_q])

                if job_type:
                    sql += " AND UPPER(ro.lines_json) LIKE ?"
                    like_job = f"%{job_type}%"
                    params.append(like_job)

                if start_date:
                    sql += " AND ro.created_at >= ?"
                    params.append(start_date)
                if end_date:
                    sql += " AND ro.created_at <= ?"
                    params.append(end_date + " 23:59:59")

                sql += f" ORDER BY ro.id {sort_order} LIMIT 150"
                repair_order_records = [dict(row) for row in db.execute(sql, params).fetchall()]

                for ro in repair_order_records:
                    try:
                        ro["lines"] = json.loads(ro.get("lines_json") or "[]")
                    except Exception:
                        ro["lines"] = []

            self.json_response({
                "query": query_str,
                "repair_orders": repair_order_records,
                "count": len(repair_order_records)
            })
            return
        if path == "/api/job-codes":
            if self.require_permission("repair_orders") is None:
                return
            with connect() as db:
                codes = [dict(row) for row in db.execute(
                    """SELECT j.*, creator.name AS created_by_name, modifier.name AS modified_by_name
                       FROM custom_job_codes j
                       LEFT JOIN employees creator ON creator.id=j.created_by
                       LEFT JOIN employees modifier ON modifier.id=j.modified_by
                       WHERE j.active=1 ORDER BY j.category,j.code"""
                )]
            self.json_response({"job_codes": codes})
            return
        super().do_GET()

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        path_parts = path.strip("/").split("/")
        if len(path_parts) == 3 and path_parts[:2] == ["api", "appointments"]:
            actor_id = self.require_permission("appointments")
            if actor_id is None:
                return
            try:
                appt_id = int(path_parts[2])
            except (IndexError, ValueError):
                self.json_response({"error": "Invalid appointment ID"}, HTTPStatus.BAD_REQUEST)
                return
            with connect() as db:
                row = db.execute("SELECT * FROM appointments WHERE id=?", (appt_id,)).fetchone()
                if not row:
                    self.json_response({"error": "Appointment not found"}, HTTPStatus.NOT_FOUND)
                    return
                if db.execute("SELECT 1 FROM repair_orders WHERE appointment_id=?", (appt_id,)).fetchone():
                    self.json_response(
                        {"error": "Appointment is linked to a repair order and cannot be permanently deleted"},
                        HTTPStatus.CONFLICT,
                    )
                    return
                details = {
                    "customer": row["customer_name"],
                    "vehicle": row["vehicle_info"],
                    "date": row["appointment_date"],
                    "time": row["promised_time"],
                    "status": row["status"],
                }
                db.execute("DELETE FROM appointments WHERE id=?", (appt_id,))
                db.execute(
                    "INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                    (actor_id, "appointment.delete", "appointment", str(appt_id), json.dumps(details), utc_now()),
                )
            self.json_response({"deleted": True, "appointment_id": appt_id})
            return
        self.json_response({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            data = self.read_json()
            if path == "/api/login":
                pin = str(data.get("pin", ""))
                if not (pin.isdigit() and len(pin) == 4):
                    self.json_response({"error": "Enter a 4-digit PIN"}, HTTPStatus.BAD_REQUEST)
                    return
                with connect() as db:
                    match = next((row for row in db.execute("SELECT id,pin_hash FROM employees WHERE active=1") if verify_pin(pin, row["pin_hash"])), None)
                    if not match:
                        self.json_response({"error": "PIN not recognized"}, HTTPStatus.UNAUTHORIZED)
                        return
                    token = secrets.token_urlsafe(32)
                    SESSIONS[token] = match["id"]
                    employee = employee_view(db, match["id"])
                    db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,created_at) VALUES (?,?,?,?,?)",
                               (match["id"], "session.login", "employee", str(match["id"]), utc_now()))
                self.json_response({"token": token, "employee": employee})
                return
            if path == "/api/management-setup":
                actor_id = self.require_permission("shop_setup")
                if actor_id is None:
                    return
                action = str(data.get("action", "SAVE_DRAFT")).strip().upper()
                if action not in {"SAVE_DRAFT", "PUBLISH"}:
                    self.json_response({"error": "Action must be SAVE_DRAFT or PUBLISH"}, HTTPStatus.BAD_REQUEST)
                    return
                profile = dict(data.get("profile") or {})
                if str(profile.get("country_code", "CA")).upper() != "CA":
                    self.json_response({"error": "This release is configured for Canadian business and tax structure"}, HTTPStatus.BAD_REQUEST)
                    return
                with connect() as db:
                    revision = db.execute("SELECT * FROM shop_config_revisions WHERE shop_id=1 AND status='DRAFT' ORDER BY id DESC LIMIT 1").fetchone()
                    if revision:
                        revision_id = int(revision["id"])
                    else:
                        base = db.execute("SELECT id FROM shop_config_revisions WHERE shop_id=1 AND status='ACTIVE' ORDER BY id DESC LIMIT 1").fetchone()
                        cur = db.execute(
                            """INSERT INTO shop_config_revisions(shop_id,based_on_revision_id,status,version_label,change_summary,created_by,created_at)
                               VALUES (1,?,'DRAFT',?,?,?,?)""",
                            (base["id"] if base else None, str(data.get("version_label", "MANAGEMENT UPDATE"))[:80],
                             str(data.get("change_summary", "MANAGEMENT SETUP UPDATE"))[:300], actor_id, utc_now()),
                        )
                        revision_id = int(cur.lastrowid)
                    allowed_profile = (
                        "legal_name","invoice_name","address_line_1","address_line_2","city","region","postal_code",
                        "country_code","phone","email","tax_registration_id","invoice_footer","warranty_wording",
                        "currency_code","timezone_name","promised_time_buffer_minutes","ro_prefix","po_prefix",
                        "business_number","business_structure","business_license_number",
                    )
                    values = {key: profile.get(key, "") for key in allowed_profile}
                    values["country_code"] = str(values["country_code"] or "CA").upper()
                    values["currency_code"] = str(values["currency_code"] or "CAD").upper()
                    values["timezone_name"] = str(values["timezone_name"] or "America/Edmonton")
                    values["promised_time_buffer_minutes"] = max(0, int(values["promised_time_buffer_minutes"] or 30))
                    values["ro_prefix"] = str(values["ro_prefix"] or "RO").upper()[:10]
                    values["po_prefix"] = str(values["po_prefix"] or "PO").upper()[:10]
                    columns = ",".join(allowed_profile)
                    placeholders = ",".join("?" for _ in allowed_profile)
                    updates = ",".join(f"{key}=excluded.{key}" for key in allowed_profile)
                    db.execute(
                        f"INSERT INTO shop_profile_configs(revision_id,{columns}) VALUES (?,{placeholders}) ON CONFLICT(revision_id) DO UPDATE SET {updates}",
                        (revision_id, *(values[key] for key in allowed_profile)),
                    )

                    for table in ("labor_rate_rules", "tax_profiles", "fee_rules", "payer_programs", "customer_type_rules"):
                        db.execute(f"DELETE FROM {table} WHERE revision_id=?", (revision_id,))
                    labor_class_id = db.execute("SELECT id FROM labor_classes WHERE code='GENERAL'").fetchone()["id"]
                    effective = date.today().isoformat()
                    for row in list(data.get("rates") or []):
                        pay = str(row.get("pay_type", "C")).upper()
                        if pay not in {"C", "W", "I"}:
                            raise ValueError("Base rate pay type must be C, W, or I; Goodwill uses a payer program")
                        db.execute(
                            """INSERT INTO labor_rate_rules(revision_id,pay_type,labor_class_id,hourly_rate,effective_from,name)
                               VALUES (?,?,?,?,?,?)""",
                            (revision_id, pay, labor_class_id, max(0, float(row.get("hourly_rate", 0))), effective,
                             str(row.get("name") or f"{pay} GENERAL RATE")[:80]),
                        )
                    for row in list(data.get("taxes") or []):
                        cur = db.execute(
                            """INSERT INTO tax_profiles(revision_id,name,registration_id,inclusive,rounding_method,exempt_customer_behavior,effective_from)
                               VALUES (?,?,?,?, 'HALF_UP','EXEMPT',?)""",
                            (revision_id, str(row.get("name") or "GST")[:80], str(row.get("registration_id", ""))[:40],
                             int(bool(row.get("inclusive", False))), effective),
                        )
                        rate = max(0, float(row.get("rate", 0))) / 100.0
                        for charge_type in ("LABOR", "PARTS", "FEES"):
                            db.execute("INSERT INTO tax_rules(tax_profile_id,charge_type,rate) VALUES (?,?,?)", (cur.lastrowid, charge_type, rate))
                    for row in list(data.get("fees") or []):
                        fee_type = str(row.get("fee_type", "SHOP_SUPPLIES")).upper()
                        calculation = str(row.get("calculation_type", "DISABLED")).upper()
                        db.execute(
                            """INSERT INTO fee_rules(revision_id,fee_type,calculation_type,basis_type,rate_or_amount,minimum_amount,maximum_amount,
                               customer_description,effective_from) VALUES (?,?,?,?,?,?,?,?,?)""",
                            (revision_id, fee_type, calculation, str(row.get("basis_type", "LABOR")).upper(),
                             max(0, float(row.get("rate_or_amount", 0))), row.get("minimum_amount") or None,
                             row.get("maximum_amount") or None, str(row.get("customer_description") or fee_type.replace("_", " "))[:100], effective),
                        )
                    for row in list(data.get("payer_programs") or []):
                        pay = str(row.get("pay_type", "W")).upper()
                        if pay not in {"W", "I", "G"}:
                            raise ValueError("Payer program must be Warranty, Internal, or Goodwill")
                        db.execute(
                            """INSERT INTO payer_programs(revision_id,pay_type,name,vendor_id,labor_method,labor_value,parts_method,parts_value,
                               manager_approval_required,active,note) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                            (revision_id, pay, str(row.get("name") or "DEFAULT")[:80], row.get("vendor_id") or None,
                             str(row.get("labor_method", "DOOR_PERCENT")).upper(), max(0, float(row.get("labor_value", 100))),
                             str(row.get("parts_method", "ACTUAL")).upper(), max(0, float(row.get("parts_value", 100))),
                             int(bool(row.get("manager_approval_required", False))), int(bool(row.get("active", True))), str(row.get("note", ""))[:300]),
                        )
                    for row in list(data.get("customer_types") or []):
                        code = str(row.get("code", "")).strip().upper().replace(" ", "_")[:30]
                        if not code:
                            continue
                        db.execute(
                            """INSERT INTO customer_type_rules(revision_id,code,name,parts_adjustment_percent,labor_adjustment_percent,
                               minimum_job_total,manager_override_required,active,note) VALUES (?,?,?,?,?,?,?,?,?)""",
                            (revision_id, code, str(row.get("name") or code)[:80], float(row.get("parts_adjustment_percent", 0)),
                             float(row.get("labor_adjustment_percent", 0)), row.get("minimum_job_total") or None,
                             int(bool(row.get("manager_override_required", True))), int(bool(row.get("active", True))), str(row.get("note", ""))[:300]),
                        )
                    if action == "PUBLISH":
                        db.execute("UPDATE shop_config_revisions SET status='REVIEWED',reviewed_by=?,reviewed_at=? WHERE id=?", (actor_id, utc_now(), revision_id))
                        db.execute("UPDATE shop_config_revisions SET status='SUPERSEDED',superseded_at=? WHERE shop_id=1 AND status='ACTIVE'", (utc_now(),))
                        db.execute("UPDATE shop_config_revisions SET status='ACTIVE',published_by=?,published_at=? WHERE id=?", (actor_id, utc_now(), revision_id))
                    db.execute(
                        "INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                        (actor_id, "shop_setup.publish" if action == "PUBLISH" else "shop_setup.save_draft", "shop_config_revision", str(revision_id),
                         json.dumps({"action": action, "legal_name": values["legal_name"]}), utc_now()),
                    )
                self.json_response({"saved": True, "revision_id": revision_id, "status": "ACTIVE" if action == "PUBLISH" else "DRAFT"})
                return
            if path == "/api/vendors":
                actor_id = self.require_permission("shop_setup")
                if actor_id is None:
                    return
                name = str(data.get("name", "")).strip().upper()
                if not name:
                    self.json_response({"error": "Vendor name is required"}, HTTPStatus.BAD_REQUEST)
                    return
                now = utc_now()
                fields = ("account_number","category","ordering_phone","ordering_email","ordering_method","cutoff_time","delivery_note",
                          "terms_note","returns_core_note","warranty_link","operational_note","country_code","currency_code",
                          "address_line_1","city","region","postal_code","tax_id")
                vals = [str(data.get(key, "")).strip() for key in fields]
                vals[1] = vals[1].upper() or "PARTS"
                vals[-2] = vals[-2].upper() or "CA"
                vals[-1] = vals[-1].upper() or "CAD"
                with connect() as db:
                    vendor_id = int(data.get("id") or 0)
                    if vendor_id:
                        assignments = ",".join(f"{key}=?" for key in fields)
                        db.execute(f"UPDATE parts_vendors SET name=?,{assignments},active=?,updated_at=? WHERE id=?",
                                   (name, *vals, int(bool(data.get("active", True))), now, vendor_id))
                    else:
                        columns = ",".join(fields)
                        placeholders = ",".join("?" for _ in fields)
                        cur = db.execute(f"INSERT INTO parts_vendors(name,{columns},active,created_at,updated_at) VALUES (?,{placeholders},?,?,?)",
                                         (name, *vals, int(bool(data.get("active", True))), now, now))
                        vendor_id = int(cur.lastrowid)
                    db.execute("DELETE FROM vendor_contacts WHERE vendor_id=?", (vendor_id,))
                    for contact in list(data.get("contacts") or []):
                        contact_name = str(contact.get("name", "")).strip().upper()
                        if not contact_name:
                            continue
                        db.execute(
                            """INSERT INTO vendor_contacts(vendor_id,name,function,phone,extension,email,preferred_method,is_primary,active,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                            (vendor_id, contact_name, str(contact.get("function", "")).upper(), str(contact.get("phone", "")),
                             str(contact.get("extension", "")), str(contact.get("email", "")), str(contact.get("preferred_method", "")).upper(),
                             int(bool(contact.get("is_primary", False))), int(bool(contact.get("active", True))), now, now),
                        )
                    db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                               (actor_id, "vendor.save", "vendor", str(vendor_id), json.dumps({"name": name}), now))
                self.json_response({"saved": True, "vendor_id": vendor_id})
                return
            if path == "/api/setup/preview":
                if self.require_permission("shop_setup") is None:
                    return
                preview_type = str(data.get("type", "")).strip().upper()
                try:
                    if preview_type == "LABOR_RATE":
                        with connect() as db:
                            result = setup_resolvers.resolve_labor_rate(
                                db,
                                shop_id=int(data.get("shop_id", 0)),
                                location_id=int(data.get("location_id", 0)),
                                pay_type=str(data.get("pay_type", "C")),
                                labor_class_code=str(data.get("labor_class_code", "")),
                                customer_id=int(data["customer_id"]) if data.get("customer_id") else None,
                                ro_override=float(data["ro_override"]) if data.get("ro_override") is not None else None,
                                effective_on=str(data.get("effective_on", "")) or None,
                            )
                    elif preview_type == "FEE":
                        result = {"amount": setup_resolvers.calculate_fee(
                            calculation_type=str(data.get("calculation_type", "DISABLED")),
                            rate_or_amount=float(data.get("rate_or_amount", 0)),
                            basis_amount=float(data.get("basis_amount", 0)),
                            units=float(data.get("units", 0)), jobs=float(data.get("jobs", 0)),
                            minimum=float(data["minimum"]) if data.get("minimum") is not None else None,
                            maximum=float(data["maximum"]) if data.get("maximum") is not None else None,
                        )}
                    elif preview_type == "TAX":
                        result = setup_resolvers.calculate_tax(
                            {str(k).upper(): float(v) for k, v in dict(data.get("charge_amounts", {})).items()},
                            {str(k).upper(): float(v) for k, v in dict(data.get("rates", {})).items()},
                        )
                    elif preview_type == "CAPACITY":
                        result = setup_resolvers.calculate_capacity(
                            productive_hours=float(data.get("productive_hours", 0)),
                            booking_target_percent=float(data.get("booking_target_percent", 100)),
                            reserve_hours=float(data.get("reserve_hours", 0)),
                            already_booked_hours=float(data.get("already_booked_hours", 0)),
                        )
                    else:
                        raise ValueError("Preview type must be LABOR_RATE, FEE, TAX, or CAPACITY.")
                    self.json_response({"preview": result})
                except (TypeError, ValueError) as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path == "/api/perf/log":
                events = list(data.get("events") or [])
                now_str = utc_now()
                with open(os.path.join(os.path.dirname(__file__), "perf.log"), "a", encoding="utf-8") as f:
                    for ev in events:
                        f.write(f"[{now_str}] [{ev.get('category','PERF')}] {ev.get('label','')} - {ev.get('duration',0):.1f}ms - Details: {json.dumps(ev.get('details',{}))}\n")
                self.json_response({"logged": True, "count": len(events)})
                return
            if path == "/api/parts":
                actor_id = self.require_permission("parts")
                if actor_id is None:
                    return
                try:
                    with connect() as db:
                        part = parts_service.create_or_update_part(db, data, actor_id=actor_id)
                    self.json_response({"part": part})
                except ValueError as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path.startswith("/api/parts/") and path.endswith("/metadata"):
                actor_id = self.require_permission("parts")
                if actor_id is None:
                    return
                try:
                    part_id = int(path.split("/")[3])
                    home_bin = data.get("home_bin", "")
                    interchange_number = data.get("interchange_number", "")
                    with connect() as db:
                        part = parts_service.update_part_metadata(
                            db, part_id, home_bin=home_bin, interchange_number=interchange_number, actor_id=actor_id
                        )
                    self.json_response({"part": part})
                except (ValueError, IndexError) as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path.startswith("/api/parts/") and path.endswith("/breakout"):
                actor_id = self.require_permission("parts")
                if actor_id is None:
                    return
                try:
                    part_id = int(path.split("/")[3])
                    with connect() as db:
                        child_part = parts_service.breakout_child_unit_part(db, part_id, data, actor_id=actor_id)
                    self.json_response({"part": child_part})
                except (ValueError, IndexError) as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path == "/api/repair-orders/remove-part":
                actor_id = self.require_permission("parts")
                if actor_id is None:
                    return
                try:
                    with connect() as db:
                        result = orders_service.remove_part(db, int(data.get("charge_id", 0)), actor_id, normalize_work_lines)
                    self.json_response(result)
                except (TypeError, ValueError) as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path == "/api/repair-orders/apply-part":
                actor_id = self.require_permission("parts")
                if actor_id is None:
                    return
                ro_number = str(data.get("ro_number", "")).strip().upper()
                try:
                    part_id = int(data.get("part_id", 0))
                    qty = parts_service.whole_quantity(data.get("qty", 0))
                except (ValueError, TypeError):
                    self.json_response({"error": "Invalid part_id or qty"}, HTTPStatus.BAD_REQUEST)
                    return
                job_line = data.get("job_line")
                notes = str(data.get("notes", "")).strip()

                if not ro_number or not part_id or qty <= 0:
                    self.json_response({"error": "ro_number, part_id, and positive qty are required"}, HTTPStatus.BAD_REQUEST)
                    return

                try:
                    with connect() as db:
                        result = orders_service.apply_part(db, ro_number, part_id, qty, job_line,
                                                           actor_id, notes, normalize_work_lines)
                    self.json_response(result)
                except Exception as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path == "/api/repair-orders":
                actor_id = self.require_permission("repair_orders")
                if actor_id is None:
                    return
                customer = str(data.get("customer", "")).strip().upper()
                vehicle = str(data.get("vehicle", "")).strip().upper()
                promised_time = str(data.get("promised_time", "")).strip().upper()
                status = str(data.get("status", "write-up")).strip().lower()
                allowed_statuses = {
                    "write-up", "hold-authorization", "ready-dispatch", "in-progress",
                    "hold-parts", "work-complete", "invoiced",
                }
                if not customer:
                    self.json_response({"error": "Customer name is required"}, HTTPStatus.BAD_REQUEST)
                    return
                if not vehicle:
                    if status == "ready-dispatch":
                        self.json_response({"error": "Vehicle information is required to generate a repair order"}, HTTPStatus.BAD_REQUEST)
                        return
                    vehicle = "UNSPECIFIED VEHICLE"
                if status not in allowed_statuses:
                    self.json_response({"error": "Invalid repair-order status"}, HTTPStatus.BAD_REQUEST)
                    return
                try:
                    lines, totals = normalize_work_lines(data.get("lines", []))
                    ro_id = int(data["id"]) if data.get("id") else None
                    appointment_id = int(data["appointment_id"]) if data.get("appointment_id") else None
                    preassigned_technician_id = int(data["preassigned_technician_id"]) if data.get("preassigned_technician_id") else None
                except (TypeError, ValueError) as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                    return
                if status == "invoiced":
                    if not lines:
                        self.json_response({"error": "An empty repair order cannot be invoiced"}, HTTPStatus.BAD_REQUEST)
                        return
                    for ln in lines:
                        if not ln.get("booked"):
                            self.json_response({"error": "All active job lines must be booked before invoicing"}, HTTPStatus.BAD_REQUEST)
                            return

                snapshots = {
                    key: str(data.get(key, "")).strip().upper()
                    for key in ("license_plate", "vin", "mileage", "fleet_unit", "po_number")
                }
                now = utc_now()
                with connect() as db, parts_service.atomic(db):
                    customer_record = db.execute(
                        "SELECT customer_type,reimbursement_details FROM customers WHERE UPPER(name)=? ORDER BY id DESC LIMIT 1",
                        (customer,),
                    ).fetchone()
                    requires_po = bool(customer_record) and (
                        str(customer_record["customer_type"] or "").upper() in {"FLEET", "COMPANY"}
                        or "PO" in str(customer_record["reimbursement_details"] or "").upper()
                    )
                    if status == "invoiced" and requires_po and not snapshots["po_number"]:
                        self.json_response(
                            {"error": "A purchase order number is required before invoicing this fleet/company repair order"},
                            HTTPStatus.BAD_REQUEST,
                        )
                        return
                    if ro_id:
                        existing = db.execute("SELECT * FROM repair_orders WHERE id=?", (ro_id,)).fetchone()
                        if not existing:
                            self.json_response({"error": "Repair order not found"}, HTTPStatus.NOT_FOUND)
                            return
                        if existing["status"] == "invoiced":
                            if status == "invoiced" and json.loads(existing["lines_json"]) == lines and all(str(existing[column]) == value for column, value in {"customer_name": customer, "vehicle_info": vehicle, **snapshots, "promised_time": promised_time}.items()):
                                self.json_response({"repair_order": dict(existing)})
                            else:
                                self.json_response({"error": "Posted repair orders are immutable."}, HTTPStatus.CONFLICT)
                            return
                        try:
                            orders_service.validate_charges(db, existing["ro_number"], lines)
                            if status == "invoiced":
                                orders_service.post_parts(db, existing["ro_number"], lines, actor_id)
                        except ValueError as err:
                            self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                            return
                        db.execute(
                            """UPDATE repair_orders SET customer_name=?,vehicle_info=?,license_plate=?,vin=?,
                               mileage=?,fleet_unit=?,po_number=?,promised_time=?,status=?,lines_json=?,
                               total_hours=?,customer_total=?,warranty_total=?,internal_total=?,goodwill_total=?,master_total=?,
                               preassigned_technician_id=?,updated_by=?,updated_at=? WHERE id=?""",
                            (customer, vehicle, snapshots["license_plate"], snapshots["vin"], snapshots["mileage"],
                             snapshots["fleet_unit"], snapshots["po_number"], promised_time, status,
                             json.dumps(lines), totals["hours"], totals["C"], totals["W"], totals["I"], totals["G"],
                             totals["master"], preassigned_technician_id, actor_id, now, ro_id),
                        )
                        action = "repair_order.update"
                    else:
                        temporary_number = f"PENDING-{secrets.token_hex(6).upper()}"
                        cur = db.execute(
                            """INSERT INTO repair_orders
                               (ro_number,appointment_id,customer_name,vehicle_info,license_plate,vin,mileage,
                                fleet_unit,po_number,promised_time,status,lines_json,total_hours,customer_total,
                                warranty_total,internal_total,goodwill_total,master_total,preassigned_technician_id,created_by,updated_by,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (temporary_number, appointment_id, customer, vehicle, snapshots["license_plate"],
                             snapshots["vin"], snapshots["mileage"], snapshots["fleet_unit"], snapshots["po_number"],
                             promised_time, status, json.dumps(lines), totals["hours"], totals["C"], totals["W"],
                             totals["I"], totals["G"], totals["master"], preassigned_technician_id, actor_id, actor_id, now, now),
                        )
                        ro_id = int(cur.lastrowid)
                        db.execute("UPDATE repair_orders SET ro_number=? WHERE id=?", (f"RO-{ro_id:06d}", ro_id))
                        action = "repair_order.create"
                    row = dict(db.execute(
                        """SELECT ro.*, COALESCE(ro.preassigned_technician_id, a.preassigned_technician_id) AS preassigned_technician_id
                           FROM repair_orders ro
                           LEFT JOIN appointments a ON ro.appointment_id = a.id
                           WHERE ro.id=?""", (ro_id,)
                    ).fetchone())
                    db.execute(
                        """INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at)
                           VALUES (?,?,?,?,?,?)""",
                        (actor_id, action, "repair_order", str(ro_id),
                         json.dumps({"ro_number": row["ro_number"], "status": status, "totals": totals}), now),
                    )
                self.json_response({"repair_order": row}, HTTPStatus.CREATED if action.endswith("create") else HTTPStatus.OK)
                return
            if path == "/api/job-codes":
                actor_id = self.require_permission("shop_setup")
                if actor_id is None:
                    return
                code = str(data.get("code", "")).strip().upper().replace(" ", "-")
                description = str(data.get("description", "")).strip().upper()
                category = str(data.get("category", "")).strip().upper()
                try:
                    job_id = int(data.get("id", 0))
                    hours = float(data.get("default_hours", 0))
                    parts = float(data.get("default_parts", 0))
                    active = 1 if bool(data.get("active", True)) else 0
                except (TypeError, ValueError):
                    self.json_response({"error": "Hours and parts allowance must be valid numbers"}, HTTPStatus.BAD_REQUEST)
                    return
                if not code or not description or not category:
                    self.json_response({"error": "Code, description, and category are required"}, HTTPStatus.BAD_REQUEST)
                    return
                if not math.isfinite(hours) or not math.isfinite(parts) or hours < 0 or parts < 0:
                    self.json_response({"error": "Hours and parts allowance cannot be negative"}, HTTPStatus.BAD_REQUEST)
                    return
                if len(code) > 24 or len(description) > 120 or len(category) > 40:
                    self.json_response({"error": "One or more job-code fields exceed their maximum length"}, HTTPStatus.BAD_REQUEST)
                    return
                now = utc_now()
                try:
                    with connect() as db:
                        if job_id:
                            existing = db.execute("SELECT * FROM custom_job_codes WHERE id=?", (job_id,)).fetchone()
                            if not existing:
                                self.json_response({"error": "Custom job code not found"}, HTTPStatus.NOT_FOUND)
                                return
                            db.execute(
                                """UPDATE custom_job_codes SET code=?,description=?,category=?,default_hours=?,
                                   default_parts=?,active=?,modified_by=?,updated_at=? WHERE id=?""",
                                (code, description, category, hours, parts, active, actor_id, now, job_id),
                            )
                            action = "job_code.update" if active else "job_code.deactivate"
                        else:
                            cur = db.execute(
                                """INSERT INTO custom_job_codes
                                   (code,description,category,default_hours,default_parts,active,created_by,modified_by,created_at,updated_at)
                                   VALUES (?,?,?,?,?,1,?,?,?,?)""",
                                (code, description, category, hours, parts, actor_id, actor_id, now, now),
                            )
                            job_id = cur.lastrowid
                            action = "job_code.create"
                        db.execute(
                            """INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at)
                               VALUES (?,?,?,?,?,?)""",
                            (actor_id, action, "custom_job_code", str(job_id), json.dumps({
                                "code": code, "description": description, "category": category,
                                "default_hours": hours, "default_parts": parts, "active": bool(active),
                            }), now),
                        )
                        row = dict(db.execute("SELECT * FROM custom_job_codes WHERE id=?", (job_id,)).fetchone())
                    self.json_response({"job_code": row}, HTTPStatus.CREATED if action == "job_code.create" else HTTPStatus.OK)
                except sqlite3.IntegrityError:
                    self.json_response({"error": f"Job code {code} already exists"}, HTTPStatus.CONFLICT)
                return
            if path == "/api/nhtsa/communications/import":
                actor_id = self.require_permission("staff_admin")
                if actor_id is None:
                    return
                archive_range = str(data.get("archive_range", "2025-2026")).strip()
                try:
                    with connect_nhtsa() as nhtsa_db:
                        result = nhtsa.import_communications(nhtsa_db, archive_range)
                    with connect() as db:
                        db.execute(
                            """INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at)
                               VALUES (?,'nhtsa.communications.import','nhtsa_archive',?,?,?)""",
                            (actor_id, archive_range, json.dumps(result), utc_now()),
                        )
                    self.json_response(result)
                except (ValueError, OSError, urllib.error.URLError, zipfile.BadZipFile) as err:
                    self.json_response({"error": f"NHTSA import failed: {err}"}, HTTPStatus.BAD_GATEWAY)
                return
            if path == "/api/parts/receive":
                actor_id = self.require_permission("parts")
                if actor_id is None:
                    return
                try:
                    part_id = int(data.get("part_id", 0))
                    qty = parts_service.whole_quantity(data.get("qty", 0))
                    cost = float(data["cost"]) if "cost" in data and data["cost"] != "" else None
                    bin_loc = str(data.get("bin_location", ""))
                    ref_no = str(data.get("reference_id", ""))
                    notes = str(data.get("notes", ""))
                    with connect() as db:
                        part = parts_service.receive_stock(db, part_id, qty, cost, bin_loc, ref_no, actor_id, notes)
                    self.json_response({"part": part})
                except ValueError as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path == "/api/parts/reserve":
                actor_id = self.require_permission("parts")
                if actor_id is None:
                    return
                try:
                    part_id = int(data.get("part_id", 0))
                    qty = parts_service.whole_quantity(data.get("qty", 0))
                    ro_no = str(data.get("ro_number", ""))
                    notes = str(data.get("notes", ""))
                    with connect() as db:
                        part = parts_service.reserve_stock(db, part_id, qty, ro_no, actor_id, notes)
                    self.json_response({"part": part})
                except ValueError as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path == "/api/parts/release":
                actor_id = self.require_permission("parts")
                if actor_id is None:
                    return
                try:
                    part_id = int(data.get("part_id", 0))
                    qty = parts_service.whole_quantity(data.get("qty", 0))
                    ro_no = str(data.get("ro_number", ""))
                    notes = str(data.get("notes", ""))
                    with connect() as db:
                        part = parts_service.release_stock(db, part_id, qty, ro_no, actor_id, notes)
                    self.json_response({"part": part})
                except ValueError as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path == "/api/parts/consume":
                if self.require_permission("parts") is None:
                    return
                self.json_response({"error": "RO parts are consumed atomically when the repair order is invoiced."}, HTTPStatus.BAD_REQUEST)
                return
            if path == "/api/parts/counter-sale":
                actor_id = self.require_permission("parts")
                if actor_id is None:
                    return
                items = data.get("items", [])
                if not items or not isinstance(items, list):
                    self.json_response({"error": "Items list is required for counter sale"}, HTTPStatus.BAD_REQUEST)
                    return
                cust_name = str(data.get("customer_name", "CASH CUSTOMER")).strip().upper()
                cust_phone = str(data.get("customer_phone", "")).strip()
                payment_method = str(data.get("payment_method", "CASH")).strip().upper()
                if payment_method not in {"CASH", "CREDIT CARD", "DEBIT CARD", "CHECK"}:
                    self.json_response({"error": "Invalid payment method"}, HTTPStatus.BAD_REQUEST)
                    return
                now_str = utc_now()
                inv_no = f"INV-OTC-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"

                try:
                    with connect() as db:
                        validated = []
                        total_amount = 0.0
                        for it in items:
                            part_id = int(it.get("part_id", 0))
                            qty = int(it.get("qty", 0))
                            unit_price = float(it.get("unit_price", 0.0))
                            if qty <= 0:
                                raise ValueError("Item quantity must be greater than zero.")
                            if not math.isfinite(unit_price) or unit_price < 0:
                                raise ValueError("Item price must be a finite, non-negative amount.")
                            part = db.execute("SELECT * FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
                            if not part:
                                raise ValueError(f"Part #{part_id} not found.")
                            on_hand = int(part["qty_on_hand"])
                            reserved = int(part["qty_reserved"])
                            unreserved = on_hand - reserved
                            if qty > unreserved:
                                raise ValueError(f"Cannot sell {qty} of {part['part_number']}; only {unreserved} unreserved units available ({reserved} reserved).")
                            item_total = qty * unit_price
                            total_amount += item_total
                            validated.append((part, qty, unit_price))

                        updated_parts = []
                        for part, qty, unit_price in validated:
                            p = parts_service.consume_stock(
                                db, part["id"], qty, inv_no, actor_id=actor_id,
                                notes=f"OTC Counter Sale to {cust_name} {cust_phone}".strip(),
                                is_ro_consumption=False,
                                manage_transaction=False,
                            )
                            updated_parts.append(p)
                        invoice = db.execute(
                            """INSERT INTO counter_sale_invoices
                               (invoice_number,customer_name,customer_phone,payment_method,total_amount,status,
                                actor_employee_id,created_at) VALUES (?,?,?,?,?,'POSTED',?,?)""",
                            (inv_no, cust_name, cust_phone, payment_method, round(total_amount, 2), actor_id, now_str),
                        )
                        invoice_id = int(invoice.lastrowid)
                        for part, qty, unit_price in validated:
                            db.execute(
                                """INSERT INTO counter_sale_invoice_lines
                                   (invoice_id,part_id,part_number_snapshot,description_snapshot,quantity,unit_price,line_total)
                                   VALUES (?,?,?,?,?,?,?)""",
                                (invoice_id, part["id"], part["part_number"], part["description"], qty,
                                 round(unit_price, 2), round(qty * unit_price, 2)),
                            )

                    self.json_response({
                        "ok": True,
                        "invoice_number": inv_no,
                        "payment_method": payment_method,
                        "total_amount": round(total_amount, 2),
                        "items_count": len(items),
                        "parts": updated_parts
                    }, HTTPStatus.CREATED)
                except ValueError as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path == "/api/parts/adjust":
                actor_id = self.require_permission("parts")
                if actor_id is None:
                    return
                try:
                    part_id = int(data.get("part_id", 0))
                    qty_change = int(data.get("qty_change", 0))
                    reason = str(data.get("reason_code", ""))
                    notes = str(data.get("notes", ""))
                    with connect() as db:
                        part = parts_service.adjust_stock(db, part_id, qty_change, reason, notes, actor_id)
                    self.json_response({"part": part})
                except ValueError as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path == "/api/parts/count":
                actor_id = self.require_permission("parts")
                if actor_id is None:
                    return
                try:
                    counts = list(data.get("counts", []))
                    with connect() as db:
                        updated_parts = parts_service.cycle_count(db, counts, actor_id)
                    self.json_response({"parts": updated_parts})
                except ValueError as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path == "/api/parts/count-shortage":
                actor_id = self.require_permission("staff_admin")
                if actor_id is None:
                    return
                try:
                    counts = list(data.get("counts", []))
                    notes = str(data.get("notes", "")).strip()
                    with connect() as db:
                        result = parts_service.reconcile_physical_shortage(db, counts, actor_id, notes)
                    self.json_response(result)
                except ValueError as err:
                    self.json_response({"error": str(err)}, HTTPStatus.BAD_REQUEST)
                return
            if path == "/api/appointments":
                actor_id = self.require_permission("appointments")
                if actor_id is None:
                    return
                cust = str(data.get("customer", "")).strip().upper()
                veh = str(data.get("vehicle", "")).strip().upper()
                concern = str(data.get("concern", "")).strip().upper()
                promised_time = str(data.get("promised_time", "")).strip().upper()
                drop_off_time = str(data.get("drop_off_time", "")).strip().upper()
                technician_id = int(data["preassigned_technician_id"]) if data.get("preassigned_technician_id") else None
                requires_carry_over = bool(data.get("requires_carry_over", False))
                appt_date = str(data.get("appointment_date", "")).strip() or utc_now()[:10]
                plate = str(data.get("license_plate", "")).strip().upper()
                vin = str(data.get("vin", "")).strip().upper()
                miles = str(data.get("mileage", "")).strip().upper()
                fleet_unit = str(data.get("fleet_unit", "")).strip().upper()
                po_num = str(data.get("po_number", "")).strip().upper()
                try:
                    raw_lines = data.get("lines", json.loads(str(data.get("lines_json", "[]"))))
                    lines, totals = normalize_work_lines(raw_lines)
                    date.fromisoformat(appt_date)
                    datetime.strptime(promised_time, "%I:%M %p")
                    if drop_off_time:
                        datetime.strptime(drop_off_time, "%I:%M %p")
                    existing_id = int(data["id"]) if data.get("id") else None
                except (TypeError, ValueError, json.JSONDecodeError) as err:
                    self.json_response({"error": f"Invalid appointment data: {err}"}, HTTPStatus.BAD_REQUEST)
                    return
                pay_type = lines[0]["pay"] if lines else "C"
                estimated_hours = totals["hours"]
                master_total = totals["master"]
                lines_json = json.dumps(lines)

                if not cust or not veh or not promised_time:
                    self.json_response({"error": "Customer, vehicle, and promised time are required"}, HTTPStatus.BAD_REQUEST)
                    return
                if len(cust) > 200 or len(veh) > 200 or len(concern) > 500:
                    self.json_response({"error": "Appointment text exceeds its maximum length"}, HTTPStatus.BAD_REQUEST)
                    return

                with connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    if technician_id and not db.execute("SELECT 1 FROM employees WHERE id=? AND active=1", (technician_id,)).fetchone():
                        self.json_response({"error": "Selected technician is not active"}, HTTPStatus.BAD_REQUEST)
                        return
                    if technician_id:
                        assigned_row = db.execute(
                            """SELECT COALESCE(SUM(estimated_hours),0) assigned_hours
                               FROM appointments
                               WHERE appointment_date=? AND preassigned_technician_id=?
                                 AND status IN ('SCHEDULED','CONVERTED')
                                 AND (? IS NULL OR id != ?)""",
                            (appt_date, technician_id, existing_id, existing_id),
                        ).fetchone()
                        assigned_hours = float(assigned_row["assigned_hours"])
                        daily_limit = technician_daily_capacity(db, technician_id, appt_date)
                        projected_hours = assigned_hours + estimated_hours
                        if projected_hours > daily_limit and not requires_carry_over:
                            tech = db.execute("SELECT name FROM employees WHERE id=?", (technician_id,)).fetchone()
                            self.json_response({
                                "error": f"{tech['name']} would be overbooked by {projected_hours - daily_limit:.1f} hours",
                                "code": "TECH_OVERBOOKED",
                                "technician": tech["name"],
                                "assigned_hours": assigned_hours,
                                "appointment_hours": estimated_hours,
                                "projected_hours": projected_hours,
                                "daily_limit": daily_limit,
                            }, HTTPStatus.CONFLICT)
                            return
                    if not vin and cust:
                        v_row = db.execute("SELECT vin FROM vehicles WHERE UPPER(owner_name)=? AND vin != '' LIMIT 1", (cust,)).fetchone()
                        if v_row and v_row["vin"]:
                            vin = str(v_row["vin"]).strip().upper()

                    if existing_id:
                        if not db.execute("SELECT 1 FROM appointments WHERE id=?", (existing_id,)).fetchone():
                            self.json_response({"error": "Appointment not found"}, HTTPStatus.NOT_FOUND)
                            return
                        db.execute("""
                            UPDATE appointments SET
                                customer_name = ?, vehicle_info = ?, concern = ?, pay_type = ?, promised_time = ?,
                                estimated_hours = ?, appointment_date = ?, license_plate = ?, vin = ?,
                                mileage = ?, fleet_unit = ?, po_number = ?, lines_json = ?, total_hours = ?, master_total = ?
                                , drop_off_time = ?, preassigned_technician_id = ?, requires_carry_over = ?
                            WHERE id = ?
                        """, (
                            cust, veh, concern, pay_type, promised_time,
                            estimated_hours, appt_date, plate, vin,
                            miles, fleet_unit, po_num, lines_json, estimated_hours, master_total,
                            drop_off_time, technician_id, int(requires_carry_over),
                            existing_id
                        ))
                        appt_id = existing_id
                        db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                                   (actor_id, "appointment.update", "appointment", str(appt_id), json.dumps({"customer": cust, "vehicle": veh, "time": promised_time, "date": appt_date}), utc_now()))
                    else:
                        cur = db.execute("""
                            INSERT INTO appointments (
                                customer_name, vehicle_info, concern, pay_type, promised_time, estimated_hours,
                                status, actor_employee_id, created_at, appointment_date, license_plate, vin,
                                mileage, fleet_unit, po_number, lines_json, total_hours, master_total
                                , drop_off_time, preassigned_technician_id, requires_carry_over
                            )
                            VALUES (?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, (
                            cust, veh, concern, pay_type, promised_time, estimated_hours,
                            actor_id, utc_now(), appt_date, plate, vin,
                            miles, fleet_unit, po_num, lines_json, estimated_hours, master_total,
                            drop_off_time, technician_id, int(requires_carry_over)
                        ))
                        appt_id = cur.lastrowid
                        db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                                   (actor_id, "appointment.create", "appointment", str(appt_id), json.dumps({"customer": cust, "vehicle": veh, "time": promised_time, "date": appt_date}), utc_now()))

                    appt = dict(db.execute("SELECT * FROM appointments WHERE id=?", (appt_id,)).fetchone())
                self.json_response({"appointment": appt, "appointment_id": appt_id, "id": appt_id}, HTTPStatus.OK if existing_id else HTTPStatus.CREATED)
                return
            if path.startswith("/api/appointments/") and path.endswith("/convert"):
                actor_id = self.require_permission("appointments")
                if actor_id is None:
                    return
                if self.require_permission("repair_orders") is None:
                    return
                try:
                    appt_id = int(path.split("/")[3])
                except (IndexError, ValueError):
                    self.json_response({"error": "Invalid appointment ID"}, HTTPStatus.BAD_REQUEST)
                    return
                with connect() as db:
                    row = db.execute("SELECT * FROM appointments WHERE id=?", (appt_id,)).fetchone()
                    if not row:
                        self.json_response({"error": "Appointment not found"}, HTTPStatus.NOT_FOUND)
                        return
                    existing_ro = db.execute("SELECT * FROM repair_orders WHERE appointment_id=?", (appt_id,)).fetchone()
                    if existing_ro:
                        self.json_response({"appointment": dict(row), "repair_order": dict(existing_ro)})
                        return
                    try:
                        lines, totals = normalize_work_lines(json.loads(row["lines_json"] or "[]"))
                    except (ValueError, json.JSONDecodeError) as err:
                        self.json_response({"error": f"Appointment cannot be converted: {err}"}, HTTPStatus.CONFLICT)
                        return
                    now = utc_now()
                    temporary_number = f"PENDING-{secrets.token_hex(6).upper()}"
                    cur = db.execute(
                        """INSERT INTO repair_orders
                           (ro_number,appointment_id,customer_name,vehicle_info,license_plate,vin,mileage,
                            fleet_unit,po_number,promised_time,status,lines_json,total_hours,customer_total,
                            warranty_total,internal_total,goodwill_total,master_total,preassigned_technician_id,created_by,updated_by,created_at,updated_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?, 'write-up',?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (temporary_number, appt_id, row["customer_name"], row["vehicle_info"], row["license_plate"],
                         row["vin"], row["mileage"], row["fleet_unit"], row["po_number"], row["promised_time"],
                         json.dumps(lines), totals["hours"], totals["C"], totals["W"], totals["I"], totals["G"], totals["master"],
                         row["preassigned_technician_id"], actor_id, actor_id, now, now),
                    )
                    ro_id = int(cur.lastrowid)
                    ro_number = f"RO-{ro_id:06d}"
                    db.execute("UPDATE repair_orders SET ro_number=? WHERE id=?", (ro_number, ro_id))
                    db.execute("UPDATE appointments SET status='CONVERTED' WHERE id=?", (appt_id,))
                    db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                               (actor_id, "appointment.convert", "appointment", str(appt_id),
                                json.dumps({"status": "CONVERTED", "ro_number": ro_number}), now))
                    appt = dict(db.execute("SELECT * FROM appointments WHERE id=?", (appt_id,)).fetchone())
                    repair_order = dict(db.execute("SELECT * FROM repair_orders WHERE id=?", (ro_id,)).fetchone())
                self.json_response({"appointment": appt, "repair_order": repair_order}, HTTPStatus.CREATED)
                return
            if path.startswith("/api/appointments/") and path.endswith("/status"):
                actor_id = self.require_permission("appointments")
                if actor_id is None:
                    return
                try:
                    appt_id = int(path.split("/")[3])
                except (IndexError, ValueError):
                    self.json_response({"error": "Invalid appointment ID"}, HTTPStatus.BAD_REQUEST)
                    return
                new_status = str(data.get("status", "CANCELLED")).strip().upper()
                new_date = str(data.get("appointment_date", "")).strip()
                new_time = str(data.get("promised_time", "")).strip()

                if new_status not in {"SCHEDULED", "DEFERRED", "CANCELLED"}:
                    self.json_response({"error": "Invalid appointment status"}, HTTPStatus.BAD_REQUEST)
                    return
                if new_status == "SCHEDULED":
                    try:
                        date.fromisoformat(new_date)
                        datetime.strptime(new_time.upper(), "%I:%M %p")
                    except ValueError:
                        self.json_response({"error": "A valid date and promised time are required"}, HTTPStatus.BAD_REQUEST)
                        return

                with connect() as db:
                    row = db.execute("SELECT * FROM appointments WHERE id=?", (appt_id,)).fetchone()
                    if not row:
                        self.json_response({"error": "Appointment not found"}, HTTPStatus.NOT_FOUND)
                        return

                    if new_status == "SCHEDULED" and new_date and new_time:
                        db.execute("UPDATE appointments SET status=?, appointment_date=?, promised_time=? WHERE id=?", (new_status, new_date, new_time, appt_id))
                    elif new_status == "DEFERRED":
                        # Deferred — clear date and promised time so it releases capacity, but keep write-up data
                        db.execute("UPDATE appointments SET status=?, appointment_date='', promised_time='' WHERE id=?", (new_status, appt_id))
                    else:
                        db.execute("UPDATE appointments SET status=? WHERE id=?", (new_status, appt_id))

                    db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                               (actor_id, f"appointment.{new_status.lower()}", "appointment", str(appt_id), json.dumps({"status": new_status, "date": new_date, "time": new_time}), utc_now()))
                    appt = dict(db.execute("SELECT * FROM appointments WHERE id=?", (appt_id,)).fetchone())
                self.json_response({"appointment": appt})
                return
            if path.startswith("/api/dev/diagnostics/"):
                if not check_dev_mode(self):
                    return

            if path == "/api/dev/diagnostics/incident":
                symptom = str(data.get("symptom", "Unspecified UI Anomaly")).strip()[:500]
                flight_recorder = data.get("flight_recorder", {})
                
                fr_file = ROOT / ".taktro" / "flight_recorder.json"
                with open(fr_file, "w", encoding="utf-8") as f:
                    json.dump(flight_recorder, f, indent=2)

                incidents_dir = ROOT / ".taktro" / "incidents"
                existing_capsules = set(incidents_dir.glob("INC-*.md"))
                with DIAG_LOCK:
                    try:
                        cmd = [sys.executable, "scripts/system_audit.py", "--symptom", symptom]
                        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=60)
                    except subprocess.TimeoutExpired:
                        self.json_response({"error": "Incident capture timed out after 60 seconds"}, HTTPStatus.GATEWAY_TIMEOUT)
                        return

                if proc.returncode != 0:
                    self.json_response({
                        "error": "Incident compiler failed",
                        "stdout": proc.stdout[-2000:],
                        "stderr": proc.stderr[-2000:]
                    }, HTTPStatus.INTERNAL_SERVER_ERROR)
                    return

                capsules = sorted(
                    set(incidents_dir.glob("INC-*.md")) - existing_capsules,
                    key=lambda p: p.stat().st_mtime,
                    reverse=True
                )
                latest_capsule = str(capsules[0].relative_to(ROOT)) if capsules else ""

                if not latest_capsule:
                    self.json_response({"error": "Incident compiler produced no new capsule"}, HTTPStatus.INTERNAL_SERVER_ERROR)
                    return

                self.json_response({
                    "ok": proc.returncode == 0,
                    "capsule_path": latest_capsule,
                    "symptom": symptom,
                    "stdout": proc.stdout,
                    "stderr": proc.stderr
                })
                return

            if path == "/api/dev/diagnostics/audit":
                with DIAG_LOCK:
                    try:
                        proc = subprocess.run([sys.executable, "scripts/system_audit.py", "--json"], cwd=ROOT, capture_output=True, text=True, timeout=30)
                    except subprocess.TimeoutExpired:
                        self.json_response({"error": "Audit timed out"}, HTTPStatus.GATEWAY_TIMEOUT)
                        return
                try:
                    res_json = json.loads(proc.stdout)
                except Exception:
                    res_json = {"raw": proc.stdout, "status": "WARN"}
                self.json_response(res_json)
                return

            if path == "/api/dev/diagnostics/baseline":
                force_flag = ["--force"] if data.get("force") else []
                with DIAG_LOCK:
                    try:
                        proc = subprocess.run([sys.executable, "scripts/system_audit.py", "--baseline", "--json"] + force_flag, cwd=ROOT, capture_output=True, text=True, timeout=30)
                    except subprocess.TimeoutExpired:
                        self.json_response({"error": "Baseline recording timed out"}, HTTPStatus.GATEWAY_TIMEOUT)
                        return
                if proc.returncode != 0:
                    self.json_response({"ok": False, "error": proc.stdout.strip() or "Baseline recording refused"}, HTTPStatus.BAD_REQUEST)
                else:
                    self.json_response({"ok": True, "stdout": proc.stdout})
                return

            if path == "/api/dev/diagnostics/tests":
                with DIAG_LOCK:
                    try:
                        proc = subprocess.run([sys.executable, "scripts/audit_test.py"], cwd=ROOT, capture_output=True, text=True, timeout=30)
                    except subprocess.TimeoutExpired:
                        self.json_response({"error": "Unit tests timed out"}, HTTPStatus.GATEWAY_TIMEOUT)
                        return
                self.json_response({"ok": proc.returncode == 0, "output": proc.stdout + proc.stderr})
                return

            if path == "/api/logout":
                token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                SESSIONS.pop(token, None)
                self.json_response({"ok": True})
                return
            if path == "/api/employees":
                actor_id = self.require_permission("staff_admin")
                if actor_id is None:
                    return
                name, pin = str(data.get("name", "")).strip().upper(), str(data.get("pin", ""))
                template_id, location_id = data.get("template_id"), data.get("location_id")
                if not name or not (pin.isdigit() and len(pin) == 4) or not template_id or not location_id:
                    self.json_response({"error": "Name, template, location, and a 4-digit PIN are required"}, HTTPStatus.BAD_REQUEST)
                    return
                with connect() as db:
                    if any(verify_pin(pin, row["pin_hash"]) for row in db.execute("SELECT pin_hash FROM employees WHERE active=1")):
                        self.json_response({"error": "That PIN is already in use"}, HTTPStatus.CONFLICT)
                        return
                    cur = db.execute("INSERT INTO employees(name,pin_hash,created_at) VALUES (?,?,?)", (name, hash_pin(pin), utc_now()))
                    employee_id = cur.lastrowid
                    db.execute("INSERT INTO employee_templates VALUES (?,?)", (employee_id, int(template_id)))
                    db.execute("INSERT INTO employee_locations VALUES (?,?)", (employee_id, int(location_id)))
                    db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                               (actor_id, "employee.create", "employee", str(employee_id), json.dumps({"name": name}), utc_now()))
                    employee = employee_view(db, employee_id)
                self.json_response({"employee": employee}, HTTPStatus.CREATED)
                return
            if path == "/api/vehicles":
                actor_id = self.require_permission("customers")
                if actor_id is None:
                    return
                fields = {key: str(data.get(key, "")).strip().upper() for key in
                          ("year", "make", "model", "trim", "engine", "transmission", "drive_type",
                           "body_class", "fuel_type", "color", "plate", "mileage", "vin", "decode_source",
                           "modifications", "notes", "transmission_type", "asset_type", "equipment_category",
                           "serial_number", "hours_meter", "shop_fleet_type")}

                asset_type = fields["asset_type"] or "VEHICLE"
                is_shop = 1 if asset_type in ("SHOP_EQUIPMENT", "SHOP_VEHICLE") or str(data.get("is_shop_equipment", "")).lower() in ("1", "true") else 0

                vin = fields["vin"]
                if asset_type not in ("VEHICLE", "SHOP_VEHICLE") and not vin:
                    vin = fields["serial_number"] or f"EQP-{secrets.token_hex(4).upper()}"

                if asset_type in ("VEHICLE", "SHOP_VEHICLE") and (not fields["year"].isdigit() or not fields["make"] or not fields["model"] or len(vin) != 17):
                    self.json_response({"error": "Year, make, model, and a 17-character VIN are required for vehicles"}, HTTPStatus.BAD_REQUEST)
                    return
                elif asset_type not in ("VEHICLE", "SHOP_VEHICLE") and (not fields["make"] or not fields["model"]):
                    self.json_response({"error": "Brand/Make and Model are required for equipment"}, HTTPStatus.BAD_REQUEST)
                    return

                year_val = int(fields["year"]) if fields["year"].isdigit() else 2024
                mileage = int(fields["mileage"].replace(",", "")) if fields["mileage"] else None
                hours_meter = float(fields["hours_meter"]) if fields["hours_meter"] else None

                with connect() as db:
                    cur = db.execute("""INSERT INTO vehicles
                        (year,make,model,trim,engine,transmission,transmission_type,drive_type,body_class,fuel_type,color,plate,mileage,
                         vin,decode_source,decoded_at,modifications,notes,asset_type,equipment_category,serial_number,hours_meter,is_shop_equipment,shop_fleet_type,created_by,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (year_val, fields["make"], fields["model"], fields["trim"],
                         fields["engine"], fields["transmission"], fields["transmission_type"] or "unknown", fields["drive_type"],
                         fields["body_class"], fields["fuel_type"], fields["color"],
                         fields["plate"], mileage, vin, fields["decode_source"],
                         utc_now() if fields["decode_source"] else None, fields["modifications"], fields["notes"],
                         asset_type, fields["equipment_category"], fields["serial_number"], hours_meter, is_shop, fields["shop_fleet_type"],
                         actor_id, utc_now()))
                    vehicle_id = cur.lastrowid
                    db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                               (actor_id, "vehicle.create", "vehicle", str(vehicle_id), json.dumps({"vin": vin, "asset_type": asset_type}), utc_now()))
                    vehicle = dict(db.execute("""SELECT v.*, c.name customer_name, c.phone customer_phone
                        FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id WHERE v.id=?""", (vehicle_id,)).fetchone())
                self.json_response({"vehicle": vehicle}, HTTPStatus.CREATED)
                return
            if path == "/api/customers":
                actor_id = self.require_permission("customers")
                if actor_id is None:
                    return
                fields = {key: str(data.get(key, "")).strip().upper() for key in
                          ("name", "phone", "email", "address", "city", "state", "postal_code", "notes",
                           "communication_preference", "customer_type", "company_name", "fleet_unit_number",
                           "contact_person", "fleet_card_details", "reimbursement_details", "tax_exempt_number")}
                name, phone = fields["name"], fields["phone"]
                if not name:
                    self.json_response({"error": "Customer name is required"}, HTTPStatus.BAD_REQUEST)
                    return

                labor_rate_raw = data.get("labor_rate")
                labor_rate = float(labor_rate_raw) if labor_rate_raw and str(labor_rate_raw).strip() else None
                if labor_rate is not None and (not math.isfinite(labor_rate) or labor_rate < 0):
                    self.json_response({"error": "Labor rate must be a finite, non-negative amount"}, HTTPStatus.BAD_REQUEST)
                    return

                with connect() as db:
                    cur = db.execute("""INSERT INTO customers
                        (name,phone,email,address,city,state,postal_code,notes,communication_preference,
                         customer_type,company_name,fleet_unit_number,contact_person,fleet_card_details,
                         reimbursement_details,tax_exempt_number,labor_rate,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (name, phone, fields["email"], fields["address"], fields["city"], fields["state"],
                         fields["postal_code"], fields["notes"], fields["communication_preference"],
                         fields["customer_type"] or "RETAIL", fields["company_name"], fields["fleet_unit_number"],
                         fields["contact_person"], fields["fleet_card_details"], fields["reimbursement_details"],
                         fields["tax_exempt_number"], labor_rate, utc_now()))
                    customer_id = cur.lastrowid
                    db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                               (actor_id, "customer.create", "customer", str(customer_id), json.dumps({"name": name}), utc_now()))
                    customer = dict(db.execute("SELECT * FROM customers WHERE id=?", (customer_id,)).fetchone())
                self.json_response({"customer": customer}, HTTPStatus.CREATED)
                return
            if path.startswith("/api/customers/") and not path.endswith("/vehicles"):
                actor_id = self.require_permission("customers")
                if actor_id is None:
                    return
                try:
                    customer_id = int(path.rsplit("/", 1)[-1])
                except ValueError:
                    self.json_response({"error": "Invalid customer ID"}, HTTPStatus.BAD_REQUEST)
                    return
                fields = {key: str(data.get(key, "")).strip().upper() for key in
                          ("name", "phone", "email", "address", "city", "state", "postal_code", "notes",
                           "communication_preference", "customer_type", "company_name", "fleet_unit_number",
                           "contact_person", "fleet_card_details", "reimbursement_details", "tax_exempt_number")}
                name = fields["name"]
                if not name:
                    self.json_response({"error": "Customer name is required"}, HTTPStatus.BAD_REQUEST)
                    return

                labor_rate_raw = data.get("labor_rate")
                labor_rate = float(labor_rate_raw) if labor_rate_raw and str(labor_rate_raw).strip() else None
                if labor_rate is not None and (not math.isfinite(labor_rate) or labor_rate < 0):
                    self.json_response({"error": "Labor rate must be a finite, non-negative amount"}, HTTPStatus.BAD_REQUEST)
                    return

                with connect() as db:
                    if not db.execute("SELECT 1 FROM customers WHERE id=?", (customer_id,)).fetchone():
                        self.json_response({"error": "Customer not found"}, HTTPStatus.NOT_FOUND)
                        return
                    db.execute("""UPDATE customers SET name=?,phone=?,email=?,address=?,city=?,state=?,
                        postal_code=?,notes=?,communication_preference=?,customer_type=?,company_name=?,
                        fleet_unit_number=?,contact_person=?,fleet_card_details=?,reimbursement_details=?,
                        tax_exempt_number=?,labor_rate=? WHERE id=?""",
                        (name, fields["phone"], fields["email"], fields["address"], fields["city"],
                         fields["state"], fields["postal_code"], fields["notes"],
                         fields["communication_preference"], fields["customer_type"] or "RETAIL",
                         fields["company_name"], fields["fleet_unit_number"], fields["contact_person"],
                         fields["fleet_card_details"], fields["reimbursement_details"],
                         fields["tax_exempt_number"], labor_rate, customer_id))
                    db.execute("UPDATE vehicles SET owner_name=?, owner_phone=? WHERE customer_id=?",
                               (name, fields["phone"], customer_id))
                    db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                               (actor_id, "customer.update", "customer", str(customer_id), json.dumps({"name": name}), utc_now()))
                    customer = dict(db.execute("SELECT * FROM customers WHERE id=?", (customer_id,)).fetchone())
                    vehicles = [dict(row) for row in db.execute("SELECT * FROM vehicles WHERE customer_id=?", (customer_id,)).fetchall()]
                    customer["vehicles"] = vehicles
                self.json_response({"customer": customer})
                return
            if path.startswith("/api/vehicles/") and path.endswith("/customer"):
                actor_id = self.require_permission("customers")
                if actor_id is None:
                    return
                vehicle_id = int(path.split("/")[3])
                customer_id = data.get("customer_id")
                with connect() as db:
                    if not db.execute("SELECT 1 FROM vehicles WHERE id=?", (vehicle_id,)).fetchone():
                        self.json_response({"error": "Vehicle not found"}, HTTPStatus.NOT_FOUND)
                        return
                    if customer_id is not None and not db.execute("SELECT 1 FROM customers WHERE id=?", (customer_id,)).fetchone():
                        self.json_response({"error": "Customer not found"}, HTTPStatus.NOT_FOUND)
                        return
                    cust = db.execute("SELECT name, phone FROM customers WHERE id=?", (customer_id,)).fetchone() if customer_id else None
                    owner_name = cust["name"] if cust else ""
                    owner_phone = cust["phone"] if cust else ""
                    db.execute("UPDATE vehicles SET customer_id=?, owner_name=?, owner_phone=? WHERE id=?", (customer_id, owner_name, owner_phone, vehicle_id))
                    db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                               (actor_id, "vehicle.customer.link", "vehicle", str(vehicle_id), json.dumps({"customer_id": customer_id}), utc_now()))
                    vehicle = dict(db.execute("""SELECT v.*, c.name customer_name, c.phone customer_phone
                        FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id WHERE v.id=?""", (vehicle_id,)).fetchone())
                self.json_response({"vehicle": vehicle})
                return
            if path.startswith("/api/vehicles/"):
                actor_id = self.require_permission("customers")
                if actor_id is None:
                    return
                vehicle_id = int(path.rsplit("/", 1)[-1])
                fields = {key: str(data.get(key, "")).strip().upper() for key in
                          ("year", "make", "model", "trim", "engine", "transmission", "transmission_type",
                           "drive_type", "body_class", "fuel_type", "color", "plate", "mileage", "vin",
                           "decode_source", "modifications", "notes", "asset_type", "equipment_category",
                           "serial_number", "hours_meter", "shop_fleet_type")}

                asset_type = fields["asset_type"] or "VEHICLE"
                is_shop = 1 if asset_type in ("SHOP_EQUIPMENT", "SHOP_VEHICLE") or str(data.get("is_shop_equipment", "")).lower() in ("1", "true") else 0
                vin = fields["vin"] or fields["serial_number"] or f"EQP-{vehicle_id}"

                if asset_type in ("VEHICLE", "SHOP_VEHICLE") and (not fields["year"].isdigit() or not fields["make"] or not fields["model"] or len(vin) != 17):
                    self.json_response({"error": "Year, make, model, and a 17-character VIN are required for vehicles"}, HTTPStatus.BAD_REQUEST)
                    return
                elif asset_type not in ("VEHICLE", "SHOP_VEHICLE") and (not fields["make"] or not fields["model"]):
                    self.json_response({"error": "Brand/Make and Model are required for equipment"}, HTTPStatus.BAD_REQUEST)
                    return

                year_val = int(fields["year"]) if fields["year"].isdigit() else 2024
                mileage = int(fields["mileage"].replace(",", "")) if fields["mileage"] else None
                hours_meter = float(fields["hours_meter"]) if fields["hours_meter"] else None

                with connect() as db:
                    existing = db.execute("SELECT 1 FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
                    if not existing:
                        self.json_response({"error": "Vehicle not found"}, HTTPStatus.NOT_FOUND)
                        return
                    db.execute("""UPDATE vehicles SET year=?,make=?,model=?,trim=?,engine=?,transmission=?,
                        transmission_type=?,drive_type=?,body_class=?,fuel_type=?,color=?,plate=?,mileage=?,vin=?,
                        decode_source=?,decoded_at=?,modifications=?,notes=?,asset_type=?,equipment_category=?,
                        serial_number=?,hours_meter=?,is_shop_equipment=?,shop_fleet_type=? WHERE id=?""",
                        (year_val, fields["make"], fields["model"], fields["trim"],
                         fields["engine"], fields["transmission"], fields["transmission_type"] or "unknown",
                         fields["drive_type"], fields["body_class"], fields["fuel_type"],
                         fields["color"], fields["plate"], mileage, vin,
                         fields["decode_source"], utc_now() if fields["decode_source"] else None,
                         fields["modifications"], fields["notes"], asset_type, fields["equipment_category"],
                         fields["serial_number"], hours_meter, is_shop, fields["shop_fleet_type"], vehicle_id))
                    db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                               (actor_id, "vehicle.update", "vehicle", str(vehicle_id),
                                json.dumps({"vin": vin, "asset_type": asset_type}), utc_now()))
                    vehicle = dict(db.execute("""SELECT v.*, c.name customer_name, c.phone customer_phone
                        FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id WHERE v.id=?""", (vehicle_id,)).fetchone())
                self.json_response({"vehicle": vehicle})
                return
            if path.startswith("/api/employees/") and path.endswith("/permissions"):
                actor_id = self.require_permission("staff_admin")
                if actor_id is None:
                    return
                employee_id = int(path.split("/")[3])
                requested = data.get("permissions")
                if not isinstance(requested, list) or any(p not in PERMISSIONS for p in requested):
                    self.json_response({"error": "Invalid permission selection"}, HTTPStatus.BAD_REQUEST)
                    return
                with connect() as db:
                    if not db.execute("SELECT 1 FROM employees WHERE id=?", (employee_id,)).fetchone():
                        self.json_response({"error": "Employee not found"}, HTTPStatus.NOT_FOUND)
                        return
                    employee = employee_view(db, employee_id)
                    base = set(employee["base_permissions"])
                    selected = set(requested)
                    db.execute("DELETE FROM employee_permission_overrides WHERE employee_id=?", (employee_id,))
                    for permission in sorted(base ^ selected):
                        db.execute("INSERT INTO employee_permission_overrides VALUES (?,?,?)",
                                   (employee_id, permission, int(permission in selected)))
                    db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                               (actor_id, "employee.permissions.update", "employee", str(employee_id),
                                json.dumps({"permissions": sorted(selected)}), utc_now()))
                    employee = employee_view(db, employee_id)
                self.json_response({"employee": employee})
                return
            if path.startswith("/api/employees/") and path.endswith("/profile"):
                actor_id = self.require_permission("staff_admin")
                if actor_id is None:
                    return
                employee_id = int(path.split("/")[3])
                name = str(data.get("name", "")).strip().upper()
                template_id = data.get("template_id")
                active = int(data.get("active", 1))
                pin = str(data.get("pin", "")).strip()

                if not name or not template_id:
                    self.json_response({"error": "Employee name and position template are required"}, HTTPStatus.BAD_REQUEST)
                    return
                if pin and (not pin.isdigit() or len(pin) != 4):
                    self.json_response({"error": "PIN must be exactly 4 numeric digits"}, HTTPStatus.BAD_REQUEST)
                    return

                phone = str(data.get("phone", "")).strip()
                address = str(data.get("address", "")).strip()
                sin = str(data.get("sin", "")).strip()
                emergency_contact_name = str(data.get("emergency_contact_name", "")).strip()
                emergency_contact_phone = str(data.get("emergency_contact_phone", "")).strip()
                medical_alert = str(data.get("medical_alert", "")).strip()
                work_days = str(data.get("work_days", "MON,TUE,WED,THU,FRI")).strip().upper()
                try:
                    daily_productive_hours = max(0.0, float(data.get("daily_productive_hours", 8.0)))
                except (TypeError, ValueError):
                    daily_productive_hours = 8.0

                with connect() as db:
                    existing = db.execute("SELECT id FROM employees WHERE id=?", (employee_id,)).fetchone()
                    if not existing:
                        self.json_response({"error": "Employee not found"}, HTTPStatus.NOT_FOUND)
                        return

                    if pin:
                        for row in db.execute("SELECT id, pin_hash FROM employees WHERE active=1 AND id != ?", (employee_id,)):
                            if verify_pin(pin, row["pin_hash"]):
                                self.json_response({"error": "That 4-digit PIN is already in use by another active employee"}, HTTPStatus.CONFLICT)
                                return
                        db.execute(
                            """UPDATE employees
                               SET name=?, pin_hash=?, active=?, phone=?, address=?, sin=?,
                                   emergency_contact_name=?, emergency_contact_phone=?,
                                   medical_alert=?, work_days=?, daily_productive_hours=?
                               WHERE id=?""",
                            (name, hash_pin(pin), active, phone, address, sin, emergency_contact_name, emergency_contact_phone, medical_alert, work_days, daily_productive_hours, employee_id)
                        )
                    else:
                        db.execute(
                            """UPDATE employees
                               SET name=?, active=?, phone=?, address=?, sin=?,
                                   emergency_contact_name=?, emergency_contact_phone=?,
                                   medical_alert=?, work_days=?, daily_productive_hours=?
                               WHERE id=?""",
                            (name, active, phone, address, sin, emergency_contact_name, emergency_contact_phone, medical_alert, work_days, daily_productive_hours, employee_id)
                        )

                    db.execute("DELETE FROM employee_templates WHERE employee_id=?", (employee_id,))
                    db.execute("INSERT INTO employee_templates(employee_id, template_id) VALUES (?, ?)", (employee_id, int(template_id)))

                    db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,?,?,?,?,?)",
                               (actor_id, "employee.profile.update", "employee", str(employee_id),
                                json.dumps({"name": name, "template_id": template_id, "pin_reset": bool(pin), "active": active}), utc_now()))
                    employee = employee_view(db, employee_id)
                self.json_response({"employee": employee})
                return
            self.json_response({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except (ValueError, json.JSONDecodeError, sqlite3.Error) as exc:
            self.json_response({"error": "Invalid request or data error"}, HTTPStatus.BAD_REQUEST)


if __name__ == "__main__":
    initialize_database()
    host = os.environ.get("TAKTRO_HOST", "127.0.0.1")
    port = int(os.environ.get("TAKTRO_PORT", "8080"))
    print(f"TaktRO running at http://localhost:{port} (initial administrator PIN: 1042)", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
