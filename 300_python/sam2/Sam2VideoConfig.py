from pathlib import Path

from config import BASE_DIR

SAM2_DEFAULT_MODEL = str((BASE_DIR / "ai" / "road" / "model" / "01_yolo11m-road-sg.pt").resolve())
SAM2_UPLOAD_SUBDIR = Path("upload/sam2/input")
SAM2_OUTPUT_SUBDIR = Path("upload/sam2/output")

SAM2_UPLOAD_DIR = BASE_DIR / SAM2_UPLOAD_SUBDIR
SAM2_OUTPUT_DIR = BASE_DIR / SAM2_OUTPUT_SUBDIR

SAM2_VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".webm", ".m4v"}

SAM2_TARGET_MODEL_MAP = {
	"road": str((BASE_DIR / "ai" / "road" / "model" / "01_yolo11m-road-sg.pt").resolve()),
	"pothole": str((BASE_DIR / "ai" / "road" / "model" / "04_yolo11m-pothole-sg.pt").resolve()),
	# Reuse road-type segmentation model for curb/step-like classes when dedicated model is absent.
	"curb_step": str((BASE_DIR / "ai" / "road" / "model" / "02_yolo11m-cobot-road-type-sg-260626.pt").resolve()),
}
