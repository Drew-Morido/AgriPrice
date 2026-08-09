import pandas as pd
import sqlite3
import os

# Set exact folder paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'agriprice_database.db')

# Pang-anim at Huling Excel file: PAGASA Weather Data
EXCEL_FILE = os.path.join(BASE_DIR, 'ML_Dataset_Weather_PAGASA_2015_2025.xlsx')

print("Starting import for PAGASA Weather Data...")

# I-check kung nandiyan ang file
if not os.path.exists(EXCEL_FILE):
    print(f"[!] Error: Hindi mahanap yung file sa {EXCEL_FILE}")
else:
    print("Reading the Weather Data Excel file (konting wait lang dahil madami ito)...")
    df = pd.read_excel(EXCEL_FILE)
    
    # Kumonekta sa existing na database
    conn = sqlite3.connect(DB_PATH)
    
    # I-save yung data sa database bilang bagong table na 'weather_data'
    table_name = "weather_data"
    df.to_sql(table_name, conn, if_exists='replace', index=False)
    
    # Expected output: 3987 rows (dahil yung 1 ay para sa header)
    print(f"Success! {len(df)} rows inserted into the '{table_name}' table.")
    
    conn.close()
    print("PAGASA Weather data import complete! KUMPLETO NA ANG DATABASE NATIN!")