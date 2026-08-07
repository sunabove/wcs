from pathlib import Path

from config import BASE_DIR

# SAM2 uses promptable segmentation checkpoints from the Meta SAM2 family.
# The installed `sam2` package expects a Hugging Face model ID here.
#SAM2_DEFAULT_MODEL = "facebook/sam2.1-hiera-tiny"
SAM2_DEFAULT_MODEL = "facebook/sam2.1-hiera-small"
SAM2_UPLOAD_SUBDIR = Path("upload/sam2/input")
SAM2_OUTPUT_SUBDIR = Path("upload/sam2/output")
SAM2_YOLO_SUBDIR = Path("upload/sam2/yolo")

SAM2_UPLOAD_DIR = BASE_DIR / SAM2_UPLOAD_SUBDIR
SAM2_OUTPUT_DIR = BASE_DIR / SAM2_OUTPUT_SUBDIR
SAM2_YOLO_DIR = BASE_DIR / SAM2_YOLO_SUBDIR

SAM2_VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".webm", ".m4v"}

