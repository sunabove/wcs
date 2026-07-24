from fastapi import APIRouter, File, Query, UploadFile

from yolo.YoloVideoConfig import YOLO_DEFAULT_MODEL
from yolo.YoloVideoService import YoloVideoService

router = APIRouter(prefix="/fast/yolo")

_service = YoloVideoService()


@router.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "yolo-video-detect",
        "default_model": YOLO_DEFAULT_MODEL,
    }


@router.post("/detect_video_upload")
def detect_video_upload(
    file: UploadFile = File(...),
    conf: float = Query(0.25, ge=0.0, le=1.0),
    iou: float = Query(0.45, ge=0.0, le=1.0),
    max_det: int = Query(300, ge=1, le=2000),
    model_name: str = Query(YOLO_DEFAULT_MODEL),
):
    return _service.detect_uploaded_video(
        upload_file=file,
        conf=conf,
        iou=iou,
        max_det=max_det,
        model_name=model_name,
    )


@router.post("/upload_video")
def upload_video(
    file: UploadFile = File(...),
):
    return _service.upload_video_only(upload_file=file)


@router.get("/uploaded_videos")
def uploaded_videos(
    limit: int = Query(50, ge=1, le=500),
):
    return _service.list_uploaded_videos(limit=limit)


@router.post("/detect_saved_video")
def detect_saved_video(
    file_name: str = Query(...),
    conf: float = Query(0.25, ge=0.0, le=1.0),
    iou: float = Query(0.45, ge=0.0, le=1.0),
    max_det: int = Query(300, ge=1, le=2000),
    model_name: str = Query(YOLO_DEFAULT_MODEL),
):
    return _service.detect_saved_video(
        file_name=file_name,
        conf=conf,
        iou=iou,
        max_det=max_det,
        model_name=model_name,
    )