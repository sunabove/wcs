from fastapi import HTTPException, UploadFile

from pathlib import Path
import hashlib
import shutil

from config import * 

def save_uploaded_image(file: UploadFile) -> dict:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    file.file.seek(0)
    hasher = hashlib.sha256()
    while True:
        chunk = file.file.read(1024 * 1024)
        if not chunk:
            break
        hasher.update(chunk)
    file_hash = hasher.hexdigest()
    file.file.seek(0)

    suffix = Path(file.filename).suffix if file.filename else ""
    suffix = suffix.lower() if suffix else ".png"

    target_path = UPLOAD_DIR / f"{file_hash}{suffix}"

    if target_path.exists() and not target_path.is_file():
        if target_path.is_dir():
            shutil.rmtree(target_path)
        else:
            target_path.unlink()

    if not target_path.is_file():
        with target_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

    upload_folder_name = UPLOAD_DIR.name

    return {
        "filename": f"{upload_folder_name}/{target_path.name}"
    }
pass # save_uploaded_image 