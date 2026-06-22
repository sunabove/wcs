"""Camera device listing test utility.

Run this file directly to see which camera indices are openable in OpenCV.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List, Optional

import cv2


@dataclass
class CameraDeviceInfo:
	index: int
	name: str
	opened_backend: str
	width: int
	height: int
	fps: float


def _get_windows_device_names() -> Dict[int, str]:
	"""Return Windows DirectShow camera names indexed by device number.

	Falls back to an empty mapping when pygrabber is unavailable.
	"""
	try:
		from pygrabber.dshow_graph import FilterGraph  # type: ignore

		names = FilterGraph().get_input_devices()
		return {idx: name for idx, name in enumerate(names)}
	except Exception:
		return {}


def _try_open_capture(index: int, backend_flag: Optional[int], backend_name: str):
	"""Try opening camera at index with the selected backend."""
	cap = None
	try:
		if backend_flag is None:
			cap = cv2.VideoCapture(index)
		else:
			cap = cv2.VideoCapture(index, backend_flag)

		if not cap or not cap.isOpened():
			return None

		width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
		height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
		fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)

		return {
			"opened_backend": backend_name,
			"width": width,
			"height": height,
			"fps": fps,
		}
	except Exception:
		return None
	finally:
		if cap is not None:
			cap.release()


def list_camera_devices(max_devices: int = 10) -> List[CameraDeviceInfo]:
	"""List camera devices that OpenCV can open.

	Tries multiple backends per index in this order:
	1) DSHOW (Windows)
	2) MSMF
	3) CAP_ANY
	"""
	if max_devices < 1:
		return []

	name_map = _get_windows_device_names()

	backends = [
		(getattr(cv2, "CAP_DSHOW", None), "DSHOW"),
		(getattr(cv2, "CAP_MSMF", None), "MSMF"),
		(None, "ANY"),
	]

	devices: List[CameraDeviceInfo] = []
	for index in range(max_devices):
		opened_info = None
		for backend_flag, backend_name in backends:
			opened_info = _try_open_capture(index, backend_flag, backend_name)
			if opened_info is not None:
				break

		if opened_info is None:
			continue

		devices.append(
			CameraDeviceInfo(
				index=index,
				name=name_map.get(index, f"Camera {index}"),
				opened_backend=opened_info["opened_backend"],
				width=opened_info["width"],
				height=opened_info["height"],
				fps=opened_info["fps"],
			)
		)

	return devices


def test_camera_device_list(max_devices: int = 10) -> List[dict]:
	"""Test helper: returns and prints openable camera device list."""
	devices = list_camera_devices(max_devices=max_devices)
	rows = [asdict(device) for device in devices]

	print(f"[CameraDevList] OpenCV version: {cv2.__version__}")
	print(f"[CameraDevList] Scan range: 0..{max_devices - 1}")
	print(f"[CameraDevList] Openable devices: {len(rows)}")

	for row in rows:
		print(
			f"- #{row['index']} {row['name']} "
			f"(backend={row['opened_backend']}, "
			f"size={row['width']}x{row['height']}, fps={row['fps']:.1f})"
		)

	if not rows:
		print("- no openable camera devices found")

	return rows


if __name__ == "__main__":
	test_camera_device_list(max_devices=10)
