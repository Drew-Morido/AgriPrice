"""
AgriPricePH — parser for the user-supplied folder of real DA "Bantay Presyo"/"Price Watch"/
"Price Monitoring" daily/weekly PDF bulletins (2018-2021), used to extend verified correction
coverage into the previously-untouched 2015 - Jan 2021 window.

The folder mixes at least 4 genuinely different report templates DA used over the years. Only
templates that explicitly break rice prices into IMPORTED COMMERCIAL RICE / LOCAL COMMERCIAL RICE
x (Special, Premium, Well milled, Regular milled) are used — the same 8-category schema this
system already tracks. Templates that only report a single undifferentiated "COMMERCIAL RICE"
figure (no imported/local split) are skipped entirely: there is no reliable way to map them onto
this schema without guessing, so guessing was not done.

Formats handled (auto-detected per file from its own header text):
  - "Format A" (~Sep 2019-Jan 2020): columns are Prevailing, Low, High, Average, in that order
    (e.g. "Special (Blue tag) kg 50.00 40.00 58.00 50.50" -> Prevailing=50.00). Requires exactly
    4 numbers on the line; fewer means the source itself reported no figure that day, and the row
    is skipped rather than guessed.
  - "Format B" (2020-Oct 2021): columns are High, Low, Prevailing (no Average column) (e.g.
    "Special Blue tag kg 54.00 45.00 52.00" -> Prevailing=52.00, the last number). Requires
    exactly 3 numbers; "NOT AVAILABLE"/"NONE" rows (fewer numbers) are skipped.
  - "Format C" ("Today vs Yesterday" comparison, Sep-Oct 2021 only, 6 files): each file reports
    TWO calendar days at once (today + the prior report date) in a single row per category, e.g.
    "Special 50.00 50.00 Special 50.00 50.00" = Imported(today, yesterday), Local(today,
    yesterday). Gives 2 candidate days per file.

Formats explicitly NOT handled (excluded, not guessed):
  - The older wide multi-market "DAILY PRICE MONITORING REPORT" template (2018-mid 2019,
    "Price-Watch-*"/"Daily*" filenames + one "RETAIL-Price-Monitoring-Sum-Market" file): reports
    only "Fancy/Premium/Well milled special/Regular milled ordinary" with no imported/local
    split — a genuinely different, incompatible schema.
  - The "BANTAY PRESYO" per-market summary poster (Oct-Dec 2021): only reports a single
    undifferentiated "Well-milled" figure per market, no Special/Premium/Regular breakdown, no
    imported/local split. This window is already covered by the DA-AMAS weekly-file correction
    (`apply_da_amas_weekly_corrections.py`) anyway, so nothing is lost by skipping it.
  - One poster-style infographic file (Retail-Price-Monitoring-December-28-2019.pdf) whose text
    extracts in a jumbled, position-dependent order with no reliable column anchors — skipped
    rather than built a fragile one-off parser for a single file whose date (Dec 28, 2019) sits 5
    days from an already-included clean-format file (Dec 23, 2019).

Every extracted "Prevailing" value is scoped to the exact line/label pdfplumber found — nothing
is inferred, interpolated, or averaged across formats.
"""

from __future__ import annotations

import glob
import os
import re
from datetime import datetime

import pdfplumber

FOLDER = r"C:\Users\Astral\Downloads\retail price"

MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"

# canonical key -> regex fragments that can start a rice-category line (order matters: try
# longest/most specific first is not needed since these are disjoint prefixes)
CATEGORY_PATTERNS = {
    "Special": r"Special",
    "Premium": r"Premium",
    "WellMilled": r"Well[\s-]?milled",
    "Regular": r"Regular\s?[Mm]illed",
}
CATEGORY_ORDER = ["Special", "Premium", "WellMilled", "Regular"]


def _find_date(text: str):
    m = re.search(rf"({MONTHS})\s+(\d{{1,2}}),?\s+(\d{{4}})", text)
    if m:
        return datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", "%B %d %Y").date()
    m = re.search(rf"(\d{{1,2}})\s+({MONTHS})\s+(\d{{4}})", text)
    if m:
        return datetime.strptime(f"{m.group(2)} {m.group(1)} {m.group(3)}", "%B %d %Y").date()
    return None


def _section_block(text: str, start_label: str, end_labels: list[str]) -> str:
    idx = text.find(start_label)
    if idx == -1:
        return ""
    rest = text[idx + len(start_label):]
    end = len(rest)
    for el in end_labels:
        e = rest.find(el)
        if e != -1:
            end = min(end, e)
    return rest[:end]


def _extract_section_values(block: str, n_expected: int, prevailing_pos: int) -> dict:
    """block = text between a section header and the next section; n_expected = how many
    numbers a valid row must have; prevailing_pos = 0-indexed position of the Prevailing value
    among those numbers. Returns {canonical_key: value or None}."""
    out = {}
    for key in CATEGORY_ORDER:
        pat = CATEGORY_PATTERNS[key]
        m = re.search(rf"{pat}[^\n]*", block)
        if not m:
            out[key] = None
            continue
        line = m.group(0)
        nums = re.findall(r"\d+\.\d+", line)
        if len(nums) == n_expected:
            out[key] = round(float(nums[prevailing_pos]), 2)
        else:
            out[key] = None
    return out


def _parse_format_ab(text: str, header_kind: str) -> dict:
    """header_kind: 'A' (Prevailing Low High Average, 4 nums, prevailing=idx0)
    or 'B' (High Low Prevailing, 3 nums, prevailing=idx2)."""
    n_expected, pos = (4, 0) if header_kind == "A" else (3, 2)
    imp_block = _section_block(text, "IMPORTED COMMERCIAL RICE", ["LOCAL COMMERCIAL RICE"])
    loc_block = _section_block(text, "LOCAL COMMERCIAL RICE", ["FISH", "LIVESTOCK"])
    imp = _extract_section_values(imp_block, n_expected, pos)
    loc = _extract_section_values(loc_block, n_expected, pos)
    return {
        "impSpecial": imp["Special"], "impPremium": imp["Premium"],
        "impWellMilled": imp["WellMilled"], "impRegular": imp["Regular"],
        "locSpecial": loc["Special"], "locPremium": loc["Premium"],
        "locWellMilled": loc["WellMilled"], "locRegular": loc["Regular"],
    }


def _parse_format_c(text: str):
    """Today/Yesterday comparison format. Returns (today_date, today_dict, yday_date, yday_dict)
    or None if the two dates/labels can't be confidently located."""
    dm = re.search(rf"({MONTHS})\s+(\d{{1,2}}),?\s+(\d{{4}})\s+({MONTHS})\s+(\d{{1,2}}),?\s+(\d{{4}})", text)
    if not dm:
        return None
    today = datetime.strptime(f"{dm.group(1)} {dm.group(2)} {dm.group(3)}", "%B %d %Y").date()
    yday = datetime.strptime(f"{dm.group(4)} {dm.group(5)} {dm.group(6)}", "%B %d %Y").date()

    block = _section_block(text, "IMPORTED COMMERCIAL RICE", ["LIVESTOCK", "FRUITS", "OTHER"])
    today_vals, yday_vals = {}, {}
    for key in CATEGORY_ORDER:
        pat = CATEGORY_PATTERNS[key]
        # each category name appears twice on the (visually two-column) line: imported cols
        # then local cols, each pair = (today, yesterday)
        matches = list(re.finditer(rf"{pat}[^\n]*", block))
        if not matches:
            today_vals[key] = (None, None)
            yday_vals[key] = (None, None)
            continue
        line = matches[0].group(0)
        nums = re.findall(r"\d+\.\d+", line)
        if len(nums) == 4:
            today_vals[key] = (float(nums[0]), float(nums[2]))
            yday_vals[key] = (float(nums[1]), float(nums[3]))
        else:
            today_vals[key] = (None, None)
            yday_vals[key] = (None, None)

    today_row = {
        "impSpecial": today_vals["Special"][0], "impPremium": today_vals["Premium"][0],
        "impWellMilled": today_vals["WellMilled"][0], "impRegular": today_vals["Regular"][0],
        "locSpecial": today_vals["Special"][1], "locPremium": today_vals["Premium"][1],
        "locWellMilled": today_vals["WellMilled"][1], "locRegular": today_vals["Regular"][1],
    }
    yday_row = {
        "impSpecial": yday_vals["Special"][0], "impPremium": yday_vals["Premium"][0],
        "impWellMilled": yday_vals["WellMilled"][0], "impRegular": yday_vals["Regular"][0],
        "locSpecial": yday_vals["Special"][1], "locPremium": yday_vals["Premium"][1],
        "locWellMilled": yday_vals["WellMilled"][1], "locRegular": yday_vals["Regular"][1],
    }
    return today, today_row, yday, yday_row


def parse_all(folder: str = FOLDER, verbose: bool = True) -> dict:
    """Returns {date_iso: {key: value}} — one row per calendar day, latest file wins on
    conflict (later files in sorted filename order are not necessarily later reports, so
    conflicts are resolved by simply keeping whichever value was found first and not overwriting
    with a second candidate for the same day; this is logged if it happens)."""
    files = sorted(glob.glob(os.path.join(folder, "*.pdf")))
    rows: dict[str, dict] = {}
    skipped_old_format = 0
    skipped_no_split = 0
    used_files = 0
    conflicts = 0

    for fp in files:
        name = os.path.basename(fp)
        try:
            with pdfplumber.open(fp) as pdf:
                text = pdf.pages[0].extract_text() or ""
        except Exception as e:
            if verbose:
                print(f"[skip] {name}: cannot read ({e})")
            continue

        if "IMPORTED COMMERCIAL RICE" not in text.upper():
            skipped_no_split += 1
            continue

        if "TODAY'S PREVAILING PRICE" in text.upper():
            parsed = _parse_format_c(text)
            if parsed is None:
                if verbose:
                    print(f"[skip] {name}: format C dates not found")
                continue
            for d, row in ((parsed[0], parsed[1]), (parsed[2], parsed[3])):
                key = d.isoformat()
                if key in rows:
                    conflicts += 1
                    continue
                rows[key] = row
            used_files += 1
            continue

        header_match = re.search(r"(Prevailing\s+Low\s+High(?:\s+Average)?|High\s+Low\s+Prevailing)", text)
        if not header_match:
            if verbose:
                print(f"[skip] {name}: header format not recognized")
            continue
        header_kind = "A" if header_match.group(1).startswith("Prevailing") else "B"

        d = _find_date(text)
        if d is None:
            if verbose:
                print(f"[skip] {name}: date not found")
            continue

        row = _parse_format_ab(text, header_kind)
        key = d.isoformat()
        if key in rows:
            conflicts += 1
            continue
        rows[key] = row
        used_files += 1

    if verbose:
        print(f"[parse_da_bantay_presyo_pdfs] used {used_files} files -> {len(rows)} unique days")
        print(f"  skipped (no imported/local split, incompatible schema): {skipped_no_split}")
        print(f"  same-day conflicts (kept first, discarded duplicate): {conflicts}")

    return rows


if __name__ == "__main__":
    rows = parse_all()
    dates = sorted(rows.keys())
    if dates:
        print(f"date range: {dates[0]} to {dates[-1]}")
