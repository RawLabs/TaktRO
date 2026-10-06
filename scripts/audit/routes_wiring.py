"""
API Route Model, Event Handlers, Hotkey Registry, DOM Index, and Wiring Graph
"""

from __future__ import annotations

import json
import re
from pathlib import Path

CONTROL_KEYWORDS = {
    "if", "for", "while", "switch", "return", "alert", "confirm", "prompt", "print", "close", "parseInt", "parseFloat"
}


def normalize_route(path: str) -> str:
    path = path.split('?')[0].strip()
    # Replace numeric IDs and template parameters
    normalized = re.sub(r'/\d+(?=/|$)', '/{id}', path)
    normalized = re.sub(r'/\$\{[^}]+\}', '/{id}', normalized)
    return normalized


def extract_backend_routes(server_path: Path) -> dict:
    routes = {}
    if not server_path.exists():
        return routes

    try:
        with open(server_path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        for idx, line in enumerate(lines, 1):
            # path == "/api/..."
            m_exact = re.search(r'path\s*==\s*["\'](/api/[^"\']+)["\']', line)
            if m_exact:
                raw = m_exact.group(1)
                norm = normalize_route(raw)
                routes[norm] = {
                    "raw": raw,
                    "type": "exact",
                    "file": str(server_path.relative_to(server_path.parent)),
                    "line": idx
                }

            # path.startswith("/api/...")
            m_pfx = re.search(r'path\.startswith\s*\(\s*["\'](/api/[^"\']+)["\']\s*\)', line)
            if m_pfx:
                raw = m_pfx.group(1)
                norm = normalize_route(raw)
                routes[norm] = {
                    "raw": raw,
                    "type": "prefix",
                    "file": str(server_path.relative_to(server_path.parent)),
                    "line": idx
                }
    except Exception:
        pass

    return routes


def extract_frontend_api_calls(js_files: list[Path], root: Path) -> list[dict]:
    calls = []
    for js_path in js_files:
        if not js_path.exists():
            continue
        rel_path = str(js_path.relative_to(root))
        try:
            with open(js_path, "r", encoding="utf-8") as f:
                for line_idx, line in enumerate(f, 1):
                    for m in re.finditer(r'api\s*\(\s*[`"\'](/api/[^`"\']+)[`"\']', line):
                        raw_route = m.group(1)
                        norm_route = normalize_route(raw_route)
                        calls.append({
                            "route_raw": raw_route,
                            "route_norm": norm_route,
                            "file": rel_path,
                            "line": line_idx
                        })
        except Exception:
            pass
    return calls


def audit_hotkey_registry(app_js: Path, root: Path) -> dict:
    hotkey_findings = {"hotkeys": [], "warnings": []}
    if not app_js.exists():
        return hotkey_findings

    try:
        with open(app_js, "r", encoding="utf-8") as f:
            content = f.read()

        # Matches 'ALT+O': () => typeof handleApptConvertKey === 'function' && handleApptConvertKey()
        for m in re.finditer(r'[\'"]([A-Z0-9_+]+)[\'"]\s*:\s*\(\)\s*=>\s*.*?(?:typeof\s+([a-zA-Z0-9_$]+)|([a-zA-Z0-9_$]+)\s*\(\))', content):
            key = m.group(1)
            fn = m.group(2) or m.group(3)
            if fn and fn not in ("function", "typeof", "document"):
                hotkey_findings["hotkeys"].append({
                    "key": key,
                    "target_function": fn,
                    "file": str(app_js.relative_to(root))
                })
    except Exception:
        pass

    return hotkey_findings


def audit_workspace_modules_and_help(all_symbols: dict, root: Path) -> dict:
    module_findings = {"modules": [], "warnings": []}
    required_renderers = {
        "O": "renderRoWriteupContent",
        "A": "renderApptContent",
        "C": "renderCustomerContent",
        "V": "renderVehicleContent",
        "P": "renderPartsContent",
        "S": "renderSettingsContent",
        "H": "renderRoHistoryWorkspace",
        "K": "loadVendorWorkspace",
        "M": "renderStaffLoading",
        "J": "renderJobSearchContent"
    }

    all_fn_names = set()
    for fpath, syms in all_symbols.items():
        funcs = syms.get("functions", {})
        if isinstance(funcs, dict):
            all_fn_names.update(funcs.keys())
        elif isinstance(funcs, list):
            for item in funcs:
                if isinstance(item, dict) and "name" in item:
                    all_fn_names.add(item["name"])
                elif isinstance(item, str):
                    all_fn_names.add(item)

    for key, renderer_name in required_renderers.items():
        if renderer_name in all_fn_names:
            module_findings["modules"].append({
                "key": key,
                "renderer": renderer_name,
                "status": "WIRED"
            })
        else:
            module_findings["warnings"].append(f"Workspace key '{key}' renderer '{renderer_name}' not found in JS symbol index")

    # Check Help & Legend Modals
    for modal_fn in ("toggleHelpModal", "toggleWorkspaceLegend"):
        if modal_fn in all_fn_names:
            module_findings["modules"].append({
                "key": "?",
                "renderer": modal_fn,
                "status": "WIRED"
            })
        else:
            module_findings["warnings"].append(f"Help modal function '{modal_fn}' not found in JS symbol index")

    return module_findings


def build_wiring_graph(root: Path, backend_routes: dict, frontend_calls: list[dict], event_handlers: list[dict]) -> dict:
    nodes = []
    edges = []

    node_ids = set()

    def add_node(nid: str, nlabel: str, ntype: str, nfile: str = ""):
        if nid not in node_ids:
            node_ids.add(nid)
            nodes.append({"id": nid, "label": nlabel, "type": ntype, "file": nfile})

    # Add API Nodes and Edges
    for norm_route, info in backend_routes.items():
        add_node(f"backend:{norm_route}", norm_route, "backend_route", info["file"])

    for call in frontend_calls:
        norm = call["route_norm"]
        call_file = call["file"]
        add_node(f"frontend:{call_file}", call_file, "frontend_file", call_file)
        add_node(f"route:{norm}", norm, "api_endpoint")

        edges.append({
            "source": f"frontend:{call_file}",
            "target": f"route:{norm}",
            "type": "api_call",
            "line": call["line"]
        })

        if norm in backend_routes:
            edges.append({
                "source": f"route:{norm}",
                "target": f"backend:{norm}",
                "type": "route_handler"
            })

    return {
        "header": "GENERATED FILE — DO NOT EDIT MANUALLY",
        "nodes": nodes,
        "edges": edges
    }
