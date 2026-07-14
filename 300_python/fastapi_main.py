from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

import json
import sys
import time
from pathlib import Path
from pydantic import BaseModel 

# cd ~/wcs
# python3 -m uvicorn 300_python.fastapi_main:app --host 0.0.0.0 --port 8000 --reload

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

app = FastAPI()

@app.get("/fast/hello")
async def hello():
    return "hello world"
pass # hello

from RoadDetectService import router as roadDetectRouter
from YoloDetectService import router as yoloDetectRouter

app.include_router(roadDetectRouter)
app.include_router(yoloDetectRouter)

