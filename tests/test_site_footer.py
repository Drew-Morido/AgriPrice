"""
B7 / B8 (DA-AMAS feedback): one footer on every public page with the sources and "last updated", and the
front page shows the DA bulletin day each rice price was taken from.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))

SHELL_PAGES = ["landpage", "current-prices", "rice-catalog", "historical", "statistics", "profile", "settings"]


def _read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
        return fh.read()


def test_every_public_page_uses_the_shared_footer():
    for name in SHELL_PAGES:
        html = _read("public", f"{name}.html")
        assert "css/site-footer.css" in html, name
        assert "js/public-shell.js" in html, name
        # The footer comes from public-shell.js only; a static copy would drift from it.
        assert not re.search(r"<footer[^>]*class=\"site-footer\"", html), name
    shell = _read("public", "js", "public-shell.js")
    assert "agripriceph@gmail.com" in shell
    for logo in ("da.png", "doe.png", "psa.png", "worldbank.png"):
        assert logo in shell
        assert os.path.exists(os.path.join(ROOT, "public", "assets", "img", "sources", logo)), logo


def test_old_contact_address_is_gone():
    for name in SHELL_PAGES:
        assert "hello@agripriceph.ph" not in _read("public", f"{name}.html"), name


def test_price_dates_never_after_last_ready_day():
    import data_pipeline as DP
    DP.load_merged_frame()
    r = DP.LAST_READINESS
    dates = r.get("price_dates") or {}
    assert dates, "no per-type price dates"
    for col, day in dates.items():
        assert col in DP.RICE_COLUMNS
        assert day <= r["ready_through"], (col, day)


def test_da_markets_read_from_the_bulletin():
    """B5: the covered-market list is read from a real Daily Price Index, never typed in."""
    import pytest
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import da_markets
    pdfs = da_markets._candidates()
    if not pdfs:
        pytest.skip("no DA bulletin PDF cached")
    got = None
    for path in pdfs[:6]:
        got = da_markets.extract(path)
        if got:
            break
    assert got, "no readable Daily Price Index"
    assert len(got["markets"]) >= 20
    assert all("\ufffd" not in m for m in got["markets"])
    assert any("Market" in m for m in got["markets"])


def test_brand_base_price_never_uses_the_estimated_row():
    """B8: the scraper's temporary estimate (DA has not published that day) is not a brand's base price."""
    import sqlite3
    sys.path.insert(0, os.path.join(ROOT, "api"))
    import catalog_service as C
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute('CREATE TABLE "WS_rice_price" (Date TEXT, "Local Well Milled" REAL, Source TEXT)')
    conn.executemany('INSERT INTO "WS_rice_price" VALUES (?,?,?)', [
        ("12/30/2026", 49.10, "da_official"),
        ("01/02/2027", 49.50, "da_official"),
        ("01/03/2027", 52.00, "estimated"),
    ])
    price, src = C._latest_base_price(conn, "locWellMilled")
    assert price == 49.50 and src == "latest DA price"
    assert C._latest_base_date(conn, "locWellMilled") == "2027-01-02"


def test_pns_section_separates_milling_from_grade():
    html = _read("public", "landpage.html")
    assert 'id="pns-grades"' in html and "PNS-BAFS-290-2025" in html
    for grade, brokens in (("Premium", "5%"), ("Grade 1", "10%"), ("Grade 5", "45%")):
        assert f"<th scope=\"row\">{grade}</th><td>{brokens}</td>" in html
    assert 'max="3"' in html and "Undermilled" in html and "Overmilled" in html
