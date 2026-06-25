from fastapi import HTTPException
from fastapi.responses import FileResponse
from fastapi.responses import Response

import cv2
import numpy as np

from pathlib import Path
from config import *

def resolve_upload_image_path(file_name: str) -> Path:
    if not file_name or not file_name.strip():
        raise HTTPException(status_code=400, detail="file_name is required")

    base_dir = BASE_DIR.resolve()
    requested_path = Path(file_name)

    # Supports both relative and canonical absolute paths.
    if requested_path.is_absolute():
        resolved_path = requested_path.resolve()
    else:
        resolved_path = (BASE_DIR / requested_path).resolve()

    if resolved_path != base_dir and base_dir not in resolved_path.parents:
        raise HTTPException(status_code=400, detail="Invalid file_name path")

    return resolved_path
pass # resolve_upload_image_path

def send_image_contents(file_name: str, download: bool = False, download_name: str = ""):
    image_path = resolve_upload_image_path(file_name)

    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")

    suffix = image_path.suffix.lower()
    media_type = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
        ".wmv": "video/x-ms-wmv"
    }.get(suffix, "application/octet-stream")

    if download:
        final_name = str(download_name or image_path.name).strip() or image_path.name
        return FileResponse(
            str(image_path),
            media_type=media_type,
            filename=final_name,
            content_disposition_type="attachment",
        )

    return FileResponse(
        str(image_path),
        media_type=media_type
    )
pass # send_image_contents


def _is_blank_or_white_frame(frame: np.ndarray) -> bool:
    if frame is None or frame.size == 0:
        return True

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    mean_val = float(np.mean(gray))
    std_val = float(np.std(gray))
    white_ratio = float(np.mean(gray > 245))

    # Typical white placeholder frames are very bright and low-texture.
    return (white_ratio > 0.92 and std_val < 14.0) or (mean_val > 245.0 and std_val < 10.0)


def _read_frame_at_index(capture: cv2.VideoCapture, frame_index: int):
    if frame_index < 0:
        frame_index = 0

    capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
    ok, frame = capture.read()
    return ok, frame


def send_video_thumbnail_contents(file_name: str, frame_seconds: float = 0.1):
    video_path = resolve_upload_image_path(file_name)

    if not video_path.exists() or not video_path.is_file():
        raise HTTPException(status_code=404, detail="Video not found")

    if video_path.suffix.lower() not in VIDEO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="file_name is not a video")

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise HTTPException(status_code=400, detail="Unable to open video")

    frame = None
    try:
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)

        candidate_indices = [0]
        if total_frames > 1:
            candidate_indices.extend([
                int(total_frames * 0.01),
                int(total_frames * 0.03),
                int(total_frames * 0.05),
            ])
        if fps > 0:
            candidate_indices.extend([
                int(round(frame_seconds * fps)),
                int(round(0.30 * fps)),
                int(round(0.60 * fps)),
            ])

        # Remove duplicates while preserving order.
        normalized_indices = []
        seen = set()
        for index in candidate_indices:
            if total_frames > 0:
                index = max(0, min(total_frames - 1, int(index)))
            else:
                index = max(0, int(index))

            if index not in seen:
                seen.add(index)
                normalized_indices.append(index)

        best_fallback = None
        for index in normalized_indices:
            ok, candidate = _read_frame_at_index(capture, index)
            if not ok or candidate is None:
                continue

            if best_fallback is None:
                best_fallback = candidate

            if not _is_blank_or_white_frame(candidate):
                frame = candidate
                break

        if frame is None:
            # Sequentially probe a few more frames from the start as a final attempt.
            capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
            for _ in range(20):
                ok, candidate = capture.read()
                if not ok or candidate is None:
                    break
                if best_fallback is None:
                    best_fallback = candidate
                if not _is_blank_or_white_frame(candidate):
                    frame = candidate
                    break

        if frame is None and best_fallback is not None:
            frame = best_fallback

        if frame is None:
            raise HTTPException(status_code=500, detail="Unable to extract video frame")

        encoded_ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        if not encoded_ok:
            raise HTTPException(status_code=500, detail="Unable to encode thumbnail")

        return Response(content=encoded.tobytes(), media_type="image/jpeg")
    finally:
        capture.release()
pass # send_video_thumbnail_contents
