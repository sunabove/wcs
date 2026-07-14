from pathlib import Path

from config import BASE_DIR

SAM2_DEFAULT_MODEL = str((BASE_DIR / "sam2" / "sam2_b.pt").resolve())
SAM2_UPLOAD_SUBDIR = Path("upload/sam2/input")
SAM2_OUTPUT_SUBDIR = Path("upload/sam2/output")

SAM2_UPLOAD_DIR = BASE_DIR / SAM2_UPLOAD_SUBDIR
SAM2_OUTPUT_DIR = BASE_DIR / SAM2_OUTPUT_SUBDIR

SAM2_VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".webm", ".m4v"}
