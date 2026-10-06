#!/usr/bin/env python3
"""Real HTTP lifecycle tests against disposable databases (stdlib only)."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="taktro-workflow-")
        cls.old_paths = server.DB_PATH, server.NHTSA_DB_PATH
        server.DB_PATH = Path(cls.temp.name) / "shop.db"
        server.NHTSA_DB_PATH = Path(cls.temp.name) / "reference.db"
        server.initialize_database()
        class QuietHandler(server.Handler):
            def log_message(self, *args):
                pass
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.token = cls.call("/api/login", {"pin": "1042"})["token"]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        server.DB_PATH, server.NHTSA_DB_PATH = cls.old_paths
        server.SESSIONS.pop(cls.token, None)
        cls.temp.cleanup()

    @classmethod
    def call(cls, path, payload=None, expected=200):
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (cls.http.server_port, path),
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + getattr(cls, "token", "")})
        try:
            response = urllib.request.urlopen(req)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result = json.load(response)
            if response.status not in (expected if isinstance(expected, tuple) else (expected,)):
                raise AssertionError(f"{path}: expected {expected}, got {response.status}: {result}")
            return result

    def part(self, sku, cost=40, retail=60):
        return self.call("/api/parts", {"part_number": sku, "description": sku, "cost_price": cost, "retail_price": retail})["part"]

    def ro(self):
        return self.call("/api/repair-orders", {"customer": "DEMO CUSTOMER", "vehicle": "2020 DEMO TRUCK", "lines": [{"line_id": "service", "op_code": "OIL", "concern": "OIL SERVICE", "labor": 50, "booked": 1}]}, 201)["repair_order"]

    def save(self, ro, lines=None, status="invoiced", expected=200):
        return self.call("/api/repair-orders", {"id": ro["id"], "customer": ro["customer_name"], "vehicle": ro["vehicle_info"], "status": status, "lines": lines if lines is not None else json.loads(ro["lines_json"])}, expected)

    def stock(self, part_id):
        return self.call(f"/api/parts/{part_id}")["part"]

    def test_receive_split_bill_post(self):
        parent = self.part("DEMO-5L")
        self.call("/api/parts/receive", {"part_id": parent["id"], "qty": 2, "cost": 40, "reference_id": "DEMO-PO"})
        child = self.call(f"/api/parts/{parent['id']}/breakout", {"unit_yield_qty": 5, "retail_price": 12})["part"]
        self.assertEqual((self.stock(parent["id"])["qty_on_hand"], child["qty_on_hand"]), (1, 5))
        self.assertEqual(child["cost_price"], 8)
        ro = self.ro()
        applied = self.call("/api/repair-orders/apply-part", {"ro_number": ro["ro_number"], "part_id": child["id"], "qty": 4, "job_line": 0})
        ro = applied["repair_order"]
        self.assertEqual((applied["part"]["qty_on_hand"], applied["part"]["qty_reserved"]), (5, 4))
        self.assertEqual(ro["master_total"], 98)
        lines = json.loads(ro["lines_json"])
        lines[0]["pay"] = "W"
        posted = self.save(ro, lines)["repair_order"]
        self.assertEqual((posted["customer_total"], posted["warranty_total"], posted["master_total"]), (0, 98, 98))
        self.assertEqual((self.stock(child["id"])["qty_on_hand"], self.stock(child["id"])["qty_reserved"]), (1, 0))
        self.save(posted)  # Retrying the same post cannot deduct twice.
        self.assertEqual(self.stock(child["id"])["qty_on_hand"], 1)
        self.save(posted, status="write-up", expected=409)
        self.call("/api/repair-orders/apply-part", {"ro_number": ro["ro_number"], "part_id": child["id"], "qty": 1, "job_line": 0}, 400)
        with server.connect() as db:
            self.assertEqual(db.execute("SELECT status FROM ro_part_charges WHERE ro_number=?", (ro["ro_number"],)).fetchone()[0], "POSTED")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM parts_transactions WHERE reference_id=? AND transaction_type='consume'", (ro["ro_number"],)).fetchone()[0], 1)

    def test_invalid_allocation_and_split_rollback(self):
        part = self.part("ROLLBACK")
        self.call("/api/parts/receive", {"part_id": part["id"], "qty": 1})
        ro = self.ro()
        self.call("/api/repair-orders/apply-part", {"ro_number": ro["ro_number"], "part_id": part["id"], "qty": 1, "job_line": 99}, 400)
        self.call("/api/repair-orders/apply-part", {"ro_number": ro["ro_number"], "part_id": part["id"], "qty": 2, "job_line": 0}, 400)
        self.assertEqual(self.stock(part["id"])["qty_reserved"], 0)
        self.part("EXISTING-CHILD")
        self.call(f"/api/parts/{part['id']}/breakout", {"unit_yield_qty": 5, "part_number": "EXISTING-CHILD"}, 400)
        self.assertEqual(self.stock(part["id"])["qty_on_hand"], 1)
        self.call(f"/api/parts/{part['id']}/breakout", {"unit_yield_qty": 2.5}, 400)
        self.call("/api/parts/reserve", {"part_id": part["id"], "qty": 1, "ro_number": ro["ro_number"]})
        self.call(f"/api/parts/{part['id']}/breakout", {"unit_yield_qty": 5}, 400)
        self.assertEqual(self.stock(part["id"])["qty_on_hand"], 1)
        self.save(ro, expected=400)  # Unconfirmed stock cannot be posted.

    def test_confirm_remove_and_protect_charge(self):
        part = self.part("REMOVE")
        self.call("/api/parts/receive", {"part_id": part["id"], "qty": 3})
        ro = self.ro()
        self.call("/api/parts/reserve", {"part_id": part["id"], "qty": 2, "ro_number": ro["ro_number"]})
        ro = self.call("/api/repair-orders/apply-part", {"ro_number": ro["ro_number"], "part_id": part["id"], "qty": 2, "job_line": 0})["repair_order"]
        self.assertEqual(self.stock(part["id"])["qty_reserved"], 2)
        lines = json.loads(ro["lines_json"])
        lines[0]["parts"] = 0
        self.save(ro, lines, status="write-up", expected=400)
        self.call("/api/parts/release", {"part_id": part["id"], "qty": 1, "ro_number": ro["ro_number"]}, 400)
        records = self.call("/api/repair-orders")["repair_orders"]
        charge = next(item for item in records if item["id"] == ro["id"])["part_charges"][0]
        self.call("/api/repair-orders/remove-part", {"charge_id": charge["id"]})
        self.assertEqual((self.stock(part["id"])["qty_on_hand"], self.stock(part["id"])["qty_reserved"]), (3, 0))
        with server.connect() as db:
            self.assertEqual(db.execute("SELECT master_total FROM repair_orders WHERE id=?", (ro["id"],)).fetchone()[0], 50)

    def test_multi_part_post_rolls_back(self):
        ro = self.ro()
        parts = [self.part("ATOMIC-A"), self.part("ATOMIC-B")]
        for part in parts:
            self.call("/api/parts/receive", {"part_id": part["id"], "qty": 1})
            ro = self.call("/api/repair-orders/apply-part", {"ro_number": ro["ro_number"], "part_id": part["id"], "qty": 1, "job_line": 0})["repair_order"]
        # Simulate an inconsistent legacy inventory record; the second consumption fails.
        with server.connect() as db:
            db.execute("UPDATE parts_inventory SET qty_on_hand=0 WHERE id=?", (parts[1]["id"],))
        self.save(ro, expected=400)
        self.assertEqual((self.stock(parts[0]["id"])["qty_on_hand"], self.stock(parts[0]["id"])["qty_reserved"]), (1, 1))
        with server.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM ro_part_charges WHERE ro_number=? AND status='POSTED'", (ro["ro_number"],)).fetchone()[0], 0)
            self.assertNotEqual(db.execute("SELECT status FROM repair_orders WHERE id=?", (ro["id"],)).fetchone()[0], "invoiced")

    def test_shortage_receipt_restores_posting(self):
        part = self.part("SHORTAGE")
        self.call("/api/parts/receive", {"part_id": part["id"], "qty": 2})
        ro = self.ro()
        ro = self.call("/api/repair-orders/apply-part", {"ro_number": ro["ro_number"], "part_id": part["id"], "qty": 2, "job_line": 0})["repair_order"]
        self.call("/api/parts/count-shortage", {"counts": [{"part_id": part["id"], "counted_qty": 1}], "notes": "DEMO PHYSICAL SHORTAGE"})
        self.save(ro, expected=400)
        self.call("/api/parts/receive", {"part_id": part["id"], "qty": 1})
        self.save(ro)
        self.assertEqual((self.stock(part["id"])["qty_on_hand"], self.stock(part["id"])["qty_reserved"]), (0, 0))

    def test_concurrent_allocation_cannot_oversell(self):
        from concurrent.futures import ThreadPoolExecutor
        part = self.part("LAST-UNIT")
        self.call("/api/parts/receive", {"part_id": part["id"], "qty": 1})
        ros = [self.ro(), self.ro()]
        def allocate(ro):
            return self.call("/api/repair-orders/apply-part", {"ro_number": ro["ro_number"], "part_id": part["id"], "qty": 1, "job_line": 0}, expected=(200, 400))
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(allocate, ros))
        self.assertEqual(sum(bool(result.get("success")) for result in results), 1)
        self.assertEqual((self.stock(part["id"])["qty_on_hand"], self.stock(part["id"])["qty_reserved"]), (1, 1))
        with server.connect() as db:
            self.assertEqual(db.execute("SELECT SUM(qty) FROM ro_part_charges WHERE part_id=?", (part["id"],)).fetchone()[0], 1)

    def test_all_pay_categories_and_booking(self):
        ro = self.ro()
        lines = [{"line_id": pay, "pay": pay, "op_code": pay, "parts": 10, "labor": 20, "booked": 1} for pay in "CWIG"]
        lines[-1]["booked"] = 0
        self.save(ro, lines, expected=400)
        lines[-1]["booked"] = 1
        posted = self.save(ro, lines)["repair_order"]
        self.assertEqual([posted[key] for key in ["customer_total", "warranty_total", "internal_total", "goodwill_total"]], [30] * 4)
        self.assertEqual(posted["master_total"], 120)


if __name__ == "__main__":
    unittest.main(verbosity=2)
