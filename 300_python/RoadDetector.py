from fastapi import HTTPException

import os
import cv2
import numpy as np
import logging
from ultralytics import YOLO
from pathlib import Path
import subprocess
import time
from fastapi.responses import StreamingResponse
import base64
import threading
from datetime import datetime
import platform
from collections import deque

try:
    import paho.mqtt.client as mqtt
except Exception:  # pragma: no cover - optional runtime dependency
    mqtt = None

from send_image import resolve_upload_image_path
from config import BASE_DIR, UPLOAD_DIR, VIDEO_EXTENSIONS
from ChartRenderer import ChartRenderer

logger = logging.getLogger(__name__)

class RoadDetector:
    MIN_CONF = 0.10
    MAX_CONF_GAP_RATIO = 0.10
    DEFAULT_OBSTACLE_CONF = 0.50
    MIN_OVERLAY_COMPONENT_AREA_RATIO = 0.0002
    
    OBSTACLE_SCORE_CONF_WEIGHT = 0.7
    OBSTACLE_SCORE_AREA_WEIGHT = 0.3
    
    _class_color_map_path = Path(__file__).resolve().parent / "colormap_road.txt"
    
    road_model_name = "ai/road/model/01-yolo11m-road-sg.pt"
    road_type_model_name = "ai/road/model/02-yolo11m-cobot-road-type-sg-260626.pt" 
    #obstacle_model_name = "ai/road/model/05-yolo11m-obstacle-sg-260810.pt"
    obstacle_model_name = "ai/road/model/05-yolo11m-obstacle-sg-260814-145446.pt"
    
    _model_paths = {
        "road": Path(__file__).resolve().parent / road_model_name,
        "road_type": Path(__file__).resolve().parent / road_type_model_name ,
        "obstacle": Path(__file__).resolve().parent / obstacle_model_name,
    }
    _models = {}
    _stream_sessions = {}  # {session_id: {capture, frame_count, fps, detect_type, file_name, input_path, roi}}
    _camera_stream_sessions = {}  # {session_id: {capture, frame_index, fps, detect_type, camera_index}}
    _detect_progress = {}  # {session_id: {status, current_frame, total_frames, percentage, error}}
    _detect_lock = threading.Lock()  # Lock for thread-safe access to _detect_progress
    _chart_renderer = ChartRenderer()
    _mqtt_last_surface_state_by_context = {}
    _mqtt_last_surface_state_published_at_by_context = {}
    _surface_state_samples_by_context = {}
    _mqtt_last_obstacle_state_by_context = {}
    _obstacle_state_samples_by_context = {}
    _mqtt_state_lock = threading.Lock()
    _mqtt_publish_queue = deque()
    _mqtt_publish_condition = threading.Condition()
    _mqtt_publish_worker_started = False
    _mqtt_publish_worker_lock = threading.Lock()
    MQTT_PUBLISH_QUEUE_MAX_SIZE = 500
    MQTT_LATEST_ONLY_TOPICS = {
        "vehicle/surface/state",
        "vehicle/surface/obstacle",
        "vehicle/operation/command",
    }
    MQTT_LATEST_ONLY_PREFIXES = (
        "vehicle/",
    )
    MQTT_DETECTION_TOPICS = {
        "vehicle/surface/state",
        "vehicle/surface/obstacle",
    }
    _legacy_stream_stop_requested_by_key = {}
    _legacy_stream_stop_lock = threading.Lock()
    _global_stream_stop_flag_path = Path(__file__).resolve().parent / ".road_detect_stream_stop_all.flag"
    SURFACE_STATE_MAJORITY_WINDOW_SEC = 0.8
    SURFACE_STATE_MIN_VOTES = 3
    SURFACE_STATE_MIN_DOMINANCE_RATIO = 0.60
    SURFACE_STATE_SWITCH_COOLDOWN_SEC = 2.0
    
    def __init__(self):
        self.image_ext = {".jpg", ".jpeg", ".png", ".bmp", ".webp"} 
        self.video_ext = set(VIDEO_EXTENSIONS)
    pass # __init__

    def _normalize_surface_label(self, label):
        text = str(label or "").strip().lower().replace("-", "_").replace(" ", "_")
        if not text:
            return ""

        synonyms = {
            "paving_block": "block",
            "paving_blocks": "block",
            "block_paving": "block",
            "soil": "dirt_road",
            "dirt": "dirt_road",
            "sand": "dirt_road",
            "gravel": "gravel_road",
            "gravelroad": "gravel_road",
            "asphalt_road": "asphalt",
        }
        return synonyms.get(text, text)

    def _resolve_surface_state_from_class_counts(self, class_counts):
        if not isinstance(class_counts, dict) or not class_counts:
            return None

        label_to_state = {
            "asphalt": 0,
            "block": 1,
            "dirt_road": 2,
            "gravel_road": 3,
        }

        best_label = None
        best_count = -1
        for raw_label, raw_count in class_counts.items():
            normalized = self._normalize_surface_label(raw_label)
            if normalized not in label_to_state:
                continue
            try:
                count = int(raw_count)
            except Exception:
                continue
            if count > best_count:
                best_count = count
                best_label = normalized

        if best_label is None:
            return None
        return label_to_state[best_label]

    def _normalize_obstacle_label(self, label):
        # Model class labels may contain leading/trailing whitespace or mixed case.
        text = str(label or "").strip().casefold().replace("-", "_").replace(" ", "_")
        if not text:
            return ""

        synonyms = {
            "pot_hole": "pothole",
            "potholes": "pothole",
            "pothole_road": "pothole",
        }
        return synonyms.get(text, text)

    def _resolve_obstacle_state_from_class_counts(self, class_counts):
        # SurfaceObstacle enum: NONE(0), DANCHA(1), POT_HOLE(2)
        if not isinstance(class_counts, dict):
            return 0

        for raw_label, raw_count in class_counts.items():
            normalized = self._normalize_obstacle_label(raw_label)
            if normalized not in ("dancha", "pothole"):
                continue
            try:
                count = int(raw_count)
            except Exception:
                count = 0
            if count > 0:
                return 1 if normalized == "dancha" else 2
        return 0

    def _get_mqtt_broker_host(self):
        env_host = str(os.getenv("MQTT_BROKER_HOST", "")).strip()
        if env_host:
            return env_host
        if platform.system() == "Windows":
            return "orangepi6plus"
        return "localhost"

    def _normalize_stream_key(self, key):
        text = str(key or "").strip().replace("\\", "/")
        text = text.lstrip("/")
        while "//" in text:
            text = text.replace("//", "/")
        return text

    def _mark_global_stream_stop_requested(self):
        try:
            self._global_stream_stop_flag_path.write_text(str(time.time()), encoding="utf-8")
        except Exception as ex:
            logger.warning("Failed to mark global stream stop flag: %s", ex)

    def _clear_global_stream_stop_requested(self):
        try:
            if self._global_stream_stop_flag_path.exists():
                self._global_stream_stop_flag_path.unlink()
        except Exception as ex:
            logger.warning("Failed to clear global stream stop flag: %s", ex)

    def _is_global_stream_stop_requested(self):
        try:
            return self._global_stream_stop_flag_path.exists()
        except Exception:
            return False

    def _legacy_stream_stop_key_candidates(self, key):
        normalized = self._normalize_stream_key(key)
        candidates = set()

        if normalized:
            candidates.add(normalized)

            name_only = normalized.split("/")[-1]
            if name_only:
                candidates.add(name_only)
                candidates.add(f"samples/video/cobot/{name_only}")

        return candidates

    def _publish_mqtt_topic(self, topic, payload):
        if mqtt is None:
            logger.warning("MQTT publish skipped: paho-mqtt is not available")
            return False

        client = None
        try:
            client_id = f"road_detector_{os.getpid()}_{int(time.time() * 1000) % 100000}"
            try:
                client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
            except Exception:
                client = mqtt.Client(client_id=client_id)

            client.connect(self._get_mqtt_broker_host(), 1883, 10)
            client.loop_start()
            # Do not retain detector-driven state values; retained stale detection
            # can override manually selected surface/obstacle state on page refresh.
            publish_info = client.publish(topic, str(payload), qos=0, retain=False)
            publish_info.wait_for_publish(timeout=2)
            return True
        except Exception as ex:
            logger.warning("MQTT publish failed: %s -> %s (%s)", topic, payload, ex)
            return False
        finally:
            if client is not None:
                try:
                    client.loop_stop()
                except Exception:
                    pass
                try:
                    client.disconnect()
                except Exception:
                    pass

    def _mqtt_publish_worker_loop(self):
        while True:
            publish_item = None
            with RoadDetector._mqtt_publish_condition:
                while not RoadDetector._mqtt_publish_queue:
                    RoadDetector._mqtt_publish_condition.wait()

                publish_item = RoadDetector._mqtt_publish_queue.popleft()

            if not publish_item:
                continue

            topic, payload = publish_item
            self._publish_mqtt_topic(topic, payload)

    def _ensure_mqtt_publish_worker(self):
        if RoadDetector._mqtt_publish_worker_started:
            return

        with RoadDetector._mqtt_publish_worker_lock:
            if RoadDetector._mqtt_publish_worker_started:
                return

            worker = threading.Thread(
                target=self._mqtt_publish_worker_loop,
                name="road-detector-mqtt-publisher",
                daemon=True,
            )
            worker.start()
            RoadDetector._mqtt_publish_worker_started = True

    def _enqueue_mqtt_topic(self, topic, payload):
        if mqtt is None:
            logger.warning("MQTT enqueue skipped: paho-mqtt is not available")
            return False

        self._ensure_mqtt_publish_worker()

        topic_text = str(topic)
        payload_text = str(payload)

        def is_latest_only_topic(topic_name):
            if topic_name in self.MQTT_LATEST_ONLY_TOPICS:
                return True
            return any(topic_name.startswith(prefix) for prefix in self.MQTT_LATEST_ONLY_PREFIXES)

        with RoadDetector._mqtt_publish_condition:
            if is_latest_only_topic(topic_text) and RoadDetector._mqtt_publish_queue:
                RoadDetector._mqtt_publish_queue = deque(
                    item for item in RoadDetector._mqtt_publish_queue if item[0] != topic_text
                )

            if len(RoadDetector._mqtt_publish_queue) >= int(self.MQTT_PUBLISH_QUEUE_MAX_SIZE):
                RoadDetector._mqtt_publish_queue.popleft()
                logger.warning("MQTT queue full; dropped oldest message")

            RoadDetector._mqtt_publish_queue.append((topic_text, payload_text))
            RoadDetector._mqtt_publish_condition.notify()

        return True

    def _clear_detection_mqtt_queue(self):
        with RoadDetector._mqtt_publish_condition:
            if not RoadDetector._mqtt_publish_queue:
                return

            RoadDetector._mqtt_publish_queue = deque(
                item for item in RoadDetector._mqtt_publish_queue if item[0] not in self.MQTT_DETECTION_TOPICS
            )

    def _publish_surface_state_if_needed(self, detect_key, stats, mqtt_publish, context_key):
        if not mqtt_publish:
            return
        if self._is_global_stream_stop_requested():
            return
        if str(detect_key or "").strip().lower() != "road_type":
            return

        class_counts = stats.get("class_counts") if isinstance(stats, dict) else None
        state_value = self._resolve_surface_state_from_class_counts(class_counts)
        if state_value is None:
            return

        context = str(context_key or "global")
        now_ts = time.time()
        with RoadDetector._mqtt_state_lock:
            samples = RoadDetector._surface_state_samples_by_context.get(context)
            if samples is None:
                samples = deque()
                RoadDetector._surface_state_samples_by_context[context] = samples

            samples.append((now_ts, state_value))

            cutoff_ts = now_ts - float(self.SURFACE_STATE_MAJORITY_WINDOW_SEC)
            while samples and samples[0][0] < cutoff_ts:
                samples.popleft()

            if not samples:
                return

            counts = {}
            last_seen_ts = {}
            for sample_ts, sample_state in samples:
                counts[sample_state] = counts.get(sample_state, 0) + 1
                last_seen_ts[sample_state] = sample_ts

            max_count = max(counts.values())
            majority_candidates = [state for state, count in counts.items() if count == max_count]
            if len(majority_candidates) == 1:
                majority_state = majority_candidates[0]
            else:
                majority_state = max(majority_candidates, key=lambda state: last_seen_ts.get(state, 0.0))

            total_votes = int(sum(counts.values()))
            majority_votes = int(counts.get(majority_state, 0))
            if total_votes < int(self.SURFACE_STATE_MIN_VOTES):
                return

            dominance_ratio = (majority_votes / float(total_votes)) if total_votes > 0 else 0.0
            if dominance_ratio < float(self.SURFACE_STATE_MIN_DOMINANCE_RATIO):
                return

            last_state = RoadDetector._mqtt_last_surface_state_by_context.get(context)
            last_published_at = float(RoadDetector._mqtt_last_surface_state_published_at_by_context.get(context, 0.0))

            # Avoid rapid state flapping caused by short-lived detection noise.
            if (
                last_state is not None
                and last_state != majority_state
                and (now_ts - last_published_at) < float(self.SURFACE_STATE_SWITCH_COOLDOWN_SEC)
            ):
                return

            if last_state == majority_state:
                return

        enqueued = self._enqueue_mqtt_topic("vehicle/surface/state", majority_state)
        if enqueued:
            with RoadDetector._mqtt_state_lock:
                RoadDetector._mqtt_last_surface_state_by_context[context] = majority_state
                RoadDetector._mqtt_last_surface_state_published_at_by_context[context] = now_ts

    def _publish_obstacle_state_if_needed(self, detect_key, stats, mqtt_publish, context_key, include_obstacle=False):
        if not mqtt_publish:
            return
        if self._is_global_stream_stop_requested():
            return

        key = str(detect_key or "").strip().lower()
        if key != "obstacle" and not include_obstacle:
            return

        class_counts = stats.get("class_counts") if isinstance(stats, dict) else None
        obstacle_value = self._resolve_obstacle_state_from_class_counts(class_counts)

        context = str(context_key or "global")
        now_ts = time.time()
        with RoadDetector._mqtt_state_lock:
            samples = RoadDetector._obstacle_state_samples_by_context.get(context)
            if samples is None:
                samples = deque()
                RoadDetector._obstacle_state_samples_by_context[context] = samples

            samples.append((now_ts, obstacle_value))

            cutoff_ts = now_ts - float(self.SURFACE_STATE_MAJORITY_WINDOW_SEC)
            while samples and samples[0][0] < cutoff_ts:
                samples.popleft()

            if not samples:
                return

            counts = {}
            last_seen_ts = {}
            for sample_ts, sample_state in samples:
                counts[sample_state] = counts.get(sample_state, 0) + 1
                last_seen_ts[sample_state] = sample_ts

            max_count = max(counts.values())
            majority_candidates = [state for state, count in counts.items() if count == max_count]
            if len(majority_candidates) == 1:
                majority_state = majority_candidates[0]
            else:
                majority_state = max(majority_candidates, key=lambda state: last_seen_ts.get(state, 0.0))

            last_state = RoadDetector._mqtt_last_obstacle_state_by_context.get(context)
            if last_state == majority_state:
                return

        enqueued = self._enqueue_mqtt_topic("vehicle/surface/obstacle", majority_state)
        if enqueued:
            with RoadDetector._mqtt_state_lock:
                RoadDetector._mqtt_last_obstacle_state_by_context[context] = majority_state

    def _get_class_color_map(self):
        color_map = {}
        try:
            with self.__class__._class_color_map_path.open("r", encoding="utf-8") as f:
                for raw_line in f:
                    line = raw_line.strip()
                    if not line or line.startswith("#"):
                        continue

                    parts = line.split()
                    if len(parts) != 4:
                        continue

                    class_name = parts[0].strip()
                    try:
                        r = int(parts[1])
                        g = int(parts[2])
                        b = int(parts[3])
                    except ValueError:
                        continue

                    r = max(0, min(255, r))
                    g = max(0, min(255, g))
                    b = max(0, min(255, b))
                    # OpenCV uses BGR color order.
                    color_map[class_name] = (b, g, r)
                    color_map[class_name.lower()] = (b, g, r)
        except FileNotFoundError:
            color_map = {}

        return color_map

    def _get_instance_mask_color(self, base_bgr, instance_index, cls_id=None):
        # Keep the class base color to avoid confusing cross-class-like hues.
        b0, g0, r0 = [int(v) for v in base_bgr]
        return (b0, g0, r0)

    def _get_class_color(self, names, cls_id, fallback=(0, 255, 255)):
        if cls_id is None:
            return fallback

        class_name = str(names.get(int(cls_id), int(cls_id))).strip()
        class_color_map = self._get_class_color_map()
        return class_color_map.get(
            class_name,
            class_color_map.get(class_name.lower(), fallback),
        )

    def _get_roi_path(self, input_path: Path) -> Path:
        return input_path.with_name(f"{input_path.stem}_roi.txt")

    def _parse_roi_values(self, raw_text: str):
        values = []
        for token in raw_text.replace(",", " ").split():
            try:
                values.append(int(float(token)))
            except ValueError:
                continue

            if len(values) == 4:
                break

        if len(values) != 4:
            return None
        return tuple(values)

    def _clamp_roi(self, roi, width: int, height: int):
        x1, y1, x2, y2 = [int(value) for value in roi]
        x1 = max(0, min(x1, width - 1))
        y1 = max(0, min(y1, height - 1))
        x2 = max(x1 + 1, min(x2, width))
        y2 = max(y1 + 1, min(y2, height))
        return (x1, y1, x2, y2)

    def _load_or_create_roi(self, input_path: Path, width: int, height: int):
        if width <= 0 or height <= 0:
            return None

        margin_x = int(width * 0.1)
        margin_y = int(height * 0.1)
        default_roi = self._clamp_roi((margin_x, margin_y, width - margin_x, height - margin_y), width, height)
        roi_path = self._get_roi_path(input_path)

        if not roi_path.exists():
            roi_path.write_text(
                f"{default_roi[0]},{default_roi[1]},{default_roi[2]},{default_roi[3]}\n",
                encoding="utf-8",
            )
            return default_roi

        try:
            raw_text = roi_path.read_text(encoding="utf-8")
        except OSError:
            return default_roi

        parsed_roi = self._parse_roi_values(raw_text)
        if parsed_roi is None:
            try:
                roi_path.write_text(
                    f"{default_roi[0]},{default_roi[1]},{default_roi[2]},{default_roi[3]}\n",
                    encoding="utf-8",
                )
            except OSError:
                pass
            return default_roi

        return self._clamp_roi(parsed_roi, width, height)

    def _apply_roi_mask(self, frame, roi):
        if roi is None:
            return frame.copy()

        x1, y1, x2, y2 = roi
        masked = np.zeros_like(frame)
        masked[y1:y2, x1:x2] = frame[y1:y2, x1:x2]
        return masked

    def _draw_roi_overlay(self, detected, roi):
        should_draw = roi is not None

        if should_draw:
            x1, y1, x2, y2 = roi
            height, width = detected.shape[:2]

            # Do not draw ROI overlay when ROI is equivalent to full image area.
            if x1 <= 0 and y1 <= 0 and x2 >= width and y2 >= height:
                should_draw = False

        if should_draw:
            roi_color = (0, 0, 255)
            overlay = detected.copy()
            cv2.rectangle(overlay, (x1, y1), (x2, y2), roi_color, cv2.FILLED)
            alpha = 0.1
            cv2.addWeighted(overlay, alpha, detected, 1 - alpha, 0, detected)
            cv2.rectangle(detected, (x1, y1), (x2, y2), roi_color, 2)

            label = "ROI"
            font_face = cv2.FONT_HERSHEY_SIMPLEX
            (text_width, text_height), baseline = cv2.getTextSize(label, font_face, 0.6, 2)
            text_y = max(y1 - 6, text_height + 4)
            label_x2 = min(width - 1, x1 + text_width + 4)
            label_y1 = max(0, text_y - text_height - 4)
            label_y2 = min(height - 1, text_y + baseline)
            cv2.rectangle(detected, (x1, label_y1), (label_x2, label_y2), roi_color, cv2.FILLED)
            cv2.putText(detected, label, (x1 + 2, text_y - 2), font_face, 0.6, (255, 255, 255), 2)

        return detected

    def _box_intersects_roi(self, box, roi):
        if roi is None:
            return True

        x1, y1, x2, y2 = [int(v) for v in box]
        rx1, ry1, rx2, ry2 = roi
        return (x1 < rx2 and x2 > rx1 and y1 < ry2 and y2 > ry1)

    def _clip_box_to_roi(self, box, roi):
        if roi is None:
            return [int(v) for v in box]

        x1, y1, x2, y2 = [int(v) for v in box]
        rx1, ry1, rx2, ry2 = roi

        x1 = max(x1, rx1)
        y1 = max(y1, ry1)
        x2 = min(x2, rx2)
        y2 = min(y2, ry2)

        if x2 <= x1 or y2 <= y1:
            return None
        return [x1, y1, x2, y2]

    def _select_best_box_index_by_weighted_score(self, boxes, confs):
        if boxes is None or confs is None:
            return None

        if len(boxes) == 0 or len(confs) == 0:
            return None

        count = min(len(boxes), len(confs))
        if count <= 0:
            return None

        boxes_eval = boxes[:count].astype(float)
        confs_eval = confs[:count].astype(float)

        widths = np.maximum(1.0, boxes_eval[:, 2] - boxes_eval[:, 0])
        heights = np.maximum(1.0, boxes_eval[:, 3] - boxes_eval[:, 1])
        areas = widths * heights
        max_area = float(np.max(areas)) if len(areas) > 0 else 0.0
        area_ratio = (areas / max_area) if max_area > 0.0 else np.ones_like(areas)

        conf_weight = float(np.clip(float(self.OBSTACLE_SCORE_CONF_WEIGHT), 0.0, 1.0))
        area_weight = float(1.0 - conf_weight)
        scores = (conf_weight * confs_eval) + (area_weight * area_ratio)
        return int(np.argmax(scores))

    def _roi_to_dict(self, roi):
        if roi is None:
            return None

        x1, y1, x2, y2 = [int(v) for v in roi]
        return {
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
        }

    def _get_media_dimensions(self, input_path: Path):
        suffix = input_path.suffix.lower()

        if suffix in self.image_ext:
            image = cv2.imread(str(input_path))
            if image is None:
                raise HTTPException(status_code=400, detail="Failed to read image file")

            height, width = image.shape[:2]
            return (width, height)

        if suffix in self.video_ext:
            capture = cv2.VideoCapture(str(input_path))
            try:
                if not capture.isOpened():
                    raise HTTPException(status_code=400, detail="Failed to read video file")

                width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
                height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
            finally:
                capture.release()

            if width <= 0 or height <= 0:
                raise HTTPException(status_code=400, detail="Failed to get media size")

            return (width, height)

        raise HTTPException(status_code=400, detail="Only image/video files are supported")

    def get_roi_info(self, file_name: str) -> dict:
        input_path = resolve_upload_image_path(file_name)
        if not input_path.exists() or not input_path.is_file():
            raise HTTPException(status_code=404, detail="Input file not found")

        width, height = self._get_media_dimensions(input_path)
        roi = self._load_or_create_roi(input_path, width, height)

        return {
            "file_name": file_name,
            "width": width,
            "height": height,
            "roi": self._roi_to_dict(roi),
            "roi_file": self._get_roi_path(input_path).name,
        }

    def save_roi_info(self, file_name: str, payload: dict) -> dict:
        input_path = resolve_upload_image_path(file_name)
        if not input_path.exists() or not input_path.is_file():
            raise HTTPException(status_code=404, detail="Input file not found")

        width, height = self._get_media_dimensions(input_path)

        roi_payload = payload.get("roi") if isinstance(payload, dict) and isinstance(payload.get("roi"), dict) else payload
        if not isinstance(roi_payload, dict):
            raise HTTPException(status_code=400, detail="roi payload is required")

        try:
            roi = (
                int(float(roi_payload["x1"])),
                int(float(roi_payload["y1"])),
                int(float(roi_payload["x2"])),
                int(float(roi_payload["y2"])),
            )
        except (KeyError, TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid roi payload")

        roi = self._clamp_roi(roi, width, height)
        roi_path = self._get_roi_path(input_path)
        try:
            roi_path.write_text(f"{roi[0]},{roi[1]},{roi[2]},{roi[3]}\n", encoding="utf-8")
        except OSError as ex:
            raise HTTPException(status_code=500, detail=f"Failed to write ROI file: {ex}")

        return {
            "saved": True,
            "file_name": file_name,
            "width": width,
            "height": height,
            "roi": self._roi_to_dict(roi),
            "roi_file": roi_path.name,
        }

    def road_detect_service(self, file_name: str, detect_type: str = "road", remove_noisy_masks: bool = True, show_detect_stats: bool = False, show_time_bar: bool = False, include_obstacle: bool = False, obstacle_conf: float = DEFAULT_OBSTACLE_CONF, mqtt_publish: bool = False) -> dict:
        input_path = resolve_upload_image_path(file_name)
        if not input_path.exists() or not input_path.is_file():
            raise HTTPException(status_code=404, detail="Input file not found")

        stem = input_path.stem
        suffix = input_path.suffix.lower()
        output_path = input_path.with_name(f"{stem}_detected{suffix}")

        if suffix in self.image_ext:
            input_image = cv2.imread(str(input_path))
            if input_image is None:
                raise HTTPException(status_code=400, detail="Failed to read image file")

            roi = self._load_or_create_roi(input_path, input_image.shape[1], input_image.shape[0])
            detected_result = self.detect_road(
                input_image,
                detect_type,
                roi=roi,
                remove_noisy_masks=remove_noisy_masks,
                show_detect_stats=False,
                return_info=True,
                include_obstacle=include_obstacle,
                obstacle_conf=obstacle_conf,
            )
            detected_image = detected_result["frame"]
            self._publish_surface_state_if_needed(
                detect_type,
                detected_result.get("stats"),
                mqtt_publish,
                f"image:{file_name}",
            )
            self._publish_obstacle_state_if_needed(
                detect_type,
                detected_result.get("stats"),
                mqtt_publish,
                f"image:{file_name}",
                include_obstacle=include_obstacle,
            )
            if not cv2.imwrite(str(output_path), detected_image):
                raise HTTPException(status_code=500, detail="Failed to write output image")
        elif suffix in self.video_ext:
            # Use MP4 container to ensure browser-compatible H.264 playback.
            output_path = input_path.with_name(f"{stem}_detected.mp4")
            # Use file_name as session_id for progress tracking
            self.detect_video(
                input_path,
                output_path,
                detect_type,
                remove_noisy_masks,
                show_detect_stats,
                show_time_bar,
                session_id=file_name,
                include_obstacle=include_obstacle,
                obstacle_conf=obstacle_conf,
                mqtt_publish=mqtt_publish,
            )
        else:
            raise HTTPException(status_code=400, detail="Only image/video files are supported")

        base_dir = BASE_DIR.resolve()
        try:
            relative_output_path = output_path.resolve().relative_to(base_dir).as_posix()
        except ValueError:
            relative_output_path = output_path.name

        return {
            "image_url": f"/fast/image/{relative_output_path}"
        }
    pass # road_detect_service

    def detect_video(self, input_path: Path, output_path: Path, detect_type: str, remove_noisy_masks: bool = True, show_detect_stats: bool = False, show_time_bar: bool = False, session_id: str = None, include_obstacle: bool = False, obstacle_conf: float = DEFAULT_OBSTACLE_CONF, mqtt_publish: bool = False) -> None:
        capture = cv2.VideoCapture(str(input_path))
        if not capture.isOpened():
            raise HTTPException(status_code=400, detail="Failed to read video file")

        fps = capture.get(cv2.CAP_PROP_FPS)
        if fps <= 0:
            fps = 20.0

        temp_output_path = output_path.with_name(f"{output_path.stem}_tmp.avi")
        if output_path.exists():
            output_path.unlink()
        if temp_output_path.exists():
            temp_output_path.unlink()

        writer = None
        target_size = None
        roi = None
        stats_history = {}
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        current_frame_no = 0
        
        # 진행 상태 초기화
        if session_id:
            with RoadDetector._detect_lock:
                RoadDetector._detect_progress[session_id] = {
                    'status': 'generating',
                    'current_frame': 0,
                    'total_frames': frame_count,
                    'percentage': 0,
                    'error': None,
                    'stage': 'frame_processing'
                }
        
        try:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                current_frame_no += 1
                
                # 진행 상태 업데이트
                if session_id:
                    # Keep frame-processing progress below encoding stage to avoid backward jumps.
                    percentage = int((current_frame_no / frame_count * 89)) if frame_count > 0 else 0
                    with RoadDetector._detect_lock:
                        RoadDetector._detect_progress[session_id] = {
                            'status': 'generating',
                            'current_frame': current_frame_no,
                            'total_frames': frame_count,
                            'percentage': percentage,
                            'error': None,
                            'stage': 'frame_processing'
                        }

                if roi is None:
                    roi = self._load_or_create_roi(input_path, frame.shape[1], frame.shape[0])

                detected_result = self.detect_road(
                    frame,
                    detect_type,
                    roi=roi,
                    remove_noisy_masks=remove_noisy_masks,
                    show_detect_stats=show_detect_stats,
                    show_time_bar=show_time_bar,
                    stats_history=stats_history,
                    frame_number=current_frame_no,
                    total_frames=frame_count,
                    frame_fps=fps,
                    return_info=True,
                    include_obstacle=include_obstacle,
                    obstacle_conf=obstacle_conf,
                )
                self._publish_surface_state_if_needed(
                    detect_type,
                    detected_result.get("stats"),
                    mqtt_publish,
                    f"video:{session_id or input_path.as_posix()}",
                )
                self._publish_obstacle_state_if_needed(
                    detect_type,
                    detected_result.get("stats"),
                    mqtt_publish,
                    f"video:{session_id or input_path.as_posix()}",
                    include_obstacle=include_obstacle,
                )
                detected_frame = detected_result["frame"]

                if writer is None:
                    h, w = detected_frame.shape[:2]
                    target_size = (w, h)
                    writer = cv2.VideoWriter(
                        str(temp_output_path),
                        cv2.VideoWriter_fourcc(*"MJPG"),
                        fps,
                        target_size
                    )
                    if not writer.isOpened():
                        raise HTTPException(status_code=500, detail="Failed to create temporary AVI video")

                if target_size is not None and (detected_frame.shape[1], detected_frame.shape[0]) != target_size:
                    detected_frame = cv2.resize(detected_frame, target_size, interpolation=cv2.INTER_LINEAR)

                writer.write(detected_frame)
        except Exception as e:
            if session_id:
                with RoadDetector._detect_lock:
                    RoadDetector._detect_progress[session_id] = {
                        'status': 'error',
                        'current_frame': current_frame_no,
                        'total_frames': frame_count,
                        'percentage': 0,
                        'error': str(e),
                        'stage': 'frame_processing'
                    }
            raise
        finally:
            capture.release()
            if writer is not None:
                writer.release()

        if not temp_output_path.exists() or temp_output_path.stat().st_size == 0:
            raise HTTPException(status_code=500, detail="Failed to write temporary AVI video")

        # 인코딩 단계 진행
        if session_id:
            with RoadDetector._detect_lock:
                RoadDetector._detect_progress[session_id] = {
                    'status': 'encoding',
                    'current_frame': frame_count,
                    'total_frames': frame_count,
                    'percentage': 90,
                    'error': None,
                    'stage': 'video_encoding'
                }

        try:
            self.transcode_video_to_h264(temp_output_path, output_path)
        finally:
            if temp_output_path.exists():
                temp_output_path.unlink()

        if not output_path.exists() or output_path.stat().st_size == 0:
            raise HTTPException(status_code=500, detail="Failed to write output video")
        
        # 완료
        if session_id:
            with RoadDetector._detect_lock:
                RoadDetector._detect_progress[session_id] = {
                    'status': 'completed',
                    'current_frame': frame_count,
                    'total_frames': frame_count,
                    'percentage': 100,
                    'error': None,
                    'stage': 'completed'
                }
    pass # detect_video

    def road_detect_stream_init(self, file_name: str, detect_type: str = "road", remove_noisy_masks: bool = True, show_detect_stats: bool = False, show_time_bar: bool = False, include_obstacle: bool = False, obstacle_conf: float = DEFAULT_OBSTACLE_CONF, mqtt_publish: bool = False) -> dict:
        """비디오 스트리밍 세션 초기화"""
        self._clear_global_stream_stop_requested()

        input_path = resolve_upload_image_path(file_name)
        if not input_path.exists() or not input_path.is_file():
            raise HTTPException(status_code=404, detail="Input file not found")

        if input_path.suffix.lower() not in self.video_ext:
            raise HTTPException(status_code=400, detail="Streaming is supported only for video files")

        # 기존 세션이 있으면 정리
        session_id = file_name
        if session_id in RoadDetector._stream_sessions:
            try:
                old_capture = RoadDetector._stream_sessions[session_id].get('capture')
                if old_capture is not None:
                    old_capture.release()
            except Exception as e:
                logger.warning("Error cleaning up old session for %s: %s", session_id, e)
            del RoadDetector._stream_sessions[session_id]

        capture = cv2.VideoCapture(str(input_path))
        if not capture.isOpened():
            raise HTTPException(status_code=400, detail="Failed to read video file")

        # 총 프레임 수와 FPS 계산
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = capture.get(cv2.CAP_PROP_FPS)
        if fps <= 0:
            fps = 20.0

        # 세션 저장
        RoadDetector._stream_sessions[session_id] = {
            'capture': capture,
            'frame_index': 0,
            'frame_count': frame_count,
            'fps': fps,
            'detect_type': detect_type,
            'include_obstacle': bool(include_obstacle),
            'obstacle_conf': float(obstacle_conf),
            'remove_noisy_masks': bool(remove_noisy_masks),
            'show_detect_stats': bool(show_detect_stats),
            'show_time_bar': bool(show_time_bar),
            'mqtt_publish': bool(mqtt_publish),
            'file_name': file_name,
            'input_path': input_path,
            'stats_history': {},
            'roi': self._load_or_create_roi(
                input_path,
                int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
                int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            )
        }

        return {
            'session_id': session_id,
            'total_frames': frame_count,
            'fps': fps,
            'detect_type': detect_type
        }
    pass # road_detect_stream_init

    def road_detect_stream_next(self, file_name: str) -> dict:
        """다음 프레임 반환 (JSON 형식)"""
        session_id = file_name
        if session_id not in RoadDetector._stream_sessions:
            # 세션이 없으면 종료 신호 반환
            return {
                'has_next': False,
                'frame_number': 0,
                'total_frames': 0,
                'frame': None,
                'error': 'Session not found'
            }

        try:
            session = RoadDetector._stream_sessions[session_id]
            capture = session['capture']
            detect_type = session['detect_type']
            include_obstacle = bool(session.get('include_obstacle', False))
            obstacle_conf = float(session.get('obstacle_conf', self.DEFAULT_OBSTACLE_CONF))
            remove_noisy_masks = bool(session.get('remove_noisy_masks', True))
            show_detect_stats = bool(session.get('show_detect_stats', False))
            show_time_bar = bool(session.get('show_time_bar', False))
            mqtt_publish = bool(session.get('mqtt_publish', False))
            frame_index = session['frame_index']
            frame_count = session['frame_count']
            fps = float(session.get('fps', 20.0) or 20.0)
            roi = session.get('roi')
            stats_history = session.get('stats_history')

            ok, frame = capture.read()
            if not ok:
                # 마지막 프레임
                return {
                    'has_next': False,
                    'frame_number': frame_index,
                    'total_frames': frame_count,
                    'frame': None
                }

            # Reflect edited ROI immediately during streaming.
            roi = self._load_or_create_roi(session['input_path'], frame.shape[1], frame.shape[0])
            session['roi'] = roi

            # 프레임 감지 처리
            detected_result = self.detect_road(
                frame,
                detect_type,
                roi=roi,
                remove_noisy_masks=remove_noisy_masks,
                show_detect_stats=show_detect_stats,
                show_time_bar=show_time_bar,
                stats_history=stats_history,
                frame_number=frame_index + 1,
                total_frames=frame_count,
                frame_fps=fps,
                return_info=True,
                include_obstacle=include_obstacle,
                obstacle_conf=obstacle_conf,
            )
            self._publish_surface_state_if_needed(
                detect_type,
                detected_result.get("stats"),
                mqtt_publish,
                f"stream:{session_id}",
            )
            self._publish_obstacle_state_if_needed(
                detect_type,
                detected_result.get("stats"),
                mqtt_publish,
                f"stream:{session_id}",
                include_obstacle=include_obstacle,
            )
            detected_frame = detected_result["frame"]

            # JPEG로 인코딩
            encoded_ok, encoded = cv2.imencode(".jpg", detected_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            if not encoded_ok:
                raise HTTPException(status_code=500, detail="Failed to encode frame")

            # Base64 인코딩
            frame_bytes = encoded.tobytes()
            frame_b64 = base64.b64encode(frame_bytes).decode('utf-8')

            # 세션 업데이트
            session['frame_index'] = frame_index + 1

            return {
                'has_next': session['frame_index'] < frame_count,
                'frame_number': frame_index + 1,
                'total_frames': frame_count,
                'frame': frame_b64,
                'detect_type': detect_type,
            }
        except Exception as e:
            logger.exception("Error in road_detect_stream_next: %s", e)
            raise HTTPException(status_code=500, detail=f"Stream processing error: {e}")
    pass # road_detect_stream_next

    def road_detect_stream_seek(self, file_name: str, frame_number: int) -> dict:
        """특정 프레임으로 이동"""
        session_id = file_name
        if session_id not in RoadDetector._stream_sessions:
            raise HTTPException(status_code=404, detail="Session not found")

        session = RoadDetector._stream_sessions[session_id]
        capture = session['capture']
        frame_count = int(session.get('frame_count', 0))
        if frame_count <= 0:
            raise HTTPException(status_code=400, detail="Invalid frame count")

        target_frame = max(1, min(int(frame_number), frame_count))
        zero_based_index = target_frame - 1

        if not capture.set(cv2.CAP_PROP_POS_FRAMES, zero_based_index):
            raise HTTPException(status_code=500, detail="Failed to seek frame")

        session['frame_index'] = zero_based_index
        session['stats_history'] = []

        return {
            'session_id': session_id,
            'frame_number': target_frame,
            'total_frames': frame_count,
            'has_next': target_frame < frame_count,
        }
    pass # road_detect_stream_seek

    def road_detect_stream_cleanup(self, file_name: str) -> dict:
        """스트리밍 세션 정리"""
        session_id = self._normalize_stream_key(file_name)

        # 닫기 버튼 cleanup 요청 시 검출 토픽 발행 대기열을 비운다.
        self._clear_detection_mqtt_queue()
        self._mark_global_stream_stop_requested()

        # 레거시 /road_detect_stream 루프 종료 신호를 먼저 기록한다.
        stop_key_candidates = self._legacy_stream_stop_key_candidates(file_name)
        with RoadDetector._legacy_stream_stop_lock:
            for stop_key in stop_key_candidates:
                RoadDetector._legacy_stream_stop_requested_by_key[stop_key] = True
        
        # 세션이 없으면 이미 정리된 것
        if session_id not in RoadDetector._stream_sessions:
            return {
                'message': 'Stream cleanup requested (session not found, legacy stream stop flag set)',
                'session_id': session_id
            }

        try:
            session = RoadDetector._stream_sessions[session_id]
            if 'capture' in session and session['capture'] is not None:
                session['capture'].release()
        except Exception as e:
            logger.warning("Error releasing capture for %s: %s", session_id, e)
        
        try:
            del RoadDetector._stream_sessions[session_id]
        except KeyError:
            pass

        return {
            'message': 'Stream session cleaned up successfully',
            'session_id': session_id
        }
    pass # road_detect_stream_cleanup

    def road_detect_stream_cleanup_all(self) -> dict:
        """모든 road detect 스트리밍 세션 정리"""
        self._clear_detection_mqtt_queue()
        self._mark_global_stream_stop_requested()

        cleaned_session_ids = []

        with RoadDetector._legacy_stream_stop_lock:
            for key in list(RoadDetector._legacy_stream_stop_requested_by_key.keys()):
                RoadDetector._legacy_stream_stop_requested_by_key[key] = True

        for session_id, session in list(RoadDetector._stream_sessions.items()):
            try:
                capture = session.get('capture') if isinstance(session, dict) else None
                if capture is not None:
                    capture.release()
            except Exception as ex:
                logger.warning("Error releasing capture for %s: %s", session_id, ex)
            finally:
                cleaned_session_ids.append(session_id)

        RoadDetector._stream_sessions = {}

        return {
            'message': 'All road stream sessions cleaned up successfully',
            'count': len(cleaned_session_ids),
            'session_ids': cleaned_session_ids,
        }
    pass # road_detect_stream_cleanup_all

    def _open_camera_capture(self, camera_index: int):
        backends = [
            getattr(cv2, "CAP_DSHOW", None),
            getattr(cv2, "CAP_MSMF", None),
            None,
        ]

        for backend in backends:
            cap = None
            try:
                if backend is None:
                    cap = cv2.VideoCapture(camera_index)
                else:
                    cap = cv2.VideoCapture(camera_index, backend)

                if cap is not None and cap.isOpened():
                    return cap
            except Exception:
                pass

            if cap is not None:
                cap.release()

        return None

    def _sanitize_camera_name(self, camera_name: str) -> str:
        raw = str(camera_name or "").strip()
        if not raw:
            return "unknown"

        forbidden = '\\/:*?"<>|'
        sanitized = []
        for ch in raw:
            if ch in forbidden:
                sanitized.append("_")
            elif ch.isspace():
                sanitized.append("_")
            else:
                sanitized.append(ch)

        name = "".join(sanitized).strip("._")
        return name or "unknown"

    def _get_camera_roi_path(self, camera_name: str) -> Path:
        safe_name = self._sanitize_camera_name(camera_name)
        roi_dir = UPLOAD_DIR / "camera_roi"
        try:
            roi_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            roi_dir = BASE_DIR
        return roi_dir / f"cam_{safe_name}_roi.txt"

    def _load_or_create_camera_roi(self, roi_path: Path, width: int, height: int):
        if width <= 0 or height <= 0:
            return None

        margin_x = int(width * 0.1)
        margin_y = int(height * 0.1)
        default_roi = self._clamp_roi((margin_x, margin_y, width - margin_x, height - margin_y), width, height)

        if not roi_path.exists():
            try:
                roi_path.write_text(
                    f"{default_roi[0]},{default_roi[1]},{default_roi[2]},{default_roi[3]}\n",
                    encoding="utf-8",
                )
            except OSError:
                pass
            return default_roi

        try:
            raw_text = roi_path.read_text(encoding="utf-8")
        except OSError:
            return default_roi

        parsed_roi = self._parse_roi_values(raw_text)
        if parsed_roi is None:
            try:
                roi_path.write_text(
                    f"{default_roi[0]},{default_roi[1]},{default_roi[2]},{default_roi[3]}\n",
                    encoding="utf-8",
                )
            except OSError:
                pass
            return default_roi

        return self._clamp_roi(parsed_roi, width, height)

    def _save_camera_roi(self, roi_path: Path, roi) -> None:
        x1, y1, x2, y2 = [int(v) for v in roi]
        roi_path.write_text(f"{x1},{y1},{x2},{y2}\n", encoding="utf-8")

    def camera_detect_stream_init(self, camera_index: int, detect_type: str = "road", camera_name: str = "", remove_noisy_masks: bool = True, show_detect_stats: bool = False, show_time_bar: bool = True, include_obstacle: bool = False, obstacle_conf: float = DEFAULT_OBSTACLE_CONF, mqtt_publish: bool = False) -> dict:
        self._clear_global_stream_stop_requested()

        session_id = f"camera_{camera_index}"

        if session_id in RoadDetector._camera_stream_sessions:
            try:
                old_capture = RoadDetector._camera_stream_sessions[session_id].get("capture")
                if old_capture is not None:
                    old_capture.release()
            except Exception:
                pass
            del RoadDetector._camera_stream_sessions[session_id]

        capture = self._open_camera_capture(int(camera_index))
        if capture is None:
            raise HTTPException(status_code=400, detail="Failed to open camera device")

        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        if fps <= 0:
            fps = 20.0

        frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        resolved_camera_name = str(camera_name or f"camera_{camera_index}")
        camera_roi_path = self._get_camera_roi_path(resolved_camera_name)
        camera_roi = self._load_or_create_camera_roi(camera_roi_path, frame_width, frame_height)

        RoadDetector._camera_stream_sessions[session_id] = {
            "capture": capture,
            "frame_index": 0,
            "fps": fps,
            "detect_type": detect_type,
            "include_obstacle": bool(include_obstacle),
            "obstacle_conf": float(obstacle_conf),
            "remove_noisy_masks": bool(remove_noisy_masks),
            "show_detect_stats": bool(show_detect_stats),
            "show_time_bar": bool(show_time_bar),
            "mqtt_publish": bool(mqtt_publish),
            "detect_enabled": True,
            "camera_index": int(camera_index),
            "camera_name": resolved_camera_name,
            "stats_history": {},
            "roi_file": camera_roi_path.name,
            "roi_path": str(camera_roi_path),
            "frame_width": frame_width,
            "frame_height": frame_height,
            "roi": camera_roi,
        }

        return {
            "session_id": session_id,
            "camera_index": int(camera_index),
            "camera_name": resolved_camera_name,
            "fps": fps,
            "detect_type": detect_type,
            "include_obstacle": bool(include_obstacle),
            "obstacle_conf": float(obstacle_conf),
            "detect_enabled": True,
            "width": frame_width,
            "height": frame_height,
            "roi": self._roi_to_dict(camera_roi),
            "roi_file": camera_roi_path.name,
        }
    pass # camera_detect_stream_init

    def camera_detect_stream_next(self, session_id: str) -> dict:
        if session_id not in RoadDetector._camera_stream_sessions:
            return {
                "has_next": False,
                "frame_number": 0,
                "frame_original": None,
                "frame_detected": None,
                "error": "Session not found",
            }

        session = RoadDetector._camera_stream_sessions[session_id]
        capture = session["capture"]
        detect_type = session.get("detect_type", "road")
        include_obstacle = bool(session.get("include_obstacle", False))
        obstacle_conf = float(session.get("obstacle_conf", self.DEFAULT_OBSTACLE_CONF))
        remove_noisy_masks = bool(session.get("remove_noisy_masks", True))
        show_detect_stats = bool(session.get("show_detect_stats", False))
        show_time_bar = bool(session.get("show_time_bar", True))
        detect_enabled = bool(session.get("detect_enabled", True))
        mqtt_publish = bool(session.get("mqtt_publish", False))
        stats_history = session.get("stats_history")
        fps = float(session.get("fps", 20.0) or 20.0)

        ok, frame = capture.read()
        if not ok or frame is None:
            return {
                "has_next": False,
                "frame_number": int(session.get("frame_index", 0)),
                "frame_original": None,
                "frame_detected": None,
            }

        frame_height, frame_width = frame.shape[:2]
        session["frame_width"] = int(frame_width)
        session["frame_height"] = int(frame_height)

        roi = session.get("roi")
        if roi is None:
            margin_x = int(frame_width * 0.1)
            margin_y = int(frame_height * 0.1)
            roi = self._clamp_roi((margin_x, margin_y, frame_width - margin_x, frame_height - margin_y), frame_width, frame_height)
            session["roi"] = roi
        else:
            session["roi"] = self._clamp_roi(roi, frame_width, frame_height)
            roi = session["roi"]

        detected_frame = None
        if detect_enabled:
            detected_result = self.detect_road(
                frame,
                detect_type,
                roi=roi,
                remove_noisy_masks=remove_noisy_masks,
                show_detect_stats=show_detect_stats,
                show_time_bar=show_time_bar,
                stats_history=stats_history,
                frame_number=int(session.get("frame_index", 0)) + 1,
                frame_fps=fps,
                return_info=True,
                include_obstacle=include_obstacle,
                obstacle_conf=obstacle_conf,
            )
            self._publish_surface_state_if_needed(
                detect_type,
                detected_result.get("stats"),
                mqtt_publish,
                f"camera:{session_id}",
            )
            self._publish_obstacle_state_if_needed(
                detect_type,
                detected_result.get("stats"),
                mqtt_publish,
                f"camera:{session_id}",
                include_obstacle=include_obstacle,
            )
            detected_frame = detected_result["frame"]

        original_ok, original_encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        detected_ok = True
        detected_encoded = None
        if detected_frame is not None:
            detected_ok, detected_encoded = cv2.imencode(".jpg", detected_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])

        if not original_ok or not detected_ok:
            raise HTTPException(status_code=500, detail="Failed to encode camera frame")

        session["frame_index"] = int(session.get("frame_index", 0)) + 1

        return {
            "has_next": True,
            "frame_number": session["frame_index"],
            "fps": float(session.get("fps", 20.0)),
            "detect_enabled": detect_enabled,
            "frame_original": base64.b64encode(original_encoded.tobytes()).decode("utf-8"),
            "frame_detected": (base64.b64encode(detected_encoded.tobytes()).decode("utf-8") if detected_encoded is not None else None),
        }
    pass # camera_detect_stream_next

    def camera_get_roi_info(self, session_id: str) -> dict:
        if session_id not in RoadDetector._camera_stream_sessions:
            raise HTTPException(status_code=404, detail="Session not found")

        session = RoadDetector._camera_stream_sessions[session_id]
        width = int(session.get("frame_width") or 0)
        height = int(session.get("frame_height") or 0)
        roi = session.get("roi")

        if (width <= 0 or height <= 0) and session.get("capture") is not None:
            capture = session.get("capture")
            width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            session["frame_width"] = width
            session["frame_height"] = height

        if width <= 0 or height <= 0:
            raise HTTPException(status_code=400, detail="Camera frame size is not ready yet")

        roi_path = Path(session.get("roi_path") or self._get_camera_roi_path(session.get("camera_name", session_id)))

        if roi is None:
            roi = self._load_or_create_camera_roi(roi_path, width, height)
            session["roi"] = roi
        else:
            roi = self._clamp_roi(roi, width, height)
            session["roi"] = roi

        try:
            self._save_camera_roi(roi_path, roi)
        except OSError:
            pass

        return {
            "session_id": session_id,
            "width": width,
            "height": height,
            "roi": self._roi_to_dict(roi),
            "roi_file": roi_path.name,
        }
    pass # camera_get_roi_info

    def camera_save_roi_info(self, session_id: str, payload: dict) -> dict:
        if session_id not in RoadDetector._camera_stream_sessions:
            raise HTTPException(status_code=404, detail="Session not found")

        session = RoadDetector._camera_stream_sessions[session_id]
        width = int(session.get("frame_width") or 0)
        height = int(session.get("frame_height") or 0)
        if width <= 0 or height <= 0:
            raise HTTPException(status_code=400, detail="Camera frame size is not ready yet")

        roi_payload = payload.get("roi") if isinstance(payload, dict) and isinstance(payload.get("roi"), dict) else payload
        if not isinstance(roi_payload, dict):
            raise HTTPException(status_code=400, detail="roi payload is required")

        try:
            roi = (
                int(float(roi_payload["x1"])),
                int(float(roi_payload["y1"])),
                int(float(roi_payload["x2"])),
                int(float(roi_payload["y2"])),
            )
        except (KeyError, TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid roi payload")

        roi = self._clamp_roi(roi, width, height)
        session["roi"] = roi

        roi_path = Path(session.get("roi_path") or self._get_camera_roi_path(session.get("camera_name", session_id)))
        try:
            self._save_camera_roi(roi_path, roi)
        except OSError as ex:
            raise HTTPException(status_code=500, detail=f"Failed to write camera ROI file: {ex}")

        return {
            "saved": True,
            "session_id": session_id,
            "width": width,
            "height": height,
            "roi": self._roi_to_dict(roi),
            "roi_file": roi_path.name,
        }
    pass # camera_save_roi_info

    def camera_detect_stream_set_mode(self, session_id: str, detect_enabled: bool) -> dict:
        if session_id not in RoadDetector._camera_stream_sessions:
            raise HTTPException(status_code=404, detail="Session not found")

        session = RoadDetector._camera_stream_sessions[session_id]
        session["detect_enabled"] = bool(detect_enabled)

        return {
            "session_id": session_id,
            "detect_enabled": bool(session["detect_enabled"]),
        }
    pass # camera_detect_stream_set_mode

    def camera_detect_stream_cleanup(self, session_id: str) -> dict:
        if session_id not in RoadDetector._camera_stream_sessions:
            return {
                "message": "Camera stream session already cleaned or not found",
                "session_id": session_id,
            }

        try:
            session = RoadDetector._camera_stream_sessions[session_id]
            if session.get("capture") is not None:
                session["capture"].release()
        except Exception:
            pass

        try:
            del RoadDetector._camera_stream_sessions[session_id]
        except KeyError:
            pass

        return {
            "message": "Camera stream session cleaned up successfully",
            "session_id": session_id,
        }
    pass # camera_detect_stream_cleanup

    def camera_detect_stream_cleanup_all(self) -> dict:
        cleaned_session_ids = []

        for session_id, session in list(RoadDetector._camera_stream_sessions.items()):
            try:
                capture = session.get("capture") if isinstance(session, dict) else None
                if capture is not None:
                    capture.release()
            except Exception:
                pass
            finally:
                cleaned_session_ids.append(session_id)

        RoadDetector._camera_stream_sessions = {}

        return {
            "message": "All camera stream sessions cleaned up successfully",
            "count": len(cleaned_session_ids),
            "session_ids": cleaned_session_ids,
        }
    pass # camera_detect_stream_cleanup_all

    def road_detect_mov_stream(self, file_name: str, detect_type: str = "road", remove_noisy_masks: bool = True, show_detect_stats: bool = False, show_time_bar: bool = False, include_obstacle: bool = False, obstacle_conf: float = DEFAULT_OBSTACLE_CONF, mqtt_publish: bool = False) -> StreamingResponse:
        """(레거시) 연속 MJPEG 스트리밍 - 하위호환성 유지"""
        input_path = resolve_upload_image_path(file_name)
        if not input_path.exists() or not input_path.is_file():
            raise HTTPException(status_code=404, detail="Input file not found")

        if input_path.suffix.lower() not in self.video_ext:
            raise HTTPException(status_code=400, detail="Streaming is supported only for video files")

        capture = cv2.VideoCapture(str(input_path))
        if not capture.isOpened():
            raise HTTPException(status_code=400, detail="Failed to read video file")

        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        if fps <= 0:
            fps = 20.0

        # 새 스트림 시작 시 이전 종료 요청 플래그를 정리한다.
        self._clear_global_stream_stop_requested()

        stream_key = self._normalize_stream_key(file_name)
        stop_key_candidates = self._legacy_stream_stop_key_candidates(stream_key)
        with RoadDetector._legacy_stream_stop_lock:
            for stop_key in stop_key_candidates:
                RoadDetector._legacy_stream_stop_requested_by_key[stop_key] = False

        def generate():
            roi = None
            stats_history = {}
            total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            frame_number = 0
            try:
                while True:
                    if self._is_global_stream_stop_requested():
                        break

                    with RoadDetector._legacy_stream_stop_lock:
                        stop_requested = any(
                            bool(RoadDetector._legacy_stream_stop_requested_by_key.get(stop_key, False))
                            for stop_key in stop_key_candidates
                        )
                    if stop_requested:
                        break

                    ok, frame = capture.read()
                    if not ok:
                        break
                    frame_number += 1

                    if roi is None:
                        roi = self._load_or_create_roi(input_path, frame.shape[1], frame.shape[0])

                    detected_result = self.detect_road(
                        frame,
                        detect_type,
                        roi=roi,
                        remove_noisy_masks=remove_noisy_masks,
                        show_detect_stats=show_detect_stats,
                        show_time_bar=show_time_bar,
                        stats_history=stats_history,
                        frame_number=frame_number,
                        total_frames=total_frames,
                        frame_fps=fps,
                        return_info=True,
                        include_obstacle=include_obstacle,
                        obstacle_conf=obstacle_conf,
                    )
                    self._publish_surface_state_if_needed(
                        detect_type,
                        detected_result.get("stats"),
                        mqtt_publish,
                        f"legacy_stream:{file_name}",
                    )
                    self._publish_obstacle_state_if_needed(
                        detect_type,
                        detected_result.get("stats"),
                        mqtt_publish,
                        f"legacy_stream:{file_name}",
                        include_obstacle=include_obstacle,
                    )
                    detected_frame = detected_result["frame"]
                    encoded_ok, encoded = cv2.imencode(".jpg", detected_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                    if not encoded_ok:
                        continue

                    frame_bytes = encoded.tobytes()
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        + f"Content-Length: {len(frame_bytes)}\r\n\r\n".encode("ascii")
                        + frame_bytes
                        + b"\r\n"
                    )
            finally:
                capture.release()
                with RoadDetector._legacy_stream_stop_lock:
                    for stop_key in stop_key_candidates:
                        RoadDetector._legacy_stream_stop_requested_by_key.pop(stop_key, None)

        return StreamingResponse(generate(), media_type="multipart/x-mixed-replace; boundary=frame")
    pass # road_detect_stream

    def transcode_video_to_h264(self, input_path: Path, output_path: Path) -> None:
        command = [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output_path),
        ]

        try:
            completed = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
        except FileNotFoundError:
            raise HTTPException(status_code=500, detail="ffmpeg is not installed or not found in PATH")

        if completed.returncode != 0:
            error_tail = (completed.stderr or "").strip().splitlines()
            error_summary = error_tail[-1] if error_tail else "ffmpeg transcoding failed"
            raise HTTPException(status_code=500, detail=f"Failed to transcode video to H.264: {error_summary}")
    pass # transcode_video_to_h264

    def _process_result_masks(
        self,
        detected,
        result,
        names,
        detect_key,
        remove_noisy_masks,
        roi=None,
        inference_roi=None,
        allowed_area_mask=None,
    ):
        regenerated_boxes = []
        regenerated_confs = []
        regenerated_cls_ids = []
        regenerated_labels = []
        regenerated_box_colors = []
        kept_binary_masks = []
        kept_mask_indices = []
        noisy_mask_polygons = []
        mask_outline_polygons = []
        mask_count = 0
        total_mask_count = 0

        if result.masks is None or result.masks.data is None:
            return {
                "detected": detected,
                "mask_count": mask_count,
                "total_mask_count": total_mask_count,
                "kept_binary_masks": kept_binary_masks,
                "kept_mask_indices": kept_mask_indices,
                "regenerated_boxes": regenerated_boxes,
                "regenerated_confs": regenerated_confs,
                "regenerated_cls_ids": regenerated_cls_ids,
                "regenerated_labels": regenerated_labels,
                "regenerated_box_colors": regenerated_box_colors,
            }

        masks = result.masks.data.cpu().numpy()
        total_mask_count = len(masks)
        mask_cls_ids = result.masks.cls.cpu().numpy().astype(int) if getattr(result.masks, "cls", None) is not None else None
        box_confs = result.boxes.conf.cpu().numpy() if (result.boxes is not None and result.boxes.conf is not None) else None
        box_xyxy = result.boxes.xyxy.cpu().numpy().astype(int) if (result.boxes is not None and result.boxes.xyxy is not None) else None
        box_cls_ids = result.boxes.cls.cpu().numpy().astype(int) if (result.boxes is not None and result.boxes.cls is not None) else None
        height, width = detected.shape[:2]
        class_color_map = self._get_class_color_map()

        target_class_ids = set()
        if detect_key and detect_key != "obstacle":
            detect_key_norm = str(detect_key).strip().lower().replace("-", "_").replace(" ", "_")
            for class_id, class_name in names.items():
                class_name_norm = str(class_name).strip().lower().replace("-", "_").replace(" ", "_")
                if class_name_norm == detect_key_norm:
                    target_class_ids.add(int(class_id))

        if box_xyxy is not None and inference_roi is not None and len(box_xyxy) > 0:
            ix1, iy1, _, _ = inference_roi
            box_xyxy[:, 0] += ix1
            box_xyxy[:, 2] += ix1
            box_xyxy[:, 1] += iy1
            box_xyxy[:, 3] += iy1

        roi_binary = None
        if roi is not None:
            rx1, ry1, rx2, ry2 = roi
            roi_binary = np.zeros((height, width), dtype=bool)
            roi_binary[ry1:ry2, rx1:rx2] = True

        prepared_masks = []
        for mask in masks:
            if inference_roi is not None:
                ix1, iy1, ix2, iy2 = inference_roi
                iw = max(1, ix2 - ix1)
                ih = max(1, iy2 - iy1)

                mask_resized_local = cv2.resize(mask, (iw, ih), interpolation=cv2.INTER_LINEAR)
                binary_mask_local = mask_resized_local > 0.5
                binary_mask = np.zeros((height, width), dtype=bool)
                binary_mask[iy1:iy2, ix1:ix2] = binary_mask_local[:(iy2 - iy1), :(ix2 - ix1)]
            else:
                mask_resized = cv2.resize(mask, (width, height), interpolation=cv2.INTER_LINEAR)
                binary_mask = mask_resized > 0.5

            if roi_binary is not None:
                binary_mask = np.logical_and(binary_mask, roi_binary)

            if allowed_area_mask is not None:
                binary_mask = np.logical_and(binary_mask, allowed_area_mask)

            prepared_masks.append(binary_mask)

        if prepared_masks:
            global_binary_mask = np.any(np.stack(prepared_masks, axis=0), axis=0)
        else:
            global_binary_mask = np.zeros((height, width), dtype=bool)

        # Track masks that still have pixels after ROI/allowed-area clipping.
        mask_has_area_flags = np.array(
            [bool(np.any(binary_mask)) for binary_mask in prepared_masks],
            dtype=bool,
        ) if prepared_masks else np.empty((0,), dtype=bool)
        mask_area_values = np.array(
            [float(np.count_nonzero(binary_mask)) for binary_mask in prepared_masks],
            dtype=float,
        ) if prepared_masks else np.empty((0,), dtype=float)

        mask_conf_values = None
        conf_keep_flags = None
        if box_confs is not None and len(box_confs) > 0 and total_mask_count > 1:
            if len(box_confs) == total_mask_count:
                mask_conf_values = box_confs.astype(float)
            elif box_xyxy is not None and len(box_xyxy) > 0:
                mask_conf_values = np.zeros((total_mask_count,), dtype=float)
                box_x1 = box_xyxy[:, 0]
                box_y1 = box_xyxy[:, 1]
                box_x2 = box_xyxy[:, 2]
                box_y2 = box_xyxy[:, 3]
                box_area = np.maximum(1.0, (box_x2 - box_x1) * (box_y2 - box_y1)).astype(float)

                for m_idx, binary_mask in enumerate(prepared_masks):
                    ys, xs = np.where(binary_mask)
                    if xs.size == 0 or ys.size == 0:
                        continue

                    mx1 = float(xs.min())
                    my1 = float(ys.min())
                    mx2 = float(xs.max())
                    my2 = float(ys.max())
                    mask_area = max(1.0, (mx2 - mx1) * (my2 - my1))

                    inter_x1 = np.maximum(mx1, box_x1)
                    inter_y1 = np.maximum(my1, box_y1)
                    inter_x2 = np.minimum(mx2, box_x2)
                    inter_y2 = np.minimum(my2, box_y2)
                    inter_w = np.maximum(0.0, inter_x2 - inter_x1)
                    inter_h = np.maximum(0.0, inter_y2 - inter_y1)
                    inter_area = inter_w * inter_h

                    union_area = mask_area + box_area - inter_area
                    iou = inter_area / np.maximum(union_area, 1e-6)
                    best_idx = int(np.argmax(iou))
                    if float(iou[best_idx]) > 0.0:
                        mask_conf_values[m_idx] = float(box_confs[best_idx])

            if mask_conf_values is not None:
                # For obstacle detection, select only one instance by combined
                # weighted-sum score (confidence-dominant).
                if detect_key == "obstacle" and len(mask_has_area_flags) == len(mask_conf_values):
                    valid_indices = np.where(mask_has_area_flags)[0]
                    if len(valid_indices) > 0:
                        valid_confs = mask_conf_values[valid_indices]
                        valid_areas = mask_area_values[valid_indices] if len(mask_area_values) == len(mask_conf_values) else np.ones_like(valid_confs)
                        max_area = float(np.max(valid_areas)) if len(valid_areas) > 0 else 0.0
                        area_ratio = (valid_areas / max_area) if max_area > 0.0 else np.ones_like(valid_confs)
                        combined_scores = (
                            (float(self.OBSTACLE_SCORE_CONF_WEIGHT) * valid_confs)
                            + (float(1 - self.OBSTACLE_SCORE_CONF_WEIGHT) * area_ratio)
                        )
                        best_local_idx = int(np.argmax(combined_scores))
                        conf_keep_flags = np.zeros((total_mask_count,), dtype=bool)
                        conf_keep_flags[int(valid_indices[best_local_idx])] = True
                    else:
                        conf_keep_flags = np.zeros((total_mask_count,), dtype=bool)
                else:
                    max_conf = float(np.max(box_confs))
                    min_keep_conf = max_conf * (1.0 - float(self.MAX_CONF_GAP_RATIO))
                    conf_keep_flags = mask_conf_values >= min_keep_conf
                    if not bool(np.any(conf_keep_flags)):
                        conf_keep_flags[int(np.argmax(mask_conf_values))] = True

        noisy_component_mask = self._build_noisy_component_mask(global_binary_mask, 0.10)

        overlay = detected.copy()
        for idx, binary_mask in enumerate(prepared_masks):
            cls_id = None
            if mask_cls_ids is not None and idx < len(mask_cls_ids):
                cls_id = int(mask_cls_ids[idx])
            elif box_cls_ids is not None and idx < len(box_cls_ids):
                cls_id = int(box_cls_ids[idx])

            if target_class_ids and cls_id is not None and cls_id not in target_class_ids:
                continue

            if conf_keep_flags is not None and not bool(conf_keep_flags[idx]):
                continue

            noisy_binary_mask = np.logical_and(binary_mask, noisy_component_mask)
            if remove_noisy_masks:
                active_binary_mask = np.logical_and(binary_mask, np.logical_not(noisy_binary_mask))
            else:
                active_binary_mask = binary_mask

            min_overlay_area = int(height * width * float(self.MIN_OVERLAY_COMPONENT_AREA_RATIO))
            active_binary_mask = self._remove_small_connected_components(active_binary_mask, min_overlay_area)

            mask_area = int(np.count_nonzero(active_binary_mask))
            if mask_area > 0:
                kept_mask_indices.append(idx)
                kept_binary_masks.append(active_binary_mask)

                mask_color = self._get_class_color(names, cls_id, fallback=(0, 255, 0))
                mask_color = self._get_instance_mask_color(mask_color, idx, cls_id)

                if detect_key in ("road", "road_type", "obstacle"):
                    contour_input_active = (active_binary_mask.astype(np.uint8) * 255)
                    contours_active, _ = cv2.findContours(
                        contour_input_active,
                        cv2.RETR_EXTERNAL,
                        cv2.CHAIN_APPROX_SIMPLE,
                    )
                    if contours_active:
                        mask_outline_polygons.extend((contour, mask_color) for contour in contours_active)

                ys, xs = np.where(active_binary_mask)
                if xs.size > 0 and ys.size > 0:
                    x1 = int(xs.min())
                    y1 = int(ys.min())
                    x2 = int(xs.max())
                    y2 = int(ys.max())

                    instance_label = ""
                    color_lookup_label = ""
                    if mask_cls_ids is not None and idx < len(mask_cls_ids):
                        instance_label = str(names.get(int(mask_cls_ids[idx]), int(mask_cls_ids[idx])))
                        color_lookup_label = instance_label
                    elif box_cls_ids is not None and idx < len(box_cls_ids):
                        instance_label = str(names.get(int(box_cls_ids[idx]), int(box_cls_ids[idx])))
                        color_lookup_label = instance_label

                    if color_lookup_label:
                        base_mask_color = class_color_map.get(
                            color_lookup_label,
                            class_color_map.get(color_lookup_label.lower(), mask_color)
                        )
                        mask_color = self._get_instance_mask_color(base_mask_color, idx, cls_id)

                    regenerated_boxes.append([x1, y1, x2, y2])
                    if mask_conf_values is not None and idx < len(mask_conf_values):
                        regenerated_confs.append(float(mask_conf_values[idx]))
                    elif box_confs is not None and idx < len(box_confs):
                        regenerated_confs.append(float(box_confs[idx]))
                    else:
                        regenerated_confs.append(0.0)
                    if mask_cls_ids is not None and idx < len(mask_cls_ids):
                        regenerated_cls_ids.append(int(mask_cls_ids[idx]))
                    elif box_cls_ids is not None and idx < len(box_cls_ids):
                        regenerated_cls_ids.append(int(box_cls_ids[idx]))
                    else:
                        regenerated_cls_ids.append(-1)
                    regenerated_labels.append(instance_label)
                    regenerated_box_colors.append(mask_color)

                overlay[active_binary_mask] = mask_color

            if (not remove_noisy_masks) and np.any(noisy_binary_mask):
                contour_input = (noisy_binary_mask.astype(np.uint8) * 255)
                contours, _ = cv2.findContours(contour_input, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                if contours:
                    for contour in contours:
                        epsilon = 0.01 * cv2.arcLength(contour, True)
                        polygon = cv2.approxPolyDP(contour, epsilon, True)
                        if polygon is not None and len(polygon) >= 3:
                            noisy_mask_polygons.append(polygon)
            pass
        pass

        mask_count = len(kept_mask_indices)
        detected = cv2.addWeighted(overlay, 0.35, detected, 0.65, 0)
        if mask_outline_polygons:
            for polygon, outline_color in mask_outline_polygons:
                cv2.polylines(detected, [polygon], True, outline_color, 1)
        if (not remove_noisy_masks) and noisy_mask_polygons:
            cv2.polylines(detected, noisy_mask_polygons, True, (0, 0, 255), 1)

        return {
            "detected": detected,
            "mask_count": mask_count,
            "total_mask_count": total_mask_count,
            "kept_binary_masks": kept_binary_masks,
            "kept_mask_indices": kept_mask_indices,
            "regenerated_boxes": regenerated_boxes,
            "regenerated_confs": regenerated_confs,
            "regenerated_cls_ids": regenerated_cls_ids,
            "regenerated_labels": regenerated_labels,
            "regenerated_box_colors": regenerated_box_colors,
        }
    pass # _process_result_masks

    def _build_noisy_component_mask(self, binary_mask, noisy_ratio: float = 0.10):
        if binary_mask is None:
            return None

        binary_mask = np.asarray(binary_mask, dtype=bool)
        if binary_mask.size == 0:
            return np.zeros_like(binary_mask, dtype=bool)

        input_mask = (binary_mask.astype(np.uint8) * 255)
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(input_mask, connectivity=8)
        if num_labels <= 1:
            return np.zeros_like(binary_mask, dtype=bool)

        total_detected_area = int(np.sum(stats[1:, cv2.CC_STAT_AREA]))
        if total_detected_area <= 0:
            return np.zeros_like(binary_mask, dtype=bool)

        noisy_threshold = int(total_detected_area * float(noisy_ratio))
        noisy_component_mask = np.zeros_like(binary_mask, dtype=bool)

        for label_idx in range(1, num_labels):
            component_area = int(stats[label_idx, cv2.CC_STAT_AREA])
            if component_area <= noisy_threshold:
                noisy_component_mask = np.logical_or(noisy_component_mask, labels == label_idx)

        return noisy_component_mask
    pass # _build_noisy_component_mask

    def _remove_small_connected_components(self, binary_mask, min_area: int):
        if binary_mask is None:
            return None

        mask = np.asarray(binary_mask, dtype=bool)
        if mask.size == 0:
            return mask

        min_area = int(max(1, min_area))
        input_mask = (mask.astype(np.uint8) * 255)
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(input_mask, connectivity=8)
        if num_labels <= 1:
            return np.zeros_like(mask, dtype=bool)

        cleaned = np.zeros_like(mask, dtype=bool)
        for label_idx in range(1, num_labels):
            component_area = int(stats[label_idx, cv2.CC_STAT_AREA])
            if component_area >= min_area:
                cleaned = np.logical_or(cleaned, labels == label_idx)

        return cleaned
    pass # _remove_small_connected_components

    def _build_boxes_payload_from_result(
        self,
        result,
        total_mask_count,
        regenerated_boxes,
        regenerated_confs,
        regenerated_cls_ids,
        regenerated_labels,
        regenerated_box_colors,
        inference_roi,
        names,
    ):
        # YOLOv11m 모델은 masks와 boxes가 동시에 존재할 수 있음.
        # 둘 다 존재하는 경우, 마스크는 영역을 강조하고 박스는 신뢰도와 함께 위치를 표시하는 용도로 활용.
        if total_mask_count > 0:
            # 작은 마스크 제외 후 남은 마스크의 실제 픽셀 영역에서 box 재생성.
            if regenerated_boxes:
                boxes = np.array(regenerated_boxes, dtype=int)
                confs = np.array(regenerated_confs, dtype=float)
                cls_ids = np.array(regenerated_cls_ids, dtype=int)
                box_labels = list(regenerated_labels)
                box_colors = list(regenerated_box_colors)
            else:
                boxes = np.empty((0, 4), dtype=int)
                confs = np.empty((0,), dtype=float)
                cls_ids = np.empty((0,), dtype=int)
                box_labels = []
                box_colors = []
        else:
            boxes = result.boxes.xyxy.cpu().numpy().astype(int)
            if inference_roi is not None:
                ix1, iy1, _, _ = inference_roi
                boxes[:, 0] += ix1
                boxes[:, 2] += ix1
                boxes[:, 1] += iy1
                boxes[:, 3] += iy1
            confs = result.boxes.conf.cpu().numpy()
            cls_ids = result.boxes.cls.cpu().numpy().astype(int) if result.boxes.cls is not None else None
            class_color_map = self._get_class_color_map()
            box_labels = []
            box_colors = []
            for idx in range(len(boxes)):
                cls_name = ""
                cls_id = None
                if cls_ids is not None and idx < len(cls_ids):
                    cls_id = int(cls_ids[idx])
                    cls_name = str(names.get(cls_id, cls_id)).strip()
                box_labels.append(cls_name)
                box_colors.append(self._get_class_color(names, cls_id))

        return {
            "boxes": boxes,
            "confs": confs,
            "cls_ids": cls_ids,
            "box_labels": box_labels,
            "box_colors": box_colors,
        }
    pass # _build_boxes_payload_from_result

    def _filter_boxes_payload_by_roi(self, payload, roi):
        boxes = payload["boxes"]
        confs = payload["confs"]
        cls_ids = payload["cls_ids"]
        box_labels = payload["box_labels"]
        box_colors = payload["box_colors"]

        if roi is None or len(boxes) == 0:
            return payload

        filtered_boxes = []
        filtered_confs = []
        filtered_cls_ids = []
        filtered_labels = []
        filtered_colors = []

        has_cls_ids = cls_ids is not None
        for idx, box in enumerate(boxes):
            if not self._box_intersects_roi(box, roi):
                continue

            clipped_box = self._clip_box_to_roi(box, roi)
            if clipped_box is None:
                continue

            filtered_boxes.append(clipped_box)
            filtered_confs.append(float(confs[idx]))
            if has_cls_ids:
                filtered_cls_ids.append(int(cls_ids[idx]))
            if idx < len(box_labels):
                filtered_labels.append(box_labels[idx])
            if idx < len(box_colors):
                filtered_colors.append(box_colors[idx])

        payload["boxes"] = np.array(filtered_boxes, dtype=int) if filtered_boxes else np.empty((0, 4), dtype=int)
        payload["confs"] = np.array(filtered_confs, dtype=float) if filtered_confs else np.empty((0,), dtype=float)
        payload["cls_ids"] = np.array(filtered_cls_ids, dtype=int) if has_cls_ids and filtered_cls_ids else (np.empty((0,), dtype=int) if has_cls_ids else None)
        payload["box_labels"] = filtered_labels
        payload["box_colors"] = filtered_colors
        return payload
    pass # _filter_boxes_payload_by_roi

    def _filter_boxes_payload_by_area_mask(self, payload, area_mask):
        boxes = payload["boxes"]
        confs = payload["confs"]
        cls_ids = payload["cls_ids"]
        box_labels = payload["box_labels"]
        box_colors = payload["box_colors"]

        if area_mask is None or len(boxes) == 0:
            return payload

        mask_h, mask_w = area_mask.shape[:2]
        filtered_boxes = []
        filtered_confs = []
        filtered_cls_ids = []
        filtered_labels = []
        filtered_colors = []

        has_cls_ids = cls_ids is not None
        for idx, box in enumerate(boxes):
            x1, y1, x2, y2 = [int(v) for v in box]
            x1 = max(0, min(x1, mask_w - 1))
            y1 = max(0, min(y1, mask_h - 1))
            x2 = max(x1 + 1, min(x2, mask_w))
            y2 = max(y1 + 1, min(y2, mask_h))

            center_x = min(mask_w - 1, max(0, (x1 + x2 - 1) // 2))
            center_y = min(mask_h - 1, max(0, (y1 + y2 - 1) // 2))
            if not bool(area_mask[center_y, center_x]):
                continue

            overlap = area_mask[y1:y2, x1:x2]
            if overlap.size == 0 or not np.any(overlap):
                continue

            ys, xs = np.where(overlap)
            if xs.size == 0 or ys.size == 0:
                continue

            # Clip the output box to the actual allowed-area overlap so
            # Obstacle boxes do not extend outside road regions.
            cx1 = int(x1 + xs.min())
            cy1 = int(y1 + ys.min())
            cx2 = int(x1 + xs.max() + 1)
            cy2 = int(y1 + ys.max() + 1)

            filtered_boxes.append([cx1, cy1, cx2, cy2])
            filtered_confs.append(float(confs[idx]))
            if has_cls_ids:
                filtered_cls_ids.append(int(cls_ids[idx]))
            if idx < len(box_labels):
                filtered_labels.append(box_labels[idx])
            if idx < len(box_colors):
                filtered_colors.append(box_colors[idx])

        payload["boxes"] = np.array(filtered_boxes, dtype=int) if filtered_boxes else np.empty((0, 4), dtype=int)
        payload["confs"] = np.array(filtered_confs, dtype=float) if filtered_confs else np.empty((0,), dtype=float)
        payload["cls_ids"] = np.array(filtered_cls_ids, dtype=int) if has_cls_ids and filtered_cls_ids else (np.empty((0,), dtype=int) if has_cls_ids else None)
        payload["box_labels"] = filtered_labels
        payload["box_colors"] = filtered_colors
        return payload
    pass # _filter_boxes_payload_by_area_mask

    def _filter_boxes_payload_by_mean_conf(self, payload):
        boxes = payload.get("boxes")
        confs = payload.get("confs")
        cls_ids = payload.get("cls_ids")
        box_labels = payload.get("box_labels")
        box_colors = payload.get("box_colors")

        if boxes is None or confs is None:
            return payload

        if len(confs) <= 1:
            return payload

        min_keep_conf = float(np.mean(confs))
        keep_indices = np.where(confs >= min_keep_conf)[0]
        if len(keep_indices) == 0:
            keep_indices = np.array([int(np.argmax(confs))])

        payload["boxes"] = boxes[keep_indices]
        payload["confs"] = confs[keep_indices]
        if cls_ids is not None:
            payload["cls_ids"] = cls_ids[keep_indices]

        if isinstance(box_labels, list):
            payload["box_labels"] = [box_labels[i] for i in keep_indices if i < len(box_labels)]
        if isinstance(box_colors, list):
            payload["box_colors"] = [box_colors[i] for i in keep_indices if i < len(box_colors)]

        return payload
    pass # _filter_boxes_payload_by_mean_conf

    def _filter_boxes_payload_by_max_conf_gap(self, payload):
        boxes = payload.get("boxes")
        confs = payload.get("confs")
        cls_ids = payload.get("cls_ids")
        box_labels = payload.get("box_labels")
        box_colors = payload.get("box_colors")

        if boxes is None or confs is None:
            return payload

        if len(confs) <= 1:
            return payload

        max_conf = float(np.max(confs))
        min_keep_conf = max_conf * (1.0 - float(self.MAX_CONF_GAP_RATIO))
        keep_indices = np.where(confs >= min_keep_conf)[0]
        if len(keep_indices) == 0:
            keep_indices = np.array([int(np.argmax(confs))])

        payload["boxes"] = boxes[keep_indices]
        payload["confs"] = confs[keep_indices]
        if cls_ids is not None:
            payload["cls_ids"] = cls_ids[keep_indices]

        if isinstance(box_labels, list):
            payload["box_labels"] = [box_labels[i] for i in keep_indices if i < len(box_labels)]
        if isinstance(box_colors, list):
            payload["box_colors"] = [box_colors[i] for i in keep_indices if i < len(box_colors)]

        return payload
    pass # _filter_boxes_payload_by_max_conf_gap

    def _filter_boxes_payload_by_top_k_conf(self, payload, top_k: int):
        boxes = payload.get("boxes")
        confs = payload.get("confs")
        cls_ids = payload.get("cls_ids")
        box_labels = payload.get("box_labels")
        box_colors = payload.get("box_colors")

        if boxes is None or confs is None:
            return payload

        k = int(top_k)
        if k <= 0 or len(confs) <= k:
            return payload

        order = np.argsort(confs)[::-1]
        keep_indices = order[:k]

        payload["boxes"] = boxes[keep_indices]
        payload["confs"] = confs[keep_indices]
        if cls_ids is not None:
            payload["cls_ids"] = cls_ids[keep_indices]

        if isinstance(box_labels, list):
            payload["box_labels"] = [box_labels[i] for i in keep_indices if i < len(box_labels)]
        if isinstance(box_colors, list):
            payload["box_colors"] = [box_colors[i] for i in keep_indices if i < len(box_colors)]

        return payload
    pass # _filter_boxes_payload_by_top_k_conf

    def _filter_boxes_payload_by_area_conf_score(self, payload, top_k: int = 1):
        boxes = payload.get("boxes")
        confs = payload.get("confs")
        cls_ids = payload.get("cls_ids")
        box_labels = payload.get("box_labels")
        box_colors = payload.get("box_colors")

        if boxes is None or confs is None:
            return payload

        if len(confs) == 0:
            return payload

        k = max(1, int(top_k))
        if len(confs) <= k:
            return payload

        box_w = np.maximum(1.0, boxes[:, 2].astype(float) - boxes[:, 0].astype(float))
        box_h = np.maximum(1.0, boxes[:, 3].astype(float) - boxes[:, 1].astype(float))
        box_area = box_w * box_h
        max_area = float(np.max(box_area)) if len(box_area) > 0 else 0.0
        area_ratio = (box_area / max_area) if max_area > 0.0 else np.ones_like(box_area)
        scores = (
            (float(self.OBSTACLE_SCORE_CONF_WEIGHT) * confs.astype(float))
            + (float(self.OBSTACLE_SCORE_AREA_WEIGHT) * area_ratio)
        )

        keep_indices = np.argsort(scores)[::-1][:k]

        payload["boxes"] = boxes[keep_indices]
        payload["confs"] = confs[keep_indices]
        if cls_ids is not None:
            payload["cls_ids"] = cls_ids[keep_indices]

        if isinstance(box_labels, list):
            payload["box_labels"] = [box_labels[i] for i in keep_indices if i < len(box_labels)]
        if isinstance(box_colors, list):
            payload["box_colors"] = [box_colors[i] for i in keep_indices if i < len(box_colors)]

        return payload
    pass # _filter_boxes_payload_by_area_conf_score

    def _draw_boxes_and_collect_counts(self, detected, boxes, confs, cls_ids, box_labels, box_colors, names, detect_key, font_face, avoid_label_regions=None):
        class_counts = {}
        class_colors = {}
        detected_count = len(boxes)
        label_regions = []

        if isinstance(avoid_label_regions, list):
            for region in avoid_label_regions:
                if region is None or len(region) < 4:
                    continue
                label_regions.append((int(region[0]), int(region[1]), int(region[2]), int(region[3])))

        for idx, ((x1, y1, x2, y2), box_conf) in enumerate(zip(boxes, confs)):
            box_color = box_colors[idx] if idx < len(box_colors) else (0, 255, 255)
            cv2.rectangle(detected, (x1, y1), (x2, y2), box_color, 2)

            cls_name = box_labels[idx] if idx < len(box_labels) and box_labels[idx] else ""
            if not cls_name and cls_ids is not None and idx < len(cls_ids):
                cls_id_value = int(cls_ids[idx])
                if cls_id_value >= 0:
                    cls_name = str(names.get(cls_id_value, cls_id_value))
            if not cls_name:
                cls_name = detect_key

            if cls_name:
                class_counts[cls_name] = class_counts.get(cls_name, 0) + 1
                if cls_name not in class_colors:
                    class_colors[cls_name] = (int(box_color[0]), int(box_color[1]), int(box_color[2]))
            label = f"{cls_name} {box_conf:.2f}".strip()
            (tw, th), baseline = cv2.getTextSize(label, font_face, 0.6, 2)
            ty = max(y1 - 6, th + 4)
            label_x1 = int(x1)
            label_y1 = int(ty - th - 4)
            label_x2 = int(x1 + tw + 4)
            label_y2 = int(ty + baseline)

            # If an obstacle label overlaps existing labels (road/road_type),
            # align the obstacle label to the right side of its bbox.
            if detect_key == "obstacle" and label_regions:
                is_overlapping = False
                for ox1, oy1, ox2, oy2 in label_regions:
                    if label_x1 < ox2 and label_x2 > ox1 and label_y1 < oy2 and label_y2 > oy1:
                        is_overlapping = True
                        break

                if is_overlapping:
                    label_x2 = min(int(detected.shape[1] - 1), int(x2))
                    label_x1 = max(0, int(label_x2 - (tw + 4)))

            cv2.rectangle(detected, (label_x1, label_y1), (label_x2, label_y2), box_color, cv2.FILLED)
            # Use white text on dark box colors for readability.
            b, g, r = int(box_color[0]), int(box_color[1]), int(box_color[2])
            luminance = (0.114 * b) + (0.587 * g) + (0.299 * r)
            text_color = (255, 255, 255) if luminance < 120 else (0, 0, 0)
            cv2.putText(detected, label, (label_x1 + 2, ty - 2), font_face, 0.6, text_color, 2)
            label_regions.append((label_x1, label_y1, label_x2, label_y2))

        return detected_count, class_counts, class_colors, label_regions

    def _render_header(self, detected, conf_text, detected_count, class_counts, started_at, font_face):
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        header_text = f"{conf_text}, time: {elapsed_ms:.0f}ms"
        if detected_count == 0:
            count_text = "not detected"
        elif class_counts:
            count_text = ", ".join([f"{key}({value})" for key, value in sorted(class_counts.items())])
        else:
            count_text = ""

        font_scale = 0.8
        font_thickness = 2
        line_gap = 8
        right_margin = 10
        box_padding = 12

        (w1, h1), b1 = cv2.getTextSize(header_text, font_face, font_scale, font_thickness)
        (w2, h2), b2 = cv2.getTextSize(count_text, font_face, font_scale, font_thickness)
        header_w = max(w1, w2)
        box_h = h1 + b1 + line_gap + h2 + b2 + 2

        required_width = header_w + box_padding + right_margin
        current_height, current_width = detected.shape[:2]
        if current_width < required_width:
            resize_ratio = required_width / float(current_width)
            detected = cv2.resize(
                detected,
                (int(round(current_width * resize_ratio)), int(round(current_height * resize_ratio))),
                interpolation=cv2.INTER_LINEAR
            )

        y1_box = 0
        text_right_x = detected.shape[1] - right_margin
        x2 = text_right_x + 6
        x1 = x2 - (header_w + box_padding)
        y2_box = y1_box + box_h

        overlay = detected.copy()
        cv2.rectangle(overlay, (x1, y1_box), (x2, y2_box), (255, 0, 0), cv2.FILLED)
        cv2.addWeighted(overlay, 0.5, detected, 0.5, 0, detected)

        my = 4
        y1 = y1_box + h1 + my
        y2 = y1 + line_gap + h2 + my
        cv2.putText(detected, header_text, (text_right_x - w1, y1), font_face, font_scale, (255, 255, 255), font_thickness)
        cv2.putText(detected, count_text, (text_right_x - w2, y2), font_face, font_scale, (255, 255, 255), font_thickness)
        return detected
    pass # _render_header

    def _append_stats_history(self, stats_history, stats, frame_number=None, total_frames=None, max_points: int = 120):
        if stats_history is None:
            return {
                "mode": "rolling",
                "points": [],
            }

        item = {
            "detected_count": int(stats.get("detected_count", 0)),
            "max_confidence": float(stats.get("max_confidence", 0.0)),
            "class_counts": {str(k): int(v) for k, v in (stats.get("class_counts") or {}).items()},
        }

        if not isinstance(stats_history, dict):
            stats_history = {}

        use_timeline = total_frames is not None and int(total_frames) > 0 and frame_number is not None
        if use_timeline:
            stats_history.setdefault("mode", "timeline")
            stats_history["mode"] = "timeline"
            stats_history["total_frames"] = int(total_frames)
            stats_history.setdefault("detected", {})
            stats_history.setdefault("max_confidence", {})
            stats_history.setdefault("classes", {})

            frame_idx = int(frame_number)
            stats_history["detected"][frame_idx] = int(item["detected_count"])
            stats_history["max_confidence"][frame_idx] = float(item["max_confidence"])

            for class_name, class_value in item["class_counts"].items():
                class_map = stats_history["classes"].setdefault(str(class_name), {})
                class_map[frame_idx] = int(class_value)
        else:
            stats_history.setdefault("mode", "rolling")
            stats_history["mode"] = "rolling"
            stats_history.setdefault("points", [])
            stats_history["points"].append(item)
            if len(stats_history["points"]) > int(max_points):
                del stats_history["points"][: len(stats_history["points"]) - int(max_points)]

        return stats_history

    def _build_chart_series(self, stats_history, frame_number=None, total_frames=None):
        if not isinstance(stats_history, dict):
            return None

        mode = str(stats_history.get("mode", "rolling"))
        if mode == "timeline":
            total_frames = int(stats_history.get("total_frames") or 0)
            if total_frames <= 1:
                return None

            detected_map = stats_history.get("detected") if isinstance(stats_history.get("detected"), dict) else {}
            conf_map = stats_history.get("max_confidence") if isinstance(stats_history.get("max_confidence"), dict) else {}
            classes_map = stats_history.get("classes") if isinstance(stats_history.get("classes"), dict) else {}
            if not detected_map and not conf_map and not classes_map:
                return None

            timeline_keys = set()
            for k in list(detected_map.keys()) + list(conf_map.keys()):
                ik = int(k)
                if ik > 0:
                    timeline_keys.add(ik)
            for cls_frame_map in classes_map.values():
                if not isinstance(cls_frame_map, dict):
                    continue
                for k in cls_frame_map.keys():
                    ik = int(k)
                    if ik > 0:
                        timeline_keys.add(ik)

            keys = sorted(timeline_keys)
            if len(keys) <= 1:
                return None

            x_vals = np.array(keys, dtype=np.float32)
            detected_vals = np.array([int(detected_map.get(int(k), 0)) for k in keys], dtype=np.float32)
            conf_vals = np.array([max(0.0, min(1.0, float(conf_map.get(int(k), 0.0)))) for k in keys], dtype=np.float32)

            class_series = {}
            for class_name, class_frame_map in classes_map.items():
                if not isinstance(class_frame_map, dict):
                    continue
                class_series[str(class_name)] = np.array(
                    [int(class_frame_map.get(int(k), 0)) for k in keys],
                    dtype=np.float32,
                )

            current_x = float(max(1, min(int(frame_number or keys[-1]), total_frames)))
            frame_label = int(total_frames)
            return x_vals, detected_vals, conf_vals, class_series, current_x, frame_label

        points = stats_history.get("points") if isinstance(stats_history.get("points"), list) else []
        if len(points) <= 1:
            return None

        resolved_total_frames = int(total_frames or stats_history.get("total_frames") or 0)
        if resolved_total_frames > 1:
            frame_now = int(frame_number or len(points))
            frame_now = max(1, min(frame_now, resolved_total_frames))
            window_len = len(points)
            window_start = max(1, frame_now - window_len + 1)
            window_end = window_start + window_len - 1
            x_vals = np.linspace(float(window_start), float(window_end), num=window_len, dtype=np.float32)
        else:
            x_vals = np.arange(1, len(points) + 1, dtype=np.float32)
        detected_vals = np.array([int(item.get("detected_count", 0)) for item in points], dtype=np.float32)
        conf_vals = np.array([max(0.0, min(1.0, float(item.get("max_confidence", 0.0)))) for item in points], dtype=np.float32)

        class_names = sorted({
            str(cls_name)
            for item in points
            for cls_name in ((item.get("class_counts") or {}).keys())
        })
        class_series = {
            class_name: np.array(
                [int((item.get("class_counts") or {}).get(class_name, 0)) for item in points],
                dtype=np.float32,
            )
            for class_name in class_names
        }

        current_x = float(int(frame_number or len(points)))
        frame_label = int(resolved_total_frames if resolved_total_frames > 0 else len(points))
        return x_vals, detected_vals, conf_vals, class_series, current_x, frame_label

    def _render_bottom_stats_overlay(self, detected, stats, stats_history, font_face, frame_number=None, total_frames=None):
        if detected is None:
            return detected

        chart_data = self._build_chart_series(
            stats_history,
            frame_number=frame_number,
            total_frames=total_frames,
        )
        if chart_data is None:
            return detected
        class_color_map = dict(self._get_class_color_map())
        stats_class_colors = stats.get("class_colors") if isinstance(stats, dict) else None
        if isinstance(stats_class_colors, dict):
            for class_name, bgr in stats_class_colors.items():
                if bgr is None or len(bgr) < 3:
                    continue
                mapped = (int(bgr[0]), int(bgr[1]), int(bgr[2]))
                class_color_map[str(class_name)] = mapped
                class_color_map[str(class_name).lower()] = mapped

        return self.__class__._chart_renderer.render_bottom_stats_overlay(
            detected,
            stats,
            chart_data,
            class_color_map,
            font_face,
        )
    pass # _render_bottom_stats_overlay

    def _format_hms_from_seconds(self, raw_seconds):
        try:
            total_seconds = max(0, int(float(raw_seconds)))
        except Exception:
            total_seconds = 0

        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        seconds = total_seconds % 60
        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"

    def _render_bottom_time_bar_overlay(self, detected, frame_number=None, total_frames=None, frame_fps=None, font_face=cv2.FONT_HERSHEY_SIMPLEX):
        if detected is None:
            return detected

        try:
            frame_idx = int(frame_number) if frame_number is not None else 0
            frame_total = int(total_frames) if total_frames is not None else 0
        except Exception:
            return detected

        if frame_idx <= 0:
            return detected

        h, w = detected.shape[:2]

        if frame_total <= 0:
            time_label = f"{int(frame_idx):5d}"
            (tw, th), _ = cv2.getTextSize(time_label, font_face, 0.62, 2)
            pad_x = 10
            pad_y = 6
            box_w = tw + (pad_x * 2)
            box_h = th + (pad_y * 2)
            x1 = int((w - box_w) / 2)
            y1 = int(h - box_h - 16)
            x2 = int(x1 + box_w)
            y2 = int(y1 + box_h)

            overlay = detected.copy()
            cv2.rectangle(overlay, (x1, y1), (x2, y2), (35, 35, 35), cv2.FILLED)
            cv2.addWeighted(overlay, 0.45, detected, 0.55, 0, detected)
            cv2.rectangle(detected, (x1, y1), (x2, y2), (220, 220, 220), 1)

            tx = int(x1 + pad_x)
            ty = int(y1 + pad_y + th)
            cv2.putText(detected, time_label, (tx, ty), font_face, 0.62, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(detected, time_label, (tx, ty), font_face, 0.62, (255, 255, 255), 2, cv2.LINE_AA)
            return detected

        frame_idx = max(1, min(frame_idx, frame_total))
        progress_ratio = frame_idx / float(frame_total)

        def _lerp_bgr(c1, c2, t):
            t = max(0.0, min(1.0, float(t)))
            return (
                int(round(c1[0] + (c2[0] - c1[0]) * t)),
                int(round(c1[1] + (c2[1] - c1[1]) * t)),
                int(round(c1[2] + (c2[2] - c1[2]) * t)),
            )

        # Shift bar color as playback nears the end.
        c_start = (60, 210, 70)    # green
        c_mid = (0, 220, 255)      # yellow
        c_high = (0, 145, 255)     # orange
        c_end = (45, 45, 235)      # red

        if progress_ratio < 0.70:
            fill_color = _lerp_bgr(c_start, c_mid, progress_ratio / 0.70)
        elif progress_ratio < 0.90:
            fill_color = _lerp_bgr(c_mid, c_high, (progress_ratio - 0.70) / 0.20)
        else:
            fill_color = _lerp_bgr(c_high, c_end, (progress_ratio - 0.90) / 0.10)

        side_margin = max(12, int(w * 0.03))
        bar_w = max(120, w - (side_margin * 2))
        bar_h = max(10, int(h * 0.016))
        x1 = int(side_margin)
        y2 = int(h - 14)
        y1 = int(y2 - bar_h)

        overlay = detected.copy()
        cv2.rectangle(overlay, (x1, y1), (x1 + bar_w, y2), (35, 35, 35), cv2.FILLED)
        cv2.addWeighted(overlay, 0.45, detected, 0.55, 0, detected)
        cv2.rectangle(detected, (x1, y1), (x1 + bar_w, y2), (220, 220, 220), 1)

        fill_w = max(1, int((bar_w - 2) * progress_ratio))
        cv2.rectangle(detected, (x1 + 1, y1 + 1), (x1 + 1 + fill_w, y2 - 1), fill_color, cv2.FILLED)

        time_label = f"{frame_idx} / {frame_total}"

        (tw, th), bl = cv2.getTextSize(time_label, font_face, 0.62, 2)
        tx = int((w - tw) / 2)
        ty = max(th + 4, y1 - 8)
        cv2.putText(detected, time_label, (tx, ty), font_face, 0.62, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(detected, time_label, (tx, ty), font_face, 0.62, (255, 255, 255), 2, cv2.LINE_AA)

        return detected
    pass # _render_bottom_time_bar_overlay

    def _prepare_inference_frame_with_road_crop(self, frame, frame_for_inference, conf, roi, detect_key):
        prepared_inference_roi = None
        road_allowed_mask = None

        if "road" not in RoadDetector._models:
            road_model_path = RoadDetector._model_paths["road"]
            if road_model_path.exists():
                RoadDetector._models["road"] = YOLO(str(road_model_path))

        if "road" not in RoadDetector._models:
            return frame_for_inference, prepared_inference_roi, road_allowed_mask

        try:
            road_result = RoadDetector._models["road"].predict(source=frame_for_inference, conf=conf, verbose=False)[0]
            if road_result.boxes is not None and road_result.boxes.conf is not None:
                road_confs = road_result.boxes.conf.cpu().numpy()
                if len(road_confs) > 0:
                    road_boxes = road_result.boxes.xyxy.cpu().numpy().astype(int)
                    best_idx = self._select_best_box_index_by_weighted_score(road_boxes, road_confs)
                    if best_idx is None:
                        return frame_for_inference, prepared_inference_roi, road_allowed_mask

                    selected_box = road_boxes[int(best_idx)]
                    src_h, src_w = frame_for_inference.shape[:2]
                    lx1, ly1, lx2, ly2 = [int(v) for v in selected_box]

                    lx1 = max(0, min(lx1, src_w - 1))
                    ly1 = max(0, min(ly1, src_h - 1))
                    lx2 = max(lx1 + 1, min(lx2, src_w))
                    ly2 = max(ly1 + 1, min(ly2, src_h))

                    offset_x, offset_y = (0, 0)
                    if roi is not None:
                        offset_x, offset_y = int(roi[0]), int(roi[1])

                    h, w = frame.shape[:2]
                    x1 = max(0, min(offset_x + lx1, w - 1))
                    y1 = max(0, min(offset_y + ly1, h - 1))
                    x2 = max(x1 + 1, min(offset_x + lx2, w))
                    y2 = max(y1 + 1, min(offset_y + ly2, h))

                    prepared_inference_roi = (x1, y1, x2, y2)

                    if detect_key == "obstacle":
                        road_allowed_mask = np.zeros((h, w), dtype=bool)
                        if road_result.masks is not None and road_result.masks.data is not None:
                            road_masks = road_result.masks.data.cpu().numpy()
                            if int(best_idx) < len(road_masks):
                                road_mask_local = cv2.resize(
                                    road_masks[int(best_idx)],
                                    (src_w, src_h),
                                    interpolation=cv2.INTER_NEAREST,
                                ) > 0.5
                                gy1 = max(0, min(offset_y, h))
                                gx1 = max(0, min(offset_x, w))
                                gy2 = max(gy1, min(offset_y + src_h, h))
                                gx2 = max(gx1, min(offset_x + src_w, w))
                                if gy2 > gy1 and gx2 > gx1:
                                    local_h = gy2 - gy1
                                    local_w = gx2 - gx1
                                    road_allowed_mask[gy1:gy2, gx1:gx2] = np.logical_or(
                                        road_allowed_mask[gy1:gy2, gx1:gx2],
                                        road_mask_local[:local_h, :local_w],
                                    )
                        else:
                            bx1, by1, bx2, by2 = [int(v) for v in selected_box]
                            bx1 += offset_x
                            by1 += offset_y
                            bx2 += offset_x
                            by2 += offset_y
                            bx1 = max(0, min(bx1, w - 1))
                            by1 = max(0, min(by1, h - 1))
                            bx2 = max(bx1 + 1, min(bx2, w))
                            by2 = max(by1 + 1, min(by2, h))
                            road_allowed_mask[by1:by2, bx1:bx2] = True

                    return frame[y1:y2, x1:x2].copy(), prepared_inference_roi, road_allowed_mask
        except Exception as e:
            logger.warning("Road area preprocessing for %s failed: %s", detect_key, e)

        return frame_for_inference, prepared_inference_roi, road_allowed_mask
    pass # _prepare_inference_frame_with_road_crop

    def detect_road(
        self,
        frame,
        detect_type: str = "road",
        roi=None,
        remove_noisy_masks: bool = True,
        return_info: bool = False,
        show_detect_stats: bool = False,
        show_time_bar: bool = False,
        stats_history=None,
        frame_number=None,
        total_frames=None,
        frame_fps=None,
        include_obstacle: bool = False,
        obstacle_conf: float = DEFAULT_OBSTACLE_CONF,
        suppress_header: bool = False,
        avoid_label_regions=None,
        draw_boxes_labels: bool = True,
    ):
        detect_key = detect_type if detect_type in RoadDetector._model_paths else "road"
        conf = RoadDetector.MIN_CONF
        if detect_key == "obstacle":
            conf = float(np.clip(float(obstacle_conf), 0.0, 1.0))
        infer_key = detect_key
        font_face = cv2.FONT_HERSHEY_SIMPLEX

        # Build ROI image first and run detection on the ROI image itself.
        inference_roi = None
        if roi is not None:
            x1, y1, x2, y2 = self._clamp_roi(roi, frame.shape[1], frame.shape[0])
            frame_for_inference = frame[y1:y2, x1:x2].copy()
            inference_roi = (x1, y1, x2, y2)
        else:
            frame_for_inference = frame.copy()

        # For road_type and obstacle detection, use the same road-area preprocessing.
        obstacle_allowed_area_mask = None
        if detect_key in ("road_type", "obstacle"):
            frame_for_inference, prepared_inference_roi, road_allowed_mask = self._prepare_inference_frame_with_road_crop(
                frame,
                frame_for_inference,
                RoadDetector.MIN_CONF,
                roi,
                detect_key,
            )
            if prepared_inference_roi is not None:
                inference_roi = prepared_inference_roi
            if detect_key == "obstacle":
                obstacle_allowed_area_mask = road_allowed_mask

        if infer_key not in RoadDetector._models:
            model_path = RoadDetector._model_paths[infer_key]
            if not model_path.exists():
                raise HTTPException(
                    status_code=500,
                    detail=f"Model file not found: {model_path}"
                ) 
            RoadDetector._models[infer_key] = YOLO(str(model_path))
        pass
    
        started_at = time.perf_counter()
        
        try:
            result = RoadDetector._models[infer_key].predict(source=frame_for_inference, conf=conf, verbose=False)[0]
        except Exception as ex:
            raise HTTPException(status_code=500, detail=f"YOLO inference failed: {ex}")

        detected = frame.copy()
        detected = self._draw_roi_overlay(detected, roi)
        names = result.names if isinstance(result.names, dict) else {}
        confs = np.empty((0,), dtype=float)

        detected_count = 0
        class_counts = {}
        class_chart_colors = {}
        mask_result = self._process_result_masks(
            detected,
            result,
            names,
            detect_key,
            remove_noisy_masks,
            roi,
            inference_roi,
            allowed_area_mask=obstacle_allowed_area_mask,
        )
        
        detected = mask_result["detected"]
        mask_count = mask_result["mask_count"]
        total_mask_count = mask_result["total_mask_count"]
        kept_mask_indices = mask_result["kept_mask_indices"]
        regenerated_boxes = mask_result["regenerated_boxes"]
        regenerated_confs = mask_result["regenerated_confs"]
        regenerated_cls_ids = mask_result["regenerated_cls_ids"]
        regenerated_labels = mask_result["regenerated_labels"]
        regenerated_box_colors = mask_result["regenerated_box_colors"]
        kept_binary_masks = mask_result.get("kept_binary_masks") or []

        boxes = np.empty((0, 4), dtype=int)
        confs = np.empty((0,), dtype=float)
        cls_ids = np.empty((0,), dtype=int)
        box_labels = []
        box_colors = []
        label_regions = []
        filtered_object_mask = np.zeros(frame.shape[:2], dtype=bool)

        # Keep compositing mask strictly segmentation-based to avoid box-shaped artifacts.
        if kept_binary_masks:
            filtered_object_mask = np.any(np.stack(kept_binary_masks, axis=0), axis=0)

        if result.boxes is not None and result.boxes.xyxy is not None:
            boxes_payload = self._build_boxes_payload_from_result(
                result,
                total_mask_count,
                regenerated_boxes,
                regenerated_confs,
                regenerated_cls_ids,
                regenerated_labels,
                regenerated_box_colors,
                inference_roi,
                names,
            )
            boxes_payload = self._filter_boxes_payload_by_roi(boxes_payload, roi)
            if detect_key == "obstacle":
                boxes_payload = self._filter_boxes_payload_by_area_mask(boxes_payload, obstacle_allowed_area_mask)
            # When masks are present, confidence filtering is already applied in
            # _process_result_masks. Applying box-only filtering again can cause
            # mask/box mismatch (overlay outside shown boxes).
            if total_mask_count <= 0:
                if detect_key != "obstacle":
                    boxes_payload = self._filter_boxes_payload_by_max_conf_gap(boxes_payload)

            if detect_key == "obstacle":
                boxes_payload = self._filter_boxes_payload_by_area_conf_score(boxes_payload, top_k=1)

            boxes = boxes_payload["boxes"]
            confs = boxes_payload["confs"]
            cls_ids = boxes_payload["cls_ids"]
            box_labels = boxes_payload["box_labels"]
            box_colors = boxes_payload["box_colors"]

            if draw_boxes_labels:
                detected_count, class_counts, class_chart_colors, label_regions = self._draw_boxes_and_collect_counts(
                    detected,
                    boxes,
                    confs,
                    cls_ids,
                    box_labels,
                    box_colors,
                    names,
                    detect_key,
                    font_face,
                    avoid_label_regions=avoid_label_regions,
                )
            else:
                detected_count = len(boxes)
                for idx, box_conf in enumerate(confs):
                    cls_name = box_labels[idx] if idx < len(box_labels) and box_labels[idx] else ""
                    if not cls_name and cls_ids is not None and idx < len(cls_ids):
                        cls_id_value = int(cls_ids[idx])
                        if cls_id_value >= 0:
                            cls_name = str(names.get(cls_id_value, cls_id_value))
                    if not cls_name:
                        cls_name = detect_key

                    class_counts[cls_name] = class_counts.get(cls_name, 0) + 1
                    if cls_name not in class_chart_colors:
                        color = box_colors[idx] if idx < len(box_colors) else (0, 255, 255)
                        class_chart_colors[cls_name] = (int(color[0]), int(color[1]), int(color[2]))
            pass
        pass

        if not class_counts and result.masks is not None and getattr(result.masks, "cls", None) is not None:
            mask_cls_ids = result.masks.cls.cpu().numpy().astype(int)
            if kept_mask_indices:
                mask_cls_ids = mask_cls_ids[kept_mask_indices]

            for cls_id in mask_cls_ids:
                cls_name = str(names.get(int(cls_id), int(cls_id)))
                class_counts[cls_name] = class_counts.get(cls_name, 0) + 1

        if detected_count == 0:
            detected_count = mask_count

        max_confidence = float(np.max(confs)) if confs is not None and len(confs) > 0 else 0.0

        fallback_class_color_map = self._get_class_color_map()
        for class_name in class_counts.keys():
            if class_name in class_chart_colors:
                continue
            mapped = fallback_class_color_map.get(class_name, fallback_class_color_map.get(str(class_name).lower()))
            if mapped is not None:
                class_chart_colors[class_name] = (int(mapped[0]), int(mapped[1]), int(mapped[2]))

        # Extra class series used only for chart/legend (not header/base counts).
        extra_chart_class_counts = {}
        extra_chart_class_colors = {}

        # Optional extra obstacle overlay on top of road/road_type detection.
        if include_obstacle and detect_key in ("road", "road_type"):
            obstacle_source_frame = frame.copy()
            obstacle_input_mask = np.zeros(frame.shape[:2], dtype=bool)

            if kept_binary_masks:
                obstacle_input_mask = np.any(np.stack(kept_binary_masks, axis=0), axis=0)
            elif len(boxes) > 0:
                for box in boxes:
                    x1, y1, x2, y2 = [int(v) for v in box]
                    x1 = max(0, min(x1, frame.shape[1] - 1))
                    y1 = max(0, min(y1, frame.shape[0] - 1))
                    x2 = max(x1 + 1, min(x2, frame.shape[1]))
                    y2 = max(y1 + 1, min(y2, frame.shape[0]))
                    obstacle_input_mask[y1:y2, x1:x2] = True

            if roi is not None:
                rx1, ry1, rx2, ry2 = self._clamp_roi(roi, frame.shape[1], frame.shape[0])
                roi_mask = np.zeros(frame.shape[:2], dtype=bool)
                roi_mask[ry1:ry2, rx1:rx2] = True
                obstacle_input_mask = np.logical_and(obstacle_input_mask, roi_mask)

            if np.any(obstacle_input_mask):
                ys, xs = np.where(obstacle_input_mask)
                px1 = int(xs.min())
                py1 = int(ys.min())
                px2 = int(xs.max() + 1)
                py2 = int(ys.max() + 1)
                obstacle_roi = self._clamp_roi((px1, py1, px2, py2), frame.shape[1], frame.shape[0])

                obstacle_result = self.detect_road(
                    obstacle_source_frame,
                    detect_type="obstacle",
                    roi=obstacle_roi,
                    remove_noisy_masks=remove_noisy_masks,
                    return_info=True,
                    show_detect_stats=False,
                    show_time_bar=False,
                    include_obstacle=False,
                    obstacle_conf=obstacle_conf,
                    suppress_header=True,
                    avoid_label_regions=label_regions,
                    draw_boxes_labels=False,
                )

                # Keep obstacle stats separate from base road/road_type counts,
                # but expose them as extra chart series.
                obstacle_stats = obstacle_result.get("stats") if isinstance(obstacle_result, dict) else None
                if isinstance(obstacle_stats, dict):
                    obstacle_counts = obstacle_stats.get("class_counts")
                    if isinstance(obstacle_counts, dict):
                        for cls_name, cls_count in obstacle_counts.items():
                            key = str(cls_name)
                            extra_chart_class_counts[key] = extra_chart_class_counts.get(key, 0) + int(cls_count)

                    obstacle_colors = obstacle_stats.get("class_colors")
                    if isinstance(obstacle_colors, dict):
                        for cls_name, bgr in obstacle_colors.items():
                            if bgr is None or len(bgr) < 3:
                                continue
                            key = str(cls_name)
                            extra_chart_class_colors[key] = (int(bgr[0]), int(bgr[1]), int(bgr[2]))

                obstacle_frame = obstacle_result.get("frame") if isinstance(obstacle_result, dict) else None
                if isinstance(obstacle_frame, np.ndarray) and obstacle_frame.shape == detected.shape:
                    obstacle_overlay_mask = obstacle_result.get("overlay_mask") if isinstance(obstacle_result, dict) else None
                    if isinstance(obstacle_overlay_mask, np.ndarray) and obstacle_overlay_mask.shape[:2] == detected.shape[:2]:
                        obstacle_overlay_mask = obstacle_overlay_mask.astype(bool)
                    else:
                        obstacle_overlay_mask = np.zeros(detected.shape[:2], dtype=bool)
                    if np.any(obstacle_overlay_mask):
                        detected[obstacle_overlay_mask] = obstacle_frame[obstacle_overlay_mask]

                obstacle_boxes = obstacle_result.get("boxes") if isinstance(obstacle_result, dict) else None
                obstacle_confs = obstacle_result.get("confs") if isinstance(obstacle_result, dict) else None
                obstacle_cls_ids = obstacle_result.get("cls_ids") if isinstance(obstacle_result, dict) else None
                obstacle_box_labels = obstacle_result.get("box_labels") if isinstance(obstacle_result, dict) else None
                obstacle_box_colors = obstacle_result.get("box_colors") if isinstance(obstacle_result, dict) else None
                obstacle_names = obstacle_result.get("names") if isinstance(obstacle_result, dict) else None

                if isinstance(obstacle_boxes, np.ndarray) and isinstance(obstacle_confs, np.ndarray) and len(obstacle_boxes) > 0:
                    _, _, _, label_regions = self._draw_boxes_and_collect_counts(
                        detected,
                        obstacle_boxes,
                        obstacle_confs,
                        obstacle_cls_ids if isinstance(obstacle_cls_ids, np.ndarray) else np.empty((0,), dtype=int),
                        obstacle_box_labels if isinstance(obstacle_box_labels, list) else [],
                        obstacle_box_colors if isinstance(obstacle_box_colors, list) else [(255, 255, 0)] * len(obstacle_boxes),
                        obstacle_names if isinstance(obstacle_names, dict) else {},
                        "obstacle",
                        font_face,
                        avoid_label_regions=label_regions,
                    )

        header_detect_name = detect_key
        
        if include_obstacle and detect_key in ("road", "road_type"):
            header_detect_info = f"{header_detect_name}({conf * 100:.0f}%), obstacle({float(np.clip(float(obstacle_conf), 0.0, 1.0)) * 100:.0f}%)"
        else:
            header_detect_info = f"{header_detect_name}({conf * 100:.0f}%)"

        if not suppress_header:
            detected = self._render_header(detected, header_detect_info, detected_count, class_counts, started_at, font_face)

        chart_class_counts = {str(key): int(value) for key, value in class_counts.items()}
        chart_class_colors = {str(key): (int(value[0]), int(value[1]), int(value[2])) for key, value in class_chart_colors.items()}
        for key, value in extra_chart_class_counts.items():
            key = str(key)
            chart_class_counts[key] = chart_class_counts.get(key, 0) + int(value)

        for key, bgr in extra_chart_class_colors.items():
            key = str(key)
            chart_class_colors[key] = (int(bgr[0]), int(bgr[1]), int(bgr[2]))

        # Resolve missing colors for extra chart classes from colormap.
        for key in chart_class_counts.keys():
            if key in chart_class_colors:
                continue
            mapped = fallback_class_color_map.get(key, fallback_class_color_map.get(str(key).lower()))
            if mapped is not None:
                chart_class_colors[key] = (int(mapped[0]), int(mapped[1]), int(mapped[2]))

        stats = {
            "detect_type": detect_key,
            "detected_count": int(detected_count),
            "max_confidence": max_confidence,
            "mask_count": int(mask_count),
            "total_mask_count": int(total_mask_count),
            "class_counts": chart_class_counts,
            "class_colors": chart_class_colors,
        }

        if show_detect_stats and not suppress_header:
            history = self._append_stats_history(stats_history, stats, frame_number=frame_number, total_frames=total_frames)
            detected = self._render_bottom_stats_overlay(detected, stats, history, font_face, frame_number=frame_number, total_frames=total_frames)

        if show_time_bar and not suppress_header:
            detected = self._render_bottom_time_bar_overlay(
                detected,
                frame_number=frame_number,
                total_frames=total_frames,
                frame_fps=frame_fps,
                font_face=font_face,
            )

        # Final safety gate: for obstacle detection, ensure nothing is rendered outside
        # confidence-filtered road area.
        if detect_key == "obstacle" and obstacle_allowed_area_mask is not None:
            if np.any(obstacle_allowed_area_mask):
                filtered_object_mask = np.logical_and(filtered_object_mask, obstacle_allowed_area_mask)
                detected = np.where(obstacle_allowed_area_mask[:, :, None], detected, frame)
            else:
                filtered_object_mask = np.zeros_like(filtered_object_mask, dtype=bool)
                detected = frame.copy()
                detected = self._draw_roi_overlay(detected, roi)

        if return_info:
            return {
                "frame": detected,
                "stats": stats,
                "overlay_mask": filtered_object_mask,
                "boxes": boxes,
                "confs": confs,
                "cls_ids": cls_ids,
                "box_labels": box_labels,
                "box_colors": box_colors,
                "names": names,
            }

        return detected
    pass # detect_road

pass # RoadDetector
