import json
import importlib
import os
import sys
import time
import uuid
from pathlib import Path

import cv2
import numpy as np
import torch

from config import BASE_DIR
from ChartRenderer import ChartRenderer
from sam2.Sam2VideoConfig import (
    SAM2_DEFAULT_MODEL,
    SAM2_OUTPUT_DIR,
    SAM2_UPLOAD_DIR,
    SAM2_VIDEO_EXTENSIONS,
)


class Sam2VideoDetector:
    _chart_renderer = ChartRenderer()
    _model_cache = {}
    _sam2_image_predictor_class = None
    _max_infer_side = 960
    _max_infer_fps = 10.0
    _max_infer_frames = 600
    _max_infer_pixels_total = 320_000_000

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

    def _load_sam2_image_predictor_class(self):
        if self.__class__._sam2_image_predictor_class is not None:
            return self.__class__._sam2_image_predictor_class

        module = self._load_external_sam2_module("sam2.sam2_image_predictor")
        predictor_class = module.SAM2ImagePredictor
        self.__class__._sam2_image_predictor_class = predictor_class
        return predictor_class

    def _load_external_sam2_module(self, module_name: str):
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
            return importlib.import_module(module_name)
        finally:
            sys.path = original_sys_path
            for name, module in restored_modules.items():
                sys.modules.setdefault(name, module)

    def _build_model_from_hf_model_id(self, model_id: str, device: str):
        build_sam_module = self._load_external_sam2_module("sam2.build_sam")
        hf_map = getattr(build_sam_module, "HF_MODEL_ID_TO_FILENAMES", {})
        if model_id not in hf_map:
            raise ValueError(f"Unsupported SAM2 model id: {model_id}")

        config_name, checkpoint_name = hf_map[model_id]

        from huggingface_hub import hf_hub_download

        offline_text = str(os.getenv("HF_HUB_OFFLINE", "")).strip().lower()
        local_files_only = offline_text in {"1", "true", "yes", "on"}

        ckpt_path = hf_hub_download(
            repo_id=model_id,
            filename=checkpoint_name,
            local_files_only=local_files_only,
        )

        build_image_model = getattr(build_sam_module, "build_sam2")
        image_model = build_image_model(
            config_file=config_name,
            ckpt_path=ckpt_path,
            device=device,
        )
        predictor_class = self._load_sam2_image_predictor_class()
        return predictor_class(image_model)

    def _get_model(self, model_name: str):
        normalized = str(model_name or "").strip() or SAM2_DEFAULT_MODEL
        cache_key = f"sam2:{normalized}"
        if cache_key not in self._model_cache:
            device = "cuda" if torch.cuda.is_available() else "cpu"
            if normalized.startswith("facebook/"):
                self._model_cache[cache_key] = self._build_model_from_hf_model_id(normalized, device)
            else:
                predictor_class = self._load_sam2_image_predictor_class()
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

    def _prepare_video_for_inference(self, input_path: Path, job_id: str):
        capture = cv2.VideoCapture(str(input_path))
        if not capture.isOpened():
            raise RuntimeError("Failed to open uploaded video")

        try:
            src_fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
            if src_fps <= 0:
                src_fps = 20.0

            src_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            src_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            src_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            if src_width <= 0 or src_height <= 0:
                raise RuntimeError("Invalid video size")

            longest_side = max(src_width, src_height)
            resize_ratio = 1.0
            if longest_side > self._max_infer_side:
                resize_ratio = self._max_infer_side / float(longest_side)

            dst_width = max(2, int(round(src_width * resize_ratio)))
            dst_height = max(2, int(round(src_height * resize_ratio)))
            dst_width += dst_width % 2
            dst_height += dst_height % 2

            target_fps = min(src_fps, self._max_infer_fps)
            frame_step = max(1, int(round(src_fps / max(0.1, target_fps))))

            estimated_out_frames = src_frames // frame_step if src_frames > 0 else self._max_infer_frames
            requires_optimize = (
                resize_ratio < 1.0
                or frame_step > 1
                or (src_frames > 0 and estimated_out_frames > self._max_infer_frames)
                or (src_frames > 0 and (src_width * src_height * src_frames) > self._max_infer_pixels_total)
            )

            if not requires_optimize:
                return {
                    "path": input_path,
                    "cleanup": False,
                    "optimized": False,
                    "fps": src_fps,
                    "width": src_width,
                    "height": src_height,
                }

            SAM2_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            optimized_path = SAM2_UPLOAD_DIR / f"_{job_id}.sam2_optimized.mp4"
            writer = self._create_video_writer(optimized_path, target_fps, dst_width, dst_height)
            if writer is None:
                raise RuntimeError("Failed to create optimized inference video")

            written = 0
            frame_index = 0
            try:
                while True:
                    ok, frame = capture.read()
                    if not ok:
                        break

                    if frame_index % frame_step != 0:
                        frame_index += 1
                        continue

                    if dst_width != src_width or dst_height != src_height:
                        frame = cv2.resize(frame, (dst_width, dst_height), interpolation=cv2.INTER_AREA)

                    writer.write(frame)
                    written += 1
                    frame_index += 1

                    if written >= self._max_infer_frames:
                        break
            finally:
                writer.release()

            if written <= 0 or not optimized_path.exists() or optimized_path.stat().st_size <= 0:
                try:
                    optimized_path.unlink(missing_ok=True)
                except OSError:
                    pass
                raise RuntimeError("Failed to prepare video for SAM2 inference")

            return {
                "path": optimized_path,
                "cleanup": True,
                "optimized": True,
                "fps": target_fps,
                "width": dst_width,
                "height": dst_height,
            }
        finally:
            capture.release()

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

    def _parse_points(self, points, width: int, height: int, point_labels=None):
        if points is None:
            return None

        raw_value = points
        if isinstance(raw_value, str):
            text = raw_value.strip()
            if not text:
                return None
            try:
                raw_value = json.loads(text)
            except Exception as ex:
                raise ValueError(f"Invalid points JSON: {ex}") from ex

        if not isinstance(raw_value, list):
            raise ValueError("points must be an array of x, y objects")
        if not raw_value:
            return None

        raw_labels = point_labels
        if isinstance(raw_labels, str):
            text = raw_labels.strip()
            if text:
                try:
                    raw_labels = json.loads(text)
                except Exception as ex:
                    raise ValueError(f"Invalid point_labels JSON: {ex}") from ex
            else:
                raw_labels = None

        if raw_labels is not None and not isinstance(raw_labels, list):
            raise ValueError("point_labels must be an array")
        if raw_labels is not None and len(raw_labels) != len(raw_value):
            raise ValueError("point_labels must have the same length as points")

        pixel_points = []
        labels = []
        for raw_point in raw_value:
            if not isinstance(raw_point, dict):
                raise ValueError("each point must be an object with x and y")
            try:
                x = float(raw_point.get("x"))
                y = float(raw_point.get("y"))
            except (TypeError, ValueError) as ex:
                raise ValueError("point values must be numbers") from ex

            x = max(0.0, min(100.0, x))
            y = max(0.0, min(100.0, y))
            pixel_points.append([
                (x / 100.0) * width,
                (y / 100.0) * height,
            ])
            label_index = len(labels)
            raw_label = (
                raw_labels[label_index]
                if raw_labels is not None
                else raw_point.get("label", 1 if label_index % 2 == 0 else 0)
            )
            try:
                label = int(raw_label)
            except (TypeError, ValueError) as ex:
                raise ValueError("point labels must be 0 or 1") from ex
            if label not in (0, 1):
                raise ValueError("point labels must be 0 or 1")
            labels.append(label)

        return np.asarray(pixel_points, dtype=np.float32), np.asarray(labels, dtype=np.int32)

    def _first_score_value(self, scores):
        if scores is None:
            return None

        try:
            if hasattr(scores, "detach"):
                scores = scores.detach().to("cpu").numpy()
            value = float(np.asarray(scores).reshape(-1)[0])
        except (TypeError, ValueError, IndexError):
            return None

        return value if np.isfinite(value) else None

    def _draw_bbox_score(self, image, bbox_rect, score):
        if bbox_rect is None or score is None:
            return

        x1, y1, _x2, _y2 = bbox_rect
        label = f"Score: {score:.3f}"
        (text_width, text_height), baseline = cv2.getTextSize(
            label,
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            1,
        )
        label_x = max(0, x1)
        label_y = max(text_height + baseline, y1)
        cv2.rectangle(
            image,
            (label_x, label_y - text_height - baseline),
            (label_x + text_width, label_y),
            (13, 110, 253),
            cv2.FILLED,
        )
        cv2.putText(
            image,
            label,
            (label_x, label_y - baseline),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )

    def _draw_option_summary(self, image, mask_input, multimask_output):
        label = (
            f"Mask input: {'On' if mask_input else 'Off'} | "
            f"Multimask output: {'On' if multimask_output else 'Off'}"
        )
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.5
        thickness = 1
        (text_width, text_height), baseline = cv2.getTextSize(label, font, font_scale, thickness)
        padding_x = 8
        padding_y = 6
        x = padding_x
        y = padding_y + text_height + baseline
        top = 0
        right = min(image.shape[1], x + text_width + padding_x)
        bottom = min(image.shape[0], y + padding_y)
        cv2.rectangle(image, (0, top), (right, bottom), (80, 45, 25), cv2.FILLED)
        cv2.putText(
            image,
            label,
            (x, y - baseline),
            font,
            font_scale,
            (255, 255, 255),
            thickness,
            cv2.LINE_AA,
        )

    def _render_score_chart(self, frame, score_history, frame_number, total_frames):
        if frame is None:
            return frame

        height, width = frame.shape[:2]
        panel_height = min(120, max(48, height // 3))
        canvas = frame.copy()

        panel_x1 = 8
        panel_x2 = max(panel_x1 + 120, width - 8)
        panel_y1 = max(0, height - panel_height)
        panel_y2 = height - 6
        chart_x1 = panel_x1 + 42
        chart_x2 = panel_x2 - 10
        chart_y1 = panel_y1 + 25
        chart_y2 = panel_y2 - 22
        if chart_x2 <= chart_x1 or chart_y2 <= chart_y1:
            return canvas

        cv2.rectangle(canvas, (panel_x1, panel_y1), (panel_x2, panel_y2), (36, 36, 36), cv2.FILLED)
        cv2.rectangle(canvas, (chart_x1, chart_y1), (chart_x2, chart_y2), (44, 44, 44), cv2.FILLED)
        cv2.rectangle(canvas, (chart_x1, chart_y1), (chart_x2, chart_y2), (100, 100, 100), 1)

        for score_tick in (0.0, 0.5, 1.0):
            tick_y = self._chart_renderer._map_chart_y(score_tick, 1.0, chart_y2, chart_y2 - chart_y1)
            cv2.line(canvas, (chart_x1, tick_y), (chart_x2, tick_y), (65, 65, 65), 1, cv2.LINE_AA)
            tick_label = f"{score_tick:.1f}"
            (tick_width, _tick_height), _baseline = cv2.getTextSize(
                tick_label,
                cv2.FONT_HERSHEY_SIMPLEX,
                0.35,
                1,
            )
            cv2.putText(
                canvas,
                tick_label,
                (max(0, chart_x1 - tick_width - 6), tick_y + 4),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.35,
                (190, 190, 190),
                1,
                cv2.LINE_AA,
            )

        x_min = 1.0
        x_max = float(max(1, int(total_frames or frame_number)))
        if x_max <= x_min:
            x_max = x_min + 1.0
        x_values = np.arange(1, len(score_history) + 1, dtype=np.float32)
        self._chart_renderer._draw_chart_series(
            canvas,
            x_values,
            np.asarray(score_history, dtype=np.float32),
            (80, 255, 80),
            x_min,
            x_max,
            chart_x1,
            chart_x2 - chart_x1,
            1.0,
            chart_y2,
            chart_y2 - chart_y1,
            2,
        )

        current_x = self._chart_renderer._map_chart_x(
            frame_number,
            x_min,
            x_max,
            chart_x1,
            chart_x2 - chart_x1,
        )
        cv2.line(canvas, (current_x, chart_y1), (current_x, chart_y2), (255, 230, 0), 1, cv2.LINE_AA)
        return canvas

    def _overlay_bbox_result(self, frame, roi_plotted, bbox_rect, score=None):
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
        self._draw_bbox_score(composed, bbox_rect, score)
        return composed

    def _overlay_mask_result(self, frame, mask_tensor, bbox_rect=None, score=None):
        if mask_tensor is None:
            return self._overlay_bbox_result(frame, frame, bbox_rect, score)

        if isinstance(mask_tensor, np.ndarray):
            mask = mask_tensor
        elif hasattr(mask_tensor, "detach"):
            mask = mask_tensor.detach().to("cpu").numpy()
        else:
            mask = np.array(mask_tensor)

        if mask.ndim == 3:
            mask = mask[0]
        if mask.ndim != 2:
            return self._overlay_bbox_result(frame, frame, bbox_rect, score)

        mask_np = mask > 0
        if not np.any(mask_np):
            return self._overlay_bbox_result(frame, frame, bbox_rect, score)

        overlay = frame.copy()
        color = np.array([13, 110, 253], dtype=np.float32)
        overlay_pixels = overlay[mask_np].astype(np.float32)
        overlay[mask_np] = np.clip(overlay_pixels * 0.35 + color * 0.65, 0, 255).astype(np.uint8)
        if bbox_rect is not None:
            x1, y1, x2, y2 = bbox_rect
            cv2.rectangle(overlay, (x1, y1), (x2 - 1, y2 - 1), (13, 110, 253), 1)
            self._draw_bbox_score(overlay, bbox_rect, score)
        return overlay

    def detect_video_file(
        self,
        input_path: Path,
        model_name: str = SAM2_DEFAULT_MODEL,
        bbox=None,
        points=None,
        point_labels=None,
        multimask_output=False,
        mask_input=True,
        progress_callback=None,
    ):
        resolved_input = Path(input_path).resolve()
        suffix = resolved_input.suffix.lower()
        if suffix not in SAM2_VIDEO_EXTENSIONS:
            raise ValueError("Only video files are supported")

        if not resolved_input.exists() or not resolved_input.is_file():
            raise FileNotFoundError(f"Input video not found: {resolved_input}")

        job_id = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        output_path = SAM2_OUTPUT_DIR / f"{job_id}_segmented.mp4"

        prepared = self._prepare_video_for_inference(resolved_input, job_id)
        prepared_path = Path(prepared["path"])
        capture = cv2.VideoCapture(str(prepared_path))
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
        x1, y1, x2, y2 = bbox_rect
        box_prompt = np.array([x1, y1, x2, y2], dtype=np.float32)
        point_prompt = self._parse_points(points, width, height, point_labels)
        previous_mask_input = None

        tracked_frames = 0
        total_segments = 0
        score_history = []

        try:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break

                try:
                    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    model.set_image(rgb_frame)
                    predict_kwargs = {
                        "box": box_prompt,
                        "multimask_output": bool(multimask_output),
                    }
                    if mask_input and previous_mask_input is not None:
                        predict_kwargs["mask_input"] = previous_mask_input
                    if point_prompt is not None:
                        predict_kwargs["point_coords"], predict_kwargs["point_labels"] = point_prompt
                    masks, scores, _logits = model.predict(**predict_kwargs)
                    detection_score = self._first_score_value(scores)
                    if mask_input and _logits is not None:
                        previous_mask_input = _logits[:1] if getattr(_logits, "ndim", 0) == 3 else _logits
                    else:
                        previous_mask_input = None
                    mask_tensor = masks[0] if isinstance(masks, np.ndarray) and masks.ndim == 3 else masks
                    if mask_tensor is not None:
                        total_segments += 1
                except RuntimeError as ex:
                    message = str(ex)
                    if "can't allocate memory" in message.lower() or "cannot allocate memory" in message.lower():
                        raise RuntimeError(
                            "메모리가 부족합니다. 더 짧은 영상을 사용하거나 해상도를 낮춘 뒤 다시 시도하세요."
                        ) from ex
                    raise

                plotted = self._overlay_mask_result(frame, mask_tensor, bbox_rect, detection_score)

                if plotted.shape[1] != width or plotted.shape[0] != height:
                    plotted = cv2.resize(plotted, (width, height), interpolation=cv2.INTER_AREA)

                self._draw_option_summary(
                    plotted,
                    mask_input,
                    multimask_output,
                )
                tracked_frames += 1
                score_history.append(max(0.0, min(1.0, float(detection_score or 0.0))))
                plotted = self._render_score_chart(
                    plotted,
                    score_history,
                    tracked_frames,
                    total_frames,
                )
                writer.write(plotted)
                if progress_callback is not None and total_frames > 0:
                    progress_callback(tracked_frames, total_frames)
        finally:
            capture.release()
            writer.release()
            if prepared.get("cleanup"):
                try:
                    prepared_path.unlink(missing_ok=True)
                except OSError:
                    pass

        if tracked_frames <= 0:
            raise RuntimeError("No frames were processed")

        elapsed_sec = round(time.time() - start_time, 3)
        return {
            "job_id": job_id,
            "model": str(model_name or SAM2_DEFAULT_MODEL),
            "processed_frames": tracked_frames,
            "input_total_frames": total_frames,
            "fps": round(fps, 3),
            "elapsed_sec": elapsed_sec,
            "segment_count": int(total_segments),
            "bbox": normalized_bbox,
            "optimized_input": bool(prepared.get("optimized")),
            "input_file": str(resolved_input),
            "output_file": str(output_path.resolve()),
            "input_url": self._to_route_url(resolved_input),
            "output_url": self._to_route_url(output_path),
        }
