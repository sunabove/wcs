from fastapi import HTTPException

import cv2
import numpy as np
from ultralytics import YOLO
from pathlib import Path
import subprocess
import time
from fastapi.responses import StreamingResponse
import base64
import json

from send_image import resolve_upload_image_path
from config import BASE_DIR, VIDEO_EXTENSIONS


class RoadDetector:
    _road_area_model = None
    _road_area_model_path = Path(__file__).resolve().parent / "ai/road/model/01_yolo11m-road-sg.pt"
    _class_color_map_path = Path(__file__).resolve().parent / "colormap_road.txt"
    _class_color_map = None
    
    _model_paths = {
        "road": Path(__file__).resolve().parent / "ai/road/model/01_yolo11m-road-sg.pt",
        "road_type": Path(__file__).resolve().parent / "ai/road/model/02_yolo11m-road-type-sg.pt",
        "pothole": Path(__file__).resolve().parent / "ai/road/model/03_yolo11m-pothole-sg.pt",
    }
    _models = {}
    _stream_sessions = {}  # {session_id: {capture, frame_count, fps, detect_type, file_name}}
    
    def __init__(self):
        self.image_ext = {".jpg", ".jpeg", ".png", ".bmp", ".webp"} 
        self.video_ext = set(VIDEO_EXTENSIONS)
    pass # __init__

    @classmethod
    def _get_class_color_map(cls):
        if cls._class_color_map is not None:
            return cls._class_color_map

        color_map = {}
        try:
            with cls._class_color_map_path.open("r", encoding="utf-8") as f:
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

        cls._class_color_map = color_map
        return cls._class_color_map

    @staticmethod
    def _get_instance_mask_color(base_bgr, instance_index, cls_id=None):
        # Keep deterministic but vary color per detected object.
        b0, g0, r0 = [int(v) for v in base_bgr]
        seed = (instance_index + 1) * 131 + (0 if cls_id is None else (int(cls_id) + 1) * 17)
        rng = np.random.default_rng(seed)

        hsv = cv2.cvtColor(np.uint8([[[b0, g0, r0]]]), cv2.COLOR_BGR2HSV)[0, 0].astype(int)
        h, s, v = int(hsv[0]), int(hsv[1]), int(hsv[2])

        hue_shift = int(rng.integers(12, 80))
        sat_shift = int(rng.integers(-20, 35))
        val_shift = int(rng.integers(-25, 30))

        h2 = (h + hue_shift) % 180
        s2 = max(80, min(255, s + sat_shift))
        v2 = max(80, min(255, v + val_shift))

        varied_bgr = cv2.cvtColor(np.uint8([[[h2, s2, v2]]]), cv2.COLOR_HSV2BGR)[0, 0]
        return (int(varied_bgr[0]), int(varied_bgr[1]), int(varied_bgr[2]))

    def road_detect_service(self, file_name: str, detect_type: str = "road") -> dict:
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

            detected_image = self.detect_road(input_image, detect_type)
            if not cv2.imwrite(str(output_path), detected_image):
                raise HTTPException(status_code=500, detail="Failed to write output image")
        elif suffix in self.video_ext:
            # Use MP4 container to ensure browser-compatible H.264 playback.
            output_path = input_path.with_name(f"{stem}_detected.mp4")
            self.detect_video(input_path, output_path, detect_type)
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

    def detect_video(self, input_path: Path, output_path: Path, detect_type: str) -> None:
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
        try:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break

                detected_frame = self.detect_road(frame, detect_type)

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
        finally:
            capture.release()
            if writer is not None:
                writer.release()

        if not temp_output_path.exists() or temp_output_path.stat().st_size == 0:
            raise HTTPException(status_code=500, detail="Failed to write temporary AVI video")

        try:
            self.transcode_video_to_h264(temp_output_path, output_path)
        finally:
            if temp_output_path.exists():
                temp_output_path.unlink()

        if not output_path.exists() or output_path.stat().st_size == 0:
            raise HTTPException(status_code=500, detail="Failed to write output video")
    pass # detect_video

    def road_detect_stream_init(self, file_name: str, detect_type: str = "road") -> dict:
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
                print(f"Error cleaning up old session for {session_id}: {e}")
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
            'file_name': file_name
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
            frame_index = session['frame_index']
            frame_count = session['frame_count']

            ok, frame = capture.read()
            if not ok:
                # 마지막 프레임
                return {
                    'has_next': False,
                    'frame_number': frame_index,
                    'total_frames': frame_count,
                    'frame': None
                }

            # 프레임 감지 처리
            detected_frame = self.detect_road(frame, detect_type)

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
                'detect_type': detect_type
            }
        except Exception as e:
            print(f"Error in road_detect_stream_next: {e}")
            raise HTTPException(status_code=500, detail=f"Stream processing error: {e}")
    pass # road_detect_stream_next

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
            print(f"Error releasing capture for {session_id}: {e}")
        
        try:
            del RoadDetector._stream_sessions[session_id]
        except KeyError:
            pass

        return {
            'message': 'Stream session cleaned up successfully',
            'session_id': session_id
        }
    pass # road_detect_stream_cleanup

    def road_detect_stream(self, file_name: str, detect_type: str = "road") -> StreamingResponse:
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
            try:
                while True:
                    ok, frame = capture.read()
                    if not ok:
                        break

                    detected_frame = self.detect_road(frame, detect_type)
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

    def detect_road(self, frame, detect_type: str = "road"):
        detect_key = detect_type if detect_type in RoadDetector._model_paths else "road"
        conf = 0.10 if detect_key == "road_type" else 0.20
        font_face = cv2.FONT_HERSHEY_SIMPLEX
        min_mask_area_ratio = 0.001  # Exclude masks smaller than 0.1% of frame area.
        min_mask_area_pixels = 64

        if detect_key not in RoadDetector._models:
            model_path = RoadDetector._model_paths[detect_key]
            if not model_path.exists():
                raise HTTPException(
                    status_code=500,
                    detail=f"Model file not found: {model_path}"
                )
            RoadDetector._models[detect_key] = YOLO(str(model_path))
        pass
    
        started_at = time.perf_counter()
        
        try:
            result = RoadDetector._models[detect_key].predict(source=frame, conf=conf, verbose=False)[0]
        except Exception as ex:
            raise HTTPException(status_code=500, detail=f"YOLO inference failed: {ex}")

        detected = frame.copy()
        names = result.names if isinstance(result.names, dict) else {}
        class_counts = {}

        detected_count = 0
        mask_count = 0
        total_mask_count = 0
        regenerated_boxes = []
        regenerated_confs = []
        regenerated_cls_ids = []

        kept_mask_indices = []
        if result.masks is not None and result.masks.data is not None:
            # YOLOv11m 모델은 masks와 boxes가 동시에 존재할 수 있음. 
            # 둘 다 존재하는 경우, 마스크는 영역을 강조하고 박스는 신뢰도와 함께 위치를 표시하는 용도로 활용.
            
            masks = result.masks.data.cpu().numpy()
            total_mask_count = len(masks)
            mask_cls_ids = result.masks.cls.cpu().numpy().astype(int) if getattr(result.masks, "cls", None) is not None else None
            box_confs = result.boxes.conf.cpu().numpy() if (result.boxes is not None and result.boxes.conf is not None) else None
            box_cls_ids = result.boxes.cls.cpu().numpy().astype(int) if (result.boxes is not None and result.boxes.cls is not None) else None
            height, width = detected.shape[:2]
            frame_area = max(1, height * width)
            min_mask_area = max(min_mask_area_pixels, int(frame_area * min_mask_area_ratio))
            class_color_map = RoadDetector._get_class_color_map()

            overlay = detected.copy()
            for idx, mask in enumerate(masks):
                mask_resized = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
                binary_mask = mask_resized > 0.5
                mask_area = int(np.count_nonzero(binary_mask))
                if mask_area < min_mask_area:
                    continue

                kept_mask_indices.append(idx)

                ys, xs = np.where(binary_mask)
                if xs.size > 0 and ys.size > 0:
                    x1 = int(xs.min())
                    y1 = int(ys.min())
                    x2 = int(xs.max())
                    y2 = int(ys.max())
                    regenerated_boxes.append([x1, y1, x2, y2])
                    if box_confs is not None and idx < len(box_confs):
                        regenerated_confs.append(float(box_confs[idx]))
                    else:
                        regenerated_confs.append(0.0)
                    if mask_cls_ids is not None and idx < len(mask_cls_ids):
                        regenerated_cls_ids.append(int(mask_cls_ids[idx]))
                    elif box_cls_ids is not None and idx < len(box_cls_ids):
                        regenerated_cls_ids.append(int(box_cls_ids[idx]))
                    else:
                        regenerated_cls_ids.append(-1)

                mask_color = (0, 255, 0)
                cls_id = None
                if mask_cls_ids is not None and idx < len(mask_cls_ids):
                    cls_id = int(mask_cls_ids[idx])
                    cls_name = str(names.get(cls_id, cls_id))
                    mask_color = class_color_map.get(cls_name, class_color_map.get(cls_name.lower(), mask_color))
                mask_color = RoadDetector._get_instance_mask_color(mask_color, idx, cls_id)
                overlay[binary_mask] = mask_color

            mask_count = len(kept_mask_indices)
            detected = cv2.addWeighted(overlay, 0.35, detected, 0.65, 0)
        pass

        if result.boxes is not None and result.boxes.xyxy is not None:
            # YOLOv11m 모델은 masks와 boxes가 동시에 존재할 수 있음. 
            # 둘 다 존재하는 경우, 마스크는 영역을 강조하고 박스는 신뢰도와 함께 위치를 표시하는 용도로 활용.
            # 박스 좌표와 신뢰도 추출
            if total_mask_count > 0:
                # 작은 마스크 제외 후 남은 마스크의 실제 픽셀 영역에서 box 재생성.
                if regenerated_boxes:
                    boxes = np.array(regenerated_boxes, dtype=int)
                    confs = np.array(regenerated_confs, dtype=float)
                    cls_ids = np.array(regenerated_cls_ids, dtype=int)
                else:
                    boxes = np.empty((0, 4), dtype=int)
                    confs = np.empty((0,), dtype=float)
                    cls_ids = np.empty((0,), dtype=int)
            else:
                boxes = result.boxes.xyxy.cpu().numpy().astype(int)
                confs = result.boxes.conf.cpu().numpy()
                cls_ids = result.boxes.cls.cpu().numpy().astype(int) if result.boxes.cls is not None else None

            detected_count = len(boxes)
            
            for idx, ((x1, y1, x2, y2), box_conf) in enumerate(zip(boxes, confs)):
                cv2.rectangle(detected, (x1, y1), (x2, y2), (0, 255, 255), 2)

                cls_name = ""
                if cls_ids is not None and idx < len(cls_ids):
                    cls_id_value = int(cls_ids[idx])
                    if cls_id_value >= 0:
                        cls_name = str(names.get(cls_id_value, cls_id_value))
                if not cls_name:
                    cls_name = detect_key

                if cls_name:
                    class_counts[cls_name] = class_counts.get(cls_name, 0) + 1
                label = f"{cls_name} {box_conf:.2f}".strip()
                (tw, th), baseline = cv2.getTextSize(label, font_face, 0.6, 2)
                ty = max(y1 - 6, th + 4)
                cv2.rectangle(detected, (x1, ty - th - 4), (x1 + tw + 4, ty + baseline), (0, 255, 255), cv2.FILLED)
                cv2.putText(detected, label, (x1 + 2, ty - 2), font_face, 0.6, (0, 0, 0), 2)
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

        showHeader = True
        if showHeader:
            # 헤더 텍스트 추가: 1줄은 타입/신뢰도, 2줄은 검출 도로 개수
            elapsed_ms = (time.perf_counter() - started_at) * 1000.0
            header_text = f"type: {detect_key}({detected_count}), conf: {conf * 100:.0f}%, time: {elapsed_ms:.0f}ms"
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

            # Resize detected image when width is smaller than header text area.
            required_width = header_w + box_padding + right_margin
            current_height, current_width = detected.shape[:2]
            if current_width < required_width:
                resize_ratio = required_width / float(current_width)
                detected = cv2.resize(
                    detected,
                    (int(round(current_width * resize_ratio)), int(round(current_height * resize_ratio))),
                    interpolation=cv2.INTER_LINEAR
                )

            # Draw a 50% alpha header background using overlay blending.
            y1_box = 10
            text_right_x = detected.shape[1] - right_margin
            x2 = text_right_x + 6
            x1 = x2 - (header_w + box_padding)
            y2_box = y1_box + box_h

            overlay = detected.copy()
            cv2.rectangle(overlay, (x1, y1_box), (x2, y2_box), (255, 0, 0), cv2.FILLED)
            cv2.addWeighted(overlay, 0.5, detected, 0.5, 0, detected)

            y1 = y1_box + h1 + 2
            y2 = y1 + line_gap + h2 + 2
            cv2.putText(detected, header_text, (text_right_x - w1, y1), font_face, font_scale, (255, 255, 255), font_thickness)
            cv2.putText(detected, count_text, (text_right_x - w2, y2), font_face, font_scale, (255, 255, 255), font_thickness)
        pass

        return detected
    pass # detect_road

    def detect_road_old(self, frame):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blur = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blur, 50, 150)

        height, width = edges.shape
        mask = np.zeros_like(edges)
        roi = np.array([
            [
                (int(width * 0.1), height),
                (int(width * 0.45), int(height * 0.6)),
                (int(width * 0.55), int(height * 0.6)),
                (int(width * 0.9), height)
            ]
        ], dtype=np.int32)
        cv2.fillPoly(mask, roi, 255)
        roi_edges = cv2.bitwise_and(edges, mask)

        lines = cv2.HoughLinesP(
            roi_edges,
            rho=1,
            theta=np.pi / 180,
            threshold=30,
            minLineLength=40,
            maxLineGap=120
        )

        overlay = frame.copy()
        if lines is not None:
            for line in lines:
                x1, y1, x2, y2 = line[0]
                cv2.line(overlay, (x1, y1), (x2, y2), (0, 255, 0), 3)

        return overlay
    pass # detect_road_old

pass # RoadDetector