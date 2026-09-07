"""
AgriPricePH — parser for the DA-AMAS "Weekly Prevailing Retail Price of Commercial Rice in
Selected NCR Wet Markets" workbook (user-supplied file, one sheet per year 2020-2026).

This is a *parser only* — it turns the raw workbook into a tidy long-format dataframe
(key, week_start, week_end, value). See apply_da_amas_weekly_corrections.py for the script
that actually writes verified rows into retail_prices.

Sheet layout (same template for 2020-2025; 2026 adds Basmati/Glutinous/Japonica rows we don't
use):
  - A header row whose first cell is "COMMODITY", with month names spanning groups of columns.
  - The next row holds "Wk 1".."Wk N" labels under each month (N varies 4-5 per month, and is
    read from the sheet itself — never assumed — because months don't split into weeks evenly).
  - Below that, two commodity sections ("IMPORTED COMMERCIAL RICE", "LOCAL COMMERCIAL RICE"),
    each with 4 rows in a fixed order: Special, Premium, Well Milled, Regular Milled. (2020 also
    has an "NFA RICE" section before the imported one, which we skip — NFA rice is not one of
    the 8 rice types this system tracks.)

Week-to-date alignment: the sheet only labels weeks as "Wk 1", "Wk 2", ... within each month, not
by calendar date. We reconstruct the exact Monday-Friday date range for each week by counting
forward continuously from the year's first Monday, using the sheet's own per-month week counts
(so a 5-week January followed by a 4-week February is handled correctly, matching how the sheet
itself groups weeks). This was validated against 3 independent real-world date anchors (matching
known DA bulletin dates) with an exact match on all 3 before being used for any correction.
"""

from __future__ import annotations

import datetime
import os

import openpyxl
import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
XLSX_PATH = os.path.join(BASE_DIR, "WEEKLY-PREVAILING-RETAIL-PRICE-RICE-2020-2025.xlsx")

# sheet row-label -> canonical key, split by IMPORTED/LOCAL section
ROW_KEYS_IMPORTED = {
    "special": "impSpecial",
    "premium": "impPremium",
    "well milled": "impWellMilled",
    "regular milled": "impRegular",
}
ROW_KEYS_LOCAL = {
    "special": "locSpecial",
    "premium": "locPremium",
    "well milled": "locWellMilled",
    "regular milled": "locRegular",
}

MONTH_NAMES = {
    "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY",
    "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
}


def _parse_sheet(ws, year: int) -> list[dict]:
    rows = list(ws.iter_rows(values_only=True))

    header_idx = next(i for i, r in enumerate(rows) if r and r[0] == "COMMODITY")
    month_row = rows[header_idx]
    week_row = rows[header_idx + 1]
    ncols = max(len(month_row), len(week_row))

    # col_index -> month name, forward-filling across the merged-cell span
    col_month: dict[int, str] = {}
    current_month = None
    for c in range(ncols):
        cell = month_row[c] if c < len(month_row) else None
        if isinstance(cell, str) and cell.strip().upper() in MONTH_NAMES:
            current_month = cell.strip().upper()
        if current_month is not None and c >= 3:  # skip COMMODITY/SPECIFICATION/UNIT cols
            col_month[c] = current_month

    # month -> ordered list of (col_index, week_number) actually present in week_row
    month_week_cols: dict[str, list[tuple[int, int]]] = {}
    for c, month in col_month.items():
        cell = week_row[c] if c < len(week_row) else None
        if isinstance(cell, str) and cell.strip().upper().startswith("WK"):
            wk_num = int("".join(ch for ch in cell if ch.isdigit()))
            month_week_cols.setdefault(month, []).append((c, wk_num))

    month_order = [m for m in (
        "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY",
        "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
    ) if m in month_week_cols]

    # continuous global week index (0-based) for every (month, week_number) column, using each
    # month's own week count from the sheet — NOT assumed to be a fixed 4 or 5.
    col_week_index: dict[int, int] = {}
    running = 0
    for month in month_order:
        cols = sorted(month_week_cols[month], key=lambda t: t[1])
        for c, wk_num in cols:
            col_week_index[c] = running + (wk_num - 1)
        running += len(cols)

    jan1 = datetime.date(year, 1, 1)
    first_monday = jan1 + datetime.timedelta(days=(7 - jan1.weekday()) % 7)

    # locate section boundaries
    section_starts = {}
    for i, r in enumerate(rows):
        if not r or not isinstance(r[0], str):
            continue
        label = r[0].strip().upper()
        if label == "IMPORTED COMMERCIAL RICE":
            section_starts["imported"] = i
        elif label == "LOCAL COMMERCIAL RICE":
            section_starts["local"] = i

    out = []

    def _emit(section_start: int, key_map: dict[str, str]):
        # the 4 commodity rows immediately follow the section header, in a fixed order
        for offset in range(1, 5):
            r = rows[section_start + offset]
            row_label = (r[0] or "").strip().lower()
            key = key_map.get(row_label)
            if key is None:
                continue
            for c, week_idx in col_week_index.items():
                if c >= len(r):
                    continue
                val = r[c]
                if val is None or (isinstance(val, str) and val.strip() in ("-", "")):
                    continue
                try:
                    val = round(float(val), 2)
                except (TypeError, ValueError):
                    continue
                week_start = first_monday + datetime.timedelta(weeks=week_idx)
                week_end = week_start + datetime.timedelta(days=4)
                out.append({
                    "key": key, "week_start": week_start.isoformat(),
                    "week_end": week_end.isoformat(), "value": val,
                })

    if "imported" in section_starts:
        _emit(section_starts["imported"], ROW_KEYS_IMPORTED)
    if "local" in section_starts:
        _emit(section_starts["local"], ROW_KEYS_LOCAL)

    return out


def parse_all(xlsx_path: str = XLSX_PATH, years: list[int] | None = None,
              validate: bool = True) -> pd.DataFrame:
    """Return tidy long-format frame: key, week_start, week_end, value.

    Each sheet's own header ("Wk 1".."Wk N" per month) is trusted for how many weeks that
    month has, but the total across all 12 months of a sheet is then checked against the real
    number of Monday-starting weeks that fit in that calendar year (52, or 53 in years where an
    extra week is genuinely needed) — continuous week-counting only makes sense if that total is
    right. The 2020 sheet fails this check (54 week-columns for a 52-week year: some month's
    header has 1-2 extra "Wk" columns we have no reliable way to identify), which was only
    caught because it silently made the last two "weeks" of 2020 collide date range-for-date
    range with the real first two weeks of 2021. Rather than guess which column is spurious,
    `validate=True` (the default) drops any year whose sheet fails this check instead of
    emitting data we can't vouch for — the same call made earlier for OCR-unreliable PDFs.
    """
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    years = years or [2020, 2021, 2022, 2023, 2024, 2025]
    records = []
    skipped = []
    for year in years:
        sheet_name = str(year)
        if sheet_name not in wb.sheetnames:
            continue
        sheet_records = _parse_sheet(wb[sheet_name], year)
        if validate:
            n_weeks = len({r["week_start"] for r in sheet_records if r["week_start"] <= f"{year}-12-31"})
            # a real Gregorian year needs 52 Monday-starting weeks, occasionally 53 — never 54+
            max_start = max((r["week_start"] for r in sheet_records), default="")
            overflow = max_start > f"{year}-12-31"
            if n_weeks > 53 or overflow:
                skipped.append((year, n_weeks, max_start))
                continue
        records.extend(sheet_records)
    if skipped and validate:
        for year, n_weeks, max_start in skipped:
            print(f"[parse_da_amas_weekly] skipping {year} sheet: week count/alignment failed "
                  f"validation ({n_weeks} in-year weeks, last week_start {max_start} overflows "
                  f"past {year}-12-31) — cannot verify which header column is spurious")
    df = pd.DataFrame.from_records(records)
    df["week_start"] = pd.to_datetime(df["week_start"])
    df["week_end"] = pd.to_datetime(df["week_end"])
    return df.sort_values(["key", "week_start"]).reset_index(drop=True)


if __name__ == "__main__":
    df = parse_all()
    print(f"parsed {len(df)} (key, week) rows, {df['week_start'].min().date()} to {df['week_start'].max().date()}")
    print(df["key"].value_counts())
