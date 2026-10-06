#!/usr/bin/env python3
"""RO/Parts browser regressions against temporary shop and reference databases.

Install Playwright in a development venv. Chromium may be supplied with
TAKTRO_BROWSER_PATH, or use the installed system/bundled Chromium.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

try:
    from playwright.sync_api import sync_playwright, expect
except ImportError:
    print("STATUS: BLOCKED — install Playwright to run browser regressions.")
    sys.exit(2)


class WorkspaceBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="taktro-browser-")
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
        cls.playwright = sync_playwright().start()
        executable = os.environ.get("TAKTRO_BROWSER_PATH") or shutil.which("chromium")
        cls.browser = cls.playwright.chromium.launch(headless=True, **({"executable_path": executable} if executable else {}))
        cls.url = f"http://127.0.0.1:{cls.http.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        server.DB_PATH, server.NHTSA_DB_PATH = cls.old_paths
        cls.temp.cleanup()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1600, "height": 1000})
        self.page = self.context.new_page()
        self.page.set_default_timeout(7000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("console", lambda message: self.errors.append(message.text) if message.type == "error" and "Failed to load resource" not in message.text else None)
        self.page.on("dialog", lambda dialog: dialog.accept())
        self.page.goto(self.url)
        self.page.locator("#employeePin").fill("1042")
        expect(self.page.locator("#authOverlay")).to_be_hidden()
        self.token = self.page.evaluate("sessionToken")

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "Browser script/command errors")

    def api(self, path, payload=None):
        response = self.context.request.fetch(self.url + path, method="POST" if payload is not None else "GET",
            data=payload, headers={"Authorization": "Bearer " + self.token})
        self.assertTrue(response.ok, f"{path}: {response.status} {response.text()}")
        return response.json()

    def seed_part(self, suffix="", qty=0):
        sku = self._testMethodName.upper() + suffix
        part = self.api("/api/parts", {"part_number": sku, "description": sku, "cost_price": 40, "retail_price": 12})["part"]
        if qty:
            self.api("/api/parts/receive", {"part_id": part["id"], "qty": qty})
        return part

    def seed_ro(self, suffix=""):
        ro = self.api("/api/repair-orders", {"customer": self._testMethodName + suffix, "vehicle": "2020 DEMO TRUCK", "lines": [{"line_id": "service", "pay": "C", "op_code": "OIL", "concern": "OIL SERVICE", "labor": 50, "booked": 0}]})["repair_order"]
        # Seed before a fresh login, just as a user opens an existing shop database.
        self.page.reload()
        self.page.locator("#employeePin").fill("1042")
        expect(self.page.locator("#authOverlay")).to_be_hidden()
        self.token = self.page.evaluate("sessionToken")
        self.page.wait_for_function("id => activeRoList.some(ro => ro.id === id)", arg=ro["id"])
        return ro

    def parts_workspace(self, part):
        self.page.locator("#cardParts").click()
        with self.page.expect_response(lambda r: '/api/parts?q=' in r.url):
            self.page.locator("#partsSearchInput").fill(part["part_number"])
        expect(self.page.locator("#partsResults tbody tr")).to_have_count(1)

    def open_ro(self, ro):
        self.page.locator("#cardNewRo").click()
        row = self.page.locator(f"#openRoTableBody tr[data-action-param='{ro['id']}']")
        row.click()
        expect(self.page.locator("#roCustInput")).to_have_value(ro["customer_name"])

    def assert_delegated(self, selector):
        violations = self.page.locator(selector).evaluate("""root => Array.from(root.querySelectorAll('*')).flatMap(element =>
          Array.from(element.attributes).filter(attribute => /^on[a-z]+$/.test(attribute.name))
          .map(attribute => `${element.tagName}: ${attribute.name}`))""")
        self.assertEqual(violations, [])
        self.assertEqual(self.page.locator(selector + " kbd:not(.keycap)").count(), 0)

    def test_receive_split_bill_post_from_ui(self):
        part = self.seed_part()
        ro = self.seed_ro()
        self.parts_workspace(part)
        self.page.locator(f"[data-action='parts.receive'][data-action-param='{part['id']}']").click()
        self.page.locator("#recQty").fill("2")
        self.page.locator("#recCost").fill("40")
        self.assert_delegated("#partsResults")
        with self.page.expect_response(lambda r: r.url.endswith('/api/parts/receive') and r.request.method == 'POST'):
            self.page.locator("#recQty").press("Alt+r")
        expect(self.page.locator("#receiveStockForm")).to_have_count(0)
        self.page.locator(f"[data-action='parts.detail'][data-action-param='{part['id']}']").last.click()
        self.page.locator("[data-command='parts.breakout'] kbd").click()
        self.page.locator("#bbYieldQty").fill("5")
        self.page.locator("#bbChildRetail").fill("12")
        self.assert_delegated("#bulkBreakoutOverlay")
        with self.page.expect_response(lambda r: r.url.endswith('/breakout') and r.request.method == 'POST'):
            self.page.locator("#bbChildRetail").press("Alt+s")
        expect(self.page.locator("#bulkBreakoutOverlay")).to_have_count(0)
        child = self.api("/api/parts?q=" + part["part_number"] + "-1L")["parts"][0]
        self.assertEqual(self.api(f"/api/parts/{part['id']}")["part"]["qty_on_hand"], 1)
        # Return to the dashboard through Escape and open the seeded RO.
        self.page.locator("#partsSearchInput").focus()
        self.page.keyboard.press("Escape")
        expect(self.page.locator("#workspaceOverlay")).to_be_hidden()
        self.open_ro(ro)
        self.assert_delegated("#workspaceContent")
        self.page.locator("[data-command='ro.add_part'] kbd").click()
        self.page.locator("#roPartSearchInput").fill(child["part_number"])
        button = self.page.locator(f"[data-action='parts.ro-confirm'][data-action-param='{child['id']}']")
        expect(button).to_be_visible()
        button.click()
        self.page.locator("#allocQty").fill("4")
        self.page.locator("#allocJobLine").select_option("service")
        with self.page.expect_response(lambda r: r.url.endswith('/api/repair-orders/apply-part') and r.request.method == 'POST'):
            self.page.locator("#allocQty").press("Alt+s")
        expect(self.page.locator("#roPartSearchModalOverlay")).to_have_count(0)
        expect(self.page.locator(".ro-parts-input")).to_have_value("48")
        expect(self.page.locator("#roConfirmedParts")).to_contain_text("CONFIRMED")
        stock = self.api(f"/api/parts/{child['id']}")["part"]
        self.assertEqual((stock["qty_on_hand"], stock["qty_reserved"]), (5, 4))
        self.page.locator(".ro-pay-select").select_option("W")
        self.page.locator(".ro-book-checkbox").check()
        with self.page.expect_response(lambda r: r.url.endswith('/api/repair-orders') and r.request.method == 'POST'):
            self.page.locator("[data-command='ro.invoice']").click()
        expect(self.page.locator("#roStatusSelect")).to_be_disabled()
        expect(self.page.locator("#roConfirmedParts")).to_contain_text("POSTED")
        stock = self.api(f"/api/parts/{child['id']}")["part"]
        self.assertEqual((stock["qty_on_hand"], stock["qty_reserved"]), (1, 0))
        posted = self.api(f"/api/repair-orders/{ro['id']}")["repair_order"]
        self.assertEqual((posted["warranty_total"], posted["customer_total"], posted["master_total"]), (98, 0, 98))
        self.page.set_viewport_size({"width": 1280, "height": 900})
        toolbar=self.page.locator(".ro-editor-toolbar")
        self.assertLessEqual(toolbar.evaluate("element => element.scrollWidth"), toolbar.evaluate("element => element.clientWidth"), "RO toolbar must fit the supported desktop width")
        artifacts = server.ROOT / ".taktro" / "test-results" / "workspace-browser"
        artifacts.mkdir(parents=True, exist_ok=True)
        self.page.screenshot(path=str(artifacts / "posted-ro.png"), full_page=True)
        expect(self.page.locator("[data-command='ro.back']")).to_be_enabled()
        self.page.locator("[data-command='ro.back']").click()
        expect(self.page.locator("#openRoTableBody")).to_be_visible()

    def test_nested_row_button_and_native_validation(self):
        part = self.seed_part(qty=2)
        self.parts_workspace(part)
        self.page.locator(f"[data-action='parts.receive'][data-action-param='{part['id']}']").click()
        expect(self.page.locator("#receiveStockForm")).to_be_visible()
        self.page.locator("#recQty").fill("0")
        self.page.locator("#recQty").press("Alt+r")
        self.assertEqual(self.api(f"/api/parts/{part['id']}")["part"]["qty_on_hand"], 2)
        expect(self.page.locator("#receiveStockForm")).to_be_visible()
        self.page.locator("#recQty").fill("1")
        requests=[]
        self.page.on("request", lambda request: requests.append(request.url) if request.method == 'POST' else None)
        with self.page.expect_response(lambda r: r.url.endswith('/api/parts/receive') and r.request.method == 'POST'):
            self.page.locator("#receiveStockForm button[type='submit'] kbd").click()
        expect(self.page.locator("#receiveStockForm")).to_have_count(0)
        self.assertEqual(sum(url.endswith('/api/parts/receive') for url in requests), 1)
        self.assertEqual(self.api(f"/api/parts/{part['id']}")["part"]["qty_on_hand"], 3)

    def test_keyboard_activation_and_editor_shortcuts(self):
        ro=self.seed_ro()
        self.page.locator("#cardNewRo").focus()
        self.page.keyboard.press("Space")
        row=self.page.locator(f"#openRoTableBody tr[data-action-param='{ro['id']}']")
        expect(row).to_be_visible()
        loads=[]
        self.page.on("request",lambda request: loads.append(request.url) if request.url.endswith('/api/repair-orders') else None)
        row.focus()
        self.page.keyboard.press("Enter")
        expect(self.page.locator("#roCustInput")).to_have_value(ro["customer_name"])
        self.assertEqual(len(loads),1)
        self.page.locator(".ro-concern-input").focus()
        self.page.keyboard.press("Alt+a")
        expect(self.page.locator("#roLinesWorkspaceBody tr")).to_have_count(2)
        self.page.locator("#roLinesWorkspaceBody tr").last.locator(".ro-concern-input").fill("NEW JOB")
        with self.page.expect_response(lambda r: r.url.endswith('/api/repair-orders') and r.request.method == 'POST'):
            self.page.keyboard.press("Alt+s")
        saved=self.api(f"/api/repair-orders/{ro['id']}")["repair_order"]
        self.assertEqual(len(json.loads(saved["lines_json"])),2)
        self.assert_delegated("#workspaceContent")

    def test_detail_edit_and_adjust_commands(self):
        part=self.seed_part(qty=2)
        self.parts_workspace(part)
        self.page.locator("#partsResults tbody tr").focus()
        self.page.keyboard.press("Space")
        expect(self.page.locator("[data-command='parts.adjust_qty']")).to_be_visible()
        self.page.locator("[data-command='parts.edit_details'] kbd").click()
        self.page.locator("#editHomeBin").fill("bin-browser")
        with self.page.expect_response(lambda r: r.url.endswith('/metadata') and r.request.method == 'POST'):
            self.page.locator("#editHomeBin").press("Alt+s")
        expect(self.page.locator("#editPartDetailsForm")).to_have_count(0)
        self.assertEqual(self.api(f"/api/parts/{part['id']}")["part"]["home_bin"],"BIN-BROWSER")
        self.page.locator("[data-command='parts.adjust_qty']").click()
        expect(self.page.locator("#adjustStockForm")).to_be_visible()
        self.assert_delegated("#partsResults")
        self.page.locator("#adjustStockForm [data-action='parts.detail']").click()
        self.page.locator("[data-command='parts.back'] kbd").click()
        expect(self.page.locator("[data-command='parts.adjust_qty']")).to_have_count(0)
        expect(self.page.locator("#partsResults tbody").first).to_be_visible()

    def test_counter_sale_input_does_not_activate_row(self):
        part=self.seed_part(qty=4)
        self.parts_workspace(part)
        self.page.locator(f"[data-command='parts.counter_sale'][data-part-id='{part['id']}']").click()
        expect(self.page.locator("#counterSaleForm")).to_be_visible()
        self.assert_delegated("#partsResults")
        self.page.locator("#csQty_0").fill("2")
        self.page.locator("#csPrice_0").fill("15")
        self.page.locator("#csQty_0").click()
        self.assertEqual(self.page.evaluate("window.expandedCounterSaleIndex"),None)
        self.page.locator("#csPayMethod").select_option("CREDIT CARD")
        self.assertEqual(self.page.evaluate("window.activeCounterSale.paymentMethod"),"CREDIT CARD")
        expect(self.page.locator("#csItemTotal_0")).to_contain_text("30.00")
        self.page.locator("[data-action='parts.counter-remove']").click()
        expect(self.page.locator("#csQty_0")).to_have_count(0)
        self.page.locator("[data-action='parts.counter-cancel']").click()
        expect(self.page.locator("#counterSaleForm")).to_have_count(0)

    def test_pending_search_cannot_replace_detail(self):
        part=self.seed_part(qty=1)
        self.page.locator("#cardParts").click()
        row=self.page.locator(f"tr[data-action='parts.detail'][data-action-param='{part['id']}']")
        expect(row).to_be_visible()
        pending=[]
        self.page.route("**/api/parts?q=*", lambda route: pending.append(route))
        with self.page.expect_request(lambda request: '/api/parts?q=' in request.url):
            self.page.locator("#partsSearchInput").fill(part["part_number"])
        row.click()
        expect(self.page.locator("[data-command='parts.adjust_qty']")).to_be_visible()
        with self.page.expect_response(lambda response: '/api/parts?q=' in response.url):
            pending[0].continue_()
        self.page.wait_for_load_state("networkidle")
        expect(self.page.locator("[data-command='parts.adjust_qty']")).to_be_visible()

    def test_parts_workspace_allocation_form(self):
        part=self.seed_part(qty=3)
        ro=self.seed_ro()
        self.parts_workspace(part)
        self.page.locator(f"[data-command='parts.apply_ro'][data-part-id='{part['id']}']").click()
        expect(self.page.locator("#applyToRoForm")).to_be_visible()
        self.page.locator("#appRoSelect").select_option(ro["ro_number"])
        self.page.locator("#appJobLineSelect").select_option("service")
        self.page.locator("#appQty").fill("2")
        self.assert_delegated("#partsResults")
        with self.page.expect_response(lambda r: r.url.endswith('/api/repair-orders/apply-part') and r.request.method == 'POST'):
            self.page.locator("#appQty").press("Alt+o")
        expect(self.page.locator("#applyToRoForm")).to_have_count(0)
        stock=self.api(f"/api/parts/{part['id']}")["part"]
        self.assertEqual((stock["qty_on_hand"],stock["qty_reserved"]),(3,2))
        saved=self.api(f"/api/repair-orders/{ro['id']}")["repair_order"]
        self.assertEqual(saved["master_total"],74)

    def test_new_part_radio_and_nested_save_button(self):
        self.page.locator("#cardParts").click()
        self.page.locator("[data-command='parts.add_stock'] kbd").click()
        expect(self.page.locator("#newPartModalOverlay")).to_be_visible()
        self.page.locator("input[name='newPartType'][value='PASSTHROUGH']").check()
        expect(self.page.locator("#npPassThroughNote")).to_be_visible()
        self.page.locator("input[name='newPartType'][value='STOCK']").check()
        expect(self.page.locator("#npPassThroughNote")).to_be_hidden()
        sku="BROWSER-NEW-PART"
        self.page.locator("#npPartNumber").fill(sku)
        self.page.locator("#npDescription").fill("BROWSER NEW PART")
        self.assert_delegated("#newPartModalOverlay")
        with self.page.expect_response(lambda r: r.url.endswith('/api/parts') and r.request.method == 'POST'):
            self.page.locator("[data-action='parts.new-save'] kbd").click()
        expect(self.page.locator("#newPartModalOverlay")).to_have_count(0)
        self.assertEqual(self.api("/api/parts?q="+sku)["parts"][0]["part_number"],sku)


    def warp_from_workspace(self, key):
        # Warp shortcuts are routed from outside editable controls.
        self.page.locator('#workspaceContent').click(position={'x': 5, 'y': 5})
        self.page.keyboard.press('Shift+' + key)

    def test_warp_escape_restores_previous_parts_screen(self):
        part = self.seed_part(qty=2)
        self.page.keyboard.press('Shift+p')
        with self.page.expect_response(lambda r: '/api/parts?q=' in r.url):
            self.page.locator('#partsSearchInput').fill(part['part_number'])
        expect(self.page.locator('#partsResults tbody tr')).to_have_count(1)
        self.warp_from_workspace('v')
        expect(self.page.locator('#vehicleSearch')).to_be_visible()
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#partsSearchInput')).to_have_value(part['part_number'])
        expect(self.page.locator('#vehicleSearch')).to_have_count(0)
        expect(self.page.locator('#activeTaskTitle')).to_contain_text('PARTS')
        expect(self.page.locator('#partsResults tbody tr')).to_have_count(1)
        self.page.locator('#partsResults tbody tr').first.click()
        expect(self.page.locator('[data-command="parts.breakout"]')).to_be_visible()
        self.warp_from_workspace('v')
        expect(self.page.locator('#vehicleSearch')).to_be_visible()
        self.page.keyboard.press('Escape')
        expect(self.page.locator('[data-command="parts.breakout"]')).to_be_visible()
        expect(self.page.locator('#partsResults')).to_contain_text(part['part_number'])
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#workspaceOverlay')).to_be_hidden()

    def test_nested_warps_keep_separate_return_frames(self):
        first = self.seed_part('-FIRST', qty=2)
        second = self.seed_part('-SECOND', qty=2)
        self.parts_workspace(first)
        self.warp_from_workspace('v')
        with self.page.expect_response(lambda r: '/api/vehicles?q=' in r.url):
            self.page.locator('#vehicleSearch').fill('FIRST VEHICLE VIEW')
        self.warp_from_workspace('p')
        with self.page.expect_response(lambda r: '/api/parts?q=' in r.url):
            self.page.locator('#partsSearchInput').fill(second['part_number'])
        expect(self.page.locator('#partsResults tbody tr')).to_have_count(1)
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#vehicleSearch')).to_have_value('FIRST VEHICLE VIEW')
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#partsSearchInput')).to_have_value(first['part_number'])
        self.page.locator('#partsSearchInput').press('Enter')
        expect(self.page.locator('#partsResults')).to_contain_text(first['part_number'])
        expect(self.page.locator('[data-command="parts.breakout"]')).to_be_visible()

    def test_customer_create_edit_and_keyboard_navigation(self):
        self.page.locator('#cardCust').click()
        expect(self.page.locator('#customerDirectoryList')).not_to_be_empty()
        self.page.locator('#addCustomerBtn kbd').click()
        self.page.locator('#editCustName').fill('BROWSER CUSTOMER MIGRATION')
        self.page.locator('#editCustPhone').fill('4035550100')
        self.page.locator('#editCustType').select_option('FLEET')
        expect(self.page.locator('#editFleetUnit')).to_be_visible()
        self.page.locator('#editFleetUnit').fill('UNIT-42')
        self.assert_delegated('#workspaceContent')
        with self.page.expect_response(lambda r: r.url.endswith('/api/customers') and r.request.method == 'POST'):
            self.page.locator('#editCustName').press('Alt+s')
        expect(self.page.locator('#customerResults')).to_contain_text('BROWSER CUSTOMER MIGRATION')
        self.page.locator('[data-action="customer.editCustomerCard"] kbd').click()
        self.page.locator('#editCustPhone').fill('555-0100')
        with self.page.expect_response(lambda r: '/api/customers/' in r.url and r.request.method == 'POST'):
            self.page.locator('#editCustPhone').press('Alt+s')
        expect(self.page.locator('#editCustForm')).to_have_count(0)
        with self.page.expect_response(lambda r: '/api/customers?q=' in r.url):
            self.page.locator('#customerSearch').fill('BROWSER CUSTOMER MIGRATION')
        row = self.page.locator('.customer-directory-row').first
        row.focus()
        row.press('ArrowUp')
        expect(self.page.locator('#customerSearch')).to_be_focused()
        row.focus()
        row.press('Enter')
        expect(self.page.locator('#customerResults')).to_contain_text('555-0100')

    def test_equipment_create_edit_and_link_customer(self):
        customer = self.api('/api/customers', {'name': 'BROWSER EQUIPMENT OWNER'})['customer']
        self.page.locator('#cardVeh').click()
        expect(self.page.locator('#vehicleResults')).not_to_be_empty()
        self.page.locator('#addVehicleBtn kbd').click()
        form = self.page.locator('.vehicle-form')
        form.locator('[name=asset_type]').select_option('EQUIPMENT')
        expect(form.locator('[name=vin]')).to_be_hidden()
        form.locator('[name=serial_number]').fill('browser-eqp-42')
        expect(form.locator('[name=serial_number]')).to_have_value('BROWSER-EQP-42')
        form.locator('[name=make]').fill('DEMO')
        form.locator('[name=model]').fill('GENERATOR')
        self.assert_delegated('#workspaceContent')
        with self.page.expect_response(lambda r: r.url.endswith('/api/vehicles') and r.request.method == 'POST') as created:
            form.locator('[name=model]').press('Alt+s')
        vehicle = created.value.json()['vehicle']
        expect(self.page.locator('.vehicle-record')).to_be_visible()
        self.page.locator('[data-action="vehicle.renderVehicleForm"]').click()
        expect(self.page.locator('.vehicle-form')).to_have_attribute('data-action-param', str(vehicle['id']))
        self.page.locator('.vehicle-form [name=model]').fill('GENERATOR UPDATED')
        with self.page.expect_response(lambda r: r.url.endswith('/api/vehicles/'+str(vehicle['id'])) and r.request.method == 'POST'):
            self.page.locator('.vehicle-form [name=model]').press('Alt+s')
        expect(self.page.locator('.vehicle-record')).to_be_visible()
        self.page.locator('[data-action="vehicle.openCustomerLink"]').click()
        with self.page.expect_response(lambda r: '/api/customers?q=' in r.url):
            self.page.locator('#customerLinkSearch').fill('BROWSER EQUIPMENT OWNER')
        with self.page.expect_response(lambda r: r.url.endswith('/customer') and r.request.method == 'POST'):
            self.page.locator(f'[data-action="vehicle.linkCustomerToVehicle"][data-action-param="{customer["id"]}"]').click()
        expect(self.page.locator('#vehicleResults')).to_contain_text('BROWSER EQUIPMENT OWNER')

    def test_opcode_picker_in_both_editors(self):
        ro = self.seed_ro()
        self.open_ro(ro)
        opcode = self.page.locator('.ro-opcode-input').first
        opcode.fill('/')
        self.assert_delegated('#workspaceContent')
        opcode.press('ArrowDown')
        opcode.press('Enter')
        expect(opcode).to_have_value('MA/')
        opcode.press('Enter')
        expect(opcode).to_have_value('MA/GEN')
        expect(self.page.locator('.ro-concern-input').first).to_have_value('GENERAL MAINTENANCE / CUSTOM SERVICE')
        self.page.locator('#workspaceContent').click(position={'x': 5, 'y': 5})
        self.page.keyboard.press('Shift+a')
        expect(self.page.locator('#apptControlHeader')).to_be_visible()
        self.page.locator('[data-action="appt.openNewApptDialog"]').click()
        opcode = self.page.locator('.appt-opcode-input').first
        opcode.fill('/')
        self.assert_delegated('#workspaceContent')
        opcode.press('Enter')
        expect(opcode).to_have_value('BR/')
        opcode.press('Tab')
        expect(opcode).to_have_value('BR/GEN')
        expect(self.page.locator('.appt-concern-input').first).to_have_value('BRAKE SYSTEM CONCERN / CUSTOM SERVICE')
        opcode.fill('/')
        opcode.press('Escape')
        expect(self.page.locator('.appt-opcode-dropdown').first).to_be_hidden()
        expect(self.page.locator('#apptFullWriteupForm')).to_be_visible()

    def test_appointment_views_create_manage_and_defer(self):
        self.page.locator('#cardAppt').click()
        expect(self.page.locator('#apptControlHeader')).to_be_visible()
        for mode in ['month','day','week']:
            self.page.locator('[data-action="appt.view-'+mode+'"]').click()
            self.page.wait_for_function('mode => activeApptViewMode === mode', arg=mode)
        self.page.locator('#apptDatePicker').fill('2026-10-05')
        self.page.locator('#apptDatePicker').press('Tab')
        self.page.wait_for_function("activeApptDate === '2026-10-05'")
        self.page.locator('[data-action="appt.openNewApptDialog"]').click()
        self.page.locator('#apptCust').fill('BROWSER APPOINTMENT MIGRATION')
        self.page.locator('#apptVeh').fill('2020 DEMO TRUCK')
        self.page.locator('.appt-concern-input').first.fill('DEMO SERVICE')
        self.page.locator('.appt-hrs-input').first.fill('1')
        self.page.locator('.appt-labor-input').first.fill('75')
        self.assert_delegated('#workspaceContent')
        with self.page.expect_response(lambda r: r.url.endswith('/api/appointments') and r.request.method == 'POST') as created:
            self.page.locator('#btnConfirmAppt kbd').click()
        appointment = created.value.json()['appointment']
        # Open the day board so the nested management action owns the click.
        self.page.locator('[data-action="appt.view-day"]').click()
        manage = self.page.locator(f'[data-action="appt.promptApptManageModal"][data-action-param="{appointment["id"]}"]').first
        manage.click()
        expect(self.page.locator('#apptManageModalOverlay')).to_be_visible()
        expect(self.page.locator('#apptFullWriteupForm')).to_have_count(0)
        self.assert_delegated('#apptManageModalOverlay')
        with self.page.expect_response(lambda r: r.url.endswith('/status') and r.request.method == 'POST'):
            self.page.locator('[data-action="appt.submitApptDefer"]').click()
        self.page.locator('[data-action="appt.view-deferred"]').click()
        expect(self.page.locator('#apptScheduleContainer')).to_contain_text('BROWSER APPOINTMENT MIGRATION')

    def test_settings_rows_draft_publish_and_vendor_contacts(self):
        self.page.locator('#cardSettings').click()
        self.page.locator('.settings-card[data-task="B"] strong').click()
        expect(self.page.locator('#setupLegalName')).to_be_visible()
        self.page.locator('#setupLegalName').fill('BROWSER DEMO SHOP')
        before = self.page.locator('[data-tax-row]').count()
        self.page.locator('[data-action="setup.addSetupTax"]').click()
        expect(self.page.locator('[data-tax-row]')).to_have_count(before+1)
        self.page.locator('[data-tax-row]').last.locator('[data-action="setup.remove-row"]').click()
        expect(self.page.locator('[data-tax-row]')).to_have_count(before)
        self.assert_delegated('#workspaceContent')
        with self.page.expect_response(lambda r: r.url.endswith('/api/management-setup') and r.request.method == 'POST'):
            self.page.locator('[data-action="setup.save-draft"] kbd').click()
        expect(self.page.locator('#setupLegalName')).to_have_value('BROWSER DEMO SHOP')
        with self.page.expect_response(lambda r: r.url.endswith('/api/management-setup') and r.request.method == 'POST'):
            self.page.locator('[data-action="setup.publish"] kbd').click()
        self.page.locator('#workspaceContent').click(position={'x': 5, 'y': 5})
        self.page.keyboard.press('Shift+k')
        expect(self.page.locator('#vendorWorkspaceSearch')).to_be_visible()
        self.page.locator('[data-action="vendor.openVendorWorkspaceEditor"] kbd').click()
        self.page.locator('#vendorName').fill('BROWSER DEMO VENDOR')
        self.page.locator('[data-action="vendor.addVendorWorkspaceContact"]').click()
        contact = self.page.locator('[data-vendor-contact]').last
        contact.locator('input').nth(0).fill('DEMO CONTACT')
        self.page.locator('[data-action="vendor.addVendorWorkspaceContact"]').click()
        self.page.locator('[data-vendor-contact]').last.locator('[data-action="vendor.remove-row"]').click()
        expect(self.page.locator('[data-vendor-contact]')).to_have_count(1)
        self.assert_delegated('#workspaceContent')
        with self.page.expect_response(lambda r: r.url.endswith('/api/vendors') and r.request.method == 'POST'):
            self.page.locator('[data-action="vendor.saveWorkspaceVendor"]').click()
        self.page.locator('#vendorWorkspaceSearch').fill('BROWSER DEMO VENDOR')
        card = self.page.locator('.vendor-card:visible')
        expect(card).to_have_count(1)
        card.click()
        expect(self.page.locator('#vendorName')).to_have_value('BROWSER DEMO VENDOR')
        self.page.locator('[data-action="vendor.cancel"]').click()
        expect(self.page.locator('.vendor-editor')).to_have_count(0)

    def test_staff_profile_and_access_forms(self):
        self.page.keyboard.press('Shift+m')
        expect(self.page.locator('#staffName')).to_be_visible()
        self.page.locator('#staffName').fill('BROWSER DEMO EMPLOYEE')
        self.page.locator('#staffPin').fill('9381')
        self.assert_delegated('#workspaceContent')
        with self.page.expect_response(lambda r: r.url.endswith('/api/employees') and r.request.method == 'POST'):
            self.page.locator('#staffName').press('Alt+s')
        row = self.page.locator('.staff-row').filter(has_text='BROWSER DEMO EMPLOYEE')
        row.focus()
        row.press('Enter')
        self.page.locator('#editEmpPhone').fill('555-0109')
        with self.page.expect_response(lambda r: r.url.endswith('/profile') and r.request.method == 'POST'):
            self.page.locator('#editEmpPhone').press('Alt+s')
        expect(self.page.locator('#editEmpPhone')).to_have_value('555-0109')
        access = self.page.locator('form[data-submit-action="staff.saveEmployeeAccess"]')
        permission = access.locator('input[name=permission]').first
        permission.check()
        with self.page.expect_response(lambda r: r.url.endswith('/permissions') and r.request.method == 'POST'):
            permission.press('Alt+s')
        self.assert_delegated('#workspaceContent')

    def test_component_actions_retry_modal_cancel_and_pagination(self):
        self.page.evaluate("""() => {
          window.componentEvents = [];
          EventDelegator.registerAction('test.retry', () => componentEvents.push('retry'));
          EventDelegator.registerAction('test.page', value => componentEvents.push(value));
          const host = document.createElement('div'); host.id = 'testComponents'; host.style.cssText = 'position:fixed;top:100px;left:100px;z-index:10000;background:black;padding:20px';
          host.innerHTML = UIComponent.Pagination({currentPage: 2, totalPages: 3, totalItems: 50, pageAction: 'test.page'});
          document.body.append(host);
          AsyncOrchestrator.renderError(host, '<error>', 'test.retry');
        }""")
        self.page.locator('#testComponents button').click()
        self.assertEqual(self.page.evaluate('componentEvents'), ['retry'])
        self.page.evaluate("testComponents.innerHTML = UIComponent.Pagination({currentPage: 2, totalPages: 3, totalItems: 50, pageAction: 'test.page'})")
        self.page.locator('#testComponents button').last.click()
        self.assertEqual(self.page.evaluate('componentEvents'), ['retry','3'])
        self.page.evaluate("() => { window.confirmResult = null; void FeedbackManager.confirm('DEMO', 'Cancel header test').then(value => window.confirmResult = value); }")
        self.assert_delegated('#feedbackConfirmModal')
        self.page.locator('#feedbackConfirmModal [aria-label="Close dialog"]').click()
        self.page.wait_for_function('window.confirmResult === false')
        expect(self.page.locator('#feedbackConfirmModal')).to_have_count(0)
        self.page.evaluate("() => { window.confirmResult = null; void FeedbackManager.confirm('DEMO', 'Escape test').then(value => window.confirmResult = value); }")
        self.page.keyboard.press('Escape')
        self.page.wait_for_function('window.confirmResult === false')
        self.page.evaluate("() => { window.confirmResult = null; window.confirmCallbacks = 0; void FeedbackManager.confirm('DEMO', 'Confirm test', () => confirmCallbacks++).then(value => window.confirmResult = value); }")
        self.page.locator('#btnConfirmOk kbd').click()
        self.page.wait_for_function('window.confirmResult === true')
        self.assertEqual(self.page.evaluate('confirmCallbacks'), 1)
        self.page.evaluate("""() => {
          EventDelegator.registerAction('test.input', (_, element) => componentEvents.push(element.value));
          EventDelegator.registerAction('test.row', value => componentEvents.push('row:' + value));
          EventDelegator.registerAction('test.sort', value => componentEvents.push('sort:' + value));
          EventDelegator.registerAction('test.submit', () => componentEvents.push('submit'));
          testComponents.innerHTML = UIComponent.SearchBar({id: 'testSearch', inputAction: 'test.input'})
            + UIComponent.ResultTable({columns: [{label: 'Name', sortKey: 'name'}], rows: [{dataId: 0, cells: ['Demo']}], rowAction: 'test.row', sortAction: 'test.sort'})
            + UIComponent.EditorForm({id: 'testForm', fieldsGridHtml: '<input id="requiredComponentField" required>', actionsHtml: '<button type="submit">SAVE</button>', submitAction: 'test.submit'});
        }""")
        self.assert_delegated('#testComponents')
        self.page.locator('#testSearch').fill('typed')
        self.page.locator('#testComponents th button').click()
        self.page.locator('#testComponents tr[data-action]').focus()
        self.page.keyboard.press('Enter')
        self.page.locator('#testForm button').click()
        self.assertEqual(self.page.evaluate('componentEvents'), ['retry', '3', 'typed', 'sort:name', 'row:0'])
        self.page.locator('#requiredComponentField').fill('valid')
        self.page.locator('#testForm button').click()
        self.assertEqual(self.page.evaluate('componentEvents.at(-1)'), 'submit')

    def test_job_catalog_custom_code_and_nested_edit(self):
        self.page.keyboard.press('Shift+j')
        expect(self.page.locator('#jobSearchInput')).to_be_visible()
        self.page.locator('[data-action="app.openCustomJobCodeForm"]').click()
        self.page.locator('#customJobCode').fill('BROWSER-DEMO')
        self.page.locator('#customJobCategory').fill('BRAKES')
        description = "OWNER'S \"BRAKES\" & <CHECK>"
        self.page.locator('#customJobDescription').fill(description)
        self.assert_delegated('#workspaceContent')
        with self.page.expect_response(lambda r: r.url.endswith('/api/job-codes') and r.request.method == 'POST'):
            self.page.locator('#customJobCode').press('Alt+s')
        self.page.locator('#jobSearchInput').fill('BROWSER-DEMO')
        row = self.page.locator('.job-catalog-row').filter(has_text='BROWSER-DEMO')
        expect(row).to_have_count(1)
        row.locator('[data-action="app.edit-job"]').click()
        expect(self.page.locator('#customJobCode')).to_have_value('BROWSER-DEMO')
        self.page.locator('#workspaceContent').click(position={'x': 5, 'y': 5})
        self.page.keyboard.press('Shift+a')
        self.page.locator('[data-action="appt.openNewApptDialog"]').click()
        opcode = self.page.locator('.appt-opcode-input').first
        opcode.fill('BROWSER-DEMO')
        self.assert_delegated('#workspaceContent')
        opcode.press('Enter')
        expect(self.page.locator('.appt-concern-input').first).to_have_value(description)


if __name__ == "__main__":
    unittest.main(verbosity=2)
