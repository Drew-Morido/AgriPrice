# datasets/ — AgriPricePH data

Every price, rate and index in AgriPricePH, from January 2015 to the latest day, and where each one came from.

```
datasets/
├── agriprice_database.db      the live database (the app, the model and the scraper read and write this file)
├── 1_factor_csv/              one final CSV per factor, 2015 → latest day
├── 2_backup_database/
│   ├── by_factor/             one SQLite copy per factor
│   └── full_snapshots/        a copy of the whole database taken before each data change
├── 3_source_files/            everything downloaded or received from DA, PSA, DOE, the World Bank, …
└── scripts/                   the scripts that import, rebuild and export the data
```

`1_factor_csv/` and `2_backup_database/by_factor/` are rewritten from the database after every successful scrape
(`api/app.py::_export_factor_files`) and at the end of `scripts/script.py`. To rewrite them by hand:
`cd datasets/scripts && py -3.13 export_factors.py`. Edit the database, never these copies: the next export
overwrites them.

## 1_factor_csv — the final data

| File | Factor | Frequency | Source |
|---|---|---|---|
| `rice_retail_prices_daily.csv` | Retail price of the 8 rice types, ₱/kg (the forecast targets) | daily | Jan 2015 – Sep 2018: PSA OpenSTAT, NCR monthly retail (one figure per month); Oct 2018 – 2022: DA daily bulletins; 2023 – Feb 2025: DA weekly prevailing prices; Mar 2025 on: DA Daily Price Index. The `source` column names the publication for every day. |
| `fuel_ncr_weekly.csv` | Diesel and RON 95, ₱/L, NCR (diesel is a model input; RON 95 is kept for reference) | weekly | 2015 – Nov 2024: the 2015–2025 fuel dataset; Dec 2024 on: DOE weekly NCR pump-price bulletin (GasWatch PH fills a week DOE leaves blank, `Filled` = 1) |
| `usd_php_daily.csv` | US dollar to peso rate (+ THB, VND from 2026) | daily | 2015–2025: the USD/PHP dataset; 2026: open.er-api.com and its dated archive |
| `psa_rice_stocks_monthly.csv` | National rice stocks, metric tons (household, commercial, NFA, total) | monthly | PSA OpenSTAT |
| `psa_farmgate_palay_monthly.csv` | Palay farmgate price, ₱/kg (other variety, fancy) | monthly | PSA OpenSTAT |
| `psa_core_inflation_monthly.csv` | Core CPI (2018=100) and core inflation, % year on year | monthly | PSA OpenSTAT |
| `worldbank_rice_monthly.csv` | Rice export price, US$/t: Viet Nam 5% (model input), Thai 5% (reference) | monthly | World Bank Pink Sheet |

Monthly figures are dated on the first day of the month they describe. The model uses each one only from the 15th of
the following month, when it has actually been published (`model/data_pipeline.py::MONTHLY_RELEASE_LAG`).

## 2_backup_database

- `by_factor/<factor>.db`: one SQLite file per factor. The `final` table has the same rows as the CSV; the other
  tables are the raw database tables it was built from.
- `full_snapshots/agriprice_database.db.backup-<reason>-<date>`: the whole database as it was just before an import
  or correction script changed it. To restore one, stop the backend and copy it over `agriprice_database.db`.

## 3_source_files — what was downloaded or received

| Folder | Contents |
|---|---|
| `DA-AMAS/daily_bulletins_pdf/` | The DA daily price bulletins listed on da.gov.ph/price-monitoring, Feb 2018 – 2025, by year (`scripts/fetch_da_bulletins.py`). `manifest.csv` records each file's URL, size, SHA-256 and whether it was downloaded or copied from a local folder. |
| `DA-AMAS/daily_price_index_pdf/` | DA Daily Price Index bulletins, 2025–2026 (`scripts/repair_ws_rice_from_bulletins.py`) |
| `DA-AMAS/scraper_downloads/` | Every DA bulletin the live scraper has read (`tools/scrap.py`) |
| `DA-AMAS/weekly_prevailing/` | DA-AMAS weekly prevailing retail prices, NCR wet markets, 2020–2025 |
| `DA-AMAS/parsed/` | What was read from the DA files: `da_daily_bulletins.csv` (+ `_review.csv`, the pages refused), the weekly and Bantay Presyo corrections, the Daily Price Index values DA confirmed by email (`da_dpi_verified_2026.csv`; never altered), the 2023–2025 bulletin values |
| `PSA/openstat_downloads/` | The CSVs downloaded from PSA OpenSTAT by hand: retail (old and new series), wholesale, farmgate |
| `PSA/api_exports/` | PSA tables read through the OpenSTAT API (`psa_retail_ncr_monthly.csv`, the NCR retail old series behind the 2015 – Sep 2018 rice prices) |
| `World_Bank/` | The latest Pink Sheet workbook (`CMO-Historical-Data-Monthly.xlsx`), saved on each refresh |
| `DOE/` | `doe_ncr_fuel_weekly.csv` (every DOE week read) and `weekly_pdf/`, the DOE bulletins |
| `Exchange_Rate/` | The USD/PHP dataset (2015–2025) and the 2026 daily file |
| `legacy_inputs/` | The original compiled workbooks. `DATASETS_RETAIL_PRICE_2015_2025.xlsx` matched no PSA or DA table and no longer supplies any value; the weather file is not a model input. Kept so `scripts/script.py` can rebuild the database from scratch. |
| `brand_survey/` | The rice brand survey workbook behind the Rice Catalog |
| `app_exports_2026-05/` | CSVs exported from the admin Price History page in May 2026 |

The PDFs (≈2 GB) are not committed to git; they can be downloaded again with the scripts above.

## scripts

Run from `datasets/scripts/`. Every location comes from `scripts/paths.py`.

| Script | What it does |
|---|---|
| `script.py` | Rebuilds the database from scratch (legacy workbooks → verified rice history → factor export) |
| `import_2026.py` | Merges the 2026 daily files (also runs on every backend start) |
| `import_psa.py`, `import_macro_factors.py`, `import_doe_fuel.py` | Reload PSA stocks/farmgate, core inflation + world rice, DOE fuel (each backs up the database first) |
| `fetch_da_bulletins.py`, `parse_da_daily_bulletins.py`, `rebuild_verified_rice_history.py` | Download the DA bulletin archive, read it, rebuild the 2015–2025 rice prices from PSA and DA |
| `export_factors.py` | Writes `1_factor_csv/` and `2_backup_database/by_factor/` |
| `backfill_missing_days.py` | Fills DA bulletin / exchange-rate days the scraper missed |
| `open_db.bat`, `view_in_browser.bat` | Open the database in the sqlite3 terminal / a simple browser viewer |
