#!/usr/bin/env python3
"""
TaktRO — Real Application Boot Smoke Test (scripts/boot_smoke_test.py)
Dynamic port allocation, HTTP server readiness check, Playwright error monitoring,
and engine initialization validation.
"""

from __future__ import annotations

import os
import sys
import time
import socket
import urllib.request
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def wait_for_server(url: str, timeout: float = 10.0) -> bool:
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(url) as resp:
                if resp.status in (200, 401, 403):
                    return True
        except Exception:
            time.sleep(0.2)
    return False

def run_boot_smoke_test():
    print("======================================================")
    print("   TaktRO REAL APPLICATION BOOT SMOKE TEST v1.0      ")
    print("======================================================")

    port = get_free_port()
    server_url = f"http://127.0.0.1:{port}"
    print(f"  • Allocating dynamic port: {port}")

    # Start server process
    server_env = os.environ.copy()
    server_env["TAKTRO_PORT"] = str(port)
    server_proc = subprocess.Popen(
        [sys.executable, str(ROOT / "server.py"), str(port)],
        cwd=ROOT,
        env=server_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )

    try:
        ready = wait_for_server(f"{server_url}/", timeout=12.0)
        if not ready:
            print("  ✗ Server failed to respond within readiness window.")
            sys.exit(1)

        print(f"  ✓ Server responsive at {server_url}")

        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            print("  ⚠ Playwright Python library not installed. Skipping browser boot check.")
            return 2

        with sync_playwright() as p:
            # Check WebKit availability
            try:
                browser = p.webkit.launch(headless=True)
            except Exception as e:
                print(f"  ⚠ WebKit browser engine unavailable: {e}")
                print("  STATUS: BLOCKED / SKIPPED (WebKit engine missing)")
                return 2

            page_errors = []
            console_errors = []

            page = browser.new_page()

            page.on("pageerror", lambda err: page_errors.append(str(err)))
            
            def handle_console(msg):
                if msg.type == "error":
                    txt = msg.text
                    # Allowlist harmless browser log noise
                    if "favicon.ico" in txt or "Failed to load resource: net::ERR_FILE_NOT_FOUND" in txt:
                        return
                    console_errors.append(txt)

            page.on("console", handle_console)

            page.goto(server_url, wait_until="networkidle")

            # Assert actual stable DOM roots
            body_el = page.query_selector("body")
            auth_overlay = page.query_selector("#authOverlay")
            workspace_overlay = page.query_selector("#workspaceOverlay")
            toast_container = page.query_selector("#toastContainer")
            assert body_el is not None, "Missing body in DOM"
            assert auth_overlay is not None, "Missing #authOverlay in DOM"
            assert workspace_overlay is not None, "Missing #workspaceOverlay in DOM"
            assert toast_container is not None, "Missing #toastContainer in DOM"
            print("  ✓ DOM Roots Verified (body, #authOverlay, #workspaceOverlay, #toastContainer)")

            # Assert Core Window Engines
            engines = page.evaluate("""() => {
              return {
                CommandRegistry: Boolean(window.CommandRegistry),
                ModalStack: Boolean(window.ModalStack),
                WorkspaceLifecycle: Boolean(window.WorkspaceLifecycle),
                AsyncOrchestrator: Boolean(window.AsyncOrchestrator),
                EventDelegator: Boolean(window.EventDelegator),
                AccessibilityManager: Boolean(window.AccessibilityManager),
                FeedbackManager: Boolean(window.FeedbackManager)
              };
            }""")

            for engine_name, loaded in engines.items():
                assert loaded, f"Engine '{engine_name}' failed to load on window!"
                print(f"  ✓ Engine '{engine_name}' initialized")

            # Test ModalStack contract with FeedbackManager.confirm
            modal_contract_test = page.evaluate("""async () => {
              const confirmPromise = window.FeedbackManager.confirm('Smoke Test', 'Testing ModalStack options contract');
              await new Promise(r => setTimeout(r, 50));
              const isStackValid = window.ModalStack.stack.length === 1 && window.ModalStack.stack[0].id === 'feedbackConfirmModal';
              const okBtn = document.getElementById('btnConfirmOk');
              if (okBtn) okBtn.click();
              await confirmPromise;
              const isClosed = window.ModalStack.stack.length === 0 && !document.getElementById('feedbackConfirmModal');
              return isStackValid && isClosed;
            }""")

            assert modal_contract_test, "ModalStack options contract & confirm teardown failed!"
            print("  ✓ ModalStack options contract & FeedbackManager.confirm verified")

            if page_errors:
                print("  ✗ Page Errors Detected:", page_errors)
                sys.exit(1)

            if console_errors:
                print("  ✗ Unhandled Console Errors Detected:", console_errors)
                sys.exit(1)

            browser.close()

    finally:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=3.0)
        except Exception:
            server_proc.kill()

    print("\n======================================================")
    print("STATUS: BOOT SMOKE TEST PASSED.")
    print("======================================================")
    return 0

if __name__ == "__main__":
    sys.exit(run_boot_smoke_test() or 0)
