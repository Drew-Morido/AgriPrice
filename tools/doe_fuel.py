"""
AgriPricePH — official DOE fuel prices for Metro Manila (NCR).

Source: Department of Energy, "Price Monitoring of Liquid Fuels — NCR", one PDF per week, listed at
https://doe.gov.ph/data-and-prices/liquid-fuels/retail-pump-prices/ncr-pump-prices. Each PDF ends with
a summary table, "PREVAILING RETAIL PRICES OF PETROLEUM PRODUCTS NCR", giving the overall range and
the COMMON PRICE (the price most NCR stations charge) per product. This module reads that table.

Why DOE and not Zigwheels (the previous source): from 2026-05-28 the Zigwheels page kept a fresh
"Last updated" date while its figures never changed (RON95 PHP 58.15 / Diesel PHP 56.74 for four
months, "changed from PHP 56.74 to PHP 56.74"), while DOE shows RON95 PHP 96.20 / Diesel PHP 103.30
for Sep 22-28, 2026. See documents/PAPER_CORRECTIONS.md, "Fuel source replaced with DOE".

Only values printed in the bulletin are returned: no interpolation. A product whose common price is
"#N/A" comes back as None.

Fallback (`fetch_gaswatch_week`): GasWatch PH (gaswatchph.com), which republishes DOE weekly
advisories with station reports. Used only when DOE cannot be reached or parsed.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional

import requests

DOE_NCR_PAGE = "https://doe.gov.ph/data-and-prices/liquid-fuels/retail-pump-prices/ncr-pump-prices"
GASWATCH_DATA = "https://gaswatchph.com/js/data.js"
SOURCE_DOE = "doe_ncr_weekly"
SOURCE_GASWATCH = "gaswatchph"

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
}
# DOE weekly PDFs are kept with the other source files (datasets/README.md).
_CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "datasets", "3_source_files",
                          "DOE", "weekly_pdf")

# Summary-table label -> WS_fuel column
_PRODUCTS = {
    "Gasoline (RON97/100)": "RON_97",
    "Gasoline (RON95)": "RON_95",
    "Gasoline (RON91)": "RON_91",
    "Diesel Plus": "Diesel_Plus",
    "Diesel": "Diesel",
    "Kerosene": "Kerosene",
}
_MONTHS = ("January|February|March|April|May|June|July|August|September|October|November|December")
_NUM = r"(\d{1,3}(?:\.\d{1,2})?|#N/A)"


# Weekly NCR PDFs DOE still hosts but no longer links from its page. DOE's current site starts at
# Dec 2024; the pre-2025 site (with older years) no longer resolves, and 2025's Apr 15-21, May 27-Jun 2
# and Jun 3-9 weeks were not found under any file name tried (they forward-fill at merge time).
EXTRA_URLS = [
    "https://prod-cms.doe.gov.ph/documents/d/guest/petro_ncr_2024-dec-31-jan-6-pdf",
]


def list_ncr_report_urls(timeout: int = 25) -> List[str]:
    """Every weekly NCR PDF linked from the DOE page (the links sit in the page's embedded data,
    so a plain HTTP GET sees them without running the site's JavaScript), plus EXTRA_URLS."""
    html = requests.get(DOE_NCR_PAGE, headers=_HEADERS, timeout=timeout).text
    text = html.replace("\\/", "/").replace("\\u0026", "&").replace('\\"', '"')
    pat = (r'https://(?:d24qbtp4vooyzi\.cloudfront\.net/api/media/file/[^"\s\\<>]+'
           r'|prod-cms\.doe\.gov\.ph/documents/d/guest/[^"\s\\<>]*(?:ncr|NCR)[^"\s\\<>]*)')
    return sorted(set(re.findall(pat, text)) | set(EXTRA_URLS))


def _cached_pdf(url: str, timeout: int = 60) -> Optional[bytes]:
    os.makedirs(_CACHE_DIR, exist_ok=True)
    path = os.path.join(_CACHE_DIR, hashlib.sha1(url.encode()).hexdigest()[:16] + ".pdf")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read()
    r = requests.get(url, headers=_HEADERS, timeout=timeout)
    if r.status_code != 200 or not r.content.startswith(b"%PDF"):
        return None
    with open(path, "wb") as f:
        f.write(r.content)
    return r.content


def _week_start(label: str) -> Optional[date]:
    """'September 22-28, 2026' / 'December 30, 2025 - January 5, 2026' / 'April 22-28,2025' -> first day."""
    m = re.search(rf"({_MONTHS})\s+(\d{{1,2}})", label)
    years = re.findall(r"(20\d\d)", label)
    if not m or not years:
        return None
    try:
        return datetime.strptime(f"{m.group(1)} {m.group(2)} {years[0]}", "%B %d %Y").date()
    except ValueError:
        return None


def parse_ncr_summary(pdf_bytes: bytes) -> Optional[Dict]:
    """{'week_start': date, 'week_label': str, 'RON_95': float|None, 'Diesel': ..., ...} or None."""
    import pdfplumber

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        text = "\n".join((p.extract_text() or "") for p in pdf.pages)
    k = text.upper().find("PREVAILING RETAIL PRICES OF PETROLEUM PRODUCTS")
    if k < 0:
        return None
    block = text[k:k + 900]
    label = re.search(r"\(for the (?:week|period) of ([^)]+)\)", block, flags=re.I)
    if not label:
        return None
    start = _week_start(label.group(1))
    if start is None:
        return None
    out: Dict = {"week_start": start, "week_label": label.group(1).strip()}
    for line in block.splitlines():
        s = line.strip()
        for name, col in _PRODUCTS.items():
            if s.startswith(name + " ") or s == name:
                # "Diesel" must not swallow the "Diesel Plus" line.
                if name == "Diesel" and s.startswith("Diesel Plus"):
                    continue
                nums = re.findall(_NUM, s[len(name):])
                common = nums[2] if len(nums) >= 3 else None
                out[col] = None if common in (None, "#N/A") else float(common)
                break
    if out.get("RON_95") is None and out.get("Diesel") is None:
        return None
    return out


def fetch_doe_weeks(urls: Optional[List[str]] = None) -> List[Dict]:
    """Parse every listed weekly PDF (downloads are cached, so only new weeks hit the network)."""
    rows = []
    for u in urls if urls is not None else list_ncr_report_urls():
        try:
            pdf = _cached_pdf(u)
            parsed = parse_ncr_summary(pdf) if pdf else None
        except Exception:
            parsed = None
        if parsed:
            parsed["url"] = u
            rows.append(parsed)
    rows.sort(key=lambda r: r["week_start"])
    # Two links for the same week (DOE re-uploads): keep one.
    dedup = {r["week_start"]: r for r in rows}
    return [dedup[k] for k in sorted(dedup)]


def to_ws_fuel_row(week: Dict, source: str = SOURCE_DOE) -> Dict:
    """Shape a parsed week for the WS_fuel table (one row per week, dated the week's first day)."""
    return {
        "Date": week["week_start"].strftime("%m/%d/%Y"),
        "Gasoline": week.get("RON_95"),
        "RON_100": None,
        "RON_95": week.get("RON_95"),
        "RON_91": week.get("RON_91"),
        "Diesel": week.get("Diesel"),
        "Diesel_Plus": week.get("Diesel_Plus"),
        "RON_97": week.get("RON_97"),
        "Kerosene": week.get("Kerosene"),
        "Source": source,
        # Fields that DOE left blank and were taken from GasWatch PH for the same week ("" = none).
        "Filled": ",".join(week.get("filled", [])),
    }


# GasWatch station fields -> WS_fuel columns (current week only; its weekly history has diesel/RON91 only).
_GASWATCH_STATION_FIELDS = {
    "premium95": "RON_95", "unleaded": "RON_91", "premium97": "RON_97",
    "diesel": "Diesel", "premiumDiesel": "Diesel_Plus", "kerosene": "Kerosene",
}


def parse_gaswatch(js: str) -> Dict:
    """GasWatch PH's public data file -> {'history': {date: {col: price}}, 'current_week': date|None}.

    `history` holds its weekly Metro Manila averages (up to 12 weeks: Diesel <- dieselAvg, RON_91 <-
    unleadedAvg). The newest week also gets per-product means over its station list, the only place the
    other grades (RON95/97, Diesel Plus, Kerosene) appear.
    """
    history: Dict[date, Dict[str, float]] = {}
    block = re.search(r"const PRICE_HISTORY = \[(.*?)\n\];", js, flags=re.S)
    for m in re.finditer(r'week:\s*"(\d{4}-\d{2}-\d{2})"(.*?)(?=\n  \{\s*\n\s*week:|\Z)',
                         block.group(1) if block else "", flags=re.S):
        wk = datetime.strptime(m.group(1), "%Y-%m-%d").date()
        d = re.search(r"dieselAvg:\s*([\d.]+)", m.group(2))
        u = re.search(r"unleadedAvg:\s*([\d.]+)", m.group(2))
        history[wk] = {k: float(v.group(1)) for k, v in (("Diesel", d), ("RON_91", u)) if v}
    current = max(history) if history else None
    stations = re.search(r"const GAS_STATIONS = \[(.*?)\n\];", js, flags=re.S)
    if current and stations:
        for field, col in _GASWATCH_STATION_FIELDS.items():
            vals = [float(v) for v in re.findall(rf'"{field}":\s*([\d.]+)', stations.group(1))]
            if vals:
                history[current].setdefault(col, round(sum(vals) / len(vals), 2))
    return {"history": history, "current_week": current}


def load_gaswatch(timeout: int = 25) -> Optional[Dict]:
    try:
        return parse_gaswatch(requests.get(GASWATCH_DATA, headers=_HEADERS, timeout=timeout).text)
    except Exception:
        return None


def fill_blanks_from_gaswatch(weeks: List[Dict], gaswatch: Optional[Dict]) -> List[Dict]:
    """Where a DOE bulletin prints "#N/A" (or omits a product), take GasWatch PH's figure for the SAME
    week (week start within 3 days). Each filled field is listed in week['filled'], so the database and
    the admin screens can say which numbers did not come from DOE. Nothing is filled across weeks.
    Note GasWatch's figures are station averages, not DOE's common (most frequent) price.
    """
    if not gaswatch or not gaswatch.get("history"):
        return weeks
    for w in weeks:
        blanks = [c for c in ("RON_95", "RON_91", "RON_97", "Diesel", "Diesel_Plus", "Kerosene") if w.get(c) is None]
        if not blanks:
            continue
        match = next((gw for d, gw in gaswatch["history"].items() if abs((d - w["week_start"]).days) <= 3), None)
        if not match:
            continue
        for c in blanks:
            if match.get(c) is not None:
                w[c] = match[c]
                w.setdefault("filled", []).append(c)
    return weeks


def fetch_gaswatch_week(today: Optional[date] = None, timeout: int = 25) -> Optional[Dict]:
    """Fallback when DOE is unreachable/stale: GasWatch PH's newest week as a whole row."""
    gw = load_gaswatch(timeout)
    if not gw or not gw["current_week"]:
        return None
    start = gw["current_week"]
    row = {"week_start": start, "week_label": f"GasWatch PH week of {start.isoformat()}"}
    row.update(gw["history"][start])
    return row


def this_weeks_tuesday(today: Optional[date] = None) -> date:
    d = today or date.today()
    return d - timedelta(days=(d.weekday() - 1) % 7)
