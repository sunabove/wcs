import shutil
import time
import uuid
import json
from pathlib import Path

import cv2
from ultralytics import SAM, YOLO

from config import BASE_DIR
from sam2.Sam2VideoConfig import (
    SAM2_DEFAULT_MODEL,
    SAM2_OUTPUT_DIR,
    SAM2_UPLOAD_DIR,
    SAM2_VIDEO_EXTENSIONS,
)


class Sam2VideoDetector:
    _model_cache = {}
    _target_infer_stride = {
        "road": 2,
        "pothole": 2,
        "curb_step": 2,
    }
    _target_class_keywords = {
        "pothole": ("pothole", "pot_hole", "hole"),
        "curb_step": (
            "curb",
            "curbstone",
            "kerb",
            "step",
            "stair",
            "stairs",
            "sidewalk",
            "gutter",
            "edge",
            "bump",
            "hump",
            "speedbump",
            "speed_bump",
        ),
    }

    def __init__(self):
        SAM2_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        SAM2_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    def _to_route_url(self, file_path: Path) -> str:
        base_dir = BASE_DIR.resolve()
        try:
            relative = file_path.resolve().relative_to(base_dir).as_posix()
        except ValueError:
            relative = file_path.name
        return f"/fast/image/{relative}"

    def _get_model(self, model_name: str):
        normalized = str(model_name or "").strip() or SAM2_DEFAULT_MODEL
        engine = "sam" if "sam" in normalized.lower() else "yolo"
        cache_key = f"{engine}:{normalized}"
        if cache_key not in self._model_cache:
            requested_path = Path(normalized)
            is_local_pt_path = requested_path.suffix.lower() == ".pt" and (
                requested_path.is_absolute() or "/" in normalized or "\\" in normalized
            )

            model_cls = SAM if engine == "sam" else YOLO

            if is_local_pt_path and not requested_path.exists():
                requested_path.parent.mkdir(parents=True, exist_ok=True)

                downloaded_model = model_cls(requested_path.name)
                ckpt_path = getattr(downloaded_model, "ckpt_path", None)

                if ckpt_path:
                    source_path = Path(str(ckpt_path)).resolve()
                    if source_path.exists() and source_path != requested_path.resolve():
                        try:
                            shutil.copy2(source_path, requested_path)
                        except OSError:
                            pass

                if requested_path.exists():
                    self._model_cache[cache_key] = model_cls(str(requested_path))
                else:
                    self._model_cache[cache_key] = downloaded_model
            else:
                self._model_cache[cache_key] = model_cls(normalized)
        return self._model_cache[cache_key]

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

    def _normalize_class_name(self, name_text: str) -> str:
        return ''.join(ch for ch in str(name_text or '').strip().lower() if ch.isalnum())

    def _resolve_target_classes(self, model, target_type: str):
        target_key = str(target_type or '').strip().lower()
        if target_key == 'road':
            return None

        keywords = self._target_class_keywords.get(target_key)
        if not keywords:
            return None

        normalized_keywords = [self._normalize_class_name(keyword) for keyword in keywords if keyword]
        names = getattr(model, 'names', None)
        if not isinstance(names, dict) or not names:
            return []

        matched_ids = []
        for class_id, class_name in names.items():
            normalized_name = self._normalize_class_name(class_name)
            if not normalized_name:
                continue
            if any(keyword in normalized_name for keyword in normalized_keywords):
                try:
                    matched_ids.append(int(class_id))
                except (TypeError, ValueError):
                    continue

        return sorted(set(matched_ids))

    def _parse_bbox(self, bbox, width: int, height: int):
        if bbox is None:
            return None, None

        raw_value = bbox
        if isinstance(raw_value, str):
            text = raw_value.strip()
            if not text:
                return None, None
            try:
                raw_value = json.loads(text)
            except Exception as ex:
                raise ValueError(f"Invalid bbox JSON: {ex}") from ex

        if not isinstance(raw_value, dict):
            raise ValueError("bbox must be an object with x, y, w, h")

        try:
            x = float(raw_value.get("x"))
            y = float(raw_value.get("y"))
            w = float(raw_value.get("w"))
            h = float(raw_value.get("h"))
        except (TypeError, ValueError) as ex:
            raise ValueError("bbox values must be numbers") from ex

        if w <= 0 or h <= 0:
            raise ValueError("bbox width and height must be greater than 0")

        x1_norm = max(0.0, min(100.0, x))
        y1_norm = max(0.0, min(100.0, y))
        x2_norm = max(0.0, min(100.0, x + w))
        y2_norm = max(0.0, min(100.0, y + h))
        if x2_norm <= x1_norm or y2_norm <= y1_norm:
            raise ValueError("bbox area is empty after normalization")

        x1 = int(round((x1_norm / 100.0) * width))
        y1 = int(round((y1_norm / 100.0) * height))
        x2 = int(round((x2_norm / 100.0) * width))
        y2 = int(round((y2_norm / 100.0) * height))

        x1 = max(0, min(width - 1, x1))
        y1 = max(0, min(height - 1, y1))
        x2 = max(1, min(width, x2))
        y2 = max(1, min(height, y2))
        if x2 <= x1:
            x2 = min(width, x1 + 1)
        if y2 <= y1:
            y2 = min(height, y1 + 1)

        normalized_bbox = {
            "x": round(x1_norm, 3),
            "y": round(y1_norm, 3),
            "w": round(x2_norm - x1_norm, 3),
            "h": round(y2_norm - y1_norm, 3),
        }
        return (x1, y1, x2, y2), normalized_bbox

    def _overlay_bbox_result(self, frame, roi_plotted, bbox_rect):
        if bbox_rect is None:
            return roi_plotted

        x1, y1, x2, y2 = bbox_rect
        composed = frame.copy()
        roi_w = max(1, x2 - x1)
        roi_h = max(1, y2 - y1)
        if roi_plotted.shape[1] != roi_w or roi_plotted.shape[0] != roi_h:
            roi_plotted = cv2.resize(roi_plotted, (roi_w, roi_h), interpolation=cv2.INTER_AREA)

        composed[y1:y2, x1:x2] = roi_plotted
        cv2.rectangle(composed, (x1, y1), (x2 - 1, y2 - 1), (13, 110, 253), 1)
        return composed

    def detect_video_file(
        self,
        input_path: Path,
        target_type: str = "road",
        conf: float = 0.25,
        max_det: int = 300,
        model_name: str = SAM2_DEFAULT_MODEL,
        bbox=None,
    ):
        resolved_input = Path(input_path).resolve()
        suffix = resolved_input.suffix.lower()
        if suffix not in SAM2_VIDEO_EXTENSIONS:
            raise ValueError("Only video files are supported")

        if not resolved_input.exists() or not resolved_input.is_file():
            raise FileNotFoundError(f"Input video not found: {resolved_input}")

        job_id = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        output_path = SAM2_OUTPUT_DIR / f"{job_id}_{target_type}_segmented.mp4"

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

        bbox_rect, normalized_bbox = self._parse_bbox(bbox, width, height)

        writer = self._create_video_writer(output_path, fps, width, height)
        if writer is None:
            capture.release()
            raise RuntimeError("Failed to create output video")

        start_time = time.time()
        model = self._get_model(model_name)
        target_classes = self._resolve_target_classes(model, target_type)
        processed_frames = 0
        total_segments = 0
        infer_stride = max(1, int(self._target_infer_stride.get(str(target_type), 2)))
        last_plotted = None

        try:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break

                if isinstance(target_classes, list) and len(target_classes) == 0:
                    plotted = frame.copy()
                    if bbox_rect is not None:
                        x1, y1, x2, y2 = bbox_rect
                        cv2.rectangle(plotted, (x1, y1), (x2 - 1, y2 - 1), (13, 110, 253), 1)
                    if plotted.shape[1] != width or plotted.shape[0] != height:
                        plotted = cv2.resize(plotted, (width, height), interpolation=cv2.INTER_AREA)
                    writer.write(plotted)
                    processed_frames += 1
                    continue

                if processed_frames % infer_stride == 0 or last_plotted is None:
                    source_frame = frame
                    if bbox_rect is not None:
                        x1, y1, x2, y2 = bbox_rect
                        source_frame = frame[y1:y2, x1:x2]

                    predict_kwargs = {
                        "source": source_frame,
                        "conf": conf,
                        "verbose": False,
                    }
                    if isinstance(target_classes, list):
                        predict_kwargs["classes"] = target_classes

                    result = model.predict(**predict_kwargs)[0]

                    masks = getattr(result, "masks", None)
                    if masks is not None and getattr(masks, "data", None) is not None:
                        total_segments += int(masks.data.shape[0])

                    plotted = result.plot()
                    plotted = self._overlay_bbox_result(frame, plotted, bbox_rect)
                    last_plotted = plotted
                else:
                    plotted = last_plotted.copy() if last_plotted is not None else frame

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
            "target_type": str(target_type),
            "model": str(model_name or SAM2_DEFAULT_MODEL),
            "processed_frames": processed_frames,
            "input_total_frames": total_frames,
            "fps": round(fps, 3),
            "elapsed_sec": elapsed_sec,
            "segment_count": int(total_segments),
            "bbox": normalized_bbox,
            "input_file": str(resolved_input),
            "output_file": str(output_path.resolve()),
            "input_url": self._to_route_url(resolved_input),
            "output_url": self._to_route_url(output_path),
        }
