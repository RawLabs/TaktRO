"""SQLite schema for versioned shop configuration and operational resources."""

from __future__ import annotations

import sqlite3


def initialize_setup_schema(db: sqlite3.Connection) -> None:
    """Create the additive Setup domain without activating unreviewed rules."""
    vendor_columns = {row["name"] for row in db.execute("PRAGMA table_info(parts_vendors)")}
    for name, definition in {
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
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS shops (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS shop_config_revisions (
            id INTEGER PRIMARY KEY,
            shop_id INTEGER NOT NULL REFERENCES shops(id),
            scope_location_id INTEGER REFERENCES locations(id),
            based_on_revision_id INTEGER REFERENCES shop_config_revisions(id),
            status TEXT NOT NULL DEFAULT 'DRAFT'
                CHECK(status IN ('DRAFT','REVIEWED','ACTIVE','SUPERSEDED')),
            version_label TEXT NOT NULL DEFAULT '',
            change_summary TEXT NOT NULL DEFAULT '',
            created_by INTEGER REFERENCES employees(id),
            reviewed_by INTEGER REFERENCES employees(id),
            published_by INTEGER REFERENCES employees(id),
            created_at TEXT NOT NULL,
            reviewed_at TEXT,
            published_at TEXT,
            superseded_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_shop_config_scope
            ON shop_config_revisions(shop_id,COALESCE(scope_location_id,0))
            WHERE status='ACTIVE';
        CREATE TABLE IF NOT EXISTS shop_profile_configs (
            revision_id INTEGER PRIMARY KEY REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            legal_name TEXT NOT NULL DEFAULT '',
            invoice_name TEXT NOT NULL DEFAULT '',
            address_line_1 TEXT NOT NULL DEFAULT '',
            address_line_2 TEXT NOT NULL DEFAULT '',
            city TEXT NOT NULL DEFAULT '',
            region TEXT NOT NULL DEFAULT '',
            postal_code TEXT NOT NULL DEFAULT '',
            country_code TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            tax_registration_id TEXT NOT NULL DEFAULT '',
            invoice_footer TEXT NOT NULL DEFAULT '',
            warranty_wording TEXT NOT NULL DEFAULT '',
            currency_code TEXT NOT NULL DEFAULT 'USD',
            timezone_name TEXT NOT NULL DEFAULT '',
            default_location_id INTEGER REFERENCES locations(id),
            promised_time_buffer_minutes INTEGER NOT NULL DEFAULT 30,
            ro_prefix TEXT NOT NULL DEFAULT 'RO',
            po_prefix TEXT NOT NULL DEFAULT 'PO'
        );
        CREATE TABLE IF NOT EXISTS business_hours (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            location_id INTEGER NOT NULL REFERENCES locations(id),
            weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
            opens_at TEXT,
            closes_at TEXT,
            break_minutes INTEGER NOT NULL DEFAULT 0,
            closed INTEGER NOT NULL DEFAULT 0,
            UNIQUE(revision_id,location_id,weekday)
        );
        CREATE TABLE IF NOT EXISTS closure_calendar (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            location_id INTEGER NOT NULL REFERENCES locations(id),
            starts_at TEXT NOT NULL,
            ends_at TEXT NOT NULL,
            reason TEXT NOT NULL,
            capacity_hours_delta REAL,
            CHECK(ends_at > starts_at)
        );
        CREATE TABLE IF NOT EXISTS technician_operational_profiles (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            employee_id INTEGER NOT NULL REFERENCES employees(id),
            primary_location_id INTEGER NOT NULL REFERENCES locations(id),
            scheduling_active INTEGER NOT NULL DEFAULT 1,
            productive_target_percent REAL NOT NULL DEFAULT 100
                CHECK(productive_target_percent BETWEEN 0 AND 200),
            labor_cost_rate REAL,
            restrictions TEXT NOT NULL DEFAULT '',
            UNIQUE(revision_id,employee_id)
        );
        CREATE TABLE IF NOT EXISTS technician_schedules (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            employee_id INTEGER NOT NULL REFERENCES employees(id),
            location_id INTEGER NOT NULL REFERENCES locations(id),
            work_date TEXT NOT NULL,
            productive_hours REAL NOT NULL CHECK(productive_hours >= 0),
            nonproductive_hours REAL NOT NULL DEFAULT 0 CHECK(nonproductive_hours >= 0),
            note TEXT NOT NULL DEFAULT '',
            UNIQUE(revision_id,employee_id,work_date)
        );
        CREATE TABLE IF NOT EXISTS capacity_policies (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            location_id INTEGER NOT NULL REFERENCES locations(id),
            booking_target_percent REAL NOT NULL DEFAULT 100
                CHECK(booking_target_percent BETWEEN 0 AND 100),
            reserve_hours REAL NOT NULL DEFAULT 0 CHECK(reserve_hours >= 0),
            UNIQUE(revision_id,location_id)
        );
        CREATE TABLE IF NOT EXISTS skills (
            id INTEGER PRIMARY KEY,
            code TEXT NOT NULL UNIQUE COLLATE NOCASE,
            name TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS technician_skills (
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            employee_id INTEGER NOT NULL REFERENCES employees(id),
            skill_id INTEGER NOT NULL REFERENCES skills(id),
            proficiency TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(revision_id,employee_id,skill_id)
        );
        CREATE TABLE IF NOT EXISTS certifications (
            id INTEGER PRIMARY KEY,
            code TEXT NOT NULL UNIQUE COLLATE NOCASE,
            name TEXT NOT NULL,
            issuer TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS technician_certifications (
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            employee_id INTEGER NOT NULL REFERENCES employees(id),
            certification_id INTEGER NOT NULL REFERENCES certifications(id),
            credential_reference TEXT NOT NULL DEFAULT '',
            issued_on TEXT,
            expires_on TEXT,
            verified INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(revision_id,employee_id,certification_id)
        );
        CREATE TABLE IF NOT EXISTS shop_resources (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            location_id INTEGER NOT NULL REFERENCES locations(id),
            code TEXT NOT NULL COLLATE NOCASE,
            name TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            unit_count INTEGER NOT NULL DEFAULT 1 CHECK(unit_count > 0),
            capacity_description TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1,
            UNIQUE(revision_id,location_id,code)
        );
        CREATE TABLE IF NOT EXISTS resource_availability (
            id INTEGER PRIMARY KEY,
            resource_id INTEGER NOT NULL REFERENCES shop_resources(id) ON DELETE CASCADE,
            starts_at TEXT NOT NULL,
            ends_at TEXT NOT NULL,
            available_units INTEGER NOT NULL DEFAULT 0 CHECK(available_units >= 0),
            reason TEXT NOT NULL DEFAULT '',
            CHECK(ends_at > starts_at)
        );
        CREATE TABLE IF NOT EXISTS job_skill_requirements (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            job_code TEXT NOT NULL COLLATE NOCASE,
            skill_id INTEGER REFERENCES skills(id),
            certification_id INTEGER REFERENCES certifications(id),
            requirement_level TEXT NOT NULL DEFAULT 'REQUIRED'
                CHECK(requirement_level IN ('REQUIRED','PREFERRED'))
        );
        CREATE TABLE IF NOT EXISTS job_resource_requirements (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            job_code TEXT NOT NULL COLLATE NOCASE,
            resource_type TEXT NOT NULL,
            units_required INTEGER NOT NULL DEFAULT 1 CHECK(units_required > 0),
            hours_required REAL CHECK(hours_required IS NULL OR hours_required >= 0)
        );
        CREATE TABLE IF NOT EXISTS labor_classes (
            id INTEGER PRIMARY KEY,
            code TEXT NOT NULL UNIQUE COLLATE NOCASE,
            name TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS labor_rate_rules (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            location_id INTEGER REFERENCES locations(id),
            pay_type TEXT NOT NULL CHECK(pay_type IN ('C','W','I')),
            labor_class_id INTEGER NOT NULL REFERENCES labor_classes(id),
            hourly_rate REAL NOT NULL CHECK(hourly_rate >= 0),
            effective_from TEXT NOT NULL,
            effective_to TEXT,
            name TEXT NOT NULL,
            CHECK(effective_to IS NULL OR effective_to >= effective_from)
        );
        CREATE TABLE IF NOT EXISTS customer_rate_contracts (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            customer_id INTEGER NOT NULL REFERENCES customers(id),
            location_id INTEGER REFERENCES locations(id),
            name TEXT NOT NULL,
            effective_from TEXT NOT NULL,
            effective_to TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            CHECK(effective_to IS NULL OR effective_to >= effective_from)
        );
        CREATE TABLE IF NOT EXISTS customer_rate_contract_lines (
            id INTEGER PRIMARY KEY,
            contract_id INTEGER NOT NULL REFERENCES customer_rate_contracts(id) ON DELETE CASCADE,
            pay_type TEXT NOT NULL CHECK(pay_type IN ('C','W','I')),
            labor_class_id INTEGER NOT NULL REFERENCES labor_classes(id),
            hourly_rate REAL NOT NULL CHECK(hourly_rate >= 0),
            UNIQUE(contract_id,pay_type,labor_class_id)
        );
        CREATE TABLE IF NOT EXISTS tax_profiles (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            location_id INTEGER REFERENCES locations(id),
            name TEXT NOT NULL,
            registration_id TEXT NOT NULL DEFAULT '',
            inclusive INTEGER NOT NULL DEFAULT 0,
            rounding_method TEXT NOT NULL DEFAULT 'HALF_UP',
            exempt_customer_behavior TEXT NOT NULL DEFAULT 'EXEMPT',
            effective_from TEXT NOT NULL,
            effective_to TEXT,
            CHECK(effective_to IS NULL OR effective_to >= effective_from)
        );
        CREATE TABLE IF NOT EXISTS tax_rules (
            id INTEGER PRIMARY KEY,
            tax_profile_id INTEGER NOT NULL REFERENCES tax_profiles(id) ON DELETE CASCADE,
            charge_type TEXT NOT NULL,
            rate REAL NOT NULL CHECK(rate >= 0),
            compound_order INTEGER NOT NULL DEFAULT 0,
            taxable INTEGER NOT NULL DEFAULT 1,
            UNIQUE(tax_profile_id,charge_type,compound_order)
        );
        CREATE TABLE IF NOT EXISTS fee_rules (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            location_id INTEGER REFERENCES locations(id),
            fee_type TEXT NOT NULL CHECK(fee_type IN ('SHOP_SUPPLIES','HAZMAT','FREIGHT','MISC')),
            calculation_type TEXT NOT NULL CHECK(calculation_type IN ('DISABLED','FLAT','PERCENT','PER_UNIT','PER_JOB')),
            basis_type TEXT NOT NULL DEFAULT 'LABOR',
            rate_or_amount REAL NOT NULL DEFAULT 0 CHECK(rate_or_amount >= 0),
            minimum_amount REAL,
            maximum_amount REAL,
            eligible_categories_json TEXT NOT NULL DEFAULT '[]',
            excluded_categories_json TEXT NOT NULL DEFAULT '[]',
            tax_charge_type TEXT NOT NULL DEFAULT '',
            customer_description TEXT NOT NULL,
            effective_from TEXT NOT NULL,
            effective_to TEXT,
            CHECK(minimum_amount IS NULL OR minimum_amount >= 0),
            CHECK(maximum_amount IS NULL OR maximum_amount >= 0),
            CHECK(maximum_amount IS NULL OR minimum_amount IS NULL OR maximum_amount >= minimum_amount),
            CHECK(effective_to IS NULL OR effective_to >= effective_from)
        );
        CREATE TABLE IF NOT EXISTS payment_methods (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            location_id INTEGER REFERENCES locations(id),
            code TEXT NOT NULL COLLATE NOCASE,
            name TEXT NOT NULL,
            method_type TEXT NOT NULL,
            accepts_deposits INTEGER NOT NULL DEFAULT 1,
            active INTEGER NOT NULL DEFAULT 1,
            UNIQUE(revision_id,location_id,code)
        );
        CREATE TABLE IF NOT EXISTS vendor_contacts (
            id INTEGER PRIMARY KEY,
            vendor_id INTEGER NOT NULL REFERENCES parts_vendors(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            function TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            extension TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            preferred_method TEXT NOT NULL DEFAULT '',
            is_primary INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vendor_contacts_lookup
            ON vendor_contacts(vendor_id,name,function);
        CREATE TABLE IF NOT EXISTS payer_programs (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            pay_type TEXT NOT NULL CHECK(pay_type IN ('W','I','G')),
            name TEXT NOT NULL,
            vendor_id INTEGER REFERENCES parts_vendors(id),
            labor_method TEXT NOT NULL DEFAULT 'DOOR_PERCENT'
                CHECK(labor_method IN ('DOOR_PERCENT','FIXED_RATE','CAPPED_RATE','NO_LABOR')),
            labor_value REAL NOT NULL DEFAULT 100 CHECK(labor_value >= 0),
            parts_method TEXT NOT NULL DEFAULT 'ACTUAL'
                CHECK(parts_method IN ('ACTUAL','PERCENT','PRORATED','NO_PARTS')),
            parts_value REAL NOT NULL DEFAULT 100 CHECK(parts_value >= 0),
            manager_approval_required INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1,
            note TEXT NOT NULL DEFAULT '',
            UNIQUE(revision_id,pay_type,name)
        );
        CREATE TABLE IF NOT EXISTS customer_type_rules (
            id INTEGER PRIMARY KEY,
            revision_id INTEGER NOT NULL REFERENCES shop_config_revisions(id) ON DELETE CASCADE,
            code TEXT NOT NULL COLLATE NOCASE,
            name TEXT NOT NULL,
            parts_adjustment_percent REAL NOT NULL DEFAULT 0,
            labor_adjustment_percent REAL NOT NULL DEFAULT 0,
            minimum_job_total REAL,
            manager_override_required INTEGER NOT NULL DEFAULT 1,
            active INTEGER NOT NULL DEFAULT 1,
            note TEXT NOT NULL DEFAULT '',
            UNIQUE(revision_id,code)
        );
        CREATE TABLE IF NOT EXISTS deposit_accounts (
            id INTEGER PRIMARY KEY,
            customer_id INTEGER NOT NULL REFERENCES customers(id),
            ro_reference TEXT NOT NULL DEFAULT '',
            appointment_id INTEGER REFERENCES appointments(id),
            currency_code TEXT NOT NULL DEFAULT 'USD',
            status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deposit_transactions (
            id INTEGER PRIMARY KEY,
            deposit_account_id INTEGER NOT NULL REFERENCES deposit_accounts(id),
            transaction_type TEXT NOT NULL
                CHECK(transaction_type IN ('REQUEST','PAYMENT','APPLICATION','REFUND','REVERSAL','FORFEITURE')),
            amount REAL NOT NULL CHECK(amount != 0),
            payment_method_snapshot TEXT NOT NULL DEFAULT '',
            processor_reference TEXT NOT NULL DEFAULT '',
            receipt_number TEXT NOT NULL DEFAULT '',
            related_transaction_id INTEGER REFERENCES deposit_transactions(id),
            actor_employee_id INTEGER REFERENCES employees(id),
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS deposit_transactions_immutable_update
            BEFORE UPDATE ON deposit_transactions
            BEGIN SELECT RAISE(ABORT,'Deposit transactions are immutable; create a compensating transaction.'); END;
        CREATE TRIGGER IF NOT EXISTS deposit_transactions_immutable_delete
            BEFORE DELETE ON deposit_transactions
            BEGIN SELECT RAISE(ABORT,'Deposit transactions are immutable; create a compensating transaction.'); END;
        CREATE TABLE IF NOT EXISTS setup_calculation_snapshots (
            id INTEGER PRIMARY KEY,
            subject_type TEXT NOT NULL,
            subject_reference TEXT NOT NULL,
            line_reference TEXT NOT NULL DEFAULT '',
            calculation_type TEXT NOT NULL,
            config_revision_id INTEGER REFERENCES shop_config_revisions(id),
            source_rule_id INTEGER,
            input_json TEXT NOT NULL,
            result_json TEXT NOT NULL,
            frozen_at TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_setup_snapshots_subject
            ON setup_calculation_snapshots(subject_type,subject_reference,line_reference);
        """
    )

    location_columns = {row["name"] for row in db.execute("PRAGMA table_info(locations)")}
    for name, definition in {
        "code": "TEXT NOT NULL DEFAULT ''",
        "shop_id": "INTEGER REFERENCES shops(id)",
        "timezone_name": "TEXT NOT NULL DEFAULT ''",
    }.items():
        if name not in location_columns:
            db.execute(f"ALTER TABLE locations ADD COLUMN {name} {definition}")

    profile_columns = {row["name"] for row in db.execute("PRAGMA table_info(shop_profile_configs)")}
    for name, definition in {
        "business_number": "TEXT NOT NULL DEFAULT ''",
        "business_structure": "TEXT NOT NULL DEFAULT ''",
        "business_license_number": "TEXT NOT NULL DEFAULT ''",
    }.items():
        if name not in profile_columns:
            db.execute(f"ALTER TABLE shop_profile_configs ADD COLUMN {name} {definition}")

    direct_revision_tables = (
        "shop_profile_configs", "business_hours", "closure_calendar",
        "technician_operational_profiles", "technician_schedules", "capacity_policies",
        "technician_skills", "technician_certifications", "shop_resources",
        "job_skill_requirements", "job_resource_requirements", "labor_rate_rules",
        "customer_rate_contracts", "tax_profiles", "fee_rules", "payment_methods",
        "payer_programs", "customer_type_rules",
    )
    for table in direct_revision_tables:
        for operation in ("INSERT", "UPDATE", "DELETE"):
            if operation == "UPDATE":
                revision_condition = """(SELECT status FROM shop_config_revisions WHERE id=OLD.revision_id)!='DRAFT'
                    OR (SELECT status FROM shop_config_revisions WHERE id=NEW.revision_id)!='DRAFT'"""
            else:
                row_alias = "NEW" if operation == "INSERT" else "OLD"
                revision_condition = (
                    f"(SELECT status FROM shop_config_revisions WHERE id={row_alias}.revision_id)!='DRAFT'"
                )
            db.execute(
                f"""CREATE TRIGGER IF NOT EXISTS {table}_draft_only_{operation.lower()}
                    BEFORE {operation} ON {table}
                    WHEN {revision_condition}
                    BEGIN SELECT RAISE(ABORT,'Only DRAFT configuration records may be changed.'); END"""
            )

    indirect_revision_tables = {
        "customer_rate_contract_lines": ("contract_id", "customer_rate_contracts"),
        "tax_rules": ("tax_profile_id", "tax_profiles"),
        "resource_availability": ("resource_id", "shop_resources"),
    }
    for table, (foreign_column, parent_table) in indirect_revision_tables.items():
        for operation in ("INSERT", "UPDATE", "DELETE"):
            if operation == "UPDATE":
                revision_condition = f"""(SELECT r.status FROM shop_config_revisions r
                          JOIN {parent_table} p ON p.revision_id=r.id
                          WHERE p.id=OLD.{foreign_column})!='DRAFT'
                    OR (SELECT r.status FROM shop_config_revisions r
                          JOIN {parent_table} p ON p.revision_id=r.id
                          WHERE p.id=NEW.{foreign_column})!='DRAFT'"""
            else:
                row_alias = "NEW" if operation == "INSERT" else "OLD"
                revision_condition = f"""(SELECT r.status FROM shop_config_revisions r
                          JOIN {parent_table} p ON p.revision_id=r.id
                          WHERE p.id={row_alias}.{foreign_column})!='DRAFT'"""
            db.execute(
                f"""CREATE TRIGGER IF NOT EXISTS {table}_draft_only_{operation.lower()}
                    BEFORE {operation} ON {table}
                    WHEN {revision_condition}
                    BEGIN SELECT RAISE(ABORT,'Only DRAFT configuration records may be changed.'); END"""
            )

    db.executescript(
        """
        CREATE TRIGGER IF NOT EXISTS shop_config_revision_no_delete_after_draft
            BEFORE DELETE ON shop_config_revisions
            WHEN OLD.status!='DRAFT'
            BEGIN SELECT RAISE(ABORT,'Reviewed or published configuration revisions cannot be deleted.'); END;
        CREATE TRIGGER IF NOT EXISTS shop_config_revision_no_reopen
            BEFORE UPDATE ON shop_config_revisions
            WHEN OLD.status IN ('ACTIVE','SUPERSEDED')
             AND NOT (OLD.status='ACTIVE' AND NEW.status='SUPERSEDED')
            BEGIN SELECT RAISE(ABORT,'Published configuration revisions cannot be edited or reopened.'); END;
        CREATE TRIGGER IF NOT EXISTS shop_config_revision_valid_transition
            BEFORE UPDATE OF status ON shop_config_revisions
            WHEN NOT (
                (OLD.status='DRAFT' AND NEW.status IN ('DRAFT','REVIEWED'))
                OR (OLD.status='REVIEWED' AND NEW.status='ACTIVE')
                OR (OLD.status='ACTIVE' AND NEW.status='SUPERSEDED')
            )
            BEGIN SELECT RAISE(ABORT,'Invalid configuration revision lifecycle transition.'); END;
        CREATE TRIGGER IF NOT EXISTS shop_config_revision_reviewed_locked
            BEFORE UPDATE ON shop_config_revisions
            WHEN OLD.status='REVIEWED' AND NEW.status!='ACTIVE'
            BEGIN SELECT RAISE(ABORT,'Reviewed configuration may only be published as ACTIVE.'); END;
        """
    )
