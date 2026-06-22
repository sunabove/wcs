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


class CameraDevList:
	"""Camera device listing and test utility."""

	def __init__(self, max_devices: int = 10):
		self.max_devices = max(1, int(max_devices))
		self.backends = [
			(getattr(cv2, "CAP_DSHOW", None), "DSHOW"),
			(getattr(cv2, "CAP_MSMF", None), "MSMF"),
			(None, "ANY"),
		]

	def _get_windows_device_names(self) -> Dict[int, str]:
		"""Return Windows DirectShow camera names indexed by device number.

		Falls back to an empty mapping when pygrabber is unavailable.
		"""
		try:
			from pygrabber.dshow_graph import FilterGraph  # type: ignore

			names = FilterGraph().get_input_devices()
			return {idx: name for idx, name in enumerate(names)}
		except Exception:
			return {}

	def _try_open_capture(self, index: int, backend_flag: Optional[int], backend_name: str):
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

	def list_camera_devices(self, max_devices: Optional[int] = None) -> List[CameraDeviceInfo]:
		"""List camera devices that OpenCV can open."""
		scan_count = self.max_devices if max_devices is None else max(1, int(max_devices))
		name_map = self._get_windows_device_names()

		devices: List[CameraDeviceInfo] = []
		for index in range(scan_count):
			opened_info = None
			for backend_flag, backend_name in self.backends:
				opened_info = self._try_open_capture(index, backend_flag, backend_name)
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

	def test_camera_device_list(self, max_devices: Optional[int] = None) -> List[dict]:
		"""Test helper: returns and prints openable camera device list."""
		scan_count = self.max_devices if max_devices is None else max(1, int(max_devices))
		devices = self.list_camera_devices(max_devices=scan_count)
		rows = [asdict(device) for device in devices]

		print(f"[CameraDevList] OpenCV version: {cv2.__version__}")
		print(f"[CameraDevList] Scan range: 0..{scan_count - 1}")
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


def list_camera_devices(max_devices: int = 10) -> List[CameraDeviceInfo]:
	"""Compatibility wrapper for previous function-style usage."""
	return CameraDevList(max_devices=max_devices).list_camera_devices()


def test_camera_device_list(max_devices: int = 10) -> List[dict]:
	"""Compatibility wrapper for previous function-style usage."""
	return CameraDevList(max_devices=max_devices).test_camera_device_list()


if __name__ == "__main__":
	CameraDevList(max_devices=10).test_camera_device_list()
