"""
AgriPricePH — collect the DA daily price bulletins (2018 onward) listed on https://www.da.gov.ph/price-monitoring/
into a local cache, so they can be read and checked offline.

    cd datasets && py -3.13 fetch_da_bulletins.py --from-year 2018 --to-year 2021
    cd datasets && py -3.13 fetch_da_bulletins.py --from-year 2022 --to-year 2025

- Lists every PDF on DA's price-monitoring page and keeps the daily rice bulletins: "Price Watch" (2018-2019),
  "Daily..." / "Price Monitoring" / "Retail Price Monitoring" (2018-2025) and "Daily Price Index" (2025 onward).
  Cigarette, weekly-average and other single-commodity reports are skipped. A date with several versions (e.g. a
  "Revised" bulletin) keeps all of them; the reader decides which one to use.
- A bulletin already on this computer (--local-dir, the folders collected by hand) is copied, not downloaded.
- Polite: one request at a time with a pause between them, retries with back-off, resumable (anything already in the
  cache with a valid PDF header is skipped).
- Writes datasets/3_source_files/DA-AMAS/daily_bulletins_pdf/<year>/<file>.pdf (PDFs gitignored) and manifest.csv beside it
  (date, url, file, bytes, sha256, origin, status).

Downloads nothing outside the requested years. Nothing here touches the database.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402  (datasets/scripts/paths.py: every datasets/ location)
import re
import shutil
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = paths.PROJECT_ROOT
CACHE = paths.DA_BULLETIN_PDF_DIR
MANIFEST = os.path.join(CACHE, "manifest.csv")
LIST_URL = "https://www.da.gov.ph/price-monitoring/"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/126.0 Safari/537.36 (AgriPricePH capstone research)"}
DEFAULT_LOCAL = [r"D:\Downloads\retail price", r"D:\Downloads\Mar–Apr 2025 daily rice price",
                 r"D:\Downloads\Apr–May 2026 daily rice price", r"D:\Downloads\SEPTEMBER SCRAP"]

_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
           "november", "december"]
_MON = {m: i + 1 for i, m in enumerate(_MONTHS)}
_ABBR = {m[:3]: i + 1 for i, m in enumerate(_MONTHS)} | {"sept": 9}
_SKIP = ("cigarette", "weekly", "pork", "fish", "chicken", "beef", "egg", "sugar", "onion", "garlic", "vegetable",
         "fruit", "livestock", "poultry", "fertilizer", "feed", "-afc", "infographic")
_KEEP = ("price-watch", "pricewatch", "price-monitoring", "price_monitoring", "pricemonitoring", "daily-price-index",
         "dpi", "retail-price-monitoring", "retailprice-monitoring", "retail-price", "daily")


def bulletin_date(name: str) -> dt.date | None:
    """Date written in a DA bulletin file name (the several naming styles DA has used since 2018)."""
    s = os.path.basename(name).lower().replace(".pdf", "")
    patterns = [
        (r"daily(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*?(\d{2})(\d{4})",       # DailyApril042018
         lambda m: (int(m[3]), _ABBR[m[1]], int(m[2]))),
        (r"_(\d{2})(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*(\d{2})(?:[_-]\d)?$",  # ..._04SEPT19
         lambda m: (2000 + int(m[3]), _ABBR[m[2]], int(m[1]))),
        (r"(\d{2})-(\d{2})-(\d{4})", lambda m: (int(m[3]), int(m[1]), int(m[2]))),          # Price_Monitoring_02-22-2020
        (r"(" + "|".join(_MONTHS) + r")[-_ ]?(\d{1,2})[-_ ,]*(\d{4})",                    # Price-Monitoring-March-3-2020
         lambda m: (int(m[3]), _MON[m[1]], int(m[2]))),
    ]
    for pat, build in patterns:
        m = re.search(pat, s)
        if m:
            try:
                return dt.date(*build(m))
            except ValueError:
                return None
    return None


def is_rice_daily(name: str) -> bool:
    n = os.path.basename(name).lower()
    return not any(x in n for x in _SKIP) and any(x in n for x in _KEEP)


def list_bulletins(year_from: int, year_to: int, until: dt.date | None = None) -> list[tuple[dt.date, str]]:
    html = requests.get(LIST_URL, headers=HEADERS, timeout=90).text
    out = []
    for url in sorted(set(re.findall(r'href="([^"]+\.pdf)"', html))):
        d = bulletin_date(url)
        if d and year_from <= d.year <= year_to and (until is None or d <= until) and is_rice_daily(url):
            out.append((d, url.replace("http://", "https://", 1)))
    return sorted(out)


def _is_pdf(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(5) == b"%PDF-"
    except OSError:
        return False


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _local_index(dirs: list[str]) -> dict[str, str]:
    idx = {}
    for d in dirs:
        if os.path.isdir(d):
            for f in os.listdir(d):
                if f.lower().endswith(".pdf"):
                    idx.setdefault(f.lower(), os.path.join(d, f))
    return idx


def _load_manifest() -> dict[str, dict]:
    if not os.path.exists(MANIFEST):
        return {}
    with open(MANIFEST, newline="", encoding="utf-8") as f:
        return {r["url"]: r for r in csv.DictReader(f)}


def _save_manifest(rows: dict[str, dict]) -> None:
    os.makedirs(CACHE, exist_ok=True)
    cols = ["date", "url", "file", "bytes", "sha256", "origin", "status"]
    with open(MANIFEST, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in sorted(rows.values(), key=lambda r: (r["date"], r["url"])):
            w.writerow({c: r.get(c, "") for c in cols})


def fetch(year_from: int, year_to: int, local_dirs: list[str], delay: float = 1.0, retries: int = 4,
          until: dt.date | None = None) -> dict:
    items = list_bulletins(year_from, year_to, until)
    local = _local_index(local_dirs)
    manifest = _load_manifest()
    stats = {"listed": len(items), "cached": 0, "copied": 0, "downloaded": 0, "failed": 0, "bytes": 0}
    session = requests.Session()
    session.headers.update(HEADERS)
    for i, (d, url) in enumerate(items, 1):
        name = os.path.basename(url)
        dest = os.path.join(CACHE, str(d.year), name)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        row = {"date": d.isoformat(), "url": url, "file": os.path.relpath(dest, CACHE)}
        if _is_pdf(dest):
            stats["cached"] += 1
            origin = manifest.get(url, {}).get("origin", "cache")
        elif name.lower() in local and _is_pdf(local[name.lower()]):
            shutil.copy2(local[name.lower()], dest)
            stats["copied"] += 1
            origin = "local_copy"
        else:
            origin, ok = "download", False
            for attempt in range(retries):
                try:
                    r = session.get(url, timeout=120)
                    if r.status_code == 200 and r.content[:5] == b"%PDF-":
                        tmp = dest + ".part"
                        with open(tmp, "wb") as f:
                            f.write(r.content)
                        os.replace(tmp, dest)
                        ok = True
                        break
                    if r.status_code == 404:
                        break
                except requests.RequestException:
                    pass
                time.sleep(delay * (2 ** attempt))
            time.sleep(delay)
            if not ok:
                stats["failed"] += 1
                manifest[url] = {**row, "origin": origin, "status": "failed"}
                print(f"[{i}/{len(items)}] FAILED {name}", flush=True)
                continue
            stats["downloaded"] += 1
        size = os.path.getsize(dest)
        stats["bytes"] += size
        manifest[url] = {**row, "bytes": size, "sha256": _sha256(dest), "origin": origin, "status": "ok"}
        if i % 25 == 0 or i == len(items):
            _save_manifest(manifest)
            print(f"[{i}/{len(items)}] cached {stats['cached']} copied {stats['copied']} downloaded "
                  f"{stats['downloaded']} failed {stats['failed']} ({stats['bytes'] / 1e6:.0f} MB)", flush=True)
    _save_manifest(manifest)
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description="Cache DA daily rice price bulletins (2018 onward).")
    ap.add_argument("--from-year", type=int, required=True)
    ap.add_argument("--to-year", type=int, required=True)
    ap.add_argument("--local-dir", action="append", default=None, help="folder of bulletins already on disk (repeatable)")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests (default 1.0)")
    ap.add_argument("--until", type=dt.date.fromisoformat, default=None,
                    help="last date to include, YYYY-MM-DD (e.g. 2025-03-31: the DA Daily Price Index covers later days)")
    a = ap.parse_args()
    stats = fetch(a.from_year, a.to_year, a.local_dir or DEFAULT_LOCAL, a.delay, until=a.until)
    print(stats)
    return 0 if stats["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
