# 2. Data

## The 7 sources (all collected automatically)
| Source | What | How often | Used for |
|---|---|---|---|
| **DA-AMAS** price bulletins | Retail price of the 8 rice types, NCR | Daily | The forecast targets |
| **DOE** | Diesel pump price, NCR (RON 95 kept for reference) | Weekly | Model input |
| Exchange rate API | USD to PHP | Daily | Model input |
| **PSA OpenSTAT** | National rice stocks, palay farmgate price | Monthly | Model inputs |
| **PSA OpenSTAT** | Core inflation (year-on-year %) | Monthly | Model input |
| **World Bank** Pink Sheet | Rice export price, Viet Nam 5% (US$/t) | Monthly | Model input |
| Tariff Commission | Rice import tariff | Quarterly | Imported-rice shelf prices (after admin approval) |

Core inflation is used, not headline inflation, because it leaves out food and energy, so it does not repeat the rice
price or the diesel price. Viet Nam 5% is used because Viet Nam is the main source of the country's imported rice.
Fertilizer was considered and left out (PSA data only to 2019, and it is a wholesale price).

## Rice price history, Jan 2015 → today (every day traced to its publication)
| Period | Source | Frequency |
|---|---|---|
| Jan 2015 – Sep 2018 | PSA OpenSTAT, NCR monthly retail price (old series) | One figure per month |
| Oct 2018 – 2022 | DA daily price bulletins (≈3,000 PDFs downloaded and read) | Daily |
| 2023 – Feb 2025 | DA-AMAS weekly prevailing prices (the daily bulletins then gave only a low–high range) | Weekly |
| Mar 2025 – today | DA Daily Price Index | Daily |

Expect a level shift on Oct 1, 2018 (PSA NCR average → DA prevailing price).

## How data is kept honest
- **Held for review:** a scraped rice price that equals the next grade's price or is far from its recent median is
  not used until an admin approves it.
- **Release-date rule:** a monthly figure is used by the model only from the 15th of the next month, when it has
  really been published (e.g. September core inflation is used from Oct 15).
- **No guessing:** if today's DA bulletin is not out, a temporary estimate may show on screen but is never used by the
  model; the forecast starts from the latest official bulletin.
- **Catch-up:** each scrape fills DA bulletins missed in the last 45 days and missing exchange-rate days.
- **Backups:** the database is copied before every change (`datasets/2_backup_database/full_snapshots`).
- **Files you can show:** `datasets/1_factor_csv/` (one final CSV per factor, 2015 → today, with a `source` column
  for rice), `datasets/3_source_files/` (the downloaded DA bulletin PDFs, PSA files, DOE PDFs, World Bank workbook).

## Keep the system running
The scraper only works while the backend is running. After a week off (Oct 14 → 26) it recovered all DA bulletins and
exchange rates automatically; longer gaps need `cd datasets/scripts && py -3.13 backfill_missing_days.py --since <date>`.
The forecast stops if the newest DOE fuel week is more than 14 days old.
