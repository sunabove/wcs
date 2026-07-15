from fastapi import APIRouter, File, Query, UploadFile

from sam2.Sam2VideoConfig import SAM2_DEFAULT_MODEL
from sam2.Sam2VideoService import Sam2VideoService

router = APIRouter(prefix="/fast/sam2")

_service = Sam2VideoService()


@router.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "sam2-video-segmentation",
        "default_model": SAM2_DEFAULT_MODEL,
    }


@router.post("/segment_video_upload")
def segment_video_upload(
    file: UploadFile = File(...),
    target_type: str = Query("road"),
    conf: float = Query(0.25, ge=0.0, le=1.0),
    max_det: int = Query(300, ge=1, le=2000),
    model_name: str = Query("auto"),
    bbox: str = Query(""),
):
    return _service.detect_uploaded_video(
        upload_file=file,
        target_type=target_type,
        conf=conf,
        max_det=max_det,
        model_name=model_name,
        bbox=bbox,
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


@router.post("/segment_saved_video")
def segment_saved_video(
    file_name: str = Query(...),
    target_type: str = Query("road"),
    conf: float = Query(0.25, ge=0.0, le=1.0),
    max_det: int = Query(300, ge=1, le=2000),
    model_name: str = Query("auto"),
    bbox: str = Query(""),
):
    return _service.detect_saved_video(
        file_name=file_name,
        target_type=target_type,
        conf=conf,
        max_det=max_det,
        model_name=model_name,
        bbox=bbox,
    )
