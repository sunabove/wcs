from fastapi import APIRouter, Query
from fastapi import HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from pathlib import Path
from config import *

router = APIRouter( prefix="/fast" )

@router.get("/road")
async def ai_road_service():
    return "hello ai road"
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
pass # image_test

@router.post("/upload_image")
async def image_upload_service(file: UploadFile = File(...)):
    from upload_image import save_uploaded_image

    return save_uploaded_image(file)
pass # image_upload_service

@router.get("/image")
async def image_service_query(file_name: str):
    from send_image import send_image_contents

    return send_image_contents(file_name)
pass # image_service_query

@router.get("/image/{file_name:path}")
async def image_service_path(file_name: str):
    from send_image import send_image_contents

    return send_image_contents(file_name)
pass # image_service_path


@router.get("/samples/{folder_name:path}")
async def sample_data_file_name_list_service(folder_name: str):
    from sample_data_file_name_list import sample_data_file_name_list

    return sample_data_file_name_list(folder_name)
pass # sample_data_file_name_list_service

@router.get("/road_detect/{file_name:path}")
async def road_detect_service(
    file_name: str,
    detect_type: str = Query("road")
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.road_detect_service(file_name, detect_type)
pass # road_detect_service

@router.get("/road_detect_stream/{file_name:path}")
async def road_detect_stream_service(
    file_name: str,
    detect_type: str = Query("road")
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.road_detect_stream(file_name, detect_type)
pass # road_detect_stream_service

