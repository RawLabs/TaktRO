"""Native window shell for TaktRO; the application server stays in its venv."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import urllib.request

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.0")
from gi.repository import Gtk, WebKit2  # noqa: E402


class TaktRODesktop:
    def __init__(self, app_python: str) -> None:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]

        app_url = f"http://127.0.0.1:{port}"
        server_env = os.environ.copy()
        server_env["TAKTRO_HOST"] = "127.0.0.1"
        server_env["TAKTRO_PORT"] = str(port)
        self.server = subprocess.Popen(
            [app_python, "server.py"],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            env=server_env,
        )
        self._wait_until_ready(app_url)

        self.window = Gtk.Window(title="TaktRO")
        self.window.set_default_size(1440, 900)
        self.window.set_size_request(1024, 700)
        self.window.connect("destroy", self.close)

        self.view = WebKit2.WebView()
        self.view.get_settings().set_property("enable-developer-extras", False)
        self.view.connect("create", self.create_child_view)
        self.view.load_uri(app_url)
        self.window.add(self.view)
        self.child_windows: list[Gtk.Window] = []

    def create_child_view(self, _source: WebKit2.WebView, _action: object) -> WebKit2.WebView:
        """Host print previews and external documents in an TaktRO child window."""
        child = WebKit2.WebView.new_with_context(self.view.get_context())
        child.get_settings().set_property("enable-developer-extras", False)
        window = Gtk.Window(title="TaktRO — Document")
        window.set_default_size(1100, 800)
        window.set_transient_for(self.window)
        window.add(child)
        window.connect("destroy", lambda win: self.child_windows.remove(win) if win in self.child_windows else None)
        child.connect("close", lambda _view: window.destroy() or True)
        self.child_windows.append(window)
        window.show_all()
        return child

    def _wait_until_ready(self, app_url: str) -> None:
        for _ in range(100):
            if self.server.poll() is not None:
                raise RuntimeError("TaktRO's local server stopped during startup")
            try:
                urllib.request.urlopen(app_url, timeout=0.2).close()
                return
            except OSError:
                time.sleep(0.05)
        self.server.terminate()
        raise RuntimeError("TaktRO's local server did not become ready")

    def run(self) -> None:
        self.window.show_all()
        self.window.maximize()
        Gtk.main()

    def close(self, _window: Gtk.Window) -> None:
        if self.server.poll() is None:
            self.server.terminate()
            try:
                self.server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.server.kill()
                self.server.wait()
        Gtk.main_quit()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: desktop.py APP_PYTHON")
    TaktRODesktop(sys.argv[1]).run()
