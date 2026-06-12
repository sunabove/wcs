from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

import json
import sys
import time
from pathlib import Path
from pydantic import BaseModel 

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

app = FastAPI()

@app.middleware("http")
async def add_process_time_header(request, call_next):
    started_at = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - started_at) * 1000
    response.headers["X-Process-Time-Ms"] = f"{elapsed_ms:.2f}"
    return response

@app.get("/fast/hello")
async def hello():
    return "hello world"
pass # hello

from ai_road_detect import router as ai_road_router

app.include_router(ai_road_router)

