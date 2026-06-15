from fastapi import HTTPException

import cv2
import numpy as np
from ultralytics import YOLO
from pathlib import Path

from send_image import resolve_upload_image_path


class RoadDetector:
    _road_area_model = None
    _road_area_model_path = Path(__file__).resolve().parent / "ai/road/model/01_yolo11m-road-sg.pt"
    
    _model_paths = {
        "road": Path(__file__).resolve().parent / "ai/road/model/01_yolo11m-road-sg.pt",
        "road_type": Path(__file__).resolve().parent / "ai/road/model/02_yolo11m-road-type-sg.pt",
        "pothole": Path(__file__).resolve().parent / "ai/road/model/03_yolo11m-pothole-sg.pt",
    }
    _models = {}
    
    def __init__(self):
        self.image_ext = {".jpg", ".jpeg", ".png", ".bmp", ".webp"} 
    pass # __init__

    def road_detect_service(self, file_name: str, conf: float = 0.25, detect_type: str = "road") -> dict:
        input_path = resolve_upload_image_path(file_name)
        if not input_path.exists() or not input_path.is_file():
            raise HTTPException(status_code=404, detail="Input file not found")

        stem = input_path.stem
        suffix = input_path.suffix.lower()
        output_path = input_path.with_name(f"{stem}_detected{suffix}")

        if suffix not in self.image_ext:
            raise HTTPException(status_code=400, detail="Only still-image files are supported")

        input_image = cv2.imread(str(input_path))
        if input_image is None:
            raise HTTPException(status_code=400, detail="Failed to read image file")

        detected_image = self.detect_road(input_image, conf, detect_type)
        
        if not cv2.imwrite(str(output_path), detected_image):
            raise HTTPException(status_code=500, detail="Failed to write output image")

        return {
            "image_url": f"/fast/image/{output_path.name}"
        }
    pass # road_detect_service

    def detect_road(self, frame, conf: float = 0.25, detect_type: str = "road"):
        
        detect_key = detect_type if detect_type in RoadDetector._model_paths else "road"

        if detect_key not in RoadDetector._models:
            model_path = RoadDetector._model_paths[detect_key]
            if not model_path.exists():
                raise HTTPException(
                    status_code=500,
                    detail=f"Model file not found: {model_path}"
                )
            RoadDetector._models[detect_key] = YOLO(str(model_path))
        pass
    
        try:
            result = RoadDetector._models[detect_key].predict(source=frame, conf=conf, verbose=False)[0]
        except Exception as ex:
            raise HTTPException(status_code=500, detail=f"YOLO inference failed: {ex}")

        detected = frame.copy()
        names = result.names if isinstance(result.names, dict) else {}
        class_counts = {}

        detected_count = 0
        mask_count = 0

        if result.masks is not None and result.masks.data is not None:
            # YOLOv11m 모델은 masks와 boxes가 동시에 존재할 수 있음. 
            # 둘 다 존재하는 경우, 마스크는 영역을 강조하고 박스는 신뢰도와 함께 위치를 표시하는 용도로 활용.
            
            masks = result.masks.data.cpu().numpy()
            mask_count = len(masks)
            height, width = detected.shape[:2]

            overlay = detected.copy()
            for mask in masks:
                mask_resized = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
                binary_mask = mask_resized > 0.5
                overlay[binary_mask] = (0, 255, 0)

            detected = cv2.addWeighted(overlay, 0.35, detected, 0.65, 0)
        pass

        if result.boxes is not None and result.boxes.xyxy is not None:
            # YOLOv11m 모델은 masks와 boxes가 동시에 존재할 수 있음. 
            # 둘 다 존재하는 경우, 마스크는 영역을 강조하고 박스는 신뢰도와 함께 위치를 표시하는 용도로 활용.
            # 박스 좌표와 신뢰도 추출
            boxes = result.boxes.xyxy.cpu().numpy().astype(int) 
            confs = result.boxes.conf.cpu().numpy()
            cls_ids = result.boxes.cls.cpu().numpy().astype(int) if result.boxes.cls is not None else None
            detected_count = len(boxes)
            
            for idx, ((x1, y1, x2, y2), box_conf) in enumerate(zip(boxes, confs)):
                cv2.rectangle(detected, (x1, y1), (x2, y2), (0, 255, 255), 2)

                cls_name = ""
                if cls_ids is not None and idx < len(cls_ids):
                    cls_name = str(names.get(int(cls_ids[idx]), int(cls_ids[idx])))
                    class_counts[cls_name] = class_counts.get(cls_name, 0) + 1
                label = f"{cls_name} {box_conf:.2f}".strip()
                (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
                ty = max(y1 - 6, th + 4)
                cv2.rectangle(detected, (x1, ty - th - 4), (x1 + tw + 4, ty + baseline), (0, 255, 255), cv2.FILLED)
                cv2.putText(detected, label, (x1 + 2, ty - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)
            pass
        pass

        if not class_counts and result.masks is not None and getattr(result.masks, "cls", None) is not None:
            mask_cls_ids = result.masks.cls.cpu().numpy().astype(int)
            for cls_id in mask_cls_ids:
                cls_name = str(names.get(int(cls_id), int(cls_id)))
                class_counts[cls_name] = class_counts.get(cls_name, 0) + 1

        if detected_count == 0:
            detected_count = mask_count

        if True :
            # 헤더 텍스트 추가: 1줄은 타입/신뢰도, 2줄은 검출 도로 개수
            header_text = f"type: {detect_key}  conf: {conf * 100:.0f}%"
            count_text = f"detect_type: {detect_type}"
            if class_counts:
                class_count_text = ", ".join([f"{key}:{value}" for key, value in sorted(class_counts.items())])
                count_text = f"{count_text}, {class_count_text}"
                
            (w1, h1), b1 = cv2.getTextSize(header_text, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
            (w2, h2), b2 = cv2.getTextSize(count_text, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
            header_w = max(w1, w2)
            line_gap = 8
            box_h = h1 + b1 + line_gap + h2 + b2 + 2

            # Draw a 50% alpha header background using overlay blending.
            y1_box = 10
            text_right_x = detected.shape[1] - 10
            x2, y2_box = text_right_x + 6, y1_box + box_h
            x1 = x2 - (header_w + 12)
            
            overlay = detected.copy()
            cv2.rectangle(overlay, (x1, y1_box), (x2, y2_box), (255, 0, 0), cv2.FILLED)
            cv2.addWeighted(overlay, 0.5, detected, 0.5, 0, detected)
            
            y1 = y1_box + h1 + 2
            y2 = y1 + line_gap + h2 + 2
            cv2.putText(detected, header_text, (text_right_x - w1, y1), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
            cv2.putText(detected, count_text, (text_right_x - w2, y2), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
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