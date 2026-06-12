from fastapi import APIRouter
from fastapi import HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from pathlib import Path


router = APIRouter( prefix="/fast" )
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "upload"

@router.get("/road")
async def ai_road_service():
    return "hello ai road"
pass

@router.post("/upload_image")
def image_upload_service(file: UploadFile = File(...)):
    import shutil
    import uuid

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
pass

@router.get("/image")
def image_service(file_name: str):
    safe_name = Path(file_name).name
    if safe_name != file_name:
        raise HTTPException(status_code=400, detail="Invalid file_name")

    image_path = UPLOAD_DIR / safe_name

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