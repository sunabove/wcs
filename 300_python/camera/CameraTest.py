#!/usr/bin/env python3

import cv2
import time

camera_id = 0

cap = cv2.VideoCapture(camera_id, cv2.CAP_V4L2)

if not cap.isOpened():
    print("카메라를 열 수 없습니다.")
    exit()

# 원하는 해상도 설정
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

prev_time = time.time()

while True:
    ret, frame = cap.read()

    if not ret:
        print("프레임 읽기 실패")
        break

    # FPS 계산
    current_time = time.time()
    fps = 1.0 / (current_time - prev_time)
    prev_time = current_time

    cv2.putText(
        frame,
        f"FPS: {fps:.1f}",
        (10, 30),
        cv2.FONT_HERSHEY_SIMPLEX,
        1,
        (0, 255, 0),
        2
    )

    cv2.imshow("Camera Viewer", frame)

    key = cv2.waitKey(1) & 0xFF

    if key == 27:  # ESC
        break

cap.release()
cv2.destroyAllWindows()