from __future__ import annotations

import argparse
import shutil
from pathlib import Path
from typing import Dict, Iterable, List

import cv2
import numpy as np


SOURCE_DIR = Path(__file__).resolve().parent


def prefer_primary_path(primary: str) -> Path:
	base_dir = SOURCE_DIR
	primary_path = base_dir / primary
	if primary_path.exists():
		return primary_path

	parts = Path(primary).parts
	if len(parts) >= 2 and parts[0].lower() == "road":
		return base_dir / Path(*parts[1:])

	return primary_path


def resolve_source_relative_path(path: Path) -> Path:
	if path.is_absolute():
		return path
	return prefer_primary_path(path.as_posix())


def default_pothole_root() -> Path:
	return prefer_primary_path("dataset/pothole600")


def default_output_root() -> Path:
	return prefer_primary_path("dataset/pothole600_yolo_seg")


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
	return build_label_lines_from_mask(mask, min_area, epsilon_ratio, mask_value, nonzero_mask)


def build_label_lines_from_mask(
	mask: np.ndarray,
	min_area: float,
	epsilon_ratio: float,
	mask_value: int,
	nonzero_mask: bool,
) -> List[str]:
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


def clamp_ratio(value: float, low: float, high: float) -> float:
	return max(low, min(high, value))


def build_perspective_matrix(
	width: int,
	height: int,
	top_width_ratio: float,
	horizon_ratio: float,
	center_shift_ratio: float,
) -> tuple[np.ndarray, int]:
	if width < 2 or height < 2:
		raise ValueError("Image size must be at least 2x2 for perspective transform.")

	top_width_ratio = clamp_ratio(top_width_ratio, 0.05, 0.98)
	horizon_ratio = clamp_ratio(horizon_ratio, 0.05, 0.95)
	center_shift_ratio = clamp_ratio(center_shift_ratio, -0.8, 0.8)

	w = float(width - 1)
	h = float(height - 1)

	top_half = (w * top_width_ratio) / 2.0
	cx = (w / 2.0) + (w / 2.0) * center_shift_ratio
	y_top = h * horizon_ratio

	x_left = max(0.0, min(w - 1.0, cx - top_half))
	x_right = max(x_left + 1.0, min(w, cx + top_half))

	src = np.array([[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]], dtype=np.float32)
	dst = np.array([[x_left, y_top], [x_right, y_top], [w, h], [0.0, h]], dtype=np.float32)

	matrix = cv2.getPerspectiveTransform(src, dst)
	crop_top = int(round(y_top))
	return matrix, crop_top


def apply_perspective_transform(
	image: np.ndarray,
	mask: np.ndarray,
	top_width_ratio: float,
	horizon_ratio: float,
	center_shift_ratio: float,
) -> tuple[np.ndarray, np.ndarray]:
	h, w = image.shape[:2]
	matrix, crop_top = build_perspective_matrix(
		width=w,
		height=h,
		top_width_ratio=top_width_ratio,
		horizon_ratio=horizon_ratio,
		center_shift_ratio=center_shift_ratio,
	)
	warped_image = cv2.warpPerspective(
		image,
		matrix,
		(w, h),
		flags=cv2.INTER_LINEAR,
		borderMode=cv2.BORDER_CONSTANT,
		borderValue=(0, 0, 0),
	)
	warped_mask = cv2.warpPerspective(
		mask,
		matrix,
		(w, h),
		flags=cv2.INTER_NEAREST,
		borderMode=cv2.BORDER_CONSTANT,
		borderValue=0,
	)

	# Remove the artificial top black band and resize back to keep output size stable.
	if 0 < crop_top < h - 1:
		warped_image = warped_image[crop_top:h, :]
		warped_mask = warped_mask[crop_top:h, :]
		warped_image = cv2.resize(warped_image, (w, h), interpolation=cv2.INTER_LINEAR)
		warped_mask = cv2.resize(warped_mask, (w, h), interpolation=cv2.INTER_NEAREST)

	return warped_image, warped_mask


def write_image(dst: Path, image: np.ndarray) -> None:
	dst.parent.mkdir(parents=True, exist_ok=True)
	if not cv2.imwrite(str(dst), image):
		raise RuntimeError(f"Failed to write image: {dst}")


def load_image_and_mask(image_path: Path, label_path: Path) -> tuple[np.ndarray, np.ndarray]:
	image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
	if image is None:
		raise RuntimeError(f"Failed to read image: {image_path}")

	mask = cv2.imread(str(label_path), cv2.IMREAD_GRAYSCALE)
	if mask is None:
		raise RuntimeError(f"Failed to read label mask: {label_path}")

	if image.shape[:2] != mask.shape[:2]:
		raise RuntimeError(
			f"Image/label size mismatch: image={image.shape[:2]}, label={mask.shape[:2]} for {image_path.name}"
		)

	return image, mask


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
	save_original: bool,
	perspective_copies: int,
	perspective_top_width_min: float,
	perspective_top_width_max: float,
	perspective_horizon_min: float,
	perspective_horizon_max: float,
	perspective_center_shift_max: float,
	seed: int | None,
) -> None:
	splits = split_roots(pothole_root)
	split_map: Dict[str, List[tuple[Path, Path]]] = {
		split: collect_pairs(path) for split, path in splits.items()
	}
	rng = np.random.default_rng(seed)
	output_per_item = (1 if save_original else 0) + max(0, perspective_copies)
	if output_per_item <= 0:
		raise ValueError("No outputs configured. Enable --save-original or set --perspective-copies >= 1.")

	clear_output_root(output_root)
	ensure_dirs(output_root, split_map.keys())

	total_items = sum(len(v) for v in split_map.values())
	processed_items = 0

	for split, items in split_map.items():
		split_total = len(items)
		print(
			f"Starting split '{split}' ({split_total} files, {output_per_item} outputs/file)..."
		)
		split_processed = 0

		for image_path, label_path in items:
			if save_original:
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

			if perspective_copies > 0:
				image, mask = load_image_and_mask(image_path, label_path)
				for idx in range(perspective_copies):
					top_width_ratio = float(
						rng.uniform(perspective_top_width_min, perspective_top_width_max)
					)
					horizon_ratio = float(
						rng.uniform(perspective_horizon_min, perspective_horizon_max)
					)
					center_shift_ratio = float(
						rng.uniform(-perspective_center_shift_max, perspective_center_shift_max)
					)

					warped_image, warped_mask = apply_perspective_transform(
						image=image,
						mask=mask,
						top_width_ratio=top_width_ratio,
						horizon_ratio=horizon_ratio,
						center_shift_ratio=center_shift_ratio,
					)

					suffix = f"_dv{idx + 1}"
					warped_img_dst = output_root / "images" / split / f"{image_path.stem}{suffix}{image_path.suffix}"
					warped_lbl_dst = output_root / "labels" / split / f"{label_path.stem}{suffix}.txt"

					write_image(warped_img_dst, warped_image)
					warped_lines = build_label_lines_from_mask(
						mask=warped_mask,
						min_area=min_area,
						epsilon_ratio=epsilon_ratio,
						mask_value=mask_value,
						nonzero_mask=nonzero_mask,
					)
					warped_lbl_dst.write_text("\n".join(warped_lines), encoding="utf-8")

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
	if perspective_copies > 0:
		print(
			"Driving-view augmentation enabled: "
			f"{perspective_copies} perspective copies per source image."
		)
	print(f"Save original samples: {save_original}")


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
		default=default_output_root(),
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
	parser.add_argument(
		"--save-original",
		action="store_true",
		default=False,
		help="Also save original image/label pairs (default: transformed-only when perspective copies are used).",
	)
	parser.add_argument(
		"--perspective-copies",
		type=int,
		default=0,
		help="Number of driving-view perspective variants to generate per source image.",
	)
	parser.add_argument(
		"--perspective-top-width-min",
		type=float,
		default=0.18,
		help="Minimum top-edge width ratio for perspective trapezoid (0~1).",
	)
	parser.add_argument(
		"--perspective-top-width-max",
		type=float,
		default=0.42,
		help="Maximum top-edge width ratio for perspective trapezoid (0~1).",
	)
	parser.add_argument(
		"--perspective-horizon-min",
		type=float,
		default=0.06,
		help="Minimum vertical ratio of top edge (horizon position, 0~1).",
	)
	parser.add_argument(
		"--perspective-horizon-max",
		type=float,
		default=0.18,
		help="Maximum vertical ratio of top edge (horizon position, 0~1).",
	)
	parser.add_argument(
		"--perspective-center-shift-max",
		type=float,
		default=0.12,
		help="Maximum horizontal center shift ratio for trapezoid top edge (0~1).",
	)
	parser.add_argument(
		"--seed",
		type=int,
		default=None,
		help="Random seed for deterministic perspective augmentation.",
	)
	return parser.parse_args()


if __name__ == "__main__":
	args = parse_args()
	pothole_root = resolve_source_relative_path(args.pothole_root)
	output_root = resolve_source_relative_path(args.output_root)
	convert(
		pothole_root=pothole_root,
		output_root=output_root,
		min_area=args.min_area,
		epsilon_ratio=args.epsilon_ratio,
		mask_value=args.mask_value,
		nonzero_mask=args.nonzero_mask,
		save_original=args.save_original,
		perspective_copies=max(0, args.perspective_copies),
		perspective_top_width_min=min(args.perspective_top_width_min, args.perspective_top_width_max),
		perspective_top_width_max=max(args.perspective_top_width_min, args.perspective_top_width_max),
		perspective_horizon_min=min(args.perspective_horizon_min, args.perspective_horizon_max),
		perspective_horizon_max=max(args.perspective_horizon_min, args.perspective_horizon_max),
		perspective_center_shift_max=max(0.0, args.perspective_center_shift_max),
		seed=args.seed,
	)
