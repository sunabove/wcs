from fastapi import APIRouter, Body, Query
from fastapi import HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from pathlib import Path
from config import *

router = APIRouter( prefix="/fast" )


def _list_opencv_camera_devices(max_devices: int = 10):
    from camera.CameraDevList import CameraDevList

    camera_dev_list = CameraDevList(max_devices=max_devices)
    items = camera_dev_list.list_camera_devices()

    # Keep response schema compatible with existing frontend.
    return [
        {
            "index": item.index,
            "name": item.name,
            "width": item.width,
            "height": item.height,
            "fps": item.fps,
        }
        for item in items
    ]

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


@router.get("/camera/devices")
async def camera_devices_service(
    max_devices: int = Query(10, ge=1, le=32)
):
    devices = _list_opencv_camera_devices(max_devices=max_devices)
    return {
        "devices": devices,
        "count": len(devices),
    }
pass # camera_devices_service

@router.get("/road_detect/{file_name:path}")
async def road_detect_service(
    file_name: str,
    detect_type: str = Query("road")
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.road_detect_service(file_name, detect_type)
pass # road_detect_service

@router.get("/road_roi/{file_name:path}")
async def road_roi_get_service(file_name: str):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.get_roi_info(file_name)
pass # road_roi_get_service

@router.post("/road_roi/{file_name:path}")
async def road_roi_save_service(
    file_name: str,
    payload: dict = Body(...)
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.save_roi_info(file_name, payload)
pass # road_roi_save_service

@router.get("/road_detect_stream/{file_name:path}")
async def road_detect_stream_service(
    file_name: str,
    detect_type: str = Query("road")
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.road_detect_stream(file_name, detect_type)
pass # road_detect_stream_service

@router.post("/road_detect_stream_init/{file_name:path}")
async def road_detect_stream_init_service(
    file_name: str,
    detect_type: str = Query("road")
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.road_detect_stream_init(file_name, detect_type)
pass # road_detect_stream_init_service

@router.get("/road_detect_stream_next/{file_name:path}")
async def road_detect_stream_next_service(
    file_name: str
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.road_detect_stream_next(file_name)
pass # road_detect_stream_next_service

@router.post("/road_detect_stream_seek/{file_name:path}")
async def road_detect_stream_seek_service(
    file_name: str,
    frame_number: int = Query(...)
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.road_detect_stream_seek(file_name, frame_number)
pass # road_detect_stream_seek_service

@router.post("/road_detect_stream_cleanup/{file_name:path}")
async def road_detect_stream_cleanup_service(
    file_name: str
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.road_detect_stream_cleanup(file_name)
pass # road_detect_stream_cleanup_service

