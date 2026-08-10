from fastapi import HTTPException, UploadFile

from pathlib import Path
import hashlib
import shutil

from config import *


def _safe_original_file_name(file_name: str) -> str:
    original_name = Path(str(file_name or "").replace("\\", "/")).name.strip()
    if not original_name or original_name in {".", ".."}:
        raise HTTPException(status_code=400, detail="Invalid file name")
    return original_name


def _resolve_sample_video_folder(target_folder: str) -> Path:
    video_root = (SAMPLES_DIR / "video").resolve()
    normalized = str(target_folder or "video").strip().replace("\\", "/").strip("/")
    if normalized.startswith("samples/"):
        normalized = normalized[len("samples/"):]

    target_path = (SAMPLES_DIR / normalized).resolve()
    if target_path != video_root and video_root not in target_path.parents:
        raise HTTPException(status_code=400, detail="Invalid sample video folder")
    return target_path


def save_uploaded_image(file: UploadFile, target_folder: str = "") -> dict:
    if not file.content_type or not (
        file.content_type.startswith("image/") or file.content_type.startswith("video/")
    ):
        raise HTTPException(status_code=400, detail="Only image/video files are allowed")

    original_name = _safe_original_file_name(file.filename)
    suffix = Path(original_name).suffix.lower()
    is_video = file.content_type.startswith("video/") or suffix in VIDEO_EXTENSIONS

    if is_video and target_folder:
        target_dir = _resolve_sample_video_folder(target_folder)
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / original_name
        temp_path = target_dir / f".{original_name}.uploading"

        try:
            file.file.seek(0)
            with temp_path.open("wb") as buffer:
                shutil.copyfileobj(file.file, buffer)
            temp_path.replace(target_path)
        except OSError as ex:
            temp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Failed to save uploaded video: {ex}") from ex

        relative_path = target_path.resolve().relative_to(BASE_DIR.resolve()).as_posix()
        return {"filename": relative_path}

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    file.file.seek(0)
    hasher = hashlib.sha256()
    while True:
        chunk = file.file.read(1024 * 1024)
        if not chunk:
            break
        hasher.update(chunk)
    file_hash = hasher.hexdigest()
    file.file.seek(0)

    suffix = suffix or ".png"

    target_path = UPLOAD_DIR / f"{file_hash}{suffix}"

    if target_path.exists() and not target_path.is_file():
        if target_path.is_dir():
            shutil.rmtree(target_path)
        else:
            target_path.unlink()

    if not target_path.is_file():
        with target_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

    upload_folder_name = UPLOAD_DIR.name

    return {
        "filename": f"{upload_folder_name}/{target_path.name}"
    }
pass # save_uploaded_image 