"""
SQLite Database Metadata Introspection & Schema Integrity Inspector
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path


def inspect_database(db_path: Path) -> dict:
    if not db_path.exists():
        return {
            "error": f"Database file not found: {db_path}",
            "tables": {},
            "integrity_check": "failed",
            "foreign_key_errors": []
        }

    metadata = {
        "header": "GENERATED FILE — DO NOT EDIT MANUALLY",
        "database_file": str(db_path.name),
        "size_bytes": db_path.stat().st_size,
        "user_version": 0,
        "integrity_check": "unknown",
        "foreign_key_errors": [],
        "tables": {}
    }

    try:
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5) as db:
            db.row_factory = sqlite3.Row

            # User Version
            uv = db.execute("PRAGMA user_version").fetchone()
            if uv:
                metadata["user_version"] = uv[0]

            # Integrity Check
            ic = db.execute("PRAGMA integrity_check").fetchone()
            metadata["integrity_check"] = ic[0] if ic else "unknown"

            # Foreign Key Check
            fk_errs = list(db.execute("PRAGMA foreign_key_check"))
            metadata["foreign_key_errors"] = [list(err) for err in fk_errs]

            # Tables
            tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            for tname in tables:
                # Row count only (zero data rows dumped)
                cnt = db.execute(f'SELECT COUNT(*) FROM "{tname}"').fetchone()[0]

                # Columns
                cols_info = list(db.execute(f'PRAGMA table_info("{tname}")'))
                cols = []
                for c in cols_info:
                    cols.append({
                        "name": c["name"],
                        "type": c["type"],
                        "notnull": bool(c["notnull"]),
                        "dflt_value": c["dflt_value"],
                        "pk": bool(c["pk"])
                    })

                # Foreign Keys
                fks_info = list(db.execute(f'PRAGMA foreign_key_list("{tname}")'))
                fks = []
                for fk in fks_info:
                    fks.append({
                        "table": fk["table"],
                        "from": fk["from"],
                        "to": fk["to"]
                    })

                metadata["tables"][tname] = {
                    "row_count": cnt,
                    "columns": cols,
                    "foreign_keys": fks
                }

    except Exception as err:
        metadata["error"] = str(err)

    return metadata
