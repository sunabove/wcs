from pathlib import Path

from config import BASE_DIR

# SAM2 uses promptable segmentation checkpoints (Meta SAM2 family), not YOLO segmentation weights.
# Keep this as a model identifier/checkpoint path consumed by the SAM backend.
SAM2_DEFAULT_MODEL = "sam2.1_t.pt"
SAM2_UPLOAD_SUBDIR = Path("upload/sam2/input")
SAM2_OUTPUT_SUBDIR = Path("upload/sam2/output")

SAM2_UPLOAD_DIR = BASE_DIR / SAM2_UPLOAD_SUBDIR
SAM2_OUTPUT_DIR = BASE_DIR / SAM2_OUTPUT_SUBDIR

SAM2_VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".webm", ".m4v"}

SAM2_TARGET_MODEL_MAP = {
	"road": SAM2_DEFAULT_MODEL,
	"pothole": SAM2_DEFAULT_MODEL,
	"curb_step": SAM2_DEFAULT_MODEL,
}
