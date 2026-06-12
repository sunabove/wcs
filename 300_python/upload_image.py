from fastapi import HTTPException, UploadFile

from pathlib import Path
import shutil
import time

from config import * 

def save_uploaded_image(file: UploadFile) -> dict:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename).suffix if file.filename else ""
    suffix = suffix.lower() if suffix else ".png"
    
    file_index = time.time_ns()
    saved_path = UPLOAD_DIR / f"{file_index}{suffix}"

    while saved_path.exists():
        file_index += 1
        saved_path = UPLOAD_DIR / f"{file_index}{suffix}"

    saved_filename = saved_path.name

    with saved_path.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {
        "filename": saved_filename
    }
pass # save_uploaded_image 