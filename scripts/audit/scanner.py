"""
Repository Scanner, File Discovery, Hashing & Git Intelligence
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_EXCLUDES = {
    ".git", ".taktro", "__pycache__", "node_modules", "venv", ".venv", "dist", "build"
}

SUPPORTED_EXTENSIONS = {
    ".py", ".js", ".html", ".css", ".json", ".sql"
}


def compute_sha256(filepath: Path) -> str:
    hasher = hashlib.sha256()
    try:
        with open(filepath, "rb") as f:
            while chunk := f.read(65536):
                hasher.update(chunk)
        return hasher.hexdigest()
    except Exception:
        return ""


def get_git_info(root: Path) -> dict:
    git_info = {
        "available": False,
        "branch": "unknown",
        "commit": "unknown",
        "dirty": False,
        "porcelain": [],
        "changed_files": []
    }
    if not (root / ".git").exists():
        return git_info

    try:
        # Branch
        proc_b = subprocess.run(["git", "branch", "--show-current"], cwd=root, capture_output=True, text=True)
        if proc_b.returncode == 0:
            git_info["branch"] = proc_b.stdout.strip() or "HEAD"

        # Commit
        proc_c = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True)
        if proc_c.returncode == 0:
            git_info["commit"] = proc_c.stdout.strip()

        # Status
        proc_s = subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True)
        if proc_s.returncode == 0:
            lines = [l for l in proc_s.stdout.splitlines() if l.strip()]
            git_info["porcelain"] = lines
            git_info["dirty"] = len(lines) > 0
            for line in lines:
                parts = line.strip().split()
                if len(parts) >= 2:
                    git_info["changed_files"].append(parts[-1])

        git_info["available"] = True
    except Exception:
        pass

    return git_info


class RepositoryScanner:
    def __init__(self, root: Path, custom_excludes: set[str] | None = None):
        self.root = root.resolve()
        self.excludes = DEFAULT_EXCLUDES | (custom_excludes or set())

    def is_excluded(self, path: Path) -> bool:
        rel = path.relative_to(self.root)
        for part in rel.parts:
            if part in self.excludes:
                return True
        return False

    def discover_files(self) -> list[Path]:
        discovered = []
        for p in self.root.rglob("*"):
            if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS:
                if not self.is_excluded(p):
                    discovered.append(p)
        return sorted(discovered, key=lambda x: str(x.relative_to(self.root)))

    def generate_manifest(self) -> dict:
        files = self.discover_files()
        file_records = []

        total_bytes = 0
        loc_counts = {"python": 0, "javascript": 0, "html": 0, "css": 0, "json": 0, "sql": 0}

        ext_map = {
            ".py": "python",
            ".js": "javascript",
            ".html": "html",
            ".css": "css",
            ".json": "json",
            ".sql": "sql"
        }

        for f in files:
            rel_path = str(f.relative_to(self.root))
            st = f.stat()
            size = st.st_size
            total_bytes += size
            sha = compute_sha256(f)

            line_count = 0
            try:
                with open(f, "r", encoding="utf-8", errors="ignore") as stream:
                    line_count = sum(1 for _ in stream)
            except Exception:
                pass

            ftype = ext_map.get(f.suffix.lower(), "other")
            if ftype in loc_counts:
                loc_counts[ftype] += line_count

            file_records.append({
                "path": rel_path,
                "type": ftype,
                "bytes": size,
                "lines": line_count,
                "sha256": sha,
                "mtime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime))
            })

        git = get_git_info(self.root)

        manifest = {
            "header": "GENERATED FILE — DO NOT EDIT MANUALLY",
            "project_name": "TaktRO",
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "repository_root": str(self.root),
            "git": git,
            "metrics": {
                "source_file_count": len(file_records),
                "total_bytes": total_bytes,
                "loc": loc_counts
            },
            "files": file_records
        }

        return manifest
