"""
AgriPricePH — international rice export prices from the World Bank Commodity Price Data ("Pink Sheet").

    Rice, Viet Namese 5%   USD per metric ton, monthly, 1960 onward   -> the model input (most Philippine rice
                                                                         imports come from Viet Nam)
    Rice, Thai 5%          USD per metric ton, monthly                  -> stored for comparison only

The monthly workbook lives at a URL that changes with every release, so it is located from the World Bank's
commodity-markets page on each run. The World Bank publishes month M on about the 2nd business day of M+1.
Prices stay in US dollars on purpose: converting to pesos would mix in the USD/PHP rate, which is already a
separate model input.
"""

from __future__ import annotations

import io
import os
import re

import pandas as pd
import requests

PAGE = "https://www.worldbank.org/en/research/commodity-markets"
SOURCE = "worldbank_pink_sheet"
_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/126.0 Safari/537.36"}
SERIES = {"viet5": "Rice, Viet Namese 5%", "thai5": "Rice, Thai 5%"}
BAND_USD_T = (100.0, 3000.0)
# The downloaded workbook is kept with the other source files (datasets/README.md).
SAVE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "datasets", "3_source_files",
                        "World_Bank")


def monthly_workbook_url(timeout: int = 60) -> str:
    html = requests.get(PAGE, headers=_HEADERS, timeout=timeout).text
    links = re.findall(r'href="([^"]+CMO-Historical-Data-Monthly\.xlsx)"', html)
    if not links:
        raise RuntimeError("World Bank monthly workbook link not found on the commodity-markets page")
    return links[0]


def parse_monthly(xlsx: bytes, from_year: int = 2015) -> pd.DataFrame:
    """Date (month start), viet5, thai5 from the workbook's "Monthly Prices" sheet."""
    raw = pd.read_excel(io.BytesIO(xlsx), sheet_name="Monthly Prices", header=None)
    head = next(i for i in range(12) if any(str(x).strip() == SERIES["viet5"] for x in raw.iloc[i].tolist()))
    names = [str(x).strip() for x in raw.iloc[head].tolist()]
    cols = {key: names.index(label) for key, label in SERIES.items()}
    body = raw.iloc[head + 1:]
    body = body[body.iloc[:, 0].astype(str).str.match(r"^\d{4}M\d{2}$")]
    out = pd.DataFrame({"Date": pd.to_datetime(body.iloc[:, 0].str.replace("M", "-") + "-01")})
    for key, i in cols.items():
        out[key] = pd.to_numeric(body.iloc[:, i].values, errors="coerce")
    out = out[out["Date"] >= pd.Timestamp(from_year, 1, 1)].dropna(subset=["viet5"])
    return out.reset_index(drop=True)


def fetch_rice_prices(from_year: int = 2015, timeout: int = 120) -> pd.DataFrame:
    url = monthly_workbook_url()
    data = requests.get(url, headers=_HEADERS, timeout=timeout).content
    out = parse_monthly(data, from_year)
    try:
        os.makedirs(SAVE_DIR, exist_ok=True)
        with open(os.path.join(SAVE_DIR, "CMO-Historical-Data-Monthly.xlsx"), "wb") as f:
            f.write(data)
    except OSError:
        pass
    return out
