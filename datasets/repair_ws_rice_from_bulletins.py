"""
AgriPricePH — check the SCRAPER's 2026 rice rows in `WS_rice_price` against the DA bulletin PDFs.

Scope, deliberately narrow:
  - Only rows the scraper wrote (Source = 'da_official') are corrected. Those values came from the
    DA website PDF, so the PDF is the authority for them. The scraper's old PDF reader (before the
    position-based rewrite of tools/pdfconvrt.py) shifted imported grades one row whenever DA printed
    "n/a" for a grade — e.g. Sep 19, 20, 22 2026.
  - Rows tagged 'da_dpi_verified' are NEVER changed. They include prices DA sent by email that are
    not on the website (the website bulletin often prints "n/a" where the emailed data has a price).
    For those rows this script only REPORTS differences, for a person to review.
  - A value is never replaced with NULL. "n/a" on the website does not mean no price exists.

Backs up the database first. Idempotent.
  py -3.13 datasets/repair_ws_rice_from_bulletins.py --dry-run
  py -3.13 datasets/repair_ws_rice_from_bulletins.py
"""

from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta

import pandas as pd
import requests

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE_DIR)
sys.path.insert(0, os.path.join(ROOT, "tools"))
from pdfconvrt import TARGET_ORDER  # noqa: E402
from parse_da_dpi_pdfs import _PDFCONVRT_COL, parse_dpi_pdf  # noqa: E402

DB_PATH = os.path.join(BASE_DIR, "agriprice_database.db")
DPI_CSV = os.path.join(BASE_DIR, "da_dpi_verified_2026.csv")
SCRAPER_CSV = os.path.join(ROOT, "tools", "scrapped price", "agriprice_database.csv")
CACHE_DIR = os.path.join(ROOT, "tools", "debug_fetch", "dpi")
OFFICIAL_SOURCES = {"da_official", "da_dpi_verified"}
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def download_bulletins(start: date, end: date, cache: str = CACHE_DIR) -> None:
    """Fetch DA Daily Price Index PDFs into `cache` (skips files already there)."""
    os.makedirs(cache, exist_ok=True)
    s = requests.Session()
    s.headers["User-Agent"] = UA
    d = start
    while d <= end:
        path = os.path.join(cache, f"{d.isoformat()}.pdf")
        if not os.path.exists(path):
            mon = d.strftime("%B")
            nxt = d.replace(day=28) + timedelta(days=4)          # DA sometimes files under next month
            for folder in (d, nxt):
                done = False
                for name in (f"Daily-Price-Index-{mon}-{d.day}-{d.year}.pdf",
                             f"Revised-Daily-Price-Index-{mon}-{d.day}-{d.year}.pdf",
                             f"Daily-Price-Index-{mon}-{d.day:02d}-{d.year}.pdf"):
                    url = f"https://www.da.gov.ph/wp-content/uploads/{folder.year}/{folder.month:02d}/{name}"
                    try:
                        r = s.get(url, timeout=30)
                    except requests.RequestException:
                        continue
                    time.sleep(0.15)
                    if r.status_code == 200 and r.content[:4] == b"%PDF":
                        with open(path, "wb") as f:
                            f.write(r.content)
                        done = True
                        break
                if done:
                    break
        d += timedelta(days=1)


def bulletin_values(cache: str = CACHE_DIR) -> dict:
    """{date: {WS column: value or None}} — keyed by the date PRINTED on each bulletin."""
    out = {}
    for name in sorted(os.listdir(cache)):
        if not name.endswith(".pdf"):
            continue
        row = parse_dpi_pdf(os.path.join(cache, name))
        if not row:
            continue
        out[row["Date"]] = {col: row[key] for key, col in _PDFCONVRT_COL.items()}
    return out


def _same(a, b) -> bool:
    a = None if a is None or (isinstance(a, float) and pd.isna(a)) else round(float(a), 2)
    b = None if b is None or (isinstance(b, float) and pd.isna(b)) else round(float(b), 2)
    return a == b


def repair(dry_run: bool = False, download: bool = True) -> dict:
    if download:
        download_bulletins(date(2026, 1, 1), date.today())
    truth = bulletin_values()

    conn = sqlite3.connect(DB_PATH)
    ws = pd.read_sql('SELECT * FROM "WS_rice_price"', conn)
    ws["_d"] = pd.to_datetime(ws["Date"], format="%m/%d/%Y", errors="coerce").dt.date
    changes, review = [], []
    for i, r in ws.iterrows():
        vals = truth.get(r["_d"])
        if vals is None:
            continue
        src = str(r.get("Source"))
        for col in TARGET_ORDER:
            new = vals[col]
            if _same(r[col], new):
                continue
            if src != "da_official" or new is None:
                review.append((r["Date"], src, col, r[col], new))     # never auto-change these
                continue
            changes.append((r["Date"], col, r[col], new))
            ws.at[i, col] = new

    if review:
        print(f"differences NOT changed (verified/emailed data, or website n/a) — review by hand: {len(review)}")
        for d_str, src, col, old, new in review:
            print(f"  {d_str}  [{src}] {col:<24} db={old!s:>7} website={'n/a' if new is None else new}")
    print(f"bulletins read: {len(truth)} | WS rows: {len(ws)} | cells to change: {len(changes)}")
    for c in changes:
        print(f"  {c[0]}  {c[1]:<24} {c[2]!s:>7} -> {c[3]!s}")
    if dry_run or not changes:
        conn.close()
        return {"changes": changes}

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(DB_PATH, DB_PATH + f".backup-pre-bulletin-repair-{stamp}")
    cur = conn.cursor()
    for d_str, col, _, new in changes:
        cur.execute(f'UPDATE "WS_rice_price" SET "{col}" = ? WHERE Date = ?', (new, d_str))
    conn.commit()
    conn.close()
    print(f"[OK] database updated (backup: agriprice_database.db.backup-pre-bulletin-repair-{stamp})")

    return {"changes": changes}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="show what would change, write nothing")
    ap.add_argument("--no-download", action="store_true", help="use only bulletins already cached")
    a = ap.parse_args()
    repair(dry_run=a.dry_run, download=not a.no_download)
