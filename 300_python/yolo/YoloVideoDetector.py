import time
import uuid
import shutil
from pathlib import Path

import cv2
from ultralytics import YOLO

from config import BASE_DIR
from yolo.YoloVideoConfig import (
    YOLO_DEFAULT_MODEL,
    YOLO_OUTPUT_DIR,
    YOLO_UPLOAD_DIR,
    YOLO_VIDEO_EXTENSIONS,
)


class YoloVideoDetector:
    _model_cache = {}

    def __init__(self):
        YOLO_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        YOLO_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    def _to_route_url(self, file_path: Path) -> str:
        base_dir = BASE_DIR.resolve()
        try:
            relative = file_path.resolve().relative_to(base_dir).as_posix()
        except ValueError:
            relative = file_path.name
        return f"/fast/image/{relative}"

    def _get_model(self, model_name: str) -> YOLO:
        normalized = str(model_name or "").strip() or YOLO_DEFAULT_MODEL
        if normalized not in self._model_cache:
            requested_path = Path(normalized)
            is_local_pt_path = requested_path.suffix.lower() == ".pt" and (
                requested_path.is_absolute() or "/" in normalized or "\\" in normalized
            )

            if is_local_pt_path and not requested_path.exists():
                requested_path.parent.mkdir(parents=True, exist_ok=True)

                downloaded_model = YOLO(requested_path.name)
                ckpt_path = getattr(downloaded_model, "ckpt_path", None)

                if ckpt_path:
                    source_path = Path(str(ckpt_path)).resolve()
                    if source_path.exists() and source_path != requested_path.resolve():
                        try:
                            shutil.copy2(source_path, requested_path)
                        except OSError:
                            # Keep using the downloaded model even if local copy fails.
                            pass

                if requested_path.exists():
                    self._model_cache[normalized] = YOLO(str(requested_path))
                else:
                    self._model_cache[normalized] = downloaded_model
            else:
                self._model_cache[normalized] = YOLO(normalized)
        return self._model_cache[normalized]

    def _create_video_writer(self, output_path: Path, fps: float, width: int, height: int):
        for codec in ("mp4v", "avc1", "H264"):
            writer = cv2.VideoWriter(
                str(output_path),
                cv2.VideoWriter_fourcc(*codec),
                fps,
                (width, height),
            )
            if writer.isOpened():
                return writer
            writer.release()
        return None

    def detect_video_file(
        self,
        input_path: Path,
        conf: float = 0.25,
        iou: float = 0.45,
        max_det: int = 300,
        model_name: str = YOLO_DEFAULT_MODEL,
    ):
        resolved_input = Path(input_path).resolve()
        suffix = resolved_input.suffix.lower()
        if suffix not in YOLO_VIDEO_EXTENSIONS:
            raise ValueError("Only video files are supported")

        if not resolved_input.exists() or not resolved_input.is_file():
            raise FileNotFoundError(f"Input video not found: {resolved_input}")

        job_id = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        output_path = YOLO_OUTPUT_DIR / f"{job_id}_detected.mp4"

        capture = cv2.VideoCapture(str(resolved_input))
        if not capture.isOpened():
            raise RuntimeError("Failed to open uploaded video")

        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        if fps <= 0:
            fps = 20.0

        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if width <= 0 or height <= 0:
            capture.release()
            raise RuntimeError("Invalid video size")

        writer = self._create_video_writer(output_path, fps, width, height)
        if writer is None:
            capture.release()
            raise RuntimeError("Failed to create output video")

        start_time = time.time()
        model = self._get_model(model_name)
        class_counts = {}
        processed_frames = 0

        try:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break

                result = model.predict(
                    source=frame,
                    conf=conf,
                    iou=iou,
                    max_det=max_det,
                    verbose=False,
                )[0]

                boxes = result.boxes
                if boxes is not None and boxes.cls is not None and len(boxes.cls) > 0:
                    class_ids = boxes.cls.detach().cpu().numpy().astype(int).tolist()
                    names = result.names or {}
                    for class_id in class_ids:
                        class_name = str(names.get(class_id, class_id))
                        class_counts[class_name] = class_counts.get(class_name, 0) + 1

                plotted = result.plot()
                if plotted.shape[1] != width or plotted.shape[0] != height:
                    plotted = cv2.resize(plotted, (width, height), interpolation=cv2.INTER_AREA)

                writer.write(plotted)
                processed_frames += 1
        finally:
            capture.release()
            writer.release()

        if processed_frames <= 0:
            raise RuntimeError("No frames were processed")

        elapsed_sec = round(time.time() - start_time, 3)

        return {
            "job_id": job_id,
            "model": str(model_name or YOLO_DEFAULT_MODEL),
            "processed_frames": processed_frames,
            "input_total_frames": total_frames,
            "fps": round(fps, 3),
            "elapsed_sec": elapsed_sec,
            "class_counts": class_counts,
            "input_file": str(resolved_input),
            "output_file": str(output_path.resolve()),
            "input_url": self._to_route_url(resolved_input),
            "output_url": self._to_route_url(output_path),
        }
