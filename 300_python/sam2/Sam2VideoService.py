import hashlib
import json
import os
import re
import subprocess
import time
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException, UploadFile

from config import BASE_DIR
from sam2.Sam2VideoConfig import (
    SAM2_DEFAULT_MODEL,
    SAM2_UPLOAD_DIR,
    SAM2_VIDEO_EXTENSIONS,
)
from sam2.Sam2VideoDetector import Sam2VideoDetector


DEFAULT_UPLOAD_LIMIT_BYTES = 1024 * 1024 * 1024


class Sam2VideoService:
    def __init__(self):
        self.detector = Sam2VideoDetector()

    def _normalize_target_type(self, target_type: str) -> str:
        value = str(target_type or "").strip().lower()
        if value in {"road", "pothole", "curb_step"}:
            return value
        raise HTTPException(status_code=400, detail="target_type must be one of: road, pothole, curb_step")

    def _safe_suffix(self, file_name: str) -> str:
        suffix = Path(str(file_name or "")).suffix.lower()
        if suffix not in SAM2_VIDEO_EXTENSIONS:
            raise HTTPException(status_code=400, detail="Only video files are supported")
        return suffix

    def _parse_size_to_bytes(self, size_text: str):
        value = str(size_text or "").strip().lower().rstrip(";")
        if not value:
            return None

        if value == "0":
            return 0

        match = re.match(r"^(\d+)([kmg])?$", value)
        if not match:
            return None

        amount = int(match.group(1))
        suffix = match.group(2)
        if suffix == "k":
            return amount * 1024
        if suffix == "m":
            return amount * 1024 * 1024
        if suffix == "g":
            return amount * 1024 * 1024 * 1024
        return amount

    def _resolve_nginx_upload_limit(self):
        env_value = os.getenv("NGINX_CLIENT_MAX_BODY_SIZE") or os.getenv("CLIENT_MAX_BODY_SIZE")
        env_bytes = self._parse_size_to_bytes(env_value)
        if env_bytes is not None:
            return env_bytes, "env", str(env_value).strip()

        conf_limit = self._resolve_nginx_upload_limit_from_files()
        if conf_limit is not None:
            conf_bytes = self._parse_size_to_bytes(conf_limit)
            if conf_bytes is not None:
                return conf_bytes, "nginx", conf_limit

        try:
            result = subprocess.run(
                ["nginx", "-T"],
                capture_output=True,
                text=True,
                check=False,
            )
            output_text = (result.stdout or "") + "\n" + (result.stderr or "")
            matches = re.findall(r"client_max_body_size\s+([^\s;]+)", output_text, flags=re.IGNORECASE)
            for raw_value in reversed(matches):
                parsed = self._parse_size_to_bytes(raw_value)
                if parsed is not None:
                    return parsed, "nginx", str(raw_value).strip()
        except Exception:
            pass

        return DEFAULT_UPLOAD_LIMIT_BYTES, "default", "1g"

    def _resolve_nginx_upload_limit_from_files(self):
        candidate_files = [
            os.getenv("NGINX_CONF_PATH", "").strip(),
            "/etc/nginx/nginx.conf",
            "/etc/nginx/conf.d/default.conf",
            "/etc/nginx/sites-enabled/default",
            "/etc/nginx/sites-available/default",
        ]

        merged_text_parts = []
        for file_path in candidate_files:
            if not file_path:
                continue
            try:
                path = Path(file_path)
                if path.exists() and path.is_file():
                    merged_text_parts.append(path.read_text(encoding="utf-8", errors="ignore"))
            except OSError:
                continue

        if not merged_text_parts:
            return None

        merged_text = "\n".join(merged_text_parts)
        matches = re.findall(r"client_max_body_size\s+([^\s;]+)", merged_text, flags=re.IGNORECASE)
        for raw_value in reversed(matches):
            parsed = self._parse_size_to_bytes(raw_value)
            if parsed is not None:
                return str(raw_value).strip()

        return None

    def get_upload_limit(self):
        max_upload_bytes, source, configured_value = self._resolve_nginx_upload_limit()
        return {
            "max_upload_bytes": int(max_upload_bytes),
            "source": source,
            "configured_value": configured_value,
        }

    def _safe_uploaded_file_name(self, file_name: str) -> str:
        value = str(file_name or "").strip()
        if not value:
            raise HTTPException(status_code=400, detail="file_name is required")

        name = Path(value).name
        if not name or name in {".", ".."}:
            raise HTTPException(status_code=400, detail="Invalid file name")

        return name

    def _resolve_model_name(self, target_type: str, model_name: str) -> str:
        _ = target_type
        value = str(model_name or "").strip()
        if value and value.lower() not in {"auto", "default"}:
            return value
        return SAM2_DEFAULT_MODEL

    def _to_relative_under_base(self, file_path: Path) -> str:
        base_dir = BASE_DIR.resolve()
        return file_path.resolve().relative_to(base_dir).as_posix()

    def _hash_file(self, file_path: Path) -> str:
        hasher = hashlib.sha256()
        with file_path.open("rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                hasher.update(chunk)
        return hasher.hexdigest()

    def _resolve_uploaded_video_path(self, file_name: str) -> Path:
        value = str(file_name or "").strip()
        if not value:
            raise HTTPException(status_code=400, detail="file_name is required")

        candidate = Path(value)
        if candidate.is_absolute():
            resolved = candidate.resolve()
        else:
            resolved = (BASE_DIR / candidate).resolve()

        upload_root = SAM2_UPLOAD_DIR.resolve()
        if resolved != upload_root and upload_root not in resolved.parents:
            raise HTTPException(status_code=400, detail="Invalid file_name path")

        suffix = resolved.suffix.lower()
        if suffix not in SAM2_VIDEO_EXTENSIONS:
            raise HTTPException(status_code=400, detail="Only video files are supported")

        if not resolved.exists() or not resolved.is_file():
            raise HTTPException(status_code=404, detail="Uploaded video not found")

        return resolved

    def _is_listable_uploaded_video(self, path: Path) -> bool:
        if not path.is_file():
            return False

        if path.suffix.lower() not in SAM2_VIDEO_EXTENSIONS:
            return False

        name_lower = path.name.lower()
        if ".playable." in name_lower or ".uploading" in name_lower or name_lower.startswith("_"):
            return False

        return True

    def _options_path(self, input_path: Path) -> Path:
        return input_path.with_suffix(".sam2")

    def _parse_options_json(self, value: str, default):
        if not str(value or "").strip():
            return default
        try:
            return json.loads(value)
        except json.JSONDecodeError as ex:
            raise HTTPException(status_code=400, detail="Detection options must be valid JSON") from ex

    def _save_detection_options(
        self,
        input_path: Path,
        target_type: str,
        model_name: str,
        bbox: str,
        points: str,
        point_labels: str,
    ) -> None:
        options = {
            "target_type": target_type,
            "model_name": model_name,
            "bbox": self._parse_options_json(bbox, None),
            "points": self._parse_options_json(points, []),
            "point_labels": self._parse_options_json(point_labels, []),
            "saved_at": datetime.now().isoformat(timespec="seconds"),
        }
        options_path = self._options_path(input_path)
        try:
            options_path.write_text(json.dumps(options, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as ex:
            raise HTTPException(status_code=500, detail=f"Failed to save detection options: {ex}") from ex

    def _save_uploaded_video(self, upload_file: UploadFile) -> Path:
        original_file_name = self._safe_uploaded_file_name(upload_file.filename)
        suffix = self._safe_suffix(original_file_name)
        SAM2_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        job_id = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        temp_path = SAM2_UPLOAD_DIR / f"{Path(original_file_name).stem}.{job_id}.uploading{suffix}"

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

        new_digest = hasher.hexdigest()
        target_name = original_file_name

        for existing_path in SAM2_UPLOAD_DIR.glob(f"*{suffix}"):
            if not existing_path.is_file() or existing_path == temp_path:
                continue

            try:
                if existing_path.stat().st_size != written_size:
                    continue
            except OSError:
                continue

            existing_digest = self._hash_file(existing_path)
            if existing_digest == new_digest:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
                return existing_path

        input_path = SAM2_UPLOAD_DIR / target_name
        if input_path.exists():
            stem = Path(original_file_name).stem
            input_path = SAM2_UPLOAD_DIR / f"{stem}_{job_id}{suffix}"

        temp_path.replace(input_path)
        return input_path

    def detect_uploaded_video(
        self,
        upload_file: UploadFile,
        target_type: str = "road",
        model_name: str = "auto",
        bbox: str = "",
        points: str = "",
        point_labels: str = "",
    ):
        input_path = self._save_uploaded_video(upload_file)
        normalized_target_type = self._normalize_target_type(target_type)
        resolved_model_name = self._resolve_model_name(normalized_target_type, model_name)
        self._save_detection_options(
            input_path=input_path,
            target_type=normalized_target_type,
            model_name=resolved_model_name,
            bbox=bbox,
            points=points,
            point_labels=point_labels,
        )

        try:
            return self.detector.detect_video_file(
                input_path=input_path,
                target_type=normalized_target_type,
                model_name=resolved_model_name,
                bbox=bbox,
                points=points,
                point_labels=point_labels,
            )
        except FileNotFoundError as ex:
            raise HTTPException(status_code=404, detail=str(ex)) from ex
        except ValueError as ex:
            raise HTTPException(status_code=400, detail=str(ex)) from ex
        except RuntimeError as ex:
            raise HTTPException(status_code=500, detail=str(ex)) from ex
        except Exception as ex:
            raise HTTPException(status_code=500, detail=f"SAM2 segmentation failed: {ex}") from ex

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
        target_type: str = "road",
        model_name: str = "auto",
        bbox: str = "",
        points: str = "",
        point_labels: str = "",
    ):
        input_path = self._resolve_uploaded_video_path(file_name)
        normalized_target_type = self._normalize_target_type(target_type)
        resolved_model_name = self._resolve_model_name(normalized_target_type, model_name)
        self._save_detection_options(
            input_path=input_path,
            target_type=normalized_target_type,
            model_name=resolved_model_name,
            bbox=bbox,
            points=points,
            point_labels=point_labels,
        )

        try:
            return self.detector.detect_video_file(
                input_path=input_path,
                target_type=normalized_target_type,
                model_name=resolved_model_name,
                bbox=bbox,
                points=points,
                point_labels=point_labels,
            )
        except FileNotFoundError as ex:
            raise HTTPException(status_code=404, detail=str(ex)) from ex
        except ValueError as ex:
            raise HTTPException(status_code=400, detail=str(ex)) from ex
        except RuntimeError as ex:
            raise HTTPException(status_code=500, detail=str(ex)) from ex
        except Exception as ex:
            raise HTTPException(status_code=500, detail=f"SAM2 segmentation failed: {ex}") from ex

    def list_uploaded_videos(self, limit: int = 50):
        SAM2_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

        items = []
        for path in SAM2_UPLOAD_DIR.glob("*"):
            if not self._is_listable_uploaded_video(path):
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
