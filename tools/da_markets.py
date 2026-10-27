"""
The markets DA-AMAS covers in the NCR Daily Price Index, read from the newest bulletin PDF the scraper saved.

Each Daily Price Index ends with a "Covered market" list (29 NCR wet markets in Oct 2026). The prevailing
retail price DA publishes is the average across these markets, so the site names them next to the source
(DA-AMAS feedback B5). The list is read, never typed in: `refresh()` runs after every scrape and writes
model/da_markets.json; if no PDF can be read the previous file stays as it is.

Run by hand:  py -3.13 tools/da_markets.py
"""

from __future__ import annotations

import glob
import json
import os
import re
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF_DIRS = [
    os.path.join(ROOT, "datasets", "3_source_files", "DA-AMAS", "scraper_downloads"),
    os.path.join(ROOT, "datasets", "3_source_files", "DA-AMAS", "daily_price_index_pdf"),
]
OUT_PATH = os.path.join(ROOT, "model", "da_markets.json")

_DATE_RE = re.compile(r"\((?:[A-Za-z]+,\s*)?([A-Z][a-z]+ \d{1,2}, \d{4})\)")
_ITEM_RE = re.compile(r"(\d{1,2})\.\s+(.+?)(?=\s+\d{1,2}\.\s|$)")


def _clean(name: str) -> str:
    # The PDF's font maps ñ to U+FFFD (Mu?oz, Las Pi?as); in NCR market names that character is always ñ.
    return re.sub(r"\s+", " ", name.replace("�", "ñ")).strip()


def extract(pdf_path: str) -> dict | None:
    """{"bulletin_date": "YYYY-MM-DD", "markets": [...]} from one Daily Price Index PDF, or None."""
    import pdfplumber

    with pdfplumber.open(pdf_path) as pdf:
        pages = [(pg.extract_text() or "") for pg in pdf.pages]
    text = "\n".join(pages)
    if "DAILY PRICE INDEX" not in text.upper() or "Covered market" not in text:
        return None
    bulletin_date = None
    m = _DATE_RE.search(text)
    if m:
        try:
            bulletin_date = datetime.strptime(m.group(1), "%B %d, %Y").strftime("%Y-%m-%d")
        except ValueError:
            pass
    tail = text.split("Covered market", 1)[1]
    found: dict[int, str] = {}
    for line in tail.splitlines():
        if line.strip().lower().startswith("page "):
            break
        for num, name in _ITEM_RE.findall(line):
            found.setdefault(int(num), _clean(name))
    if len(found) < 5:
        return None
    markets = [found[k] for k in sorted(found)]
    return {"bulletin_date": bulletin_date, "markets": markets}


def _candidates() -> list[str]:
    files = []
    for d in PDF_DIRS:
        files += glob.glob(os.path.join(d, "*.pdf"))
    return sorted(files, key=os.path.getmtime, reverse=True)


def refresh(max_tries: int = 6) -> dict | None:
    """Read the newest readable bulletin and save the list. Returns what was saved, or None."""
    for path in _candidates()[:max_tries]:
        try:
            got = extract(path)
        except Exception:
            got = None
        if got:
            got["source_pdf"] = os.path.basename(path)
            got["read_at"] = datetime.now().isoformat(timespec="seconds")
            tmp = OUT_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(got, fh, ensure_ascii=False, indent=1)
            os.replace(tmp, OUT_PATH)
            return got
    return None


def load() -> dict:
    try:
        with open(OUT_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


if __name__ == "__main__":
    r = refresh()
    if not r:
        print("No readable Daily Price Index PDF found.")
    else:
        print(f"{len(r['markets'])} markets, bulletin {r['bulletin_date']} ({r['source_pdf']})")
        for i, name in enumerate(r["markets"], 1):
            print(f"{i:>2}. {name}")
