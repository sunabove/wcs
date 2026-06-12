from fastapi import HTTPException, UploadFile

from pathlib import Path
import shutil
import uuid

from config import * 

def save_uploaded_image(file: UploadFile) -> dict:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename).suffix if file.filename else ""
    saved_filename = f"{uuid.uuid4().hex}{suffix}"
    saved_path = UPLOAD_DIR / saved_filename

    with saved_path.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {
        "filename": saved_filename
    }
pass # save_uploaded_image 