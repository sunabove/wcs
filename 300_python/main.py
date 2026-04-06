# main.py
from fastapi import FastAPI
import sqlite3
import platform

app = FastAPI()

def getDbPath() -> str:
    # OS별 데이터베이스 경로 설정
    DB_PATH = "/home/www/data/wcs.db"

    if platform.system() == "Windows":
        DB_PATH = f"C:{DB_PATH}" 
    pass

    return DB_PATH
pass # getDbPath

def get_db_connection():
    conn = sqlite3.connect( getDbPath() )
    conn.row_factory = sqlite3.Row  # dict 형태로 반환
    return conn
pass # get_db_connection

@app.get("/items/{item_id}")
def read_item(item_id: int):
    return {
        "item_id": item_id,
        "name": "example item"
    }
pass # read_item
 
@app.get("/")
def read_wcs_data():
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT key, value, update_dt FROM wcs_data")
    rows = cursor.fetchall()

    conn.close()

    # Row → list (컬럼명 없이 값만 반환)
    result = [list(row) for row in rows]

    return result

pass # read_wcs_data

