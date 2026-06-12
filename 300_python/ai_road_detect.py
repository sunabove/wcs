from fastapi import APIRouter
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from pathlib import Path


router = APIRouter(  prefix="/wcs" )

@router.get("/ai_road")
def ai_road_service(url: str):
    return {
        "message": "hello ai road",
        "url": url
    }
pass

@router.post("/upload_image")
def image_upload_service(file):
    return {
        "message": "hello image upload",
        "filename": file.filename
    }
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