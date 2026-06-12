from fastapi import APIRouter
from fastapi import HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from pathlib import Path
import shutil
import uuid


router = APIRouter( prefix="/fast" )

@router.get("/road")
def ai_road_service(url: str):
    return {
        "message": "hello ai road",
        "url": url
    }
pass

@router.post("/upload_image")
def image_upload_service(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed")

    base_dir = Path(__file__).resolve().parent
    upload_dir = base_dir / "upload"
    upload_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename).suffix if file.filename else ""
    saved_filename = f"{uuid.uuid4().hex}{suffix}"
    saved_path = upload_dir / saved_filename

    with saved_path.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {
        "filename": saved_filename
    }
pass

@router.get("/image")
def image_service(file_name: str):
    safe_name = Path(file_name).name
    if safe_name != file_name:
        raise HTTPException(status_code=400, detail="Invalid file_name")

    base_dir = Path(__file__).resolve().parent
    image_path = base_dir / "upload" / safe_name

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
pass

@router.get("/image_test")
def image_test():
    base_dir = Path(__file__).resolve().parent
    image_path = base_dir / "test/test_image.jpg"

    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(
        str(image_path),
        media_type="image/jpeg"
    )
pass 