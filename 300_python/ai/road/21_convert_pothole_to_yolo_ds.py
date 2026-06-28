from __future__ import annotations

import argparse
import shutil
from pathlib import Path
from typing import Dict, Iterable, List

import cv2
import numpy as np


def prefer_primary_path(primary: str) -> Path:
	base_dir = Path(__file__).resolve().parent
	primary_path = base_dir / primary
	if primary_path.exists():
		return primary_path

	parts = Path(primary).parts
	if len(parts) >= 2:
		return base_dir / Path(*parts[1:])

	return primary_path


def default_pothole_root() -> Path:
	return prefer_primary_path("road/dataset/pothole600")


def clear_output_root(output_root: Path) -> None:
	if output_root.exists():
		print(f"Existing output found. Removing: {output_root}")
		if output_root.is_dir():
			shutil.rmtree(output_root)
		else:
			output_root.unlink()


def ensure_dirs(output_root: Path, splits: Iterable[str]) -> None:
	for split in splits:
		(output_root / "images" / split).mkdir(parents=True, exist_ok=True)
		(output_root / "labels" / split).mkdir(parents=True, exist_ok=True)


def split_roots(pothole_root: Path) -> Dict[str, Path]:
	raw = {
		"train": pothole_root / "training",
		"val": pothole_root / "validation",
		"test": pothole_root / "testing",
	}

	for name, path in raw.items():
		if not path.exists():
			raise FileNotFoundError(f"Split folder not found for '{name}': {path}")

	return raw


def find_image_for_stem(rgb_dir: Path, stem: str) -> Path | None:
	for ext in (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"):
		candidate = rgb_dir / f"{stem}{ext}"
		if candidate.exists():
			return candidate
	return None


def collect_pairs(split_root: Path) -> List[tuple[Path, Path]]:
	rgb_dir = split_root / "rgb"
	label_dir = split_root / "label"

	if not rgb_dir.exists() or not label_dir.exists():
		raise FileNotFoundError(
			f"Expected 'rgb' and 'label' folders in split root: {split_root}"
		)

	pairs: list[tuple[Path, Path]] = []
	for label_path in sorted(label_dir.glob("*.png")):
		image_path = find_image_for_stem(rgb_dir, label_path.stem)
		if image_path is None:
			raise FileNotFoundError(f"No matching image for label: {label_path}")
		pairs.append((image_path, label_path))

	if not pairs:
		raise RuntimeError(f"No label PNG files found in: {label_dir}")

	return pairs


def polygon_from_binary_mask(
	binary_mask: np.ndarray,
	min_area: float,
	epsilon_ratio: float,
	width: int,
	height: int,
) -> List[List[float]]:
	contours, _ = cv2.findContours(binary_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
	polygons: list[list[float]] = []

	for contour in contours:
		area = cv2.contourArea(contour)
		if area < min_area:
			continue

		peri = cv2.arcLength(contour, True)
		epsilon = epsilon_ratio * peri
		approx = cv2.approxPolyDP(contour, epsilon, True)
		if len(approx) < 3:
			continue

		pts = approx.reshape(-1, 2).astype(np.float32)
		pts[:, 0] = np.clip(pts[:, 0] / width, 0.0, 1.0)
		pts[:, 1] = np.clip(pts[:, 1] / height, 0.0, 1.0)

		flat = pts.flatten().tolist()
		if len(flat) >= 6:
			polygons.append(flat)

	return polygons


def build_label_lines(
	label_path: Path,
	min_area: float,
	epsilon_ratio: float,
	mask_value: int,
	nonzero_mask: bool,
) -> List[str]:
	mask = cv2.imread(str(label_path), cv2.IMREAD_GRAYSCALE)
	if mask is None:
		raise RuntimeError(f"Failed to read label mask: {label_path}")

	h, w = mask.shape[:2]
	if nonzero_mask:
		binary = np.where(mask > 0, 255, 0).astype(np.uint8)
	else:
		binary = np.where(mask == mask_value, 255, 0).astype(np.uint8)

	if not np.any(binary):
		return []

	polygons = polygon_from_binary_mask(binary, min_area, epsilon_ratio, w, h)
	lines: list[str] = []
	for poly in polygons:
		coord_text = " ".join(f"{x:.6f}" for x in poly)
		lines.append(f"0 {coord_text}")

	return lines


def copy_image(src: Path, dst: Path) -> None:
	dst.parent.mkdir(parents=True, exist_ok=True)
	shutil.copy2(src, dst)


def write_dataset_yaml(output_root: Path) -> None:
	yaml_text = (
		f"path: {output_root.resolve().as_posix()}\n"
		"train: images/train\n"
		"val: images/val\n"
		"test: images/test\n"
		"nc: 1\n"
		"names: ['pothole']\n"
	)
	(output_root / "dataset.yaml").write_text(yaml_text, encoding="utf-8")


def convert(
	pothole_root: Path,
	output_root: Path,
	min_area: float,
	epsilon_ratio: float,
	mask_value: int,
	nonzero_mask: bool,
) -> None:
	splits = split_roots(pothole_root)
	split_map: Dict[str, List[tuple[Path, Path]]] = {
		split: collect_pairs(path) for split, path in splits.items()
	}

	clear_output_root(output_root)
	ensure_dirs(output_root, split_map.keys())

	total_items = sum(len(v) for v in split_map.values())
	processed_items = 0

	for split, items in split_map.items():
		split_total = len(items)
		print(f"Starting split '{split}' ({split_total} files)...")
		split_processed = 0

		for image_path, label_path in items:
			img_dst = output_root / "images" / split / image_path.name
			lbl_dst = output_root / "labels" / split / f"{label_path.stem}.txt"

			copy_image(image_path, img_dst)
			label_lines = build_label_lines(
				label_path=label_path,
				min_area=min_area,
				epsilon_ratio=epsilon_ratio,
				mask_value=mask_value,
				nonzero_mask=nonzero_mask,
			)
			lbl_dst.write_text("\n".join(label_lines), encoding="utf-8")

			processed_items += 1
			split_processed += 1
			overall_pct = (processed_items / total_items * 100.0) if total_items else 100.0
			split_pct = (split_processed / split_total * 100.0) if split_total else 100.0
			print(
				f"[{processed_items}/{total_items}] {overall_pct:6.2f}% | "
				f"{split}: {split_processed}/{split_total} ({split_pct:6.2f}%)",
				end="\r",
				flush=True,
			)

		if split_total > 0:
			print()

	write_dataset_yaml(output_root)

	print("Conversion complete.")
	print(f"Pothole root: {pothole_root}")
	print(f"Output root: {output_root}")
	print(
		"Split sizes -> "
		f"train: {len(split_map['train'])}, "
		f"val: {len(split_map['val'])}, "
		f"test: {len(split_map['test'])}"
	)


def parse_args() -> argparse.Namespace:
	parser = argparse.ArgumentParser(
		description="Convert pothole600 masks to YOLO segmentation dataset format."
	)
	parser.add_argument(
		"--pothole-root",
		type=Path,
		default=default_pothole_root(),
		help="Path to pothole600 root folder.",
	)
	parser.add_argument(
		"--output-root",
		type=Path,
		default=Path("road/dataset/pothole600_yolo_seg"),
		help="Output folder for YOLO segmentation dataset.",
	)
	parser.add_argument(
		"--min-area",
		type=float,
		default=20.0,
		help="Minimum contour area (in pixels) to keep polygons.",
	)
	parser.add_argument(
		"--epsilon-ratio",
		type=float,
		default=0.002,
		help="Approximation ratio for contour simplification.",
	)
	parser.add_argument(
		"--mask-value",
		type=int,
		default=255,
		help="Mask pixel value treated as pothole when --nonzero-mask is not used.",
	)
	parser.add_argument(
		"--nonzero-mask",
		action="store_true",
		help="Treat any non-zero pixel value as pothole mask.",
	)
	return parser.parse_args()


if __name__ == "__main__":
	args = parse_args()
	convert(
		pothole_root=args.pothole_root,
		output_root=args.output_root,
		min_area=args.min_area,
		epsilon_ratio=args.epsilon_ratio,
		mask_value=args.mask_value,
		nonzero_mask=args.nonzero_mask,
	)
