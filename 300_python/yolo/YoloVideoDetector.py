import shutil
import time
import uuid
from pathlib import Path

import cv2
from fastapi import HTTPException, UploadFile
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
            self._model_cache[normalized] = YOLO(normalized)
        return self._model_cache[normalized]

    def _safe_suffix(self, file_name: str) -> str:
        suffix = Path(str(file_name or "")).suffix.lower()
        if suffix not in YOLO_VIDEO_EXTENSIONS:
            raise HTTPException(status_code=400, detail="Only video files are supported")
        return suffix

    def detect_uploaded_video(
        self,
        upload_file: UploadFile,
        conf: float = 0.25,
        iou: float = 0.45,
        max_det: int = 300,
        model_name: str = YOLO_DEFAULT_MODEL,
    ):
        suffix = self._safe_suffix(upload_file.filename)

        job_id = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        input_path = YOLO_UPLOAD_DIR / f"{job_id}{suffix}"
        output_path = YOLO_OUTPUT_DIR / f"{job_id}_detected.mp4"

        try:
            upload_file.file.seek(0)
            with input_path.open("wb") as target_file:
                shutil.copyfileobj(upload_file.file, target_file)
        finally:
            upload_file.file.close()

        capture = cv2.VideoCapture(str(input_path))
        if not capture.isOpened():
            raise HTTPException(status_code=400, detail="Failed to open uploaded video")

        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        if fps <= 0:
            fps = 20.0

        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if width <= 0 or height <= 0:
            capture.release()
            raise HTTPException(status_code=500, detail="Invalid video size")

        writer = cv2.VideoWriter(
            str(output_path),
            cv2.VideoWriter_fourcc(*"mp4v"),
            fps,
            (width, height),
        )
        if not writer.isOpened():
            capture.release()
            raise HTTPException(status_code=500, detail="Failed to create output video")

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
            raise HTTPException(status_code=500, detail="No frames were processed")

        elapsed_sec = round(time.time() - start_time, 3)

        return {
            "job_id": job_id,
            "model": str(model_name or YOLO_DEFAULT_MODEL),
            "processed_frames": processed_frames,
            "input_total_frames": total_frames,
            "fps": round(fps, 3),
            "elapsed_sec": elapsed_sec,
            "class_counts": class_counts,
            "input_file": str(input_path.resolve()),
            "output_file": str(output_path.resolve()),
            "input_url": self._to_route_url(input_path),
            "output_url": self._to_route_url(output_path),
        }
