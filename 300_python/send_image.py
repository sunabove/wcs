from fastapi import HTTPException
from fastapi.responses import FileResponse

from pathlib import Path
from config import *

def resolve_upload_image_path(file_name: str) -> Path:
    if not file_name or not file_name.strip():
        raise HTTPException(status_code=400, detail="file_name is required")

    upload_root = UPLOAD_DIR.resolve()
    requested_path = Path(file_name)

    # Supports both plain filename and canonical absolute path.
    if requested_path.is_absolute():
        resolved_path = requested_path.resolve()
    else:
        resolved_path = (UPLOAD_DIR / requested_path).resolve()

    if resolved_path != upload_root and upload_root not in resolved_path.parents:
        raise HTTPException(status_code=400, detail="Invalid file_name path")

    return resolved_path
pass # resolve_upload_image_path

def send_image_contents(file_name: str):
    image_path = resolve_upload_image_path(file_name)

    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")

    suffix = image_path.suffix.lower()
    media_type = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp"
    }.get(suffix, "application/octet-stream")

    return FileResponse(
        str(image_path),
        media_type=media_type
    )
pass # send_image_contents
