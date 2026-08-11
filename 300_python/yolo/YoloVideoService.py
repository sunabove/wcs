import shutil
import hashlib
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
        YOLO_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

        original_name = Path(str(upload_file.filename or "")).name.strip()
        if not original_name:
            original_name = f"uploaded{suffix}"

        target_path = YOLO_UPLOAD_DIR / original_name
        temp_path = YOLO_UPLOAD_DIR / f"{original_name}.uploading{suffix}"

        hasher = hashlib.sha256()
        written_size = 0

        try:
            upload_file.file.seek(0)
            with temp_path.open("wb") as target_file:
                while True:
                    chunk = upload_file.file.read(1024 * 1024)
                    if not chunk:
                        break
                    hasher.update(chunk)
                    target_file.write(chunk)
                    written_size += len(chunk)
        finally:
            upload_file.file.close()

        # Keep the original uploaded filename as the stored filename.
        # If same name already exists, overwrite atomically.
        temp_path.replace(target_path)
        return target_path

    def _hash_file(self, file_path: Path) -> str:
        hasher = hashlib.sha256()
        with file_path.open("rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                hasher.update(chunk)
        return hasher.hexdigest()

    def detect_uploaded_video(
        self,
        upload_file: UploadFile,
        conf: float = 0.25,
        iou: float = 0.45,
        max_det: int = 300,
        model_name: str = YOLO_DEFAULT_MODEL,
        class_names: list[str] | None = None,
    ):
        input_path = self._save_uploaded_video(upload_file)

        try:
            return self.detector.detect_video_file(
                input_path=input_path,
                conf=conf,
                iou=iou,
                max_det=max_det,
                model_name=model_name,
                class_names=class_names,
            )
        except FileNotFoundError as ex:
            raise HTTPException(status_code=404, detail=str(ex)) from ex
        except ValueError as ex:
            raise HTTPException(status_code=400, detail=str(ex)) from ex
        except RuntimeError as ex:
            raise HTTPException(status_code=500, detail=str(ex)) from ex
        except Exception as ex:
            raise HTTPException(status_code=500, detail=f"YOLO detect failed: {ex}") from ex

    def upload_video_only(self, upload_file: UploadFile):
        input_path = self._save_uploaded_video(upload_file)
        relative = self._to_relative_under_base(input_path)

        return {
            "file_name": relative,
            "display_name": input_path.name,
            "size": int(input_path.stat().st_size),
            "uploaded_at": datetime.fromtimestamp(input_path.stat().st_mtime).isoformat(timespec="seconds"),
            "input_url": f"/fast/image/{relative}",
            "thumbnail_url": f"/fast/video_thumbnail/{relative}",
        }

    def detect_saved_video(
        self,
        file_name: str,
        conf: float = 0.25,
        iou: float = 0.45,
        max_det: int = 300,
        model_name: str = YOLO_DEFAULT_MODEL,
        class_names: list[str] | None = None,
    ):
        input_path = self._resolve_uploaded_video_path(file_name)

        try:
            return self.detector.detect_video_file(
                input_path=input_path,
                conf=conf,
                iou=iou,
                max_det=max_det,
                model_name=model_name,
                class_names=class_names,
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

            name_lower = path.name.lower()
            # Skip derived/transient files so only real uploaded originals are listed.
            if ".playable." in name_lower or ".uploading" in name_lower or name_lower.startswith("_"):
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

    def delete_uploaded_video(self, file_name: str):
        input_path = self._resolve_uploaded_video_path(file_name)
        input_stem = input_path.stem
        deleted_paths = []

        def remove_file(path: Path):
            if path.is_file() or path.is_symlink():
                path.unlink(missing_ok=True)
                deleted_paths.append(str(path))

        remove_file(input_path)
        remove_file(input_path.with_name(f"{input_stem}.playable.mp4"))
        remove_file(input_path.with_name(f"{input_stem}.playable.tmp.mp4"))
        for path in YOLO_UPLOAD_DIR.glob(f"_{input_stem}.*"):
            remove_file(path)

        return {
            "file_name": self._to_relative_under_base(input_path),
            "deleted": True,
            "deleted_count": len(deleted_paths),
        }
