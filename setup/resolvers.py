"""Central preview/production resolvers for active shop configuration."""

from __future__ import annotations

from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import math
import sqlite3


def _as_of(value: str | None) -> str:
    return value or date.today().isoformat()


def active_revision_id(db: sqlite3.Connection, shop_id: int, location_id: int | None = None) -> int | None:
    row = db.execute(
        """SELECT id FROM shop_config_revisions
           WHERE shop_id=? AND status='ACTIVE'
             AND (scope_location_id=? OR scope_location_id IS NULL)
           ORDER BY CASE WHEN scope_location_id=? THEN 0 ELSE 1 END,id DESC LIMIT 1""",
        (shop_id, location_id, location_id),
    ).fetchone()
    return int(row["id"]) if row else None


def resolve_labor_rate(
    db: sqlite3.Connection,
    *,
    shop_id: int,
    location_id: int,
    pay_type: str,
    labor_class_code: str,
    customer_id: int | None = None,
    ro_override: float | None = None,
    effective_on: str | None = None,
) -> dict:
    """Resolve one labor rate and return both the result and selection evidence."""
    if ro_override is not None:
        if ro_override < 0:
            raise ValueError("RO labor-rate override cannot be negative.")
        return {"hourly_rate": float(ro_override), "source": "RO_OVERRIDE", "rule_id": None,
                "config_revision_id": None, "rules_checked": ["RO override selected"]}

    pay = pay_type.strip().upper()
    if pay not in {"C", "W", "I"}:
        raise ValueError("Pay type must be C, W, or I.")
    on_date = _as_of(effective_on)
    revision_id = active_revision_id(db, shop_id, location_id)
    if revision_id is None:
        raise ValueError("No active shop configuration resolves for this location.")
    labor_class = db.execute(
        "SELECT id,name FROM labor_classes WHERE code=? COLLATE NOCASE AND active=1",
        (labor_class_code.strip(),),
    ).fetchone()
    if not labor_class:
        raise ValueError("Labor class is not configured.")

    checked = ["RO override: none"]
    if customer_id is not None:
        contract = db.execute(
            """SELECT l.id,l.hourly_rate,c.name
               FROM customer_rate_contracts c
               JOIN customer_rate_contract_lines l ON l.contract_id=c.id
               WHERE c.revision_id=? AND c.customer_id=? AND c.active=1
                 AND (c.location_id=? OR c.location_id IS NULL)
                 AND l.pay_type=? AND l.labor_class_id=?
                 AND c.effective_from<=? AND (c.effective_to IS NULL OR c.effective_to>=?)
               ORDER BY CASE WHEN c.location_id=? THEN 0 ELSE 1 END,c.id DESC LIMIT 1""",
            (revision_id, customer_id, location_id, pay, labor_class["id"], on_date, on_date, location_id),
        ).fetchone()
        if contract:
            checked.append(f"Customer contract: {contract['name']} selected")
            return {"hourly_rate": float(contract["hourly_rate"]), "source": "CUSTOMER_CONTRACT",
                    "rule_id": int(contract["id"]), "config_revision_id": revision_id,
                    "rules_checked": checked}
    checked.append("Customer contract: none")

    rule = db.execute(
        """SELECT id,hourly_rate,name,location_id FROM labor_rate_rules
           WHERE revision_id=? AND pay_type=? AND labor_class_id=?
             AND (location_id=? OR location_id IS NULL)
             AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)
           ORDER BY CASE WHEN location_id=? THEN 0 ELSE 1 END,id DESC LIMIT 1""",
        (revision_id, pay, labor_class["id"], location_id, on_date, on_date, location_id),
    ).fetchone()
    if not rule:
        raise ValueError("No labor-rate rule resolves for the requested inputs.")
    source = "LOCATION_RATE" if rule["location_id"] is not None else "SHOP_DEFAULT"
    checked.append(f"{source}: {rule['name']} selected")
    return {"hourly_rate": float(rule["hourly_rate"]), "source": source,
            "rule_id": int(rule["id"]), "config_revision_id": revision_id,
            "rules_checked": checked}


def calculate_fee(*, calculation_type: str, rate_or_amount: float, basis_amount: float = 0,
                  units: float = 0, jobs: float = 0, minimum: float | None = None,
                  maximum: float | None = None) -> float:
    values = [rate_or_amount, basis_amount, units, jobs]
    values.extend(value for value in (minimum, maximum) if value is not None)
    if not all(math.isfinite(value) for value in values):
        raise ValueError("Fee inputs must be finite numbers.")
    if any(value < 0 for value in values):
        raise ValueError("Fee inputs cannot be negative.")
    if minimum is not None and maximum is not None and maximum < minimum:
        raise ValueError("Fee maximum cannot be less than its minimum.")
    kind = calculation_type.strip().upper()
    if kind == "DISABLED":
        amount = 0.0
    elif kind == "FLAT":
        amount = rate_or_amount
    elif kind == "PERCENT":
        amount = basis_amount * rate_or_amount / 100
    elif kind == "PER_UNIT":
        amount = units * rate_or_amount
    elif kind == "PER_JOB":
        amount = jobs * rate_or_amount
    else:
        raise ValueError("Unsupported fee calculation type.")
    if minimum is not None:
        amount = max(amount, minimum)
    if maximum is not None:
        amount = min(amount, maximum)
    return float(Decimal(str(amount)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def calculate_tax(charge_amounts: dict[str, float], rates: dict[str, float]) -> dict:
    """Calculate additive per-charge tax using decimal half-up rounding."""
    taxable_basis = Decimal("0")
    tax_amount = Decimal("0")
    detail = {}
    for charge_type, raw_amount in charge_amounts.items():
        amount = Decimal(str(raw_amount))
        rate = Decimal(str(rates.get(charge_type, 0)))
        if not amount.is_finite() or not rate.is_finite() or amount < 0 or rate < 0:
            raise ValueError("Tax amounts and rates must be finite and non-negative.")
        line_tax = (amount * rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        if rate:
            taxable_basis += amount
        tax_amount += line_tax
        detail[charge_type] = {"basis": float(amount), "rate": float(rate), "tax": float(line_tax)}
    return {"taxable_basis": float(taxable_basis), "tax_amount": float(tax_amount), "detail": detail}


def calculate_capacity(*, productive_hours: float, booking_target_percent: float,
                       reserve_hours: float, already_booked_hours: float) -> dict:
    physical = max(0.0, productive_hours)
    target = physical * max(0.0, min(100.0, booking_target_percent)) / 100
    available = max(0.0, target - max(0.0, reserve_hours) - max(0.0, already_booked_hours))
    return {"physical_capacity": physical, "booking_target": target,
            "reserved_capacity": max(0.0, reserve_hours),
            "already_booked": max(0.0, already_booked_hours), "available_to_book": available}
