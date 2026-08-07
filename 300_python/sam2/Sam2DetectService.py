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


@router.get("/upload_limit")
def upload_limit():
    return _service.get_upload_limit()


@router.post("/segment_video_upload")
def segment_video_upload(
    file: UploadFile = File(...),
    model_name: str = Query("auto"),
    bbox: str = Query(""),
    points: str = Query(""),
    point_labels: str = Query(""),
    multimask_output: bool = Query(False),
    mask_input: bool = Query(True),
    clahe: bool = Query(False),
):
    return _service.detect_uploaded_video(
        upload_file=file,
        model_name=model_name,
        bbox=bbox,
        points=points,
        point_labels=point_labels,
        multimask_output=multimask_output,
        mask_input=mask_input,
        clahe=clahe,
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


@router.get("/video_options")
def video_options(
    file_name: str = Query(...),
):
    return _service.get_video_options(file_name=file_name)


@router.post("/video_options")
def save_video_options(
    file_name: str = Query(...),
    model_name: str = Query("auto"),
    bbox: str = Query(""),
    points: str = Query(""),
    point_labels: str = Query(""),
    multimask_output: bool = Query(False),
    mask_input: bool = Query(True),
    clahe: bool = Query(False),
):
    return _service.save_video_options(
        file_name=file_name,
        model_name=model_name,
        bbox=bbox,
        points=points,
        point_labels=point_labels,
        multimask_output=multimask_output,
        mask_input=mask_input,
        clahe=clahe,
    )


@router.post("/segment_saved_video")
def segment_saved_video(
    file_name: str = Query(...),
    model_name: str = Query("auto"),
    bbox: str = Query(""),
    points: str = Query(""),
    point_labels: str = Query(""),
    multimask_output: bool = Query(False),
    mask_input: bool = Query(True),
    clahe: bool = Query(False),
):
    return _service.detect_saved_video(
        file_name=file_name,
        model_name=model_name,
        bbox=bbox,
        points=points,
        point_labels=point_labels,
        multimask_output=multimask_output,
        mask_input=mask_input,
        clahe=clahe,
    )


@router.get("/segment_status/{job_id}")
def segment_status(job_id: str):
    return _service.get_segment_status(job_id)


@router.post("/convert_yolo_dataset")
def convert_yolo_dataset(
    file_name: str = Query(...),
):
    return _service.convert_yolo_dataset(file_name=file_name)
