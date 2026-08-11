import json
import importlib
import os
import re
import shutil
import sys
import time
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
    SAM2_YOLO_DIR,
    SAM2_VIDEO_EXTENSIONS,
)


class Sam2VideoDetector:
    _chart_renderer = ChartRenderer()
    _model_cache = {}
    _yolo_conversion_cache = {}
    _sam2_image_predictor_class = None
    _sam2_video_predictor_class = None
    _max_infer_side = 960
    _max_infer_fps = 10.0
    _max_infer_frames = 600
    _max_infer_pixels_total = 320_000_000
    _score_plateau_area_ratio_threshold = 0.86
    _score_plateau_first_derivative_threshold = 0.04
    _score_plateau_second_derivative_threshold = 0.18

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

    def _yolo_conversion_cache_path(self, input_path: Path) -> Path:
        return SAM2_OUTPUT_DIR / f"{Path(input_path).stem}.sam2_yolo_cache.npz"

    def _save_yolo_conversion_cache(self, input_path: Path, cache: dict) -> bool:
        cache_path = self._yolo_conversion_cache_path(input_path)
        mask_history = cache.get("mask_history", [])
        mask_shape = next(
            (np.asarray(mask).shape for mask in mask_history if mask is not None),
            None,
        )
        if cache.get("detection_threshold") is None or not mask_shape or len(mask_shape) != 2:
            cache_path.unlink(missing_ok=True)
            return False

        height, width = int(mask_shape[0]), int(mask_shape[1])
        valid_masks = np.asarray([mask is not None for mask in mask_history], dtype=np.bool_)
        packed_masks = np.packbits(
            np.stack([
                np.asarray(mask, dtype=np.bool_) if mask is not None else np.zeros((height, width), dtype=np.bool_)
                for mask in mask_history
            ]).reshape(len(mask_history), -1),
            axis=1,
        )
        temporary_path = cache_path.with_suffix(".tmp.npz")
        np.savez_compressed(
            temporary_path,
            source_video_path=np.asarray(str(cache["source_video_path"])),
            cleanup_source=np.asarray(bool(cache.get("cleanup_source")), dtype=np.bool_),
            score_history=np.asarray(cache.get("score_history", []), dtype=np.float32),
            detection_threshold=np.asarray(float(cache["detection_threshold"]), dtype=np.float32),
            mask_shape=np.asarray([height, width], dtype=np.int32),
            valid_masks=valid_masks,
            packed_masks=packed_masks,
        )
        temporary_path.replace(cache_path)
        return True

    def _load_yolo_conversion_cache(self, input_path: Path):
        resolved_input = Path(input_path).resolve()
        memory_cache = self._yolo_conversion_cache.get(str(resolved_input))
        if memory_cache and Path(memory_cache["source_video_path"]).is_file():
            return memory_cache

        cache_path = self._yolo_conversion_cache_path(resolved_input)
        if not cache_path.is_file():
            return None

        try:
            with np.load(cache_path, allow_pickle=False) as saved:
                source_video_path = Path(str(saved["source_video_path"].item()))
                if not source_video_path.is_file():
                    cache_path.unlink(missing_ok=True)
                    return None
                height, width = (int(value) for value in saved["mask_shape"])
                valid_masks = saved["valid_masks"].astype(np.bool_)
                unpacked_masks = np.unpackbits(
                    saved["packed_masks"],
                    axis=1,
                    count=height * width,
                ).reshape(-1, height, width).astype(np.bool_)
                cache = {
                    "source_video_path": str(source_video_path),
                    "cleanup_source": bool(saved["cleanup_source"].item()),
                    "score_history": saved["score_history"].astype(np.float32).tolist(),
                    "mask_history": [
                        unpacked_masks[index] if is_valid else None
                        for index, is_valid in enumerate(valid_masks)
                    ],
                    "detection_threshold": float(saved["detection_threshold"].item()),
                }
        except (OSError, ValueError, KeyError):
            return None

        self._yolo_conversion_cache[str(resolved_input)] = cache
        return cache

    def has_yolo_conversion_cache(self, input_path: Path) -> bool:
        resolved_input = Path(input_path).resolve()
        memory_cache = self._yolo_conversion_cache.get(str(resolved_input))
        if memory_cache:
            return (
                memory_cache.get("detection_threshold") is not None
                and Path(memory_cache["source_video_path"]).is_file()
            )

        cache_path = self._yolo_conversion_cache_path(resolved_input)
        if not cache_path.is_file():
            return False
        try:
            with np.load(cache_path, allow_pickle=False) as saved:
                return bool(
                    Path(str(saved["source_video_path"].item())).is_file()
                    and np.isfinite(float(saved["detection_threshold"].item()))
                )
        except (OSError, ValueError, KeyError):
            return False

    def has_yolo_dataset(self, input_path: Path) -> bool:
        input_stem = Path(input_path).stem
        images_dir = SAM2_YOLO_DIR / "images" / "train"
        labels_dir = SAM2_YOLO_DIR / "labels" / "train"
        masks_dir = SAM2_YOLO_DIR / "masks" / "train"
        if not images_dir.is_dir() or not labels_dir.is_dir() or not masks_dir.is_dir():
            return False

        file_prefix = f"{input_stem}_"
        for image_path in images_dir.iterdir():
            if not image_path.is_file() or image_path.suffix.lower() != ".jpg":
                continue
            if not image_path.name.startswith(file_prefix):
                continue
            output_stem = image_path.stem
            if (labels_dir / f"{output_stem}.txt").is_file() and (masks_dir / f"{output_stem}.png").is_file():
                return True
        return False

    def list_yolo_dataset_frames(self, input_path: Path):
        input_stem = Path(input_path).stem
        images_dir = SAM2_YOLO_DIR / "images" / "train"
        labels_dir = SAM2_YOLO_DIR / "labels" / "train"
        masks_dir = SAM2_YOLO_DIR / "masks" / "train"
        if not images_dir.is_dir() or not labels_dir.is_dir() or not masks_dir.is_dir():
            return []

        file_prefix = f"{input_stem}_"
        frames = []
        for image_path in sorted(images_dir.glob(f"{file_prefix}*.jpg")):
            output_stem = image_path.stem
            label_path = labels_dir / f"{output_stem}.txt"
            mask_path = masks_dir / f"{output_stem}.png"
            if not label_path.is_file() or not mask_path.is_file():
                continue
            frame_text = output_stem[len(file_prefix):]
            if not frame_text.isdigit():
                continue
            frames.append({
                "frame_index": int(frame_text),
                "image_url": self._to_route_url(image_path),
                "label_url": self._to_route_url(label_path),
                "mask_url": self._to_route_url(mask_path),
            })
        return frames

    def get_yolo_dataset_summary(self):
        registry_path = SAM2_YOLO_DIR / "classes.json"
        class_names = []
        if registry_path.is_file():
            try:
                saved_names = json.loads(registry_path.read_text(encoding="utf-8"))
                if isinstance(saved_names, list):
                    class_names = [str(name) for name in saved_names if str(name).strip()]
            except (OSError, json.JSONDecodeError):
                class_names = []

        images_dir = SAM2_YOLO_DIR / "images" / "train"
        labels_dir = SAM2_YOLO_DIR / "labels" / "train"
        masks_dir = SAM2_YOLO_DIR / "masks" / "train"
        input_file_stems = set()
        frame_count = 0
        segment_count = 0
        if images_dir.is_dir() and labels_dir.is_dir() and masks_dir.is_dir():
            for image_path in images_dir.glob("*.jpg"):
                output_stem = image_path.stem
                label_path = labels_dir / f"{output_stem}.txt"
                mask_path = masks_dir / f"{output_stem}.png"
                if not label_path.is_file() or not mask_path.is_file():
                    continue
                match = re.fullmatch(r"(.+)_\d+", output_stem)
                if match:
                    input_file_stems.add(match.group(1))
                frame_count += 1
                try:
                    segment_count += sum(
                        1
                        for line in label_path.read_text(encoding="utf-8").splitlines()
                        if line.strip()
                    )
                except OSError:
                    continue

        return {
            "class_count": len(class_names),
            "class_names": class_names,
            "input_file_count": len(input_file_stems),
            "frame_count": frame_count,
            "segment_count": segment_count,
        }

    def ensure_yolo_dataset_yaml(self):
        registry_path = SAM2_YOLO_DIR / "classes.json"
        if not registry_path.is_file():
            raise FileNotFoundError("YOLO classes.json file not found")
        try:
            saved_names = json.loads(registry_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as ex:
            raise ValueError("Invalid YOLO classes.json file") from ex
        if not isinstance(saved_names, list) or not saved_names:
            raise ValueError("YOLO class registry is empty")

        class_names = [str(name) for name in saved_names if str(name).strip()]
        dataset_yaml = SAM2_YOLO_DIR / "dataset.yaml"
        dataset_yaml.write_text(
            f"path: {SAM2_YOLO_DIR.resolve().as_posix()}\n"
            "train: images/train\n"
            "val: images/train\n"
            f"names: {json.dumps(class_names, ensure_ascii=False)}\n",
            encoding="utf-8",
        )
        return dataset_yaml

    def delete_yolo_dataset(self, input_path: Path) -> int:
        file_prefix = f"{Path(input_path).stem}_"
        deleted_count = 0
        if not SAM2_YOLO_DIR.is_dir():
            return deleted_count

        for output_path in SAM2_YOLO_DIR.rglob("*"):
            if output_path.is_file() and output_path.name.startswith(file_prefix):
                output_path.unlink()
                deleted_count += 1
        return deleted_count

    def _load_sam2_image_predictor_class(self):
        if self.__class__._sam2_image_predictor_class is not None:
            return self.__class__._sam2_image_predictor_class

        module = self._load_external_sam2_module("sam2.sam2_image_predictor")
        predictor_class = module.SAM2ImagePredictor
        self.__class__._sam2_image_predictor_class = predictor_class
        return predictor_class

    def _load_sam2_video_predictor_class(self):
        if self.__class__._sam2_video_predictor_class is not None:
            return self.__class__._sam2_video_predictor_class

        module = self._load_external_sam2_module("sam2.sam2_video_predictor")
        predictor_class = module.SAM2VideoPredictor
        self.__class__._sam2_video_predictor_class = predictor_class
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

    def _get_video_model(self, model_name: str):
        normalized = str(model_name or "").strip() or SAM2_DEFAULT_MODEL
        cache_key = f"sam2-video:{normalized}"
        if cache_key not in self._model_cache:
            device = "cuda" if torch.cuda.is_available() else "cpu"
            predictor_class = self._load_sam2_video_predictor_class()
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

    def _prepare_video_for_inference(self, input_path: Path, input_file_stem: str):
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
            optimized_path = SAM2_UPLOAD_DIR / f"_{input_file_stem}.sam2_optimized.mp4"
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
            values = np.asarray(scores, dtype=np.float32).reshape(-1)
            values = values[np.isfinite(values)]
            value = float(np.max(values)) if values.size > 0 else None
        except (TypeError, ValueError):
            return None

        return value

    def _video_mask_score(self, mask_logits) -> float:
        if mask_logits is None:
            return 0.0
        if hasattr(mask_logits, "detach"):
            mask_logits = mask_logits.detach().float().to("cpu").numpy()
        logits = np.asarray(mask_logits, dtype=np.float32).squeeze()
        if logits.ndim != 2:
            return 0.0
        foreground_logits = logits[np.isfinite(logits) & (logits > 0)]
        if foreground_logits.size == 0:
            return 0.0
        probabilities = 1.0 / (1.0 + np.exp(-np.clip(foreground_logits, -30.0, 30.0)))
        return float(np.mean(probabilities))

    def _select_best_mask(self, masks, scores):
        if masks is None:
            return None

        if hasattr(masks, "detach"):
            masks = masks.detach().to("cpu").numpy()
        masks = np.asarray(masks)
        if masks.ndim != 3:
            return masks

        try:
            if hasattr(scores, "detach"):
                scores = scores.detach().to("cpu").numpy()
            score_values = np.asarray(scores, dtype=np.float32).reshape(-1)
            best_index = int(np.nanargmax(score_values)) if score_values.size > 0 else 0
        except (TypeError, ValueError):
            best_index = 0

        best_index = max(0, min(best_index, masks.shape[0] - 1))
        return masks[best_index]

    def _to_binary_mask(self, mask_tensor, frame_shape):
        if mask_tensor is None:
            return None

        if hasattr(mask_tensor, "detach"):
            mask_tensor = mask_tensor.detach().to("cpu").numpy()
        mask = np.asarray(mask_tensor)
        if mask.ndim == 3:
            mask = mask[0]
        if mask.ndim != 2:
            return None

        frame_height, frame_width = frame_shape[:2]
        mask_np = mask > 0
        if mask_np.shape != (frame_height, frame_width):
            mask_np = cv2.resize(
                mask_np.astype(np.uint8),
                (frame_width, frame_height),
                interpolation=cv2.INTER_NEAREST,
            ) > 0
        return mask_np

    def _get_mask_bbox(self, mask_np):
        mask = np.asarray(mask_np, dtype=np.uint8)
        if mask.ndim != 2 or not np.any(mask):
            return None

        component_count, labels, stats, _centroids = cv2.connectedComponentsWithStats(
            (mask > 0).astype(np.uint8),
            connectivity=8,
        )
        if component_count <= 1:
            return None

        component_areas = stats[1:, cv2.CC_STAT_AREA]
        largest_area = int(np.max(component_areas))
        minimum_component_area = max(4, int(round(largest_area * 0.02)))
        kept_components = np.flatnonzero(component_areas >= minimum_component_area) + 1
        if len(kept_components) == 0:
            kept_components = [int(np.argmax(component_areas)) + 1]

        cleaned_mask = np.isin(labels, kept_components)
        mask_y, mask_x = np.where(cleaned_mask)
        if len(mask_x) == 0 or len(mask_y) == 0:
            return None
        return (
            int(mask_x.min()),
            int(mask_y.min()),
            int(mask_x.max()) + 1,
            int(mask_y.max()) + 1,
        )

    def _calculate_mask_bbox_fill_ratio(self, mask_tensor, frame_shape):
        mask_np = self._to_binary_mask(mask_tensor, frame_shape)
        if mask_np is None:
            return 0.0

        bbox = self._get_mask_bbox(mask_np)
        if bbox is None:
            return 0.0

        x1, y1, x2, y2 = bbox
        bbox_area = float(max(0, x2 - x1) * max(0, y2 - y1))
        mask_area = float(np.count_nonzero(mask_np[y1:y2, x1:x2]))
        return mask_area / bbox_area if bbox_area > 0 else 0.0

    def _calculate_mask_pair_iou(self, mask_tensor, reference_mask, frame_shape):
        mask_np = self._to_binary_mask(mask_tensor, frame_shape)
        if mask_np is None or reference_mask is None:
            return 0.0

        reference_np = self._to_binary_mask(reference_mask, frame_shape)
        if reference_np is None:
            return 0.0

        intersection = int(np.count_nonzero(np.logical_and(mask_np, reference_np)))
        union = int(np.count_nonzero(np.logical_or(mask_np, reference_np)))
        return float(intersection / union) if union > 0 else 0.0

    def _calculate_mask_iou(self, mask_tensor, bbox_rect, frame_shape):
        if mask_tensor is None or bbox_rect is None:
            return 0.0

        mask_np = self._to_binary_mask(mask_tensor, frame_shape)
        if mask_np is None:
            return 0.0

        x1, y1, x2, y2 = bbox_rect
        bbox_area = max(0, x2 - x1) * max(0, y2 - y1)
        if bbox_area <= 0:
            return 0.0

        mask_area = int(np.count_nonzero(mask_np))
        intersection = int(np.count_nonzero(mask_np[y1:y2, x1:x2]))
        union = mask_area + bbox_area - intersection
        return float(intersection / union) if union > 0 else 0.0

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

    def _draw_option_summary(self, image, mask_input, multimask_output, clahe, iou_mask_filter):
        label = (
            f"Mask input: {'On' if mask_input else 'Off'} | "
            f"Multimask output: {'On' if multimask_output else 'Off'} | "
            f"CLAHE: {'On' if clahe else 'Off'} | "
            f"IoU Mask filter: {'On' if iou_mask_filter else 'Off'}"
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

    def _find_score_plateau_bounds(self, score_values):
        values = np.asarray(score_values, dtype=np.float32).reshape(-1)
        if len(values) < 2:
            return None, None

        values = np.nan_to_num(values, nan=0.0, posinf=1.0, neginf=0.0)
        values = np.clip(values, 0.0, 1.0)
        if len(values) >= 3:
            smoothed_values = np.asarray([
                np.median(values[index - 1:index + 2])
                for index in range(1, len(values) - 1)
            ], dtype=np.float32)
            smoothed_values = np.concatenate((
                values[:1],
                smoothed_values,
                values[-1:],
            ))
        else:
            smoothed_values = values.copy()

        first_derivative = np.gradient(smoothed_values)
        second_derivative = np.gradient(first_derivative)

        high_score_threshold = max(
            0.5,
            float(np.percentile(smoothed_values, 75.0)) - 0.2,
        )
        candidate_indices = np.flatnonzero(
            (values >= high_score_threshold)
            & (np.abs(first_derivative) <= self._score_plateau_first_derivative_threshold)
            & (np.abs(second_derivative) <= self._score_plateau_second_derivative_threshold)
        )
        if len(candidate_indices) == 0:
            fallback_start = min(
                range(len(values) - 1),
                key=lambda index: (
                    -float(np.mean(smoothed_values[index:index + 2])),
                    float(np.ptp(smoothed_values[index:index + 2])),
                    index,
                ),
            )
            return fallback_start, fallback_start + 1

        minimum_plateau_length = 2
        candidates = []
        plateau_start = int(candidate_indices[0])
        plateau_end = plateau_start
        for index in candidate_indices[1:]:
            index = int(index)
            if index != plateau_end + 1:
                if plateau_end - plateau_start + 1 >= minimum_plateau_length:
                    plateau_values = values[plateau_start:plateau_end + 1]
                    derivative_is_stable = (
                        np.any(
                            np.abs(first_derivative[plateau_start:plateau_end + 1])
                            <= self._score_plateau_first_derivative_threshold
                        )
                        and np.any(
                            np.abs(second_derivative[plateau_start:plateau_end + 1])
                            <= self._score_plateau_second_derivative_threshold
                        )
                    )
                    plateau_peak = float(np.max(plateau_values))
                    plateau_area = float(np.sum(plateau_values))
                    plateau_rectangle_area = plateau_peak * len(plateau_values)
                    if (
                        derivative_is_stable
                        and plateau_rectangle_area > 0.0
                        and plateau_area / plateau_rectangle_area
                        >= self._score_plateau_area_ratio_threshold
                    ):
                        candidates.append((plateau_start, plateau_end))
                plateau_start = index
            plateau_end = index

        if plateau_end - plateau_start + 1 >= minimum_plateau_length:
            plateau_values = values[plateau_start:plateau_end + 1]
            derivative_is_stable = (
                np.any(
                    np.abs(first_derivative[plateau_start:plateau_end + 1])
                    <= self._score_plateau_first_derivative_threshold
                )
                and np.any(
                    np.abs(second_derivative[plateau_start:plateau_end + 1])
                    <= self._score_plateau_second_derivative_threshold
                )
            )
            plateau_peak = float(np.max(plateau_values))
            plateau_area = float(np.sum(plateau_values))
            plateau_rectangle_area = plateau_peak * len(plateau_values)
            if (
                derivative_is_stable
                and plateau_rectangle_area > 0.0
                and plateau_area / plateau_rectangle_area
                >= self._score_plateau_area_ratio_threshold
            ):
                candidates.append((plateau_start, plateau_end))

        if not candidates:
            fallback_start = min(
                range(len(values) - 1),
                key=lambda index: (
                    -float(np.mean(smoothed_values[index:index + 2])),
                    float(np.ptp(smoothed_values[index:index + 2])),
                    index,
                ),
            )
            return fallback_start, fallback_start + 1

        # The first plateau is defined by temporal order, not by the highest Score.
        return candidates[0]

    def _get_score_peak_bounds(self, score_values, peak_index):
        values = np.asarray(score_values, dtype=np.float32).reshape(-1)
        if len(values) == 0 or peak_index is None:
            return None, None

        peak_index = max(0, min(len(values) - 1, int(peak_index)))
        plateau_tolerance = 0.2
        peak_start = peak_index
        peak_end = peak_index
        while (
            peak_start > 0
            and float(np.max(values[peak_start - 1:peak_end + 1]))
            - float(np.min(values[peak_start - 1:peak_end + 1])) <= plateau_tolerance
        ):
            peak_start -= 1
        while (
            peak_end + 1 < len(values)
            and float(np.max(values[peak_start:peak_end + 2]))
            - float(np.min(values[peak_start:peak_end + 2])) <= plateau_tolerance
        ):
            peak_end += 1
        return peak_start, peak_end

    def _get_leading_score_plateau_bounds(self, score_values, peak_start):
        values = np.asarray(score_values, dtype=np.float32).reshape(-1)
        if len(values) == 0 or peak_start is None or peak_start <= 1:
            return None, None

        plateau_tolerance = 0.2
        plateau_end = int(peak_start) - 1
        while plateau_end >= 1:
            plateau_start = plateau_end
            while (
                plateau_start > 0
                and float(np.max(values[plateau_start:plateau_end + 1]))
                - float(np.min(values[plateau_start:plateau_end + 1])) <= plateau_tolerance
            ):
                plateau_start -= 1

            if plateau_end - plateau_start + 1 >= 2:
                return plateau_start, plateau_end
            plateau_end = plateau_start - 1

        return None, None

    def _get_score_threshold_regions(self, score_values, threshold):
        values = np.asarray(score_values, dtype=np.float32).reshape(-1)
        if len(values) == 0 or threshold is None:
            return []

        indices = np.flatnonzero(values >= float(threshold))
        if len(indices) == 0:
            return []

        regions = []
        region_start = int(indices[0])
        region_end = region_start
        for index in indices[1:]:
            index = int(index)
            if index != region_end + 1:
                regions.append((region_start, region_end + 1))
                region_start = index
            region_end = index
        regions.append((region_start, region_end + 1))
        return regions

    def _get_boolean_regions(self, condition):
        values = np.asarray(condition, dtype=bool).reshape(-1)
        indices = np.flatnonzero(values)
        if len(indices) == 0:
            return []

        regions = []
        region_start = int(indices[0])
        region_end = region_start
        for index in indices[1:]:
            index = int(index)
            if index != region_end + 1:
                regions.append((region_start, region_end + 1))
                region_start = index
            region_end = index
        regions.append((region_start, region_end + 1))
        return regions

    def _render_score_chart(
        self,
        frame,
        score_history,
        iou_history,
        iou_threshold,
        fill_ratio_history,
        frame_number,
        total_frames,
    ):
        if frame is None:
            return frame

        height, width = frame.shape[:2]
        panel_height = min(132, max(64, height // 3))
        canvas = frame.copy()

        panel_x1 = 8
        panel_x2 = max(panel_x1 + 120, width - 8)
        panel_y1 = max(0, height - panel_height)
        panel_y2 = height - 6
        y_axis_font = cv2.FONT_HERSHEY_SIMPLEX
        y_axis_font_scale = 0.35
        y_axis_thickness = 1
        y_axis_labels = ("0.0", "0.5", "1.0")
        y_axis_label_width = max(
            cv2.getTextSize(label, y_axis_font, y_axis_font_scale, y_axis_thickness)[0][0]
            for label in y_axis_labels
        )
        chart_x1 = panel_x1 + y_axis_label_width + 14
        chart_x2 = panel_x2 - 10
        chart_y1 = panel_y1 + 20
        chart_y2 = panel_y2 - 22
        if chart_x2 <= chart_x1 or chart_y2 <= chart_y1:
            return canvas

        chart_background = canvas.copy()
        cv2.rectangle(chart_background, (panel_x1, panel_y1), (panel_x2, panel_y2), (36, 36, 36), cv2.FILLED)
        cv2.rectangle(chart_background, (chart_x1, chart_y1), (chart_x2, chart_y2), (44, 44, 44), cv2.FILLED)
        cv2.addWeighted(chart_background, 0.8, canvas, 0.2, 0.0, canvas)
        cv2.rectangle(canvas, (chart_x1, chart_y1), (chart_x2, chart_y2), (100, 100, 100), 1)

        for score_tick in (0.0, 0.5, 1.0):
            tick_y = self._chart_renderer._map_chart_y(score_tick, 1.0, chart_y2, chart_y2 - chart_y1)
            cv2.line(canvas, (chart_x1, tick_y), (chart_x2, tick_y), (65, 65, 65), 1, cv2.LINE_AA)
            tick_label = f"{score_tick:.1f}"
            (tick_width, _tick_height), _baseline = cv2.getTextSize(
                tick_label,
                y_axis_font,
                y_axis_font_scale,
                y_axis_thickness,
            )
            cv2.putText(
                canvas,
                tick_label,
                (chart_x1 - tick_width - 8, tick_y + 4),
                y_axis_font,
                y_axis_font_scale,
                (190, 190, 190),
                y_axis_thickness,
                cv2.LINE_AA,
            )

        x_min = 1.0
        x_max = float(max(1, int(total_frames or frame_number)))
        if x_max <= x_min:
            x_max = x_min + 1.0
        x_values = np.arange(1, len(score_history) + 1, dtype=np.float32)
        score_values = np.asarray(score_history, dtype=np.float32)
        peak_start, peak_last = self._find_score_plateau_bounds(score_history)
        self._chart_renderer._draw_chart_series(
            canvas,
            x_values,
            np.asarray(iou_history, dtype=np.float32),
            (255, 190, 60),
            x_min,
            x_max,
            chart_x1,
            chart_x2 - chart_x1,
            1.0,
            chart_y2,
            chart_y2 - chart_y1,
            1,
        )
        self._chart_renderer._draw_chart_series(
            canvas,
            x_values,
            score_values,
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
        if peak_start is not None and peak_last is not None:
            peak_end = peak_last + 1
            first_peak_minimum = float(np.min(score_values[peak_start:peak_end]))
            threshold_y = self._chart_renderer._map_chart_y(
                first_peak_minimum,
                1.0,
                chart_y2,
                chart_y2 - chart_y1,
            )
            cv2.line(
                canvas,
                (chart_x1, threshold_y),
                (chart_x2, threshold_y),
                (0, 165, 255),
                1,
                cv2.LINE_AA,
            )
            threshold_layer = canvas.copy()
            for region_start, region_end in self._get_score_threshold_regions(
                score_values,
                first_peak_minimum,
            ):
                self._chart_renderer._draw_chart_series(
                    threshold_layer,
                    x_values[region_start:region_end],
                    score_values[region_start:region_end],
                    (0, 165, 255),
                    x_min,
                    x_max,
                    chart_x1,
                    chart_x2 - chart_x1,
                    1.0,
                    chart_y2,
                    chart_y2 - chart_y1,
                    2,
                )
            cv2.addWeighted(threshold_layer, 0.65, canvas, 0.35, 0.0, canvas)
            plateau_layer = canvas.copy()
            self._chart_renderer._draw_chart_series(
                plateau_layer,
                x_values[peak_start:peak_end],
                score_values[peak_start:peak_end],
                (0, 0, 255),
                x_min,
                x_max,
                chart_x1,
                chart_x2 - chart_x1,
                1.0,
                chart_y2,
                chart_y2 - chart_y1,
                2,
            )
            cv2.addWeighted(plateau_layer, 0.75, canvas, 0.25, 0.0, canvas)

        if iou_threshold is not None:
            iou_threshold_y = self._chart_renderer._map_chart_y(
                iou_threshold,
                1.0,
                chart_y2,
                chart_y2 - chart_y1,
            )
            cv2.line(
                canvas,
                (chart_x1, iou_threshold_y),
                (chart_x2, iou_threshold_y),
                (255, 0, 255),
                1,
                cv2.LINE_AA,
            )

        if peak_start is not None and peak_last is not None and iou_threshold is not None:
            sample_count = min(len(score_values), len(iou_history))
            if sample_count > 0:
                score_samples = score_values[:sample_count]
                iou_samples = np.asarray(iou_history[:sample_count], dtype=np.float32)
                score_passed = score_samples >= first_peak_minimum
                iou_passed = iou_samples >= iou_threshold
                qualified_regions = self._get_boolean_regions(score_passed & iou_passed)
                score_only_regions = self._get_boolean_regions(score_passed & ~iou_passed)
                filter_layer = canvas.copy()
                for region_start, region_end in qualified_regions:
                    self._chart_renderer._draw_chart_series(
                        filter_layer,
                        x_values[region_start:region_end],
                        score_values[region_start:region_end],
                        (0, 255, 255),
                        x_min,
                        x_max,
                        chart_x1,
                        chart_x2 - chart_x1,
                        1.0,
                        chart_y2,
                        chart_y2 - chart_y1,
                        3,
                    )
                for region_start, region_end in score_only_regions:
                    self._chart_renderer._draw_chart_series(
                        filter_layer,
                        x_values[region_start:region_end],
                        score_values[region_start:region_end],
                        (255, 80, 180),
                        x_min,
                        x_max,
                        chart_x1,
                        chart_x2 - chart_x1,
                        1.0,
                        chart_y2,
                        chart_y2 - chart_y1,
                        3,
                    )
                cv2.addWeighted(filter_layer, 0.9, canvas, 0.1, 0.0, canvas)

        cv2.putText(
            canvas,
            "Score",
            (panel_x1 + 8, panel_y1 + 13),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.35,
            (80, 255, 80),
            1,
            cv2.LINE_AA,
        )
        cv2.putText(
            canvas,
            "IoU",
            (panel_x1 + 62, panel_y1 + 13),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.35,
            (255, 190, 60),
            1,
            cv2.LINE_AA,
        )
        if peak_start is not None and peak_last is not None:
            cv2.putText(
                canvas,
                "Ref-Score",
                (panel_x1 + 108, panel_y1 + 13),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.3,
                (0, 165, 255),
                1,
                cv2.LINE_AA,
            )
        if iou_threshold is not None:
            cv2.putText(
                canvas,
                "Ref-IoU",
                (panel_x1 + 180, panel_y1 + 13),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.3,
                (255, 0, 255),
                1,
                cv2.LINE_AA,
            )
        if peak_start is not None and peak_last is not None:
            cv2.putText(
                canvas,
                "Plateau",
                (panel_x1 + 282, panel_y1 + 13),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.28,
                (0, 0, 255),
                1,
                cv2.LINE_AA,
            )
        if peak_start is not None and peak_last is not None and iou_threshold is not None:
            cv2.putText(
                canvas,
                "Score+IoU",
                (panel_x1 + 340, panel_y1 + 13),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.28,
                (0, 255, 255),
                1,
                cv2.LINE_AA,
            )
            cv2.putText(
                canvas,
                "Score only",
                (panel_x1 + 398, panel_y1 + 13),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.28,
                (255, 80, 180),
                1,
                cv2.LINE_AA,
            )
        cv2.putText(
            canvas,
            "Frame",
            (panel_x1 + 465, panel_y1 + 13),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.28,
            (255, 230, 0),
            1,
            cv2.LINE_AA,
        )

        x_ticks = self._chart_renderer._uniform_ticks(x_min, x_max, target_ticks=4)
        if int(x_max) not in x_ticks:
            x_ticks.append(int(x_max))
        x_ticks = sorted(set(x_ticks))
        for x_tick in x_ticks:
            tick_x = self._chart_renderer._map_chart_x(
                x_tick,
                x_min,
                x_max,
                chart_x1,
                chart_x2 - chart_x1,
            )
            cv2.line(canvas, (tick_x, chart_y2), (tick_x, chart_y2 + 4), (130, 130, 130), 1, cv2.LINE_AA)
            tick_label = str(int(x_tick))
            (tick_width, _tick_height), _baseline = cv2.getTextSize(
                tick_label,
                cv2.FONT_HERSHEY_SIMPLEX,
                0.32,
                1,
            )
            cv2.putText(
                canvas,
                tick_label,
                (max(chart_x1, min(chart_x2 - tick_width, tick_x - (tick_width // 2))), chart_y2 + 16),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.32,
                (190, 190, 190),
                1,
                cv2.LINE_AA,
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
        mask_bbox = self._get_mask_bbox(mask_np)
        display_bbox = mask_bbox or bbox_rect
        if display_bbox is not None:
            x1, y1, x2, y2 = display_bbox
            cv2.rectangle(overlay, (x1, y1), (x2 - 1, y2 - 1), (13, 110, 253), 1)
            self._draw_bbox_score(overlay, display_bbox, score)
        return overlay

    def _build_yolo_segmentation_labels(self, mask_np, class_id=0, min_area=4.0):
        mask = (np.asarray(mask_np, dtype=np.uint8) > 0).astype(np.uint8) * 255
        if mask.ndim != 2 or not np.any(mask):
            return []

        height, width = mask.shape[:2]
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        labels = []
        for contour in contours:
            if cv2.contourArea(contour) < min_area:
                continue

            perimeter = cv2.arcLength(contour, True)
            approximation = cv2.approxPolyDP(contour, 0.002 * perimeter, True)
            if len(approximation) < 3:
                continue

            points = approximation.reshape(-1, 2).astype(np.float32)
            points[:, 0] = np.clip(points[:, 0] / max(1, width), 0.0, 1.0)
            points[:, 1] = np.clip(points[:, 1] / max(1, height), 0.0, 1.0)
            coordinates = " ".join(f"{value:.6f}" for value in points.reshape(-1))
            labels.append(f"{int(class_id)} {coordinates}")

        return labels

    def _extract_yolo_class_name(self, file_name: str) -> str:
        match = re.fullmatch(r"(.+?)_?\d+\.mp4", Path(file_name).name, flags=re.IGNORECASE)
        if not match:
            raise ValueError(
                "YOLO input filename must match {class_name}_{idx}.mp4 or {class_name}{idx}.mp4"
            )
        return match.group(1)

    def _get_yolo_class_registry(self, output_root: Path, class_name: str):
        registry_path = output_root / "classes.json"
        previous_class_names = []
        if registry_path.is_file():
            try:
                saved_names = json.loads(registry_path.read_text(encoding="utf-8"))
                if isinstance(saved_names, list):
                    previous_class_names = [str(name) for name in saved_names if str(name).strip()]
            except (OSError, json.JSONDecodeError):
                previous_class_names = []

        uploaded_class_names = set()
        if SAM2_UPLOAD_DIR.is_dir():
            for input_path in SAM2_UPLOAD_DIR.iterdir():
                if not input_path.is_file() or input_path.suffix.lower() != ".mp4":
                    continue
                try:
                    uploaded_class_names.add(self._extract_yolo_class_name(input_path.name))
                except ValueError:
                    continue

        uploaded_class_names.add(class_name)
        class_names = sorted(
            set(previous_class_names).union(uploaded_class_names),
            key=lambda name: (name.casefold(), name),
        )
        return (
            registry_path,
            previous_class_names,
            class_names,
            class_names.index(class_name),
        )

    def _remap_yolo_label_class_ids(
        self,
        output_root: Path,
        previous_class_names,
        class_names,
    ) -> None:
        labels_dir = output_root / "labels" / "train"
        if not labels_dir.is_dir():
            return

        class_id_map = {
            previous_id: class_names.index(name)
            for previous_id, name in enumerate(previous_class_names)
        }
        for label_path in labels_dir.glob("*.txt"):
            try:
                lines = label_path.read_text(encoding="utf-8").splitlines()
                remapped_lines = []
                for line in lines:
                    parts = line.split(maxsplit=1)
                    if not parts:
                        continue
                    previous_id = int(parts[0])
                    class_id = class_id_map.get(previous_id, previous_id)
                    remapped_lines.append(
                        f"{class_id} {parts[1]}" if len(parts) > 1 else str(class_id)
                    )
                label_path.write_text(
                    "\n".join(remapped_lines) + ("\n" if remapped_lines else ""),
                    encoding="utf-8",
                )
            except (OSError, ValueError):
                continue

    def _export_yolo_dataset(
        self,
        source_video_path: Path,
        output_root: Path,
        input_file_stem: str,
        class_name: str,
        score_history,
        mask_history,
        detection_threshold,
    ):
        if detection_threshold is None:
            return None

        registry_path, previous_class_names, class_names, class_id = self._get_yolo_class_registry(
            output_root,
            class_name,
        )
        file_prefix = f"{input_file_stem}_"
        if output_root.is_dir():
            for existing_path in output_root.rglob("*"):
                if existing_path.is_file() and existing_path.name.startswith(file_prefix):
                    existing_path.unlink()

        images_dir = output_root / "images" / "train"
        labels_dir = output_root / "labels" / "train"
        masks_dir = output_root / "masks" / "train"
        images_dir.mkdir(parents=True, exist_ok=True)
        labels_dir.mkdir(parents=True, exist_ok=True)
        masks_dir.mkdir(parents=True, exist_ok=True)

        capture = cv2.VideoCapture(str(source_video_path))
        if not capture.isOpened():
            raise RuntimeError("Failed to reopen video for YOLO dataset export")

        image_count = 0
        label_count = 0
        frame_index = 0
        try:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break

                qualifies = (
                    frame_index < len(score_history)
                    and float(score_history[frame_index]) >= float(detection_threshold)
                    and frame_index < len(mask_history)
                    and mask_history[frame_index] is not None
                )
                if qualifies:
                    labels = self._build_yolo_segmentation_labels(
                        mask_history[frame_index],
                        class_id=class_id,
                    )
                    if labels:
                        stem = f"{input_file_stem}_{frame_index:06d}"
                        image_path = images_dir / f"{stem}.jpg"
                        label_path = labels_dir / f"{stem}.txt"
                        mask_path = masks_dir / f"{stem}.png"
                        if not cv2.imwrite(str(image_path), frame):
                            raise RuntimeError(f"Failed to save YOLO dataset image: {image_path}")
                        mask_image = (np.asarray(mask_history[frame_index], dtype=np.uint8) > 0).astype(np.uint8) * 255
                        if not cv2.imwrite(str(mask_path), mask_image):
                            raise RuntimeError(f"Failed to save YOLO dataset mask: {mask_path}")
                        label_path.write_text("\n".join(labels) + "\n", encoding="utf-8")
                        image_count += 1
                        label_count += len(labels)

                frame_index += 1
        finally:
            capture.release()

        if image_count <= 0:
            return {
                "root": None,
                "image_count": 0,
                "label_count": 0,
            }

        if previous_class_names and previous_class_names != class_names:
            self._remap_yolo_label_class_ids(output_root, previous_class_names, class_names)
        dataset_yaml = output_root / "dataset.yaml"
        dataset_yaml.write_text(
            f"path: {output_root.resolve().as_posix()}\n"
            "train: images/train\n"
            "val: images/train\n"
            f"names: {json.dumps(class_names, ensure_ascii=False)}\n",
            encoding="utf-8",
        )
        registry_path.write_text(
            json.dumps(class_names, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        return {
            "root": output_root,
            "class_name": class_name,
            "class_id": class_id,
            "image_count": image_count,
            "label_count": label_count,
        }

    def convert_yolo_dataset(self, input_path: Path):
        resolved_input = Path(input_path).resolve()
        class_name = self._extract_yolo_class_name(resolved_input.name)
        cached = self._load_yolo_conversion_cache(resolved_input)
        if not cached:
            raise ValueError("No completed detection is available for YOLO conversion")

        source_video_path = Path(cached["source_video_path"])
        if not source_video_path.is_file():
            self._yolo_conversion_cache.pop(str(resolved_input), None)
            raise ValueError("YOLO conversion source is unavailable. Run SAM2 detection again")

        dataset_result = self._export_yolo_dataset(
            source_video_path=source_video_path,
            output_root=SAM2_YOLO_DIR,
            input_file_stem=resolved_input.stem,
            class_name=class_name,
            score_history=cached["score_history"],
            mask_history=cached["mask_history"],
            detection_threshold=cached["detection_threshold"],
        )
        result = {
            "input_file_stem": resolved_input.stem,
            "yolo_class_name": class_name,
            "yolo_class_id": int(dataset_result["class_id"] if dataset_result else -1),
            "yolo_dataset_image_count": int(dataset_result["image_count"] if dataset_result else 0),
            "yolo_dataset_label_count": int(dataset_result["label_count"] if dataset_result else 0),
        }
        return result

    def detect_video_file(
        self,
        input_path: Path,
        model_name: str = SAM2_DEFAULT_MODEL,
        prompt_frame: int = 1,
        bbox=None,
        points=None,
        point_labels=None,
        multimask_output=False,
        mask_input=True,
        clahe=False,
        iou_mask_filter=True,
        progress_callback=None,
    ):
        resolved_input = Path(input_path).resolve()
        suffix = resolved_input.suffix.lower()
        if suffix not in SAM2_VIDEO_EXTENSIONS:
            raise ValueError("Only video files are supported")

        if not resolved_input.exists() or not resolved_input.is_file():
            raise FileNotFoundError(f"Input video not found: {resolved_input}")

        input_file_stem = resolved_input.stem
        output_path = SAM2_OUTPUT_DIR / f"{input_file_stem}.mp4"

        prepared = self._prepare_video_for_inference(resolved_input, input_file_stem)
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

        prompt_frame_index = max(0, int(prompt_frame) - 1)
        if total_frames > 0:
            prompt_frame_index = min(prompt_frame_index, total_frames - 1)

        bbox_rect, normalized_bbox = self._parse_bbox(bbox, width, height)
        if bbox_rect is None:
            bbox_rect = (0, 0, width, height)
            normalized_bbox = {
                "x": 0.0,
                "y": 0.0,
                "w": 100.0,
                "h": 100.0,
            }

        temporary_output_path = SAM2_OUTPUT_DIR / f"_{input_file_stem}.sam2_overlay.mp4"
        overlay_writer = self._create_video_writer(temporary_output_path, fps, width, height)
        if overlay_writer is None:
            capture.release()
            raise RuntimeError("Failed to create output video")

        writer = None
        render_capture = None
        inference_state = None
        video_predictor = None
        clahe_input_path = None
        start_time = time.time()
        x1, y1, x2, y2 = bbox_rect
        box_prompt = np.array([x1, y1, x2, y2], dtype=np.float32)
        point_prompt = self._parse_points(points, width, height, point_labels)
        clahe_processor = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)) if clahe else None

        tracked_frames = 0
        total_segments = 0
        score_history = [0.0] * total_frames
        fill_ratio_history = [0.0] * total_frames
        iou_history = []
        mask_history = [None] * total_frames
        reference_mask = None

        try:
            model_input_path = prepared_path
            clahe_writer = None
            if clahe_processor is not None:
                clahe_input_path = SAM2_UPLOAD_DIR / f"_{input_file_stem}.sam2_clahe.mp4"
                clahe_writer = self._create_video_writer(clahe_input_path, fps, width, height)
                if clahe_writer is None:
                    raise RuntimeError("Failed to create CLAHE inference video")
                model_input_path = clahe_input_path

            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                overlay_writer.write(frame)
                if clahe_writer is not None:
                    lab_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
                    lab_frame[:, :, 0] = clahe_processor.apply(lab_frame[:, :, 0])
                    clahe_writer.write(cv2.cvtColor(lab_frame, cv2.COLOR_LAB2BGR))

            capture.release()
            capture = None
            overlay_writer.release()
            overlay_writer = None
            if clahe_writer is not None:
                clahe_writer.release()

            video_predictor = self._get_video_model(model_name)
            inference_state = video_predictor.init_state(
                video_path=str(model_input_path),
                offload_video_to_cpu=True,
                offload_state_to_cpu=not torch.cuda.is_available(),
            )
            state_frame_count = int(inference_state.get("num_frames", total_frames))
            if state_frame_count <= 0:
                raise RuntimeError("SAM2 video predictor loaded no frames")
            if state_frame_count != total_frames:
                total_frames = state_frame_count
                score_history = [0.0] * total_frames
                fill_ratio_history = [0.0] * total_frames
                mask_history = [None] * total_frames
            prompt_frame_index = min(prompt_frame_index, total_frames - 1)

            point_coords = point_prompt[0] if point_prompt is not None else None
            point_labels_array = point_prompt[1] if point_prompt is not None else None
            video_predictor.add_new_points_or_box(
                inference_state=inference_state,
                frame_idx=prompt_frame_index,
                obj_id=1,
                points=point_coords,
                labels=point_labels_array,
                box=box_prompt,
            )

            processed_indices = set()

            def collect_propagation(propagation):
                nonlocal total_segments, tracked_frames
                for result_frame_index, object_ids, video_mask_logits in propagation:
                    result_frame_index = int(result_frame_index)
                    if result_frame_index < 0 or result_frame_index >= total_frames:
                        continue
                    object_id_values = [int(value) for value in object_ids]
                    object_position = object_id_values.index(1)
                    mask_logits = video_mask_logits[object_position]
                    mask = self._to_binary_mask(mask_logits, (height, width, 3))
                    score_history[result_frame_index] = self._video_mask_score(mask_logits)
                    mask_history[result_frame_index] = mask
                    fill_ratio_history[result_frame_index] = self._calculate_mask_bbox_fill_ratio(
                        mask,
                        (height, width, 3),
                    )
                    if result_frame_index not in processed_indices:
                        processed_indices.add(result_frame_index)
                        if mask is not None and np.any(mask):
                            total_segments += 1
                    tracked_frames = len(processed_indices)
                    if progress_callback is not None:
                        progress_callback(tracked_frames, max(1, total_frames * 2))

            collect_propagation(video_predictor.propagate_in_video(
                inference_state,
                start_frame_idx=prompt_frame_index,
                max_frame_num_to_track=total_frames - prompt_frame_index,
                reverse=False,
            ))
            if prompt_frame_index > 0:
                collect_propagation(video_predictor.propagate_in_video(
                    inference_state,
                    start_frame_idx=prompt_frame_index,
                    max_frame_num_to_track=prompt_frame_index + 1,
                    reverse=True,
                ))

            # Select the highest stable Score plateau for thresholding and reference-mask selection.
            local_peak_start, local_peak_last = self._find_score_plateau_bounds(
                np.asarray(score_history[prompt_frame_index:], dtype=np.float32),
            )
            peak_start = (
                prompt_frame_index + local_peak_start
                if local_peak_start is not None
                else None
            )
            peak_last = (
                prompt_frame_index + local_peak_last
                if local_peak_last is not None
                else None
            )
            detection_threshold = None
            iou_threshold = None
            if peak_start is not None and peak_last is not None:
                detection_threshold = float(np.min(score_history[peak_start:peak_last + 1]))
                reference_mask_index = (peak_start + peak_last) // 2
                if mask_history[reference_mask_index] is not None:
                    reference_mask = mask_history[reference_mask_index].copy()

            if reference_mask is None:
                iou_history = [0.0] * len(mask_history)
            else:
                iou_history = [
                    self._calculate_mask_pair_iou(mask, reference_mask, (height, width, 3))
                    for mask in mask_history
                ]
                if peak_start is not None and peak_last is not None:
                    iou_threshold = float(np.min(iou_history[peak_start:peak_last + 1]))

            previous_cache = self._yolo_conversion_cache.get(str(resolved_input))
            if previous_cache and previous_cache.get("cleanup_source"):
                previous_source_path = Path(previous_cache["source_video_path"])
                try:
                    if previous_source_path.resolve() != prepared_path.resolve():
                        previous_source_path.unlink(missing_ok=True)
                except OSError:
                    pass
            self._yolo_conversion_cache[str(resolved_input)] = {
                "source_video_path": str(prepared_path),
                "cleanup_source": bool(prepared.get("cleanup")),
                "score_history": score_history,
                "mask_history": mask_history,
                "detection_threshold": detection_threshold,
            }
            yolo_conversion_available = self._save_yolo_conversion_cache(
                resolved_input,
                self._yolo_conversion_cache[str(resolved_input)],
            )

            writer = self._create_video_writer(output_path, fps, width, height)
            if writer is None:
                raise RuntimeError("Failed to create output video")
            render_capture = cv2.VideoCapture(str(temporary_output_path))
            if not render_capture.isOpened():
                raise RuntimeError("Failed to reopen intermediate output video")

            rendered_frames = 0
            while True:
                ok, plotted = render_capture.read()
                if not ok:
                    break
                rendered_frames += 1
                frame_index = rendered_frames - 1
                if (
                    detection_threshold is not None
                    and frame_index < len(score_history)
                    and score_history[frame_index] >= detection_threshold
                    and (
                        not iou_mask_filter
                        or
                        iou_threshold is None
                        or (
                            frame_index < len(iou_history)
                            and iou_history[frame_index] >= iou_threshold
                        )
                    )
                    and frame_index < len(mask_history)
                    and mask_history[frame_index] is not None
                ):
                    plotted = self._overlay_mask_result(
                        plotted,
                        mask_history[frame_index],
                        bbox_rect,
                        score_history[frame_index],
                    )
                self._draw_option_summary(
                    plotted,
                    mask_input,
                    multimask_output,
                    clahe,
                    iou_mask_filter,
                )
                plotted = self._render_score_chart(
                    plotted,
                    score_history,
                    iou_history,
                    iou_threshold,
                    fill_ratio_history,
                    rendered_frames,
                    total_frames,
                )
                writer.write(plotted)
                if progress_callback is not None and total_frames > 0:
                    progress_callback(total_frames + rendered_frames, max(1, total_frames * 2))
        finally:
            if capture is not None:
                capture.release()
            if render_capture is not None:
                render_capture.release()
            if overlay_writer is not None:
                overlay_writer.release()
            if writer is not None:
                writer.release()
            try:
                temporary_output_path.unlink(missing_ok=True)
            except OSError:
                pass
            if prepared.get("cleanup") and str(resolved_input) not in self._yolo_conversion_cache:
                try:
                    prepared_path.unlink(missing_ok=True)
                except OSError:
                    pass

        if tracked_frames <= 0:
            raise RuntimeError("No frames were processed")

        elapsed_sec = round(time.time() - start_time, 3)
        return {
            "job_id": input_file_stem,
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
            "input_file_stem": input_file_stem,
            "yolo_conversion_available": yolo_conversion_available,
            "yolo_dataset_image_count": 0,
            "yolo_dataset_label_count": 0,
        }
