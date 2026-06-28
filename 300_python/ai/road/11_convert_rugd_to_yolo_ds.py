# Manual run:
# 1. cd ai\road
# 2. python convert_yolo_dataset.py

from __future__ import annotations

import argparse
import random
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

import cv2
import numpy as np


@dataclass(frozen=True)
class ClassSpec:
	original_id: int
	yolo_id: int
	name: str
	rgb: Tuple[int, int, int]


ROAD_SURFACE_CLASSES = (
	"dirt",
	"sand",
	"asphalt",
	"gravel",
	"concrete",
	"mulch",
	"rock-bed",
)


def prefer_primary_path(primary: str) -> Path:
	base_dir = Path(__file__).resolve().parent
	primary_path = base_dir / primary
	if primary_path.exists():
		return primary_path

	parts = Path(primary).parts
	if len(parts) >= 2:
		return base_dir / Path(*parts[1:])

	return primary_path


def default_rugd_root() -> Path:
	return prefer_primary_path("road/dataset/RUGD")


# Read colormap file and map selected classes to contiguous YOLO class IDs.
def parse_colormap(
	colormap_path: Path,
	ignore_ids: set[int],
	include_ids: set[int] | None,
	include_names: set[str] | None,
) -> List[ClassSpec]:
	entries: list[tuple[int, str, tuple[int, int, int]]] = []
	with colormap_path.open("r", encoding="utf-8") as f:
		for raw_line in f:
			line = raw_line.strip()
			if not line:
				continue

			parts = line.split()
			if len(parts) < 5:
				continue

			cls_id = int(parts[0])
			if cls_id in ignore_ids:
				continue

			r, g, b = map(int, parts[-3:])
			name = " ".join(parts[1:-3])
			name_lower = name.lower()

			if include_ids is not None and cls_id not in include_ids:
				continue

			if include_names is not None and name_lower not in include_names:
				continue

			entries.append((cls_id, name, (r, g, b)))

	entries.sort(key=lambda x: x[0])
	if not entries:
		raise ValueError("No classes selected. Check include filters and ignore IDs.")

	specs = [
		ClassSpec(original_id=orig_id, yolo_id=idx, name=name, rgb=rgb)
		for idx, (orig_id, name, rgb) in enumerate(entries)
	]
	return specs


# Resolve frame/annotation/colormap roots from the standard RUGD layout.
def find_roots(rugd_root: Path) -> tuple[Path, Path, Path]:
	frame_root = rugd_root / "RUGD_01_frames"
	ann_root = rugd_root / "RUGD_02_annotations"
	colormap = ann_root / "RUGD_annotation-colormap.txt"

	if frame_root.exists() and ann_root.exists() and colormap.exists():
		return frame_root, ann_root, colormap

	raise FileNotFoundError(
		"RUGD root structure not found. Expected '\n"
		"- RUGD_01_frames + RUGD_02_annotations + colormap"
	)


# Collect image and annotation PNG pairs with matching relative paths.
def collect_pairs(frame_root: Path, ann_root: Path) -> List[tuple[Path, Path]]:
	pairs: list[tuple[Path, Path]] = []

	for ann_path in ann_root.rglob("*.png"):
		rel = ann_path.relative_to(ann_root)
		frame_path = frame_root / rel
		if frame_path.exists():
			pairs.append((frame_path, ann_path))

	if not pairs:
		raise RuntimeError("No image/annotation PNG pairs found.")

	pairs.sort(key=lambda x: str(x[1]))
	return pairs


# Shuffle pairs deterministically and split into train/val/test sets.
def split_items(
	items: List[tuple[Path, Path]],
	train_ratio: float,
	val_ratio: float,
	seed: int,
) -> Dict[str, List[tuple[Path, Path]]]:
	test_ratio = 1.0 - train_ratio - val_ratio
	if test_ratio < 0:
		raise ValueError("train_ratio + val_ratio must be <= 1.0")

	rnd = random.Random(seed)
	shuffled = items[:]
	rnd.shuffle(shuffled)

	n = len(shuffled)
	n_train = int(n * train_ratio)
	n_val = int(n * val_ratio)
	n_test = n - n_train - n_val

	return {
		"train": shuffled[:n_train],
		"val": shuffled[n_train : n_train + n_val],
		"test": shuffled[n_train + n_val : n_train + n_val + n_test],
	}


# Create output image/label directories for all dataset splits.
def ensure_dirs(output_root: Path, splits: Iterable[str]) -> None:
	for split in splits:
		(output_root / "images" / split).mkdir(parents=True, exist_ok=True)
		(output_root / "labels" / split).mkdir(parents=True, exist_ok=True)


# Extract simplified normalized polygons from a binary class mask.
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


# Convert one annotation mask image into YOLO segmentation label lines.
def build_label_lines(
	ann_path: Path,
	classes: List[ClassSpec],
	min_area: float,
	epsilon_ratio: float,
) -> List[str]:
	mask_bgr = cv2.imread(str(ann_path), cv2.IMREAD_COLOR)
	if mask_bgr is None:
		raise RuntimeError(f"Failed to read annotation mask: {ann_path}")

	mask_rgb = cv2.cvtColor(mask_bgr, cv2.COLOR_BGR2RGB)
	h, w = mask_rgb.shape[:2]
	lines: list[str] = []

	for cls in classes:
		color = np.array(cls.rgb, dtype=np.uint8)
		binary = cv2.inRange(mask_rgb, color, color)
		if not np.any(binary):
			continue

		polygons = polygon_from_binary_mask(binary, min_area, epsilon_ratio, w, h)
		for poly in polygons:
			coord_text = " ".join(f"{x:.6f}" for x in poly)
			lines.append(f"{cls.yolo_id} {coord_text}")

	return lines


# Copy a source image to destination, creating parent directories as needed.
def copy_image(src: Path, dst: Path) -> None:
	dst.parent.mkdir(parents=True, exist_ok=True)
	shutil.copy2(src, dst)


# Write dataset metadata file used by YOLO training.
def write_dataset_yaml(output_root: Path, classes: List[ClassSpec]) -> None:
	names = [cls.name for cls in classes]
	yaml_text = (
		f"path: {output_root.resolve().as_posix()}\n"
		"train: images/train\n"
		"val: images/val\n"
		"test: images/test\n"
		f"nc: {len(names)}\n"
		f"names: {names}\n"
	)
	(output_root / "dataset.yaml").write_text(yaml_text, encoding="utf-8")


# Build a unique flat file stem from a nested relative path.
def safe_stem_for_nested_path(rel_path: Path) -> str:
	return "__".join(rel_path.with_suffix("").parts)


# Remove previous conversion output so each run starts from a clean state.
def clear_output_root(output_root: Path) -> None:
	if output_root.exists():
		print(f"Existing output found. Removing: {output_root}")
		if output_root.is_dir():
			shutil.rmtree(output_root)
		else:
			output_root.unlink()


# Run end-to-end conversion from RUGD masks to YOLO segmentation dataset format.
def convert(
	rugd_root: Path,
	output_root: Path,
	train_ratio: float,
	val_ratio: float,
	seed: int,
	min_area: float,
	epsilon_ratio: float,
	ignore_ids: set[int],
	include_ids: set[int] | None,
	include_names: set[str] | None,
) -> None:
	frame_root, ann_root, colormap_path = find_roots(rugd_root)
	classes = parse_colormap(colormap_path, ignore_ids, include_ids, include_names)
	pairs = collect_pairs(frame_root, ann_root)
	split_map = split_items(pairs, train_ratio, val_ratio, seed)

	clear_output_root(output_root)
	ensure_dirs(output_root, split_map.keys())
	total_items = sum(len(v) for v in split_map.values())
	processed_items = 0

	for split, items in split_map.items():
		split_total = len(items)
		print(f"Starting split '{split}' ({split_total} files)...")
		split_processed = 0

		for frame_path, ann_path in items:
			rel = ann_path.relative_to(ann_root)
			file_id = safe_stem_for_nested_path(rel)

			img_dst = output_root / "images" / split / f"{file_id}{frame_path.suffix.lower()}"
			lbl_dst = output_root / "labels" / split / f"{file_id}.txt"

			copy_image(frame_path, img_dst)
			label_lines = build_label_lines(
				ann_path=ann_path,
				classes=classes,
				min_area=min_area,
				epsilon_ratio=epsilon_ratio,
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

	write_dataset_yaml(output_root, classes)

	total = sum(len(v) for v in split_map.values())
	print("Conversion complete.")
	print(f"RUGD root: {rugd_root}")
	print(f"Output root: {output_root}")
	print(f"Classes (YOLO): {len(classes)}")
	print("Selected classes:", [f"{c.yolo_id}:{c.name}" for c in classes])
	print(f"Images total: {total}")
	print(
		"Split sizes -> "
		f"train: {len(split_map['train'])}, "
		f"val: {len(split_map['val'])}, "
		f"test: {len(split_map['test'])}"
	)


# Parse command-line options for dataset conversion.
def parse_args() -> argparse.Namespace:
	parser = argparse.ArgumentParser(
		description="Convert RUGD semantic masks to YOLO segmentation dataset format."
	)
	parser.add_argument(
		"--rugd-root",
		type=Path,
		default=default_rugd_root(),
		help="Path to RUGD root folder.",
	)
	parser.add_argument(
		"--output-root",
		type=Path,
		default=Path("road/dataset/rugd_yolo_seg"),
		help="Output folder for YOLO segmentation dataset.",
	)
	parser.add_argument("--train-ratio", type=float, default=0.8, help="Train split ratio.")
	parser.add_argument("--val-ratio", type=float, default=0.1, help="Validation split ratio.")
	parser.add_argument("--seed", type=int, default=42, help="Random seed for split.")
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
		"--ignore-ids",
		type=int,
		nargs="*",
		default=[0],
		help="Original class IDs to ignore. Default ignores void class 0.",
	)
	parser.add_argument(
		"--include-ids",
		type=int,
		nargs="*",
		default=None,
		help="Only keep these original class IDs.",
	)
	parser.add_argument(
		"--include-names",
		type=str,
		nargs="*",
		default=ROAD_SURFACE_CLASSES,
		help=(
			"Only keep these class names (case-insensitive). "
			"Default is road-surface classes."
		),
	)
	parser.add_argument(
		"--road-only",
		action="store_true",
		help="Keep only road-surface classes: dirt/sand/asphalt/gravel/concrete/mulch/rock-bed.",
	)
	return parser.parse_args()


if __name__ == "__main__":
	args = parse_args()
	name_filter = None
	if args.include_names is not None:
		name_filter = {name.lower() for name in args.include_names}

	if args.road_only:
		if name_filter is None:
			name_filter = set(ROAD_SURFACE_CLASSES)
		else:
			name_filter |= set(ROAD_SURFACE_CLASSES)

	id_filter = set(args.include_ids) if args.include_ids is not None else None

	convert(
		rugd_root=args.rugd_root,
		output_root=args.output_root,
		train_ratio=args.train_ratio,
		val_ratio=args.val_ratio,
		seed=args.seed,
		min_area=args.min_area,
		epsilon_ratio=args.epsilon_ratio,
		ignore_ids=set(args.ignore_ids),
		include_ids=id_filter,
		include_names=name_filter,
	)
