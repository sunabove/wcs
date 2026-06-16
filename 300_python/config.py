from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "upload"
SAMPLES_DIR = BASE_DIR / "samples"

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".webm", ".m4v"}
