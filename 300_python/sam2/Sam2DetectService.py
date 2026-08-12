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
    prompt_frame: int = Query(1, ge=1),
    bbox: str = Query(""),
    points: str = Query(""),
    point_labels: str = Query(""),
    multimask_output: bool = Query(False),
    mask_input: bool = Query(True),
    clahe: bool = Query(False),
    reference_score: float = Query(0.5, ge=0.0, le=1.0),
):
    return _service.detect_uploaded_video(
        upload_file=file,
        model_name=model_name,
        prompt_frame=prompt_frame,
        bbox=bbox,
        points=points,
        point_labels=point_labels,
        multimask_output=multimask_output,
        mask_input=mask_input,
        clahe=clahe,
        reference_score=reference_score,
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


@router.get("/video_metadata")
def video_metadata(
    file_name: str = Query(...),
    output: bool = Query(False),
):
    return _service.get_video_metadata(file_name=file_name, output=output)


@router.delete("/uploaded_video")
def delete_uploaded_video(
    file_name: str = Query(...),
):
    return _service.delete_uploaded_video(file_name=file_name)


@router.get("/video_options")
def video_options(
    file_name: str = Query(...),
):
    return _service.get_video_options(file_name=file_name)


@router.post("/video_options")
def save_video_options(
    file_name: str = Query(...),
    model_name: str = Query("auto"),
    prompt_frame: int = Query(1, ge=1),
    bbox: str = Query(""),
    points: str = Query(""),
    point_labels: str = Query(""),
    multimask_output: bool = Query(False),
    mask_input: bool = Query(True),
    clahe: bool = Query(False),
    reference_score: float = Query(0.8, ge=0.0, le=1.0),
):
    return _service.save_video_options(
        file_name=file_name,
        model_name=model_name,
        prompt_frame=prompt_frame,
        bbox=bbox,
        points=points,
        point_labels=point_labels,
        multimask_output=multimask_output,
        mask_input=mask_input,
        clahe=clahe,
        reference_score=reference_score,
    )


@router.post("/segment_saved_video")
def segment_saved_video(
    file_name: str = Query(...),
    model_name: str = Query("auto"),
    prompt_frame: int = Query(1, ge=1),
    bbox: str = Query(""),
    points: str = Query(""),
    point_labels: str = Query(""),
    multimask_output: bool = Query(False),
    mask_input: bool = Query(True),
    clahe: bool = Query(False),
    reference_score: float = Query(0.8, ge=0.0, le=1.0),
):
    return _service.detect_saved_video(
        file_name=file_name,
        model_name=model_name,
        prompt_frame=prompt_frame,
        bbox=bbox,
        points=points,
        point_labels=point_labels,
        multimask_output=multimask_output,
        mask_input=mask_input,
        clahe=clahe,
        reference_score=reference_score,
    )


@router.get("/segment_status/{job_id}")
def segment_status(job_id: str):
    return _service.get_segment_status(job_id)


@router.post("/convert_yolo_dataset")
def convert_yolo_dataset(
    file_name: str = Query(...),
):
    return _service.convert_yolo_dataset(file_name=file_name)


@router.get("/yolo_dataset_frames")
def yolo_dataset_frames(
    file_name: str = Query(...),
):
    return _service.get_yolo_dataset_frames(file_name=file_name)


@router.get("/yolo_dataset_summary")
def yolo_dataset_summary():
    return _service.get_yolo_dataset_summary()


@router.post("/train_yolo_dataset")
def train_yolo_dataset(
    force_retrain: bool = Query(False),
):
    return _service.start_yolo_training(force_retrain=force_retrain)


@router.get("/yolo_training_status")
def active_yolo_training_status():
    return _service.get_active_yolo_training()


@router.get("/yolo_training_status/{job_id}")
def yolo_training_status(job_id: str):
    return _service.get_yolo_training_status(job_id)


@router.post("/yolo_training_stop/{job_id}")
def stop_yolo_training(job_id: str):
    return _service.stop_yolo_training(job_id)


@router.delete("/yolo_dataset")
def delete_yolo_dataset(
    file_name: str = Query(...),
):
    return _service.delete_yolo_dataset(file_name=file_name)
