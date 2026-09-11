"""
AgriPricePH — parser for DA "Daily Price Index" (DPI) bulletin PDFs, NCR.

This is the post-March-2025 template: one PDF per report day, text-layer (no OCR), with an
IMPORTED COMMERCIAL RICE and a LOCAL COMMERCIAL RICE block listing one prevailing retail price
per grade. Since ~March 2025 the grades are the expanded set (Basmati / Glutinous /
Jasponica / Other Special Rice / Premium / Well Milled / Regular Milled); this system tracks the
four core grades, where "Other Special Rice" is the Special grade.

Only values printed in the bulletin are returned — no interpolation, no forward-fill.
"""

from __future__ import annotations

import glob
import os
import re
from datetime import datetime

import pdfplumber

# canonical key -> label as printed under each section header
CORE_GRADES = {
    "Special": "Other Special Rice",
    "Premium": "Premium",
    "WellMilled": "Well Milled",
    "Regular": "Regular Milled",
}
MONTHS = ("January|February|March|April|May|June|July|August|September|October|November|December")


def _price_after(block: str, label: str):
    """First price on the line that starts with `label` inside `block`."""
    for line in block.splitlines():
        s = line.strip()
        if not s.lower().startswith(label.lower()):
            continue
        nums = re.findall(r"(\d{1,3}(?:,\d{3})*\.\d{1,2})", s)
        if nums:
            return float(nums[0].replace(",", ""))
    return None


def parse_dpi_pdf(path: str) -> dict | None:
    """Return {'Date': date, 'impSpecial': .., ... 'locRegular': ..} or None."""
    try:
        with pdfplumber.open(path) as pdf:
            text = pdf.pages[0].extract_text() or ""
    except Exception:
        return None
    if "IMPORTED COMMERCIAL RICE" not in text:
        return None

    m = re.search(rf"({MONTHS})\s+(\d{{1,2}}),\s*(\d{{4}})", text)
    if not m:
        return None
    d = datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", "%B %d %Y").date()

    i = text.index("IMPORTED COMMERCIAL RICE")
    j = text.index("LOCAL COMMERCIAL RICE") if "LOCAL COMMERCIAL RICE" in text else len(text)
    imp_block = text[i:j]
    rest = text[j:]
    # local block ends at the next ALL-CAPS section heading
    k = re.search(r"\n(?=[A-Z][A-Z &(),./-]{6,}\n)", rest[len("LOCAL COMMERCIAL RICE"):])
    loc_block = rest[: k.start() + len("LOCAL COMMERCIAL RICE")] if k else rest

    row = {"Date": d}
    for key, label in CORE_GRADES.items():
        row[f"imp{key}"] = _price_after(imp_block, label)
        row[f"loc{key}"] = _price_after(loc_block, label)
    return row


def parse_folder(folder: str, verbose: bool = True) -> list:
    rows, bad = [], 0
    for path in sorted(glob.glob(os.path.join(folder, "*.pdf"))):
        r = parse_dpi_pdf(path)
        if r is None:
            bad += 1
            if verbose:
                print(f"  [skip] {os.path.basename(path)}")
            continue
        rows.append(r)
    # "Revised-..." files supersede the original for the same date
    by_date = {}
    for r in sorted(rows, key=lambda x: x["Date"]):
        by_date[r["Date"]] = r
    if verbose:
        print(f"[parse_da_dpi_pdfs] parsed {len(rows)} PDFs -> {len(by_date)} unique days, {bad} skipped")
    return [by_date[d] for d in sorted(by_date)]


if __name__ == "__main__":
    import sys
    out = parse_folder(sys.argv[1] if len(sys.argv) > 1 else ".")
    print(f"{len(out)} days: {out[0]['Date']} -> {out[-1]['Date']}" if out else "none")
