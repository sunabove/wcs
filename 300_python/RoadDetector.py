from fastapi import HTTPException

import cv2
import numpy as np

from send_image import resolve_upload_image_path


class RoadDetector:
    def __init__(self):
        self.image_ext = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

    def detect_lane_overlay(self, frame):
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
    pass # detect_lane_overlay

    def detect_road_image(self, file_name: str) -> dict:
        input_path = resolve_upload_image_path(file_name)
        if not input_path.exists() or not input_path.is_file():
            raise HTTPException(status_code=404, detail="Input file not found")

        stem = input_path.stem
        suffix = input_path.suffix.lower()
        output_path = input_path.with_name(f"{stem}_detected{suffix}")

        if suffix not in self.image_ext:
            raise HTTPException(status_code=400, detail="Only still-image files are supported")

        image = cv2.imread(str(input_path))
        if image is None:
            raise HTTPException(status_code=400, detail="Failed to read image file")

        detected = self.detect_lane_overlay(image)
        if not cv2.imwrite(str(output_path), detected):
            raise HTTPException(status_code=500, detail="Failed to write output image")

        return {
            "image_url": f"/fast/image/{output_path.name}"
        }
    pass # detect_road_image

pass # RoadDetector