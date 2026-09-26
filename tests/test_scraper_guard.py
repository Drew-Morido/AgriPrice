"""
Regression tests for the DA bulletin reader and the scraper's sanity guard.

Panel/data finding (PAPER_CORRECTIONS.md): on Sep 19, 20 and 22 2026 the scraper saved three imported
grades one column off, because the PDF reader mapped "the last four prices in the section" to
Special -> Regular and DA printed "n/a" for Imported Regular. These tests pin the fix: prices are
paired with their grade by position on the page, "n/a" stays empty, and a suspicious scraped price
is held for review instead of being saved.

Fixtures are real DA Daily Price Index bulletins (tests/fixtures/).

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sys

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
FIX = os.path.join(ROOT, "tests", "fixtures")

from pdfconvrt import extract_rice_prices_from_pdf_file  # noqa: E402
import scrape_guard  # noqa: E402

pytest.importorskip("pdfplumber")


# ── PDF reader ────────────────────────────────────────────────────────────────
def test_na_bulletin_does_not_shift_grades():
    """Sep 20 2026: price column printed above each label, Imported Regular = n/a."""
    r = extract_rice_prices_from_pdf_file(os.path.join(FIX, "dpi_2026-09-20_na_price_above.pdf"))
    assert r["Imported Special"] == 60.24      # old reader: 60.63 (the Japonica price)
    assert r["Imported Premium"] == 54.07      # old reader: 60.24 (the Special price)
    assert r["Imported Well Milled"] == 47.76  # old reader: 54.07 (the Premium price)
    assert r["Imported Regular Milled"] is None  # DA printed n/a — must stay empty, not borrow a price
    assert (r["Local Special"], r["Local Premium"], r["Local Well Milled"], r["Local Regular Milled"]) == (59.72, 53.70, 48.40, 44.77)


def test_inline_bulletin_reads_all_eight():
    """Sep 17 2026: prices inline with their labels."""
    r = extract_rice_prices_from_pdf_file(os.path.join(FIX, "dpi_2026-09-17_inline.pdf"))
    assert [r[k] for k in ["Imported Special", "Imported Premium", "Imported Well Milled", "Imported Regular Milled"]] == [59.88, 53.46, 48.04, 45.25]
    assert [r[k] for k in ["Local Special", "Local Premium", "Local Well Milled", "Local Regular Milled"]] == [60.12, 54.05, 48.86, 44.57]


def test_specialty_rows_never_leak_into_core_grades():
    """Basmati (~195) and Glutinous/Japonica rows must not be taken by a core grade."""
    r = extract_rice_prices_from_pdf_file(os.path.join(FIX, "dpi_2026-06-30.pdf"))
    assert r["Imported Special"] == 59.59 and r["Local Regular Milled"] == 44.71
    assert all(v is None or 30 <= v <= 80 for v in r.values())


# ── sanity guard ──────────────────────────────────────────────────────────────
def _history(days=8, **cols):
    dates = pd.date_range("2026-09-10", periods=days, freq="D")
    df = pd.DataFrame({"_date": dates})
    for col, val in cols.items():
        df[col] = val
    return df


HIST = _history(**{
    "Imported Special": 59.9, "Imported Premium": 53.7, "Imported Well Milled": 48.2,
    "Imported Regular Milled": 45.25, "Local Special": 60.1, "Local Premium": 54.0,
    "Local Well Milled": 48.8, "Local Regular Milled": 44.6,
})


@pytest.fixture(autouse=True)
def _tmp_queue(tmp_path, monkeypatch):
    monkeypatch.setattr(scrape_guard, "REVIEW_PATH", str(tmp_path / "review.json"))


def test_shifted_row_is_held():
    """The Sep 19 2026 row as the old reader saved it."""
    shifted = {"Imported Special": 60.33, "Imported Premium": 60.00, "Imported Well Milled": 54.05,
               "Imported Regular Milled": 48.03, "Local Special": 59.78, "Local Premium": 53.76,
               "Local Well Milled": 48.33, "Local Regular Milled": 44.76}
    cleaned, held = scrape_guard.check_rice_row("09/19/2026", shifted, HIST)
    held_cols = {h["column"] for h in held}
    assert {"Imported Premium", "Imported Well Milled", "Imported Regular Milled"} <= held_cols
    assert all(cleaned[c] is None for c in held_cols)
    assert cleaned["Local Premium"] == 53.76  # normal readings pass through untouched


def test_normal_row_passes():
    ok = {"Imported Special": 60.0, "Imported Premium": 54.05, "Imported Well Milled": 48.03,
          "Imported Regular Milled": None, "Local Special": 59.78, "Local Premium": 53.76,
          "Local Well Milled": 48.33, "Local Regular Milled": 44.76}
    cleaned, held = scrape_guard.check_rice_row("09/19/2026", ok, HIST)
    assert held == [] and cleaned == ok


def test_copied_neighbour_cell_is_held():
    """Jul 23 2026 pattern: Imported Premium equal to Imported Special."""
    row = {"Imported Special": 59.53, "Imported Premium": 59.53, "Imported Well Milled": 48.2,
           "Imported Regular Milled": 45.25, "Local Special": 60.1, "Local Premium": 54.0,
           "Local Well Milled": 48.8, "Local Regular Milled": 44.6}
    _, held = scrape_guard.check_rice_row("09/19/2026", row, HIST)
    assert any("same price as" in h["reason"] for h in held)


def test_approved_reading_is_not_held_again():
    row = {"Imported Special": 59.9, "Imported Premium": 60.00, "Imported Well Milled": 48.2,
           "Imported Regular Milled": 45.25, "Local Special": 60.1, "Local Premium": 54.0,
           "Local Well Milled": 48.8, "Local Regular Milled": 44.6}
    _, held = scrape_guard.check_rice_row("09/19/2026", row, HIST)
    assert scrape_guard.queue(held) == len(held) >= 1
    assert scrape_guard.queue(held) == 0                      # deduplicated
    entries = scrape_guard._load()
    for e in entries:
        e["status"] = "approved"
    scrape_guard._save(entries)
    _, held_again = scrape_guard.check_rice_row("09/19/2026", row, HIST)
    assert held_again == []
