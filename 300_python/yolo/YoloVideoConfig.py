from pathlib import Path

from config import BASE_DIR

YOLO_DEFAULT_MODEL = str((BASE_DIR / "yolo" / "yolo26n.pt").resolve())
YOLO_UPLOAD_SUBDIR = Path("upload/yolo/input")
YOLO_OUTPUT_SUBDIR = Path("upload/yolo/output")

YOLO_UPLOAD_DIR = BASE_DIR / YOLO_UPLOAD_SUBDIR
YOLO_OUTPUT_DIR = BASE_DIR / YOLO_OUTPUT_SUBDIR

YOLO_VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".webm", ".m4v"}
