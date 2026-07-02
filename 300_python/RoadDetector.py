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

from send_image import resolve_upload_image_path
from config import BASE_DIR, UPLOAD_DIR, VIDEO_EXTENSIONS
from ChartRenderer import ChartRenderer

logger = logging.getLogger(__name__)

class RoadDetector:
    MIN_CONF = 0.10
    MAX_CONF_GAP_RATIO = 0.10
    _class_color_map_path = Path(__file__).resolve().parent / "colormap_road.txt"
    _class_color_map = None
    
    road_type_model_name = "ai/road/model/02_yolo11m-cobot-road-type-sg-260626.pt"
    #road_type_model_name = "ai/road/model/03_yolo11m-road-type-sg.pt"
    
    _model_paths = {
        "road": Path(__file__).resolve().parent / "ai/road/model/01_yolo11m-road-sg.pt",
        "road_type": Path(__file__).resolve().parent / road_type_model_name ,
        "pothole": Path(__file__).resolve().parent / "ai/road/model/04_yolo11m-pothole-sg.pt",
    }
    _models = {}
    _stream_sessions = {}  # {session_id: {capture, frame_count, fps, detect_type, file_name, input_path, roi}}
    _camera_stream_sessions = {}  # {session_id: {capture, frame_index, fps, detect_type, camera_index}}
    _detect_progress = {}  # {session_id: {status, current_frame, total_frames, percentage, error}}
    _detect_lock = threading.Lock()  # Lock for thread-safe access to _detect_progress
    _chart_renderer = ChartRenderer()
    
    def __init__(self):
        self.image_ext = {".jpg", ".jpeg", ".png", ".bmp", ".webp"} 
        self.video_ext = set(VIDEO_EXTENSIONS)
    pass # __init__

    def _get_class_color_map(self):
        if self.__class__._class_color_map is not None:
            return self.__class__._class_color_map

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

        self.__class__._class_color_map = color_map
        return self.__class__._class_color_map

    def _get_instance_mask_color(self, base_bgr, instance_index, cls_id=None):
        # Keep the class base color to avoid confusing cross-class-like hues.
        b0, g0, r0 = [int(v) for v in base_bgr]
        return (b0, g0, r0)

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
            overlay = detected.copy()
            cv2.rectangle(overlay, (x1, y1), (x2, y2), (0, 0, 255), cv2.FILLED)
            alpha = 0.1
            cv2.addWeighted(overlay, alpha, detected, 1 - alpha, 0, detected)
            cv2.rectangle(detected, (x1, y1), (x2, y2), (0, 0, 255), 2)

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

    def road_detect_service(self, file_name: str, detect_type: str = "road", remove_noisy_masks: bool = True, show_detect_stats: bool = True) -> dict:
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
            detected_image = self.detect_road(
                input_image,
                detect_type,
                roi=roi,
                remove_noisy_masks=remove_noisy_masks,
                show_detect_stats=False,
            )
            if not cv2.imwrite(str(output_path), detected_image):
                raise HTTPException(status_code=500, detail="Failed to write output image")
        elif suffix in self.video_ext:
            # Use MP4 container to ensure browser-compatible H.264 playback.
            output_path = input_path.with_name(f"{stem}_detected.mp4")
            # Use file_name as session_id for progress tracking
            self.detect_video(input_path, output_path, detect_type, remove_noisy_masks, show_detect_stats, session_id=file_name)
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

    def detect_video(self, input_path: Path, output_path: Path, detect_type: str, remove_noisy_masks: bool = True, show_detect_stats: bool = True, session_id: str = None) -> None:
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
                    stats_history=stats_history,
                    frame_number=current_frame_no,
                    total_frames=frame_count,
                    return_info=True,
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

    def road_detect_stream_init(self, file_name: str, detect_type: str = "road", remove_noisy_masks: bool = True, show_detect_stats: bool = True) -> dict:
        """비디오 스트리밍 세션 초기화"""
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
            'remove_noisy_masks': bool(remove_noisy_masks),
            'show_detect_stats': bool(show_detect_stats),
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
            remove_noisy_masks = bool(session.get('remove_noisy_masks', True))
            show_detect_stats = bool(session.get('show_detect_stats', True))
            frame_index = session['frame_index']
            frame_count = session['frame_count']
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
                stats_history=stats_history,
                frame_number=frame_index + 1,
                total_frames=frame_count,
                return_info=True,
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
        session_id = file_name
        
        # 세션이 없으면 이미 정리된 것
        if session_id not in RoadDetector._stream_sessions:
            return {
                'message': 'Stream session already cleaned or not found',
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

    def camera_detect_stream_init(self, camera_index: int, detect_type: str = "road", camera_name: str = "", remove_noisy_masks: bool = True, show_detect_stats: bool = True) -> dict:
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
            "remove_noisy_masks": bool(remove_noisy_masks),
            "show_detect_stats": bool(show_detect_stats),
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
        remove_noisy_masks = bool(session.get("remove_noisy_masks", True))
        show_detect_stats = bool(session.get("show_detect_stats", True))
        detect_enabled = bool(session.get("detect_enabled", True))
        stats_history = session.get("stats_history")

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
                stats_history=stats_history,
                frame_number=int(session.get("frame_index", 0)) + 1,
                return_info=True,
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

    def road_detect_stream(self, file_name: str, detect_type: str = "road", remove_noisy_masks: bool = True, show_detect_stats: bool = True) -> StreamingResponse:
        """(레거시) 연속 MJPEG 스트리밍 - 하위호환성 유지"""
        input_path = resolve_upload_image_path(file_name)
        if not input_path.exists() or not input_path.is_file():
            raise HTTPException(status_code=404, detail="Input file not found")

        if input_path.suffix.lower() not in self.video_ext:
            raise HTTPException(status_code=400, detail="Streaming is supported only for video files")

        capture = cv2.VideoCapture(str(input_path))
        if not capture.isOpened():
            raise HTTPException(status_code=400, detail="Failed to read video file")

        def generate():
            roi = None
            stats_history = {}
            total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            frame_number = 0
            try:
                while True:
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
                        stats_history=stats_history,
                        frame_number=frame_number,
                        total_frames=total_frames,
                        return_info=True,
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
    ):
        regenerated_boxes = []
        regenerated_confs = []
        regenerated_cls_ids = []
        regenerated_labels = []
        regenerated_box_colors = []
        kept_mask_indices = []
        noisy_mask_polygons = []
        mask_count = 0
        total_mask_count = 0

        if result.masks is None or result.masks.data is None:
            return {
                "detected": detected,
                "mask_count": mask_count,
                "total_mask_count": total_mask_count,
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
        if detect_key:
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

                mask_resized_local = cv2.resize(mask, (iw, ih), interpolation=cv2.INTER_NEAREST)
                binary_mask_local = mask_resized_local > 0.5
                binary_mask = np.zeros((height, width), dtype=bool)
                binary_mask[iy1:iy2, ix1:ix2] = binary_mask_local[:(iy2 - iy1), :(ix2 - ix1)]
            else:
                mask_resized = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
                binary_mask = mask_resized > 0.5

            if roi_binary is not None:
                binary_mask = np.logical_and(binary_mask, roi_binary)

            prepared_masks.append(binary_mask)

        if prepared_masks:
            global_binary_mask = np.any(np.stack(prepared_masks, axis=0), axis=0)
        else:
            global_binary_mask = np.zeros((height, width), dtype=bool)

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

            mask_area = int(np.count_nonzero(active_binary_mask))
            if mask_area > 0:
                kept_mask_indices.append(idx)

                mask_color = (0, 255, 0)
                if mask_cls_ids is not None and idx < len(mask_cls_ids):
                    cls_id = int(mask_cls_ids[idx])
                    cls_name = str(names.get(cls_id, cls_id))
                    mask_color = class_color_map.get(cls_name, class_color_map.get(cls_name.lower(), mask_color))
                mask_color = self._get_instance_mask_color(mask_color, idx, cls_id)

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
        if (not remove_noisy_masks) and noisy_mask_polygons:
            cv2.polylines(detected, noisy_mask_polygons, True, (0, 0, 255), 1)

        return {
            "detected": detected,
            "mask_count": mask_count,
            "total_mask_count": total_mask_count,
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
            box_labels = []
            box_colors = [(0, 255, 255)] * len(boxes)

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

    def _draw_boxes_and_collect_counts(self, detected, boxes, confs, cls_ids, box_labels, box_colors, names, detect_key, font_face):
        class_counts = {}
        class_colors = {}
        detected_count = len(boxes)

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
            cv2.rectangle(detected, (x1, ty - th - 4), (x1 + tw + 4, ty + baseline), box_color, cv2.FILLED)
            # Use white text on dark box colors for readability.
            b, g, r = int(box_color[0]), int(box_color[1]), int(box_color[2])
            luminance = (0.114 * b) + (0.587 * g) + (0.299 * r)
            text_color = (255, 255, 255) if luminance < 120 else (0, 0, 0)
            cv2.putText(detected, label, (x1 + 2, ty - 2), font_face, 0.6, text_color, 2)

        return detected_count, class_counts, class_colors

    def _render_header(self, detected, detect_key, detected_count, conf, class_counts, started_at, font_face):
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        header_text = f"Detect: {detect_key}, conf: {conf * 100:.0f}%, time: {elapsed_ms:.0f}ms"
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

    def _prepare_inference_frame_with_road_crop(self, frame, frame_for_inference, conf, roi, detect_key):
        if "road" not in RoadDetector._models:
            road_model_path = RoadDetector._model_paths["road"]
            if road_model_path.exists():
                RoadDetector._models["road"] = YOLO(str(road_model_path))

        if "road" not in RoadDetector._models:
            return frame_for_inference

        try:
            road_result = RoadDetector._models["road"].predict(source=frame_for_inference, conf=conf, verbose=False)[0]
            if roi is None and road_result.boxes is not None and road_result.boxes.conf is not None:
                road_confs = road_result.boxes.conf.cpu().numpy()
                if len(road_confs) > 0:
                    road_boxes = road_result.boxes.xyxy.cpu().numpy().astype(int)
                    max_conf = float(np.max(road_confs))
                    min_keep_conf = max_conf * (1.0 - float(self.MAX_CONF_GAP_RATIO))
                    keep_indices = np.where(road_confs >= min_keep_conf)[0]
                    if len(keep_indices) == 0:
                        keep_indices = np.array([int(np.argmax(road_confs))])

                    selected_boxes = road_boxes[keep_indices]
                    x1 = int(np.min(selected_boxes[:, 0]))
                    y1 = int(np.min(selected_boxes[:, 1]))
                    x2 = int(np.max(selected_boxes[:, 2]))
                    y2 = int(np.max(selected_boxes[:, 3]))

                    h, w = frame.shape[:2]
                    x1 = max(0, min(x1, w - 1))
                    y1 = max(0, min(y1, h - 1))
                    x2 = max(x1 + 1, min(x2, w))
                    y2 = max(y1 + 1, min(y2, h))

                    return frame[y1:y2, x1:x2].copy()
        except Exception as e:
            logger.warning("Road area preprocessing for %s failed: %s", detect_key, e)

        return frame_for_inference
    pass # _prepare_inference_frame_with_road_crop

    def detect_road(
        self,
        frame,
        detect_type: str = "road",
        roi=None,
        remove_noisy_masks: bool = True,
        return_info: bool = False,
        show_detect_stats: bool = False,
        stats_history=None,
        frame_number=None,
        total_frames=None,
    ):
        detect_key = detect_type if detect_type in RoadDetector._model_paths else "road"
        conf = RoadDetector.MIN_CONF
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

        # For road_type and pothole, use the same road-area preprocessing.
        if detect_key in ("road_type", "pothole"):
            frame_for_inference = self._prepare_inference_frame_with_road_crop(
                frame,
                frame_for_inference,
                conf,
                roi,
                detect_key,
            )

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
            )
            boxes_payload = self._filter_boxes_payload_by_roi(boxes_payload, roi)
            # When masks are present, confidence filtering is already applied in
            # _process_result_masks. Applying box-only filtering again can cause
            # mask/box mismatch (overlay outside shown boxes).
            if total_mask_count <= 0:
                boxes_payload = self._filter_boxes_payload_by_max_conf_gap(boxes_payload)

            boxes = boxes_payload["boxes"]
            confs = boxes_payload["confs"]
            cls_ids = boxes_payload["cls_ids"]
            box_labels = boxes_payload["box_labels"]
            box_colors = boxes_payload["box_colors"]

            detected_count, class_counts, class_chart_colors = self._draw_boxes_and_collect_counts(
                detected,
                boxes,
                confs,
                cls_ids,
                box_labels,
                box_colors,
                names,
                detect_key,
                font_face,
            )
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

        detected = self._render_header(detected, detect_key, detected_count, conf, class_counts, started_at, font_face)

        stats = {
            "detect_type": detect_key,
            "detected_count": int(detected_count),
            "max_confidence": max_confidence,
            "mask_count": int(mask_count),
            "total_mask_count": int(total_mask_count),
            "class_counts": {str(key): int(value) for key, value in class_counts.items()},
            "class_colors": {str(key): (int(value[0]), int(value[1]), int(value[2])) for key, value in class_chart_colors.items()},
        }

        if show_detect_stats:
            history = self._append_stats_history(stats_history, stats, frame_number=frame_number, total_frames=total_frames)
            detected = self._render_bottom_stats_overlay(detected, stats, history, font_face, frame_number=frame_number, total_frames=total_frames)

        if return_info:
            return {
                "frame": detected,
                "stats": stats,
            }

        return detected
    pass # detect_road

pass # RoadDetector
