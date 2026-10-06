"""NHTSA recall lookup and manufacturer-communication bulk import."""

from __future__ import annotations

import csv
import io
import json
import sqlite3
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path


ARCHIVE_RANGES = {
    "1995-1999", "2000-2004", "2005-2009", "2010-2014",
    "2015-2019", "2020-2024", "2025-2026",
}
ARCHIVE_CACHE_DIR = Path(__file__).resolve().parent / ".local" / "nhtsa"


def _load_archive(archive_range: str) -> bytes:
    """Return a verified archive, reusing the Git-ignored local cache when possible."""
    archive_name = f"TSBS_RECEIVED_{archive_range}.zip"
    cache_path = ARCHIVE_CACHE_DIR / archive_name
    if cache_path.is_file():
        cached = cache_path.read_bytes()
        if zipfile.is_zipfile(io.BytesIO(cached)):
            return cached
        cache_path.unlink()

    url = f"https://static.nhtsa.gov/odi/ffdd/tsbs/{archive_name}"
    request = urllib.request.Request(url, headers={"User-Agent": "TaktRO/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        downloaded = response.read()
    if not zipfile.is_zipfile(io.BytesIO(downloaded)):
        raise zipfile.BadZipFile("NHTSA response is not a valid ZIP archive.")

    ARCHIVE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    temporary_path = cache_path.with_suffix(".zip.download")
    temporary_path.write_bytes(downloaded)
    temporary_path.replace(cache_path)
    return downloaded


def fetch_recalls(year: int, make: str, model: str, timeout: int = 8) -> list[dict]:
    query = urllib.parse.urlencode({"modelYear": year, "make": make, "model": model})
    url = f"https://api.nhtsa.gov/recalls/recallsByVehicle?{query}"
    request = urllib.request.Request(url, headers={"User-Agent": "TaktRO/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    return payload.get("results") or payload.get("Results") or []


def search_communications(db: sqlite3.Connection, year: int, make: str, model: str) -> list[dict]:
    rows = db.execute(
        """SELECT MIN(id) AS id,nhtsa_id,MAX(replacement_id) AS replacement_id,
                  MAX(date_added) AS date_added,MAX(document_id) AS document_id,
                  MAX(communication_date) AS communication_date,MAX(campaign_id) AS campaign_id,
                  MAX(communication_type) AS communication_type,make,model,model_year,
                  GROUP_CONCAT(DISTINCT nhtsa_component) AS nhtsa_component,
                  GROUP_CONCAT(DISTINCT manufacturer_system) AS manufacturer_system,
                  GROUP_CONCAT(DISTINCT manufacturer_subsystem) AS manufacturer_subsystem,
                  MAX(summary) AS summary,MAX(pdf_url) AS pdf_url,
                  MAX(source_archive) AS source_archive,MAX(imported_at) AS imported_at
           FROM nhtsa_communications
           WHERE model_year=? AND make=? COLLATE NOCASE AND model=? COLLATE NOCASE
           GROUP BY nhtsa_id,make,model,model_year
           ORDER BY communication_date DESC,nhtsa_id DESC""",
        (year, make.strip(), model.strip()),
    ).fetchall()
    return [dict(row) for row in rows]


def import_communications(db: sqlite3.Connection, archive_range: str) -> dict:
    if archive_range not in ARCHIVE_RANGES:
        raise ValueError("Unsupported NHTSA archive range.")
    archive_bytes = _load_archive(archive_range)

    imported = 0
    now = datetime.now(timezone.utc).isoformat()
    csv.field_size_limit(10_000_000)
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive, db:
        names = [name for name in archive.namelist() if name.lower().endswith((".txt", ".tsv"))]
        if not names:
            raise ValueError("NHTSA archive does not contain a supported flat file.")
        stream = io.TextIOWrapper(archive.open(names[0]), encoding="utf-8-sig", errors="replace", newline="")
        for fields in csv.reader(stream, delimiter="\t"):
            if len(fields) < 14 or not fields[0].strip().isdigit():
                continue
            nhtsa_id, replacement_id, date_added, document_id, communication_date, campaign_id, communication_type, make, model, model_year, component, manufacturer_system, manufacturer_subsystem, summary = fields[:14]
            if not model_year.strip().isdigit():
                continue
            pdf_year = (date_added or communication_date or "0000")[:4]
            pdf_url = f"https://static.nhtsa.gov/odi/tsbs/{pdf_year}/MC-{nhtsa_id.strip()}-0001.pdf"
            db.execute(
                """INSERT INTO nhtsa_communications
                   (nhtsa_id,replacement_id,date_added,document_id,communication_date,campaign_id,
                    communication_type,make,model,model_year,nhtsa_component,manufacturer_system,
                    manufacturer_subsystem,summary,pdf_url,source_archive,imported_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(nhtsa_id,make,model,model_year,nhtsa_component) DO UPDATE SET
                    replacement_id=excluded.replacement_id,date_added=excluded.date_added,
                    document_id=excluded.document_id,communication_date=excluded.communication_date,
                    campaign_id=excluded.campaign_id,communication_type=excluded.communication_type,
                    manufacturer_system=excluded.manufacturer_system,
                    manufacturer_subsystem=excluded.manufacturer_subsystem,summary=excluded.summary,
                    pdf_url=excluded.pdf_url,source_archive=excluded.source_archive,imported_at=excluded.imported_at""",
                (nhtsa_id.strip(), replacement_id.strip(), date_added.strip(), document_id.strip(),
                 communication_date.strip(), campaign_id.strip(), communication_type.strip(), make.strip(),
                 model.strip(), int(model_year), component.strip(), manufacturer_system.strip(),
                 manufacturer_subsystem.strip(), summary.strip(), pdf_url, archive_range, now),
            )
            imported += 1
    return {"archive_range": archive_range, "rows_processed": imported, "imported_at": now}
