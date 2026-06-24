from fastapi import HTTPException
from fastapi.responses import FileResponse
from fastapi.responses import Response

import cv2

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

def send_image_contents(file_name: str):
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

    return FileResponse(
        str(image_path),
        media_type=media_type
    )
pass # send_image_contents


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

        seek_index = 0
        if total_frames > 0 and fps > 0:
            seek_index = int(max(0, min(total_frames - 1, round(frame_seconds * fps))))

        if seek_index > 0:
            capture.set(cv2.CAP_PROP_POS_FRAMES, seek_index)

        ok, frame = capture.read()
        if not ok or frame is None:
            capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = capture.read()

        if not ok or frame is None:
            raise HTTPException(status_code=500, detail="Unable to extract video frame")

        encoded_ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        if not encoded_ok:
            raise HTTPException(status_code=500, detail="Unable to encode thumbnail")

        return Response(content=encoded.tobytes(), media_type="image/jpeg")
    finally:
        capture.release()
pass # send_video_thumbnail_contents
