#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -x "$SCRIPT_DIR/.venv/bin/python3" ]; then
  PYTHON_BIN="$SCRIPT_DIR/.venv/bin/python3"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "TaktRO requires Python 3.10 or newer." >&2
  exit 1
fi

if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'; then
  echo "TaktRO requires Python 3.10 or newer." >&2
  exit 1
fi

echo "Starting TaktRO..."

# Keep the application server in its venv. A system Python is used only for the
# native GTK window because Linux supplies GTK bindings outside the venv.
DESKTOP_PYTHON=""
for candidate in /usr/bin/python3 "$(command -v python3 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && \
     "$candidate" -c 'import gi; gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.0")' >/dev/null 2>&1; then
    DESKTOP_PYTHON="$candidate"
    break
  fi
done
if [ -n "$DESKTOP_PYTHON" ]; then
  exec "$DESKTOP_PYTHON" "$SCRIPT_DIR/desktop.py" "$PYTHON_BIN"
fi

echo "Desktop WebKit is unavailable; opening TaktRO in the default browser." >&2
APP_PORT="$($PYTHON_BIN -c 'import socket, os
host = os.environ.get("TAKTRO_HOST", "127.0.0.1")
for port in range(8080, 8181):
    sock = socket.socket()
    try:
        sock.bind((host, port))
    except OSError:
        sock.close()
        continue
    sock.close()
    print(port)
    break
else:
    raise SystemExit(1)')" || {
  echo "TaktRO could not find an available port between 8080 and 8180." >&2
  exit 1
}
APP_URL="http://127.0.0.1:$APP_PORT"

open_browser() {
  echo "Opening $APP_URL"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$APP_URL" >/dev/null 2>&1 &
  elif command -v gio >/dev/null 2>&1; then
    gio open "$APP_URL" >/dev/null 2>&1 &
  else
    echo "No desktop browser launcher was found. Open $APP_URL manually." >&2
  fi
}

TAKTRO_PORT="$APP_PORT" "$PYTHON_BIN" server.py &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

for _ in {1..50}; do
  if "$PYTHON_BIN" -c "import urllib.request; urllib.request.urlopen('$APP_URL', timeout=0.2)" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SERVER_PID"
    exit 1
  fi
  sleep 0.1
done

if ! "$PYTHON_BIN" -c "import urllib.request; urllib.request.urlopen('$APP_URL', timeout=0.5)" >/dev/null 2>&1; then
  echo "TaktRO did not become ready at $APP_URL." >&2
  exit 1
fi

open_browser

wait "$SERVER_PID"
