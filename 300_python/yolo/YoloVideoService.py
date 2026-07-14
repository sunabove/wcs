import shutil
import time
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

from yolo.YoloVideoConfig import YOLO_DEFAULT_MODEL, YOLO_UPLOAD_DIR, YOLO_VIDEO_EXTENSIONS
from yolo.YoloVideoDetector import YoloVideoDetector


class YoloVideoService:
    def __init__(self):
        self.detector = YoloVideoDetector()

    def _safe_suffix(self, file_name: str) -> str:
        suffix = Path(str(file_name or "")).suffix.lower()
        if suffix not in YOLO_VIDEO_EXTENSIONS:
            raise HTTPException(status_code=400, detail="Only video files are supported")
        return suffix

    def _save_uploaded_video(self, upload_file: UploadFile) -> Path:
        suffix = self._safe_suffix(upload_file.filename)
        job_id = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        input_path = YOLO_UPLOAD_DIR / f"{job_id}{suffix}"

        try:
            upload_file.file.seek(0)
            with input_path.open("wb") as target_file:
                shutil.copyfileobj(upload_file.file, target_file)
        finally:
            upload_file.file.close()

        return input_path

    def detect_uploaded_video(
        self,
        upload_file: UploadFile,
        conf: float = 0.25,
        iou: float = 0.45,
        max_det: int = 300,
        model_name: str = YOLO_DEFAULT_MODEL,
    ):
        input_path = self._save_uploaded_video(upload_file)

        try:
            return self.detector.detect_video_file(
                input_path=input_path,
                conf=conf,
                iou=iou,
                max_det=max_det,
                model_name=model_name,
            )
        except FileNotFoundError as ex:
            raise HTTPException(status_code=404, detail=str(ex)) from ex
        except ValueError as ex:
            raise HTTPException(status_code=400, detail=str(ex)) from ex
        except RuntimeError as ex:
            raise HTTPException(status_code=500, detail=str(ex)) from ex
        except Exception as ex:
            raise HTTPException(status_code=500, detail=f"YOLO detect failed: {ex}") from ex
