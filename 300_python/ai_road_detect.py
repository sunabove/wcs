from fastapi import APIRouter
from fastapi import HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from pathlib import Path
from config import *
import cv2
import numpy as np

router = APIRouter( prefix="/fast" )

@router.get("/road")
async def ai_road_service():
    return "hello ai road"
pass

@router.get("/image_test")
async def image_test():
    base_dir = Path(__file__).resolve().parent
    image_path = base_dir / "test/test_image.jpg"

    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(
        str(image_path),
        media_type="image/jpeg"
    )
pass # image_test

@router.post("/upload_image")
async def image_upload_service(file: UploadFile = File(...)):
    from upload_image import save_uploaded_image

    return save_uploaded_image(file)
pass # image_upload_service

@router.get("/image")
async def image_service_query(file_name: str):
    from send_image import send_image_contents

    return send_image_contents(file_name)
pass # image_service_query

@router.get("/image/{file_name:path}")
async def image_service_path(file_name: str):
    from send_image import send_image_contents

    return send_image_contents(file_name)
pass # image_service_path


@router.get("/detect_road/{file_name:path}")
async def detect_road(file_name: str):
    from send_image import resolve_upload_image_path

    input_path = resolve_upload_image_path(file_name)
    if not input_path.exists() or not input_path.is_file():
        raise HTTPException(status_code=404, detail="Input file not found")

    stem = input_path.stem
    suffix = input_path.suffix.lower()
    output_path = input_path.with_name(f"{stem}_road{suffix}")

    image_ext = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

    if suffix not in image_ext:
        raise HTTPException(status_code=400, detail="Only still-image files are supported")

    def detect_lane_overlay(frame):
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

    image = cv2.imread(str(input_path))
    if image is None:
        raise HTTPException(status_code=400, detail="Failed to read image file")

    detected = detect_lane_overlay(image)
    if not cv2.imwrite(str(output_path), detected):
        raise HTTPException(status_code=500, detail="Failed to write output image")

    return {
        "image_url": f"/fast/image/{output_path.name}"
    }
    
pass # detect_road

