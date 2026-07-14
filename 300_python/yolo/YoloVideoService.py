import shutil
import time
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException, UploadFile

from config import BASE_DIR
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

    def _to_relative_under_base(self, file_path: Path) -> str:
        base_dir = BASE_DIR.resolve()
        return file_path.resolve().relative_to(base_dir).as_posix()

    def _resolve_uploaded_video_path(self, file_name: str) -> Path:
        value = str(file_name or "").strip()
        if not value:
            raise HTTPException(status_code=400, detail="file_name is required")

        candidate = Path(value)
        if candidate.is_absolute():
            resolved = candidate.resolve()
        else:
            resolved = (BASE_DIR / candidate).resolve()

        upload_root = YOLO_UPLOAD_DIR.resolve()
        if resolved != upload_root and upload_root not in resolved.parents:
            raise HTTPException(status_code=400, detail="Invalid file_name path")

        suffix = resolved.suffix.lower()
        if suffix not in YOLO_VIDEO_EXTENSIONS:
            raise HTTPException(status_code=400, detail="Only video files are supported")

        if not resolved.exists() or not resolved.is_file():
            raise HTTPException(status_code=404, detail="Uploaded video not found")

        return resolved

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

    def detect_saved_video(
        self,
        file_name: str,
        conf: float = 0.25,
        iou: float = 0.45,
        max_det: int = 300,
        model_name: str = YOLO_DEFAULT_MODEL,
    ):
        input_path = self._resolve_uploaded_video_path(file_name)

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

    def list_uploaded_videos(self, limit: int = 50):
        YOLO_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

        items = []
        for path in YOLO_UPLOAD_DIR.glob("*"):
            if not path.is_file():
                continue
            if path.suffix.lower() not in YOLO_VIDEO_EXTENSIONS:
                continue

            stat = path.stat()
            relative = self._to_relative_under_base(path)
            items.append(
                {
                    "file_name": relative,
                    "display_name": path.name,
                    "size": int(stat.st_size),
                    "uploaded_at": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                    "input_url": f"/fast/image/{relative}",
                    "thumbnail_url": f"/fast/video_thumbnail/{relative}",
                }
            )

        items.sort(key=lambda item: item.get("uploaded_at", ""), reverse=True)
        return {"videos": items[: max(1, int(limit))]}
