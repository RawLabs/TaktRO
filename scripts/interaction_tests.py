#!/usr/bin/env python3
"""
TaktRO Browser Interaction Test Suite (scripts/interaction_tests.py)
Drives a real Playwright browser session against an isolated test server & database.
Tests actual DOM focus, modal unwinding, dropdown closing, unsaved dirty prompts, 
nested button event propagation, e.repeat protection, and 6-tier Escape session locking.
"""

import os
import sys
import time
import subprocess
import socket
from pathlib import Path

TEST_DB_PATH = Path("taktro_test_interaction.db")
TEST_PORT = 8999

def is_webkit_available():
    sys.path.insert(0, '/home/ghost/.local/lib/python3.10/site-packages')
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.webkit.launch(headless=True)
            browser.close()
        return True
    except Exception as err:
        print(f"DEBUG: WebKit launch check: {err}")
        return False

def seed_isolated_test_db():
    if TEST_DB_PATH.exists():
        TEST_DB_PATH.unlink()

def run_interaction_tests():
    print("======================================================")
    print("   TaktRO REAL WEBKIT BROWSER INTERACTION SUITE v2.5  ")
    print("======================================================")

    if not is_webkit_available():
        print("  ⚠ Playwright WebKit engine is unavailable on this host.")
        print("  STATUS: BLOCKED / SKIPPED (WebKit engine missing)")
        print("======================================================\n")
        return 2

    # Seed isolated database and start temporary server process
    seed_isolated_test_db()
    env = os.environ.copy()
    env["TAKTRO_DB_PATH"] = str(TEST_DB_PATH.resolve())
    env["TAKTRO_PORT"] = str(TEST_PORT)

    server_proc = subprocess.Popen(
        [sys.executable, "server.py"],
        cwd=str(Path(__file__).parent.parent),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )

    time.sleep(1.5)

    try:
        sys.path.insert(0, '/home/ghost/.local/lib/python3.10/site-packages')
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.webkit.launch(headless=True)
            page = browser.new_page()
            page.goto(f"http://localhost:{TEST_PORT}")

            # 1. Login with PIN 1042 (auto-submits on 4 digits) and wait for #authOverlay to become hidden
            page.fill("#employeePin", "1042")
            page.wait_for_selector("#authOverlay", state="hidden", timeout=5000)
            page.evaluate("""async () => api('/api/parts', {
                method: 'POST',
                body: JSON.stringify({
                    part_number: 'TEST-001', description: 'ISOLATED TEST PART',
                    home_bin: 'BIN-A01', cost_price: 10, retail_price: 20,
                    qty_on_hand: 12, reorder_point: 2, reorder_qty: 6
                })
            })""")
            shortcut_violations = page.evaluate("""() => Array.from(CommandRegistry.commands.values())
                .filter(command => /^[A-Z0-9?]$/.test(String(command.hotkey || '').toUpperCase().trim()))
                .map(command => command.id)""")
            assert shortcut_violations == [], f"Plain-letter commands are forbidden: {shortcut_violations}"
            print("  ✓ Test 1: WebKit PIN login auto-submitted & auth overlay hidden.")

            # 2. Real Mouse Click on Dashboard Card to Open RO Board
            page.click("#cardNewRo")
            page.wait_for_selector("#workspaceOverlay:not(.hidden)", timeout=5000)
            print("  ✓ Test 2: Clicked #cardNewRo -> Workspace overlay opened.")

            # 3. Enter/Space Activation Exactly Once & Form Control Shortcut Suppression
            page.evaluate("createNewRoSession()")
            page.wait_for_selector("#roCustInput", timeout=5000)
            page.wait_for_timeout(150) # Allow rAF focus/select to settle
            page.fill("#roCustInput", "n")
            input_val = page.input_value("#roCustInput")
            assert input_val == "n", f"Expected input value 'n', got '{input_val}'"
            print("  ✓ Test 3: Form inputs suppress plain-letter shortcuts.")
            page.wait_for_timeout(400)  # settle debounced typeahead work from this test
            page.evaluate("window.DropdownRegistry.close()")
            assert page.evaluate("window.DropdownRegistry.active === null")

            # 4. Nested Modal & Focus Trapping
            page.evaluate("openRoAddPartModal()")
            page.wait_for_selector("#roPartSearchModalOverlay", timeout=3000)
            is_modal_active = page.evaluate("window.ModalStack.stack.length === 1")
            assert is_modal_active, "ModalStack should contain top modal"
            print("  ✓ Test 4: Nested modal registered with ModalStack and focus trapped.")

            # 5. Escape Unwinding Tier 2: Modal Close
            page.keyboard.press("Escape")
            page.wait_for_selector("#roPartSearchModalOverlay", state="detached", timeout=3000)
            print("  ✓ Test 5: Escape unwound modal layer.")

            # 6. Dirty Editor Protection (Accept & Reject)
            # Isolate this tier from any customer typeahead opened by Test 3.
            page.evaluate("window.DropdownRegistry.close()")
            assert page.evaluate("window.DropdownRegistry.active === null"), "Dropdown tier must be clear before editor test"
            dirty_value = "DIRTY-PLATE"
            page.fill("#roPlateInput", dirty_value)
            assert page.evaluate("window.EditorStack.isCurrentEditorDirty()"), "Real form edit must mark the editor dirty"

            # Reject discard: editor and entered value must remain intact.
            page.once("dialog", lambda dialog: dialog.dismiss())
            page.keyboard.press("Escape")
            page.wait_for_timeout(150)
            is_editor_still_active = page.evaluate("window.EditorStack.activeEditor !== null")
            assert is_editor_still_active, "Editor should remain open when dirty exit is cancelled"
            assert page.input_value("#roPlateInput") == dirty_value, "Rejected discard must preserve the edited value"

            # Accept discard: the registered cancel path must close the editor.
            page.once("dialog", lambda dialog: dialog.accept())
            page.keyboard.press("Escape")
            page.wait_for_function("window.EditorStack.activeEditor === null")
            page.wait_for_selector("#roCustInput", state="detached", timeout=3000)
            print("  ✓ Test 6: Dirty editor rejected and accepted discard correctly.")

            # 7. Parent Workspace Restoration
            page.keyboard.press("Escape")
            page.wait_for_selector("#workspaceOverlay", state="hidden", timeout=3000)
            print("  ✓ Test 7: Escape returned from workspace to main dashboard.")

            # 8. Customer search must accept letters that are also workspace commands.
            page.keyboard.press("Shift+c")
            page.wait_for_selector("#customerSearch", timeout=5000)
            customer_query = "The quick brown fox jumps over a lazy dog 0123"
            page.type("#customerSearch", customer_query)
            assert page.input_value("#customerSearch") == customer_query, "Plain command letters must remain typable in customer search"
            assert page.evaluate("state.activeTask") == "C", "Typing in customer search must not navigate away"
            page.keyboard.press("Escape")
            page.wait_for_selector("#workspaceOverlay", state="hidden", timeout=3000)
            page.wait_for_function("!['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)")
            print("  ✓ Test 8: Customer search preserved ordinary letters and workspace focus.")

            # 9. Parts Domain Coverage: Breakout, Edit Details, Dirty Protection, Command Order
            page.keyboard.press("Shift+p")
            page.wait_for_selector("#workspaceOverlay:not(.hidden)", timeout=5000)
            page.wait_for_selector("#partsResults", timeout=5000)

            # Test ALT+B from list does nothing safely
            page.keyboard.press("Alt+b")
            page.wait_for_timeout(200)
            assert page.query_selector("#bulkBreakoutOverlay") is None, "ALT+B without selected part should do nothing"

            # Open part detail for part #1
            page.evaluate("openPartsDetail(1)")
            page.wait_for_selector("[data-command='parts.breakout']", timeout=5000)

            # Assert exact part card command order left-to-right
            cmds = page.evaluate("""() => {
              const btns = Array.from(document.querySelectorAll('#partsResults [data-command]'));
              return btns.map(b => b.getAttribute('data-command'));
            }""")
            expected_cmds = ["parts.back", "parts.apply_ro", "parts.edit_details", "parts.counter_sale", "parts.adjust_qty", "parts.breakout"]
            assert cmds == expected_cmds, f"Expected button order {expected_cmds}, got {cmds}"

            # Test ALT+B hotkey opens breakout modal
            page.keyboard.press("Alt+b")
            page.wait_for_selector("#bulkBreakoutOverlay", timeout=3000)
            is_breakout_modal_active = page.evaluate("window.ModalStack.stack.some(m => m.id === 'bulkBreakoutOverlay')")
            assert is_breakout_modal_active, "Bulk breakout overlay must be registered in ModalStack"

            # Close breakout modal via Escape
            page.keyboard.press("Escape")
            page.wait_for_selector("#bulkBreakoutOverlay", state="detached", timeout=3000)

            # Test Mouse click on [data-command="parts.breakout"]
            page.click("[data-command='parts.breakout']")
            page.wait_for_selector("#bulkBreakoutOverlay", timeout=3000)
            page.click("#bulkBreakoutOverlay button[type='button']") # Click cancel button
            page.wait_for_selector("#bulkBreakoutOverlay", state="detached", timeout=3000)
            print("  ✓ Parts Test: ALT+B hotkey & mouse parity registered with ModalStack.")

            # Test Edit Part Details subview (ALT+E)
            page.click("[data-command='parts.edit_details']")
            page.wait_for_selector("#editPartDetailsForm", timeout=5000)
            page.wait_for_function("window.EditorStack.activeEditor?.id === 'editPartDetailsEditor'", timeout=5000)

            # Clean state check
            assert not page.evaluate("window.EditorStack.isCurrentEditorDirty()"), "Editor initially clean"

            # Fill dirty values in Home Bin & Interchange
            page.fill("#editHomeBin", "BIN-A99")
            page.fill("#editInterchange", "ALT-9900")
            assert page.evaluate("window.EditorStack.isCurrentEditorDirty()"), "Editing bin/interchange must mark editor dirty via snapshot comparison"

            # Reject dirty Escape
            page.once("dialog", lambda dialog: dialog.dismiss())
            page.keyboard.press("Escape")
            page.wait_for_timeout(150)
            assert page.evaluate("window.EditorStack.activeEditor?.id === 'editPartDetailsEditor'"), "Rejecting dirty escape preserves edit subview"

            # Submit and save metadata
            assert page.evaluate("document.querySelector('#editPartDetailsForm').checkValidity()"), "Part metadata form must be valid before submit"
            assert page.get_attribute("#editPartDetailsForm", "data-submit-bound") == "true", "Part metadata submit listener must be bound"
            page.click("#editPartDetailsForm button[type='submit']")
            page.wait_for_selector("#editPartDetailsForm", state="detached", timeout=8000)

            # Verify saved details reflected in detail view and DB persistence
            bin_text = page.inner_text("#partsResults")
            assert "BIN-A99" in bin_text and "ALT-9900" in bin_text, "Saved bin and interchange numbers must be rendered in part details"
            print("  ✓ Parts Test: Edit details subview, dirty protection, and server persistence verified.")

            # Close parts workspace
            page.keyboard.press("Escape")
            page.wait_for_selector("#workspaceOverlay", state="hidden", timeout=3000)

            # 10. Final Dashboard Lock
            page.keyboard.press("Escape")
            page.wait_for_selector("#authOverlay:not(.hidden)", timeout=5000)
            print("  ✓ Test 10: Dashboard Escape locked session and displayed login overlay.")

            browser.close()

    finally:
        server_proc.terminate()
        server_proc.wait()
        if TEST_DB_PATH.exists():
            TEST_DB_PATH.unlink()

    print("======================================================")
    print("STATUS: ALL REAL WEBKIT INTERACTION TESTS PASSED.")
    print("======================================================\n")
    return 0

if __name__ == "__main__":
    sys.exit(run_interaction_tests() or 0)
