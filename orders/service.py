"""Confirmed parts billing and atomic RO inventory posting."""
import json
from parts import service as stock


def validate_charges(db, ro_number, lines):
    by_id = {line["line_id"]: line for line in lines}
    for charge in db.execute("SELECT line_id, SUM(qty * unit_price) AS amount FROM ro_part_charges WHERE ro_number=? GROUP BY line_id", (ro_number,)):
        line = by_id.get(charge["line_id"])
        if not line or round(float(line["parts"]), 2) < round(charge["amount"], 2):
            raise ValueError("A confirmed parts line cannot be removed or reduced below its billed parts amount.")


def apply_part(db, ro_number, part_id, qty, job_line, actor_id, notes, normalize):
    qty = stock.whole_quantity(qty)
    with stock.atomic(db):
        ro = stock.require_open_ro(db, ro_number)
        part = db.execute("SELECT * FROM parts_inventory WHERE id=?", (part_id,)).fetchone()
        if not part:
            raise ValueError("Part not found.")
        lines, _ = normalize(json.loads(ro["lines_json"]))
        if str(job_line).upper() in {"NEW", "NEW LINE"}:
            lines.append({"pay": "C", "op_code": part["part_number"], "concern": "PART: " + part["description"], "parts": 0, "booked": 1})
            lines, _ = normalize(lines)
            target = lines[-1]
        else:
            try:
                index = int(job_line)
                if index < 0 or index >= len(lines):
                    raise ValueError("Job line not found.")
                target = lines[index]
            except (TypeError, ValueError):
                matches = [line for line in lines if line["line_id"] == str(job_line) or line["op_code"] == str(job_line).strip().upper()]
                if len(matches) != 1:
                    raise ValueError("Select a valid, unambiguous job line.") from None
                target = matches[0]
        # Existing unbilled reservations may be confirmed without reserving twice.
        reserved = db.execute("SELECT COALESCE(SUM(fulfilled_qty),0) FROM parts_reservations WHERE part_id=? AND ro_number=? AND status IN ('ACTIVE','SHORT')", (part_id, ro["ro_number"])).fetchone()[0]
        billed = db.execute("SELECT COALESCE(SUM(qty),0) FROM ro_part_charges WHERE part_id=? AND ro_number=? AND status='CONFIRMED'", (part_id, ro["ro_number"])).fetchone()[0]
        additional = max(0, qty - max(0, reserved - billed))
        if additional:
            stock.reserve_stock(db, part_id, additional, ro["ro_number"], actor_id, notes)
        price = float(part["retail_price"])
        target["parts"] = round(float(target["parts"]) + qty * price, 2)
        lines, totals = normalize(lines)
        now = stock._utc_now()
        db.execute("INSERT INTO ro_part_charges(ro_number,line_id,part_id,qty,unit_price,unit_cost,created_at) VALUES (?,?,?,?,?,?,?)", (ro["ro_number"], target["line_id"], part_id, qty, price, float(part["average_cost"] if part["average_cost"] is not None else part["cost_price"]), now))
        db.execute("UPDATE repair_orders SET lines_json=?,total_hours=?,customer_total=?,warranty_total=?,internal_total=?,goodwill_total=?,master_total=?,updated_by=?,updated_at=? WHERE id=?", (json.dumps(lines), totals["hours"], totals["C"], totals["W"], totals["I"], totals["G"], totals["master"], actor_id, now, ro["id"]))
        db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,'repair_order.part_confirm','repair_order',?,?,?)", (actor_id, str(ro["id"]), json.dumps({"part_id": part_id, "qty": qty, "line_id": target["line_id"], "notes": notes}), now))
        return {"success": True, "totals": totals, "part": stock.get_part_by_id(db, part_id), "repair_order": dict(db.execute("SELECT * FROM repair_orders WHERE id=?", (ro["id"],)).fetchone())}


def post_parts(db, ro_number, lines, actor_id):
    with stock.atomic(db):
        stock.require_open_ro(db, ro_number)
        validate_charges(db, ro_number, lines)
        charges = db.execute("SELECT part_id,SUM(qty) AS qty FROM ro_part_charges WHERE ro_number=? AND status='CONFIRMED' GROUP BY part_id", (ro_number,)).fetchall()
        allocations = db.execute("SELECT part_id,SUM(requested_qty) AS demand,SUM(fulfilled_qty) AS fulfilled FROM parts_reservations WHERE ro_number=? AND status IN ('ACTIVE','SHORT') GROUP BY part_id", (ro_number,)).fetchall()
        required = {row["part_id"]: row["qty"] for row in charges}
        allocated = {row["part_id"]: row["demand"] for row in allocations}
        if required != allocated or any(row["demand"] != row["fulfilled"] for row in allocations):
            raise ValueError("Every reserved part must be fully available and confirmed on a billed RO line before posting.")
        for charge in charges:
            stock.consume_stock(db, charge["part_id"], charge["qty"], ro_number, actor_id, "RO POST", manage_transaction=False)
        now = stock._utc_now()
        db.execute("UPDATE ro_part_charges SET status='POSTED',posted_at=? WHERE ro_number=? AND status='CONFIRMED'", (now, ro_number))
        db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,'repair_order.post','repair_order',? ,?,?)", (actor_id, ro_number, json.dumps({"parts": required}), now))


def remove_part(db, charge_id, actor_id, normalize):
    with stock.atomic(db):
        charge = db.execute("SELECT * FROM ro_part_charges WHERE id=?", (charge_id,)).fetchone()
        if not charge:
            raise ValueError("Confirmed part charge not found.")
        ro = stock.require_open_ro(db, charge["ro_number"])
        lines, _ = normalize(json.loads(ro["lines_json"]))
        target = next((line for line in lines if line["line_id"] == charge["line_id"]), None)
        if target is None:
            raise ValueError("Confirmed part line not found.")
        target["parts"] = max(0, round(target["parts"] - charge["qty"] * charge["unit_price"], 2))
        lines, totals = normalize(lines)
        db.execute("DELETE FROM ro_part_charges WHERE id=?", (charge_id,))
        stock.release_stock(db, charge["part_id"], charge["qty"], ro["ro_number"], actor_id, "REMOVE RO CHARGE")
        now = stock._utc_now()
        db.execute("UPDATE repair_orders SET lines_json=?,total_hours=?,customer_total=?,warranty_total=?,internal_total=?,goodwill_total=?,master_total=?,updated_by=?,updated_at=? WHERE id=?", (json.dumps(lines), totals["hours"], totals["C"], totals["W"], totals["I"], totals["G"], totals["master"], actor_id, now, ro["id"]))
        db.execute("INSERT INTO audit_events(actor_employee_id,action,subject_type,subject_id,details_json,created_at) VALUES (?,'repair_order.part_remove','repair_order',?,?,?)", (actor_id, str(ro["id"]), json.dumps(dict(charge)), now))
        return {"success": True}
