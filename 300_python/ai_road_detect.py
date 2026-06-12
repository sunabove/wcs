from fastapi import APIRouter
from fastapi import HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from pathlib import Path
from config import *

router = APIRouter( prefix="/fast" )

@router.get("/road")
async def ai_road_service():
    return "hello ai road"
pass

@router.post("/upload_image")
async def image_upload_service(file: UploadFile = File(...)):
    from upload_image import save_uploaded_image

    return save_uploaded_image(file)
pass

@router.get("/image")
async def image_service_query(file_name: str):
    from send_image import send_image_contents

    return send_image_contents(file_name)
pass

@router.get("/image/{file_name:path}")
async def image_service_path(file_name: str):
    from send_image import send_image_contents

    return send_image_contents(file_name)
pass

@router.get("/image_test")
async def image_test():
    base_dir = Path(__file__).resolve().parent
    image_path = base_dir / "test/test_image.jpg"

    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(
        str(image_path),
        media_type="image/jpeg"
    )
pass 