import pandas as pd
import sqlite3
import os

# Get the exact directory where this script is located (the 'datasets' folder)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

datasets = {
    "farmgate_prices": "DATASET_FARMGATE_YEAR_2015_2025.xlsx",
    "fuel_history": "DATASETS_FUEL_HISTORY_PRICE_2015_2025.xlsx",
    "retail_prices": "DATASETS_RETAIL_PRICE_2015_2025.xlsx",
    "rice_stock": "DATESET_RICE_STOCK_INVENTORY_2015_2025.xlsx",
    "usd_php": "ML_Dataset_USD_PHP_2015_2025.xlsx",
    "weather": "ML_Dataset_Weather_PAGASA_2015_2025.xlsx"
}

# Create the DB in the exact same folder
db_path = os.path.join(BASE_DIR, "agriprice_database.db")
conn = sqlite3.connect(db_path)

print(f"Creating database at: {db_path}")

for table_name, file_name in datasets.items():
    # Build the full, absolute path to the Excel file
    file_path = os.path.join(BASE_DIR, file_name)
    
    if os.path.exists(file_path):
        print(f"Reading {file_name}...")
        df = pd.read_excel(file_path)
        df.to_sql(table_name, conn, if_exists='replace', index=False)
        print(f" => Successfully inserted into table: {table_name}")
    else:
        print(f" [!] Error: File '{file_path}' not found.")

conn.close()
print("Database creation complete!")

# Auto-merge 2026 daily files kung nandiyan
try:
    from import_2026 import import_all
    print("Merging 2026 daily XLSX...")
    import_all(verbose=True)
except Exception as e:
    print(f"2026 import skipped: {e}")

# Apply verified DA bulletin prices (2023-12-25 to 2025-12-31, partial — see the script's
# docstring for exactly what's covered and why) on top of the raw historical import above.
try:
    from apply_da_corrections import apply_corrections
    print("Applying verified DA bulletin corrections...")
    apply_corrections(verbose=True)
except Exception as e:
    print(f"DA corrections skipped: {e}")

# Apply the DA-AMAS weekly-file corrections (2021-01-04 to 2023-12-24 — the window the
# per-bulletin correction above deliberately left untouched; see the script's docstring).
try:
    from apply_da_amas_weekly_corrections import apply_corrections as apply_amas_corrections
    print("Applying DA-AMAS weekly-file corrections (2021-2023)...")
    apply_amas_corrections(verbose=True, backup=False)
except Exception as e:
    print(f"DA-AMAS weekly corrections skipped: {e}")

# Apply the DA Bantay Presyo/Price Watch/Price Monitoring bulletin PDF corrections (110
# individual days, 2019-10-01 to 2021-10-22 — extends coverage into the previously-untouched
# pre-2021 window; runs after the weekly-file correction above so these higher-resolution daily
# bulletins take precedence on the 2021 dates the two windows share — see the script's docstring).
try:
    from apply_da_bantay_presyo_corrections import apply_corrections as apply_bantay_presyo_corrections
    print("Applying DA Bantay Presyo bulletin PDF corrections (2019-2021)...")
    apply_bantay_presyo_corrections(verbose=True, backup=False)
except Exception as e:
    print(f"DA Bantay Presyo corrections skipped: {e}")