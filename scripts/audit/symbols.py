"""
Python AST & JavaScript Regex Symbol Indexer and Utility Cataloger
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path


class PythonSymbolVisitor(ast.NodeVisitor):
    def __init__(self, filename: str):
        self.filename = filename
        self.classes = {}
        self.functions = {}
        self.imports = []
        self.current_class = None

    def visit_Import(self, node: ast.Import):
        for name in node.names:
            self.imports.append(name.name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom):
        mod = node.module or ""
        for name in node.names:
            self.imports.append(f"{mod}.{name.name}" if mod else name.name)
        self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef):
        prev = self.current_class
        self.current_class = node.name
        self.classes[node.name] = {
            "name": node.name,
            "start": node.lineno,
            "end": getattr(node, "end_lineno", node.lineno),
            "bases": [ast.unparse(b) for b in node.bases] if hasattr(ast, "unparse") else [],
            "methods": []
        }
        self.generic_visit(node)
        self.current_class = prev

    def visit_FunctionDef(self, node: ast.FunctionDef):
        self._handle_function(node, is_async=False)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
        self._handle_function(node, is_async=True)
        self.generic_visit(node)

    def _handle_function(self, node, is_async=False):
        args = [arg.arg for arg in node.args.args]
        decorators = []
        if hasattr(ast, "unparse"):
            decorators = [ast.unparse(d) for d in node.decorator_list]

        calls = set()
        sql_strings = []
        for child in ast.walk(node):
            if isinstance(child, ast.Call):
                if isinstance(child.func, ast.Name):
                    calls.add(child.func.id)
                elif isinstance(child.func, ast.Attribute):
                    calls.add(child.func.attr)
            elif isinstance(child, ast.Constant) and isinstance(child.value, str):
                val_upper = child.value.strip().upper()
                if any(k in val_upper for k in ("SELECT ", "INSERT INTO ", "UPDATE ", "DELETE FROM ", "CREATE TABLE ")):
                    sql_strings.append(child.value.strip()[:80])

        info = {
            "name": node.name,
            "is_async": is_async,
            "start": node.lineno,
            "end": getattr(node, "end_lineno", node.lineno),
            "args": args,
            "decorators": decorators,
            "calls": list(calls)[:20],
            "sql_strings": sql_strings[:5]
        }

        if self.current_class and self.current_class in self.classes:
            self.classes[self.current_class]["methods"].append(node.name)

        fn_key = f"{self.current_class}.{node.name}" if self.current_class else node.name
        self.functions[fn_key] = info


def parse_python_file(filepath: Path) -> dict:
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            code = f.read()
        tree = ast.parse(code, filename=str(filepath))
        visitor = PythonSymbolVisitor(filepath.name)
        visitor.visit(tree)
        return {
            "classes": visitor.classes,
            "functions": visitor.functions,
            "imports": sorted(set(visitor.imports))
        }
    except Exception as err:
        return {"error": str(err), "classes": {}, "functions": {}, "imports": []}


def parse_javascript_file(filepath: Path) -> dict:
    functions = {}
    imports = []
    api_calls = []
    dom_ids = set()

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            lines = f.readlines()

        for idx, line in enumerate(lines, 1):
            # Function declarations: function fnName(a, b)
            for match in re.finditer(r'(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)', line):
                fn_name = match.group(1)
                args = [a.strip() for a in match.group(2).split(',') if a.strip()]
                functions[fn_name] = {
                    "name": fn_name,
                    "type": "declaration",
                    "start": idx,
                    "end": idx,  # approximate
                    "args": args
                }

            # Arrow / expression functions: const fnName = (a, b) =>
            for match in re.finditer(r'(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>', line):
                fn_name = match.group(1)
                args = [a.strip() for a in match.group(2).split(',') if a.strip()]
                functions[fn_name] = {
                    "name": fn_name,
                    "type": "expression",
                    "start": idx,
                    "end": idx,
                    "args": args
                }

            # Window function assignments: window.fnName =
            for match in re.finditer(r'window\.([a-zA-Z0-9_$]+)\s*=\s*', line):
                fn_name = match.group(1)
                functions[fn_name] = {
                    "name": fn_name,
                    "type": "window_assignment",
                    "start": idx,
                    "end": idx,
                    "args": []
                }

            # API calls
            for match in re.finditer(r'api\s*\(\s*[`"\'](/api/[^`"\']+)[`"\']', line):
                api_calls.append({"route": match.group(1), "line": idx})

            # DOM IDs
            for match in re.finditer(r'getElementById\s*\(\s*[\'"]([a-zA-Z0-9_-]+)[\'"]\s*\)', line):
                dom_ids.add(match.group(1))

        return {
            "functions": functions,
            "api_calls": api_calls,
            "dom_ids": sorted(dom_ids)
        }
    except Exception as err:
        return {"error": str(err), "functions": {}, "api_calls": [], "dom_ids": []}


KNOWN_CORE_UTILITIES = {
    "api": "Centralized HTTP API fetch wrapper (JSON, auth tokens, error handling)",
    "escapeHtml": "Safely escapes HTML strings against XSS injection",
    "formatMoney": "Formats numeric values into $0.00 currency strings",
    "normalizePhone": "Normalizes phone numbers to standard shop format",
    "showToast": "Displays notification toast on screen",
    "openCustomer": "Opens customer detail modal/workspace",
    "openVehicle": "Opens vehicle detail lookup",
    "searchParts": "Queries Parts & Inventory engine",
    "openNewStockPartModal": "Opens modal to intake new stock inventory item",
    "openNewPassThroughPartModal": "Opens modal for pass-through buy-in part",
    "selectTask": "Navigates sitewide workspace screens (O, A, C, V, P, S, etc.)",
}


def build_utility_index(all_symbols: dict) -> dict:
    discovered_utilities = {}

    for file_path, data in all_symbols.items():
        if not file_path.endswith(".js"):
            continue
        fns = data.get("functions", {})
        for name, details in fns.items():
            if name in KNOWN_CORE_UTILITIES or name.startswith("open") or name.startswith("format") or name.startswith("render"):
                discovered_utilities[name] = {
                    "file": file_path,
                    "line": details.get("start", 0),
                    "description": KNOWN_CORE_UTILITIES.get(name, "Application UI/Service Utility helper")
                }

    return discovered_utilities
