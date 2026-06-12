from fastapi import HTTPException

import cv2
import numpy as np
from ultralytics import YOLO
from pathlib import Path

from send_image import resolve_upload_image_path


class RoadDetector:
    _road_area_model = None
    _road_area_model_path = Path(__file__).resolve().parent / "ai/road/model/01_yolo11m-road-sg.pt"
    
    def __init__(self):
        self.image_ext = {".jpg", ".jpeg", ".png", ".bmp", ".webp"} 
    pass # __init__

    def road_detect_service(self, file_name: str) -> dict:
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

        detected_image = self.detect_road(input_image)
        
        if not cv2.imwrite(str(output_path), detected_image):
            raise HTTPException(status_code=500, detail="Failed to write output image")

        return {
            "image_url": f"/fast/image/{output_path.name}"
        }
    pass # road_detect_service

    def detect_road(self, frame):
        
        if RoadDetector._road_area_model is None:
            if not RoadDetector._road_area_model_path.exists():
                raise HTTPException(
                    status_code=500,
                    detail=f"Model file not found: {RoadDetector._road_area_model_path}"
                )
            RoadDetector._road_area_model = YOLO(str(RoadDetector._road_area_model_path))
        pass
    
        try:
            result = RoadDetector._road_area_model.predict(source=frame, verbose=False)[0]
        except Exception as ex:
            raise HTTPException(status_code=500, detail=f"YOLO inference failed: {ex}")

        detected = frame.copy()

        if result.masks is not None and result.masks.data is not None:
            masks = result.masks.data.cpu().numpy()
            height, width = detected.shape[:2]

            overlay = detected.copy()
            for mask in masks:
                mask_resized = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
                binary_mask = mask_resized > 0.5
                overlay[binary_mask] = (0, 255, 0)

            detected = cv2.addWeighted(overlay, 0.35, detected, 0.65, 0)

        if result.boxes is not None and result.boxes.xyxy is not None:
            boxes = result.boxes.xyxy.cpu().numpy().astype(int)
            confs = result.boxes.conf.cpu().numpy()
            for (x1, y1, x2, y2), conf in zip(boxes, confs):
                cv2.rectangle(detected, (x1, y1), (x2, y2), (0, 255, 255), 2)
                label = f"{conf:.2f}"
                cv2.putText(detected, label, (x1, y1 - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
            pass
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