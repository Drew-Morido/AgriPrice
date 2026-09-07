"""
AgriPricePH — seed the `rice_brand` catalog table from the curated brand-mapping workbook.

Reads the "Final Brand Mapping" sheet of `datasets/Rice_Brand_Final_Mapping.xlsx` (34 curated
brands + Akira + Master Chef Well-Milled = 36 brand-category rows) and inserts each row into
`rice_brand`, using the schema/tables from `datasets/catalog_schema.py` (created + the 8
categories seeded first if not already present).

This is Phase 1 of the Rice Brand module: read-only catalog data only. It does NOT touch
`rice_price_bracket` or anything under `model/` — brand rows carry their source price as
informational text in `notes` only; no pricing math happens here or anywhere the LSTM sees.

Idempotent: `rice_brand` has a UNIQUE(category_id, brand_name, package) constraint, and this
script checks for that exact row before inserting, so running it twice never creates duplicates
(it just reports 0 added / N skipped on the second run).

Run:  py -3.13 datasets/seed_brand_mapping.py            # seed
      py -3.13 datasets/seed_brand_mapping.py --status    # per-category brand counts only
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys

import openpyxl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from catalog_schema import _db_path, create_catalog_tables, seed_categories  # noqa: E402

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
XLSX_PATH = os.path.join(PROJECT_ROOT, "datasets", "Rice_Brand_Final_Mapping.xlsx")
SHEET_NAME = "Final Brand Mapping"

# Header row cells (as they appear in the sheet), used only to locate the header row robustly.
HEADER_FIRST_CELL = "Segment"


def _split_category(cell: str) -> str:
    """'locSpecial — Local Special' -> 'locSpecial' (the canonical_key the DB uses)."""
    s = str(cell or "").strip()
    for sep in ("—", "–", "-"):
        if sep in s:
            return s.split(sep, 1)[0].strip()
    return s


def _verification_status(cell: str) -> str:
    """The sheet's 'Is Verified?' column really means 'is this DTI-verified?' — every row here
    passed a real field survey (per its own text), so 'NO' maps to 'field_verified', not
    'unverified'. 'YES' (none in this sheet today) would map to the stronger 'dti_verified'."""
    s = str(cell or "").strip().upper()
    if s.startswith("YES"):
        return "dti_verified"
    if s.startswith("NO") or "FIELD SURVEY" in s:
        return "field_verified"
    return "unverified"


def read_rows(xlsx_path: str = XLSX_PATH) -> list[dict]:
    """Parse the sheet into plain dicts, one per brand-category row."""
    if not os.path.exists(xlsx_path):
        raise FileNotFoundError(f"Workbook not found: {xlsx_path}")
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    if SHEET_NAME not in wb.sheetnames:
        raise ValueError(f"Sheet '{SHEET_NAME}' not found in {xlsx_path}. Sheets: {wb.sheetnames}")
    ws = wb[SHEET_NAME]

    all_rows = list(ws.iter_rows(values_only=True))
    header_idx = None
    for i, r in enumerate(all_rows):
        if r and str(r[0] or "").strip() == HEADER_FIRST_CELL:
            header_idx = i
            break
    if header_idx is None:
        raise ValueError(f"Could not find header row starting with '{HEADER_FIRST_CELL}'.")

    out = []
    for r in all_rows[header_idx + 1:]:
        if not r or not str(r[0] or "").strip():
            continue  # blank row = end of table
        segment = str(r[0] or "").strip()
        canonical_key = _split_category(r[1])
        brand_name = str(r[2] or "").strip()
        package = str(r[3] or "").strip() or None
        skus_merged = r[4]
        price_per_kilo = str(r[5] or "").strip() or None
        location = str(r[6] or "").strip() or None
        source = str(r[7] or "").strip() or None
        verification_status = _verification_status(r[8])
        note = str(r[9] or "").strip() or None
        if not brand_name or not canonical_key:
            continue

        notes_parts = []
        if skus_merged not in (None, ""):
            notes_parts.append(f"SKUs merged: {skus_merged}")
        if price_per_kilo:
            notes_parts.append(f"Source price: {price_per_kilo} (informational — not used in forecasting)")
        notes = ". ".join(notes_parts) or None

        out.append({
            "segment": segment,
            "canonical_key": canonical_key,
            "brand_name": brand_name,
            "package": package,
            "location": location,
            "source": source,
            "verification_status": verification_status,
            "classification_note": note,
            "notes": notes,
        })
    return out


def seed_brands(conn: sqlite3.Connection, rows: list[dict]) -> tuple[int, int, list[str]]:
    """Insert brand rows; skip ones that already exist (idempotent). Returns (added, skipped, warnings)."""
    cur = conn.cursor()
    cat_ids = {r[0]: r[1] for r in cur.execute("SELECT canonical_key, id FROM dti_category")}

    added = 0
    skipped = 0
    warnings = []
    for row in rows:
        cat_id = cat_ids.get(row["canonical_key"])
        if cat_id is None:
            warnings.append(f"Unknown category '{row['canonical_key']}' for brand '{row['brand_name']}' — skipped.")
            continue
        exists = cur.execute(
            "SELECT 1 FROM rice_brand WHERE category_id=? AND brand_name=? AND "
            "(package IS ? OR package = ?)",
            (cat_id, row["brand_name"], row["package"], row["package"]),
        ).fetchone()
        if exists:
            skipped += 1
            continue
        cur.execute(
            "INSERT INTO rice_brand(category_id, brand_name, package, location, source, "
            "source_url, last_verified, classification_note, verification_status, notes) "
            "VALUES (?,?,?,?,?,NULL,NULL,?,?,?)",
            (cat_id, row["brand_name"], row["package"], row["location"], row["source"],
             row["classification_note"], row["verification_status"], row["notes"]),
        )
        added += 1
    conn.commit()
    return added, skipped, warnings


def category_counts(conn: sqlite3.Connection) -> list[tuple[str, str, int]]:
    return list(conn.execute(
        "SELECT c.name, c.canonical_key, COUNT(b.id) "
        "FROM dti_category c LEFT JOIN rice_brand b ON b.category_id = c.id "
        "GROUP BY c.id ORDER BY c.segment, c.name"
    ))


def main() -> int:
    ap = argparse.ArgumentParser(description="Seed rice_brand from Rice_Brand_Final_Mapping.xlsx")
    ap.add_argument("--status", action="store_true", help="show per-category brand counts only, no seeding")
    ap.add_argument("--xlsx", default=XLSX_PATH, help="path to the mapping workbook")
    args = ap.parse_args()

    db = _db_path()
    if not os.path.exists(db):
        print(f"[ERROR] database not found at {db}. Run datasets/script.py first.")
        return 1

    conn = sqlite3.connect(db)
    try:
        create_catalog_tables(conn)
        seed_categories(conn)

        if args.status:
            print(f"DB: {db}")
            for name, key, count in category_counts(conn):
                print(f"  {name:<28} ({key:<14}) {count}")
            return 0

        rows = read_rows(args.xlsx)
        added, skipped, warnings = seed_brands(conn, rows)
        for w in warnings:
            print(f"[WARN] {w}")
        print(f"[OK] parsed {len(rows)} brand-category rows from {os.path.basename(args.xlsx)}")
        print(f"[OK] inserted {added} new brand(s), skipped {skipped} already-present brand(s)")
        print()
        print("Per-category brand counts:")
        for name, key, count in category_counts(conn):
            print(f"  {name:<28} ({key:<14}) {count}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
