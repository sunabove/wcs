import json
import importlib
import shutil
import sys
import time
import uuid
from pathlib import Path

import cv2
import numpy as np
import torch

from config import BASE_DIR
from sam2.Sam2VideoConfig import (
    SAM2_DEFAULT_MODEL,
    SAM2_OUTPUT_DIR,
    SAM2_UPLOAD_DIR,
    SAM2_VIDEO_EXTENSIONS,
)


class Sam2VideoDetector:
    _model_cache = {}
    _sam2_predictor_class = None

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

    def _load_sam2_predictor_class(self):
        if self.__class__._sam2_predictor_class is not None:
            return self.__class__._sam2_predictor_class

        local_root = Path(__file__).resolve().parents[1]
        original_sys_path = list(sys.path)
        restored_modules = {
            name: sys.modules[name]
            for name in list(sys.modules.keys())
            if name == "sam2" or name.startswith("sam2.")
        }

        try:
            for name in list(restored_modules.keys()):
                sys.modules.pop(name, None)

            filtered_path = []
            for entry in original_sys_path:
                if not entry:
                    continue
                try:
                    if Path(entry).resolve() == local_root:
                        continue
                except OSError:
                    pass
                filtered_path.append(entry)

            sys.path = filtered_path
            module = importlib.import_module("sam2.sam2_video_predictor")
            predictor_class = module.SAM2VideoPredictor
            self.__class__._sam2_predictor_class = predictor_class
            return predictor_class
        finally:
            sys.path = original_sys_path
            for name, module in restored_modules.items():
                sys.modules.setdefault(name, module)

    def _get_model(self, model_name: str):
        normalized = str(model_name or "").strip() or SAM2_DEFAULT_MODEL
        cache_key = f"sam2:{normalized}"
        if cache_key not in self._model_cache:
            predictor_class = self._load_sam2_predictor_class()
            device = "cuda" if torch.cuda.is_available() else "cpu"
            self._model_cache[cache_key] = predictor_class.from_pretrained(
                normalized,
                device=device,
            )
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

    def _overlay_mask_result(self, frame, mask_tensor, bbox_rect=None):
        if mask_tensor is None:
            return self._overlay_bbox_result(frame, frame, bbox_rect)

        mask = mask_tensor.detach().to("cpu")
        if mask.ndim == 3:
            mask = mask[0]
        if mask.ndim != 2:
            return self._overlay_bbox_result(frame, frame, bbox_rect)

        mask_np = mask.numpy() > 0
        if not np.any(mask_np):
            return self._overlay_bbox_result(frame, frame, bbox_rect)

        overlay = frame.copy()
        color = np.array([13, 110, 253], dtype=np.float32)
        overlay_pixels = overlay[mask_np].astype(np.float32)
        overlay[mask_np] = np.clip(overlay_pixels * 0.35 + color * 0.65, 0, 255).astype(np.uint8)
        if bbox_rect is not None:
            x1, y1, x2, y2 = bbox_rect
            cv2.rectangle(overlay, (x1, y1), (x2 - 1, y2 - 1), (13, 110, 253), 1)
        return overlay

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
        if bbox_rect is None:
            bbox_rect = (0, 0, width, height)
            normalized_bbox = {
                "x": 0.0,
                "y": 0.0,
                "w": 100.0,
                "h": 100.0,
            }

        writer = self._create_video_writer(output_path, fps, width, height)
        if writer is None:
            capture.release()
            raise RuntimeError("Failed to create output video")

        start_time = time.time()
        model = self._get_model(model_name)
        inference_state = model.init_state(str(resolved_input))
        x1, y1, x2, y2 = bbox_rect
        model.add_new_points_or_box(
            inference_state=inference_state,
            frame_idx=0,
            obj_id=1,
            box=[x1, y1, x2, y2],
        )

        tracked_frames = 0
        total_segments = 0

        try:
            for frame_idx, _obj_ids, video_res_masks in model.propagate_in_video(inference_state):
                ok, frame = capture.read()
                if not ok:
                    break

                mask_tensor = video_res_masks[0] if hasattr(video_res_masks, "shape") and len(video_res_masks.shape) == 4 else video_res_masks
                if mask_tensor is not None and hasattr(mask_tensor, "detach"):
                    total_segments += 1

                plotted = self._overlay_mask_result(frame, mask_tensor, bbox_rect)

                if plotted.shape[1] != width or plotted.shape[0] != height:
                    plotted = cv2.resize(plotted, (width, height), interpolation=cv2.INTER_AREA)

                writer.write(plotted)
                tracked_frames += 1
        finally:
            capture.release()
            writer.release()

        if tracked_frames <= 0:
            raise RuntimeError("No frames were processed")

        elapsed_sec = round(time.time() - start_time, 3)

        return {
            "job_id": job_id,
            "target_type": str(target_type),
            "model": str(model_name or SAM2_DEFAULT_MODEL),
            "processed_frames": tracked_frames,
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
