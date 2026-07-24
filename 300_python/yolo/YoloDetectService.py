from pathlib import Path
from datetime import datetime

from fastapi import APIRouter, File, Query, UploadFile

from config import BASE_DIR
from yolo.YoloVideoConfig import YOLO_DEFAULT_MODEL
from yolo.YoloVideoService import YoloVideoService

router = APIRouter(prefix="/fast/yolo")

_service = YoloVideoService()


def _describe_model_file(path: Path) -> str:
    name = path.stem.lower()
    if "sidewalk" in name:
        return "보도/측면 분할 모델"
    if name.startswith("yolo26"):
        return "기본 검출 모델"
    if "road" in name:
        return "도로 관련 모델"
    return "YOLO 모델"


@router.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "yolo-video-detect",
        "default_model": YOLO_DEFAULT_MODEL,
    }


@router.get("/models")
def models():
    model_dir = (BASE_DIR / "yolo" / "model").resolve()
    items = []

    if model_dir.exists():
        for path in sorted(model_dir.glob("*.pt")):
            if not path.is_file():
                continue

            stat = path.stat()
            items.append(
                {
                    "file_name": path.name,
                    "display_name": path.stem,
                    "model_path": path.as_posix(),
                    "size": int(stat.st_size),
                    "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                    "is_default": str(path.resolve()) == str(Path(YOLO_DEFAULT_MODEL).resolve()),
                    "description": _describe_model_file(path),
                }
            )

    return {"models": items}


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