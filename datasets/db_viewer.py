import sqlite3
import pandas as pd
import os
from flask import Flask

app = Flask(__name__)

# Hanapin yung exact path ng database mo
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'agriprice_database.db')

@app.route('/')
def view_database():
    if not os.path.exists(DB_PATH):
        return f"<h1>Error: Hindi mahanap ang database sa {DB_PATH}</h1>"
    
    conn = sqlite3.connect(DB_PATH)
    
    # Kunin lahat ng pangalan ng tables sa database mo
    tables_query = "SELECT name FROM sqlite_master WHERE type='table';"
    tables = pd.read_sql_query(tables_query, conn)['name'].tolist()
    
    html_output = "<h1>AgriPricePH Database Viewer</h1>"
    html_output += "<p>Showing the first 100 rows of each table for performance.</p>"
    
    # Loop sa lahat ng tables at i-convert sa HTML
    for table in tables:
        html_output += f"<h2>Table: {table}</h2>"
        try:
            # Nilagyan natin ng LIMIT 100 para hindi mag-crash yung browser mo sa laki ng weather data
            df = pd.read_sql_query(f'SELECT * FROM "{table}" LIMIT 5000', conn)
            # Automatic na ginagawang HTML table ng pandas ang data
            html_output += df.to_html(index=False)
        except Exception as e:
            html_output += f"<p style='color:red;'>Error loading table: {e}</p>"
        
        html_output += "<hr>"
        
    conn.close()
    
    # Simpleng CSS para maging malinis at madaling basahin
    style = """
    <style>
        body { font-family: 'DM Sans', Arial, sans-serif; padding: 20px; background: #F4F6F3; color: #1C2B1E; }
        h1 { color: #1A3A2A; border-bottom: 2px solid #4CAF6E; padding-bottom: 10px; }
        h2 { color: #2D5A3E; margin-top: 30px; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 20px; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        th, td { border: 1px solid #E2EAE4; padding: 10px; text-align: left; font-size: 13px; }
        th { background-color: #4CAF6E; color: white; font-weight: bold; }
        tr:nth-child(even) { background-color: #FAFCFB; }
        tr:hover { background-color: #E2EAE4; }
    </style>
    """
    return style + html_output

if __name__ == '__main__':
    # Gumamit tayo ng port 5001 para hindi bumangga sa app.py (na nasa 5000)
    print("Starting Database Viewer...")
    print("Open this link in your browser: http://127.0.0.1:5001")
    app.run(debug=True, port=5001)