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
pass # _list_opencv_camera_devices

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
async def image_service_query(
    file_name: str,
    download: bool = Query(False),
    download_name: str = Query(""),
):
    from send_image import send_image_contents

    return send_image_contents(file_name, download=download, download_name=download_name)
pass # image_service_query

@router.get("/image/{file_name:path}")
async def image_service_path(
    file_name: str,
    download: bool = Query(False),
    download_name: str = Query(""),
):
    from send_image import send_image_contents

    return send_image_contents(file_name, download=download, download_name=download_name)
pass # image_service_path


@router.get("/video_thumbnail/{file_name:path}")
async def video_thumbnail_service(file_name: str):
    from send_image import send_video_thumbnail_contents

    return send_video_thumbnail_contents(file_name)
pass # video_thumbnail_service


@router.get("/video_playable/{file_name:path}")
async def video_playable_service(
    file_name: str,
    force_transcode: bool = Query(False),
):
    from send_image import get_browser_playable_video_url

    return get_browser_playable_video_url(file_name, force_transcode=force_transcode)
pass # video_playable_service


@router.get("/samples/{folder_name:path}")
async def sample_data_file_name_list_service(folder_name: str):
    from sample_data_file_name_list import sample_data_file_name_list

    return sample_data_file_name_list(folder_name)
pass # sample_data_file_name_list_service


@router.get("/sample_folders/{folder_name:path}")
async def sample_data_folder_name_list_service(folder_name: str):
    from sample_data_file_name_list import sample_data_folder_name_list

    return sample_data_folder_name_list(folder_name)
pass # sample_data_folder_name_list_service


@router.get("/sample_browser/{folder_name:path}")
async def sample_data_browser_service(folder_name: str):
    from sample_data_file_name_list import sample_data_browser_list

    return sample_data_browser_list(folder_name)
pass # sample_data_browser_service


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


@router.post("/camera_detect_stream_init")
async def camera_detect_stream_init_service(
    camera_index: int = Query(..., ge=0, le=64),
    detect_type: str = Query("road"),
    camera_name: str = Query(""),
    remove_noisy_masks: bool = Query(True),
    show_detect_stats: bool = Query(True),
    include_pothole: bool = Query(False),
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.camera_detect_stream_init(
        camera_index=camera_index,
        detect_type=detect_type,
        camera_name=camera_name,
        remove_noisy_masks=remove_noisy_masks,
        show_detect_stats=show_detect_stats,
        include_pothole=include_pothole,
    )
pass # camera_detect_stream_init_service


@router.get("/camera_detect_stream_next/{session_id}")
async def camera_detect_stream_next_service(
    session_id: str
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.camera_detect_stream_next(session_id=session_id)
pass # camera_detect_stream_next_service


@router.post("/camera_detect_stream_mode/{session_id}")
async def camera_detect_stream_mode_service(
    session_id: str,
    detect_enabled: bool = Query(True)
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.camera_detect_stream_set_mode(session_id=session_id, detect_enabled=detect_enabled)
pass # camera_detect_stream_mode_service


@router.get("/camera_roi/{session_id}")
async def camera_roi_get_service(session_id: str):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.camera_get_roi_info(session_id=session_id)
pass # camera_roi_get_service


@router.post("/camera_roi/{session_id}")
async def camera_roi_save_service(
    session_id: str,
    payload: dict = Body(...)
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.camera_save_roi_info(session_id=session_id, payload=payload)
pass # camera_roi_save_service


@router.post("/camera_detect_stream_cleanup/{session_id}")
async def camera_detect_stream_cleanup_service(
    session_id: str
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.camera_detect_stream_cleanup(session_id=session_id)
pass # camera_detect_stream_cleanup_service


@router.post("/camera_detect_stream_cleanup_all")
async def camera_detect_stream_cleanup_all_service():
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.camera_detect_stream_cleanup_all()
pass # camera_detect_stream_cleanup_all_service

@router.get("/road_detect/{file_name:path}")
def road_detect_service(
    file_name: str,
    detect_type: str = Query("road"),
    remove_noisy_masks: bool = Query(True),
    show_detect_stats: bool = Query(True),
    include_pothole: bool = Query(False),
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.road_detect_service(file_name, detect_type, remove_noisy_masks, show_detect_stats, include_pothole)
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
    detect_type: str = Query("road"),
    remove_noisy_masks: bool = Query(True),
    show_detect_stats: bool = Query(True),
    include_pothole: bool = Query(False),
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.road_detect_stream(file_name, detect_type, remove_noisy_masks, show_detect_stats, include_pothole)
pass # road_detect_stream_service

@router.post("/road_detect_stream_init/{file_name:path}")
async def road_detect_stream_init_service(
    file_name: str,
    detect_type: str = Query("road"),
    remove_noisy_masks: bool = Query(True),
    show_detect_stats: bool = Query(True),
    include_pothole: bool = Query(False),
):
    from RoadDetector import RoadDetector

    detector = RoadDetector()

    return detector.road_detect_stream_init(file_name, detect_type, remove_noisy_masks, show_detect_stats, include_pothole)
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

@router.get("/road_detect_progress/{file_name:path}")
async def road_detect_progress_service(file_name: str):
    """비디오 감지 진행 상황 조회"""
    from RoadDetector import RoadDetector

    requested_key = str(file_name or "")
    normalized_key = requested_key.replace("\\", "/").lstrip("/")
    key_candidates = [requested_key, normalized_key]

    with RoadDetector._detect_lock:
        progress = None
        for key in key_candidates:
            if key in RoadDetector._detect_progress:
                progress = RoadDetector._detect_progress.get(key, {}).copy()
                break

    if progress is None:
        return {
            'status': 'not_started',
            'current_frame': 0,
            'total_frames': 0,
            'percentage': 0,
            'error': None,
            'stage': 'idle'
        }
    
    return progress
pass # road_detect_progress_service

