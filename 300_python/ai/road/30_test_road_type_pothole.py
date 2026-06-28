from ultralytics import YOLO
from pathlib import Path
import matplotlib.pyplot as plt
import numpy as np
import cv2
import os
import time

BASE_DIR = Path(__file__).resolve().parent

road_model = YOLO(str(BASE_DIR / "model/01_yolo11m-road-sg.pt"))
road_type_model = YOLO(str(BASE_DIR / "model/02_yolo11m-road-type-sg.pt"))
pothole_model = YOLO(str(BASE_DIR / "model/04_yolo11m-pothole-sg.pt"))

colormap_path = BASE_DIR / "dataset/RUGD/RUGD_02_annotations/RUGD_annotation-colormap.txt"

image_folders = [
    BASE_DIR / "test_data_02_anyang",
    BASE_DIR / "test_data_03_pothole",
]
exts = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff"}
image_files = sorted(
    str(p)
    for folder in image_folders
    for p in Path(folder).rglob("*")
    if p.is_file() and p.suffix.lower() in exts
)

if not image_files:
    raise FileNotFoundError(f"No image files found in any of: {image_folders}")

if not colormap_path.exists():
    raise FileNotFoundError(f"RUGD colormap file not found: {colormap_path}")

alpha = 0.40

def build_road_mask(result, h: int, w: int) -> np.ndarray:
    if result.masks is None:
        return np.zeros((h, w), dtype=np.uint8)

    masks = result.masks.data.cpu().numpy()  # (N, Hm, Wm)
    road_mask = np.zeros((h, w), dtype=np.uint8)

    for m in masks:
        resized = cv2.resize(m.astype(np.float32), (w, h), interpolation=cv2.INTER_NEAREST)
        road_mask = np.maximum(road_mask, (resized > 0.5).astype(np.uint8) * 255)

    return road_mask

def load_rugd_colormap(txt_path: Path) -> dict[str, tuple[int, int, int]]:
    cmap: dict[str, tuple[int, int, int]] = {}
    with txt_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) < 5:
                continue
            class_name = parts[1]
            r, g, b = map(int, parts[2:5])
            cmap[class_name] = (r, g, b)
    return cmap

def fallback_color(class_id: int) -> tuple[int, int, int]:
    return ((37 * class_id) % 256, (97 * class_id) % 256, (173 * class_id) % 256)

def render_road_type_on_bgr(
    base_bgr: np.ndarray,
    road_mask: np.ndarray,
    result,
    id_to_name: dict[int, str],
    id_to_color_rgb: dict[int, tuple[int, int, int]],
    alpha_fill: float,
) -> np.ndarray:
    vis = base_bgr.copy()
    detected_union = np.zeros(vis.shape[:2], dtype=bool)

    if result.masks is None or result.boxes is None or len(result.boxes) == 0:
        vis[:, :] = (255, 255, 255)
        return vis

    masks = result.masks.data.cpu().numpy()  # (N, Hm, Wm)
    cls_ids = result.boxes.cls.cpu().numpy().astype(int)
    h, w = vis.shape[:2]

    for m, cls_id in zip(masks, cls_ids):
        color_rgb = id_to_color_rgb.get(int(cls_id), fallback_color(int(cls_id)))
        color_bgr = (color_rgb[2], color_rgb[1], color_rgb[0])

        resized_mask = cv2.resize(m.astype(np.float32), (w, h), interpolation=cv2.INTER_NEAREST)
        mask = resized_mask > 0.5
        if not np.any(mask):
            continue
        valid_mask = mask & (road_mask > 0)
        if not np.any(valid_mask):
            continue

        detected_union |= valid_mask

        mask_u8 = (valid_mask.astype(np.uint8) * 255)
        contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue

        overlay = vis.copy()
        cv2.fillPoly(overlay, contours, color_bgr)
        vis = cv2.addWeighted(overlay, alpha_fill, vis, 1.0 - alpha_fill, 0.0)

        # Red outline (BGR) on road-type output
        cv2.polylines(vis, contours, True, (0, 0, 255), 2, lineType=cv2.LINE_AA)

    # Show only detected road-type regions; everything else becomes white.
    vis[~detected_union] = (255, 255, 255)

    return vis

def render_pothole_on_road_only(
    base_bgr: np.ndarray,
    road_mask: np.ndarray,
    result,
) -> tuple[np.ndarray, int]:
    vis = base_bgr.copy()

    if result.masks is None or result.boxes is None or len(result.boxes) == 0:
        return vis, 0

    mask_polygons = result.masks.xy
    masks_data = result.masks.data.cpu().numpy()
    boxes_xyxy = result.boxes.xyxy.cpu().numpy().astype(int)
    confs = result.boxes.conf.cpu().numpy() if result.boxes.conf is not None else np.ones(len(boxes_xyxy))
    keep_indices: list[int] = []

    for idx in range(len(boxes_xyxy)):
        overlap = False

        if mask_polygons is not None and idx < len(mask_polygons):
            pts = np.asarray(mask_polygons[idx], dtype=np.float32)
            if pts.size >= 6:
                pts_i32 = np.round(pts).astype(np.int32).reshape(-1, 1, 2)
                poly_mask = np.zeros(road_mask.shape, dtype=np.uint8)
                cv2.fillPoly(poly_mask, [pts_i32], 255)
                overlap = np.any((poly_mask > 0) & (road_mask > 0))
        elif idx < len(masks_data):
            resized_mask = cv2.resize(masks_data[idx].astype(np.float32), (vis.shape[1], vis.shape[0]), interpolation=cv2.INTER_NEAREST)
            overlap = np.any((resized_mask > 0.5) & (road_mask > 0))

        if not overlap:
            continue

        keep_indices.append(idx)

    kept = len(keep_indices)
    if kept == 0:
        return vis, 0

    # Draw pothole polygon outlines in red and bounding boxes in blue.
    for idx in keep_indices:
        if mask_polygons is not None and idx < len(mask_polygons):
            pts = np.asarray(mask_polygons[idx], dtype=np.float32)
            if pts.size >= 6:
                pts_i32 = np.round(pts).astype(np.int32).reshape(-1, 1, 2)
                cv2.polylines(vis, [pts_i32], True, (0, 0, 255), 2, lineType=cv2.LINE_AA)
        elif idx < len(masks_data):
            resized_mask = cv2.resize(masks_data[idx].astype(np.float32), (vis.shape[1], vis.shape[0]), interpolation=cv2.INTER_NEAREST)
            valid_mask = (resized_mask > 0.5) & (road_mask > 0)
            mask_u8 = (valid_mask.astype(np.uint8) * 255)
            contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if contours:
                cv2.polylines(vis, contours, True, (0, 0, 255), 2, lineType=cv2.LINE_AA)

        x1, y1, x2, y2 = boxes_xyxy[idx].tolist()
        x1 = max(0, min(x1, vis.shape[1] - 1))
        x2 = max(0, min(x2, vis.shape[1] - 1))
        y1 = max(0, min(y1, vis.shape[0] - 1))
        y2 = max(0, min(y2, vis.shape[0] - 1))
        if x2 <= x1 or y2 <= y1:
            continue

        cv2.rectangle(vis, (x1, y1), (x2, y2), (255, 0, 0), 2)
        conf_text = f"{float(confs[idx]):.2f}"
        (tw, th), baseline = cv2.getTextSize(conf_text, cv2.FONT_HERSHEY_SIMPLEX, 0.9, 3)
        tx = x1
        ty = max(th + 6, y1 - 8)
        cv2.rectangle(
            vis,
            (tx - 4, ty - th - 4),
            (tx + tw + 4, ty + baseline + 2),
            (255, 255, 255),
            -1,
        )
        cv2.putText(
            vis,
            conf_text,
            (tx, ty),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.9,
            (255, 0, 0),
            3,
            lineType=cv2.LINE_AA,
        )

    return vis, kept

rugd_cmap = load_rugd_colormap(colormap_path)

if isinstance(road_type_model.names, dict):
    id_to_name = {int(k): str(v) for k, v in road_type_model.names.items()}
else:
    id_to_name = {i: str(n) for i, n in enumerate(road_type_model.names)}

id_to_color_rgb: dict[int, tuple[int, int, int]] = {}
for class_id, class_name in id_to_name.items():
    id_to_color_rgb[int(class_id)] = rugd_cmap.get(str(class_name), fallback_color(int(class_id)))

for image_file in image_files:
    filename = os.path.basename(image_file)

    original_bgr = cv2.imread(image_file)
    if original_bgr is None:
        print(f"Skip unreadable file: {image_file}")
        continue

    h, w = original_bgr.shape[:2]
    original_rgb = cv2.cvtColor(original_bgr, cv2.COLOR_BGR2RGB)

    t0 = time.time()
    road_result = road_model(image_file, verbose=False)[0]
    t_road = time.time() - t0

    road_mask = build_road_mask(road_result, h, w)
    road_only_bgr = original_bgr.copy()
    road_only_bgr[road_mask == 0] = (255, 255, 255)

    road_overlay = original_rgb.copy()
    overlay = road_overlay.copy()
    overlay[road_mask > 0] = (0, 255, 0)
    road_overlay = cv2.addWeighted(overlay, alpha, road_overlay, 1.0 - alpha, 0.0)
    road_overlay_bgr = cv2.cvtColor(road_overlay, cv2.COLOR_RGB2BGR)

    t1 = time.time()
    road_type_result = road_type_model(original_bgr, verbose=False)[0]
    t_road_type = time.time() - t1
    road_type_bgr = render_road_type_on_bgr(
        road_only_bgr,
        road_mask,
        road_type_result,
        id_to_name,
        id_to_color_rgb,
        alpha,
    )
    road_type_rgb = cv2.cvtColor(road_type_bgr, cv2.COLOR_BGR2RGB)
    if road_type_result.masks is None or road_type_result.boxes is None or len(road_type_result.boxes) == 0:
        road_type_title = "Road Type: None"
    else:
        title_masks = road_type_result.masks.data.cpu().numpy()
        cls_ids = road_type_result.boxes.cls.cpu().numpy().astype(int)
        detected_names = set()
        for m, cls_id in zip(title_masks, cls_ids):
            resized_mask = cv2.resize(m.astype(np.float32), (w, h), interpolation=cv2.INTER_NEAREST)
            instance_region = resized_mask > 0.5
            if np.any(instance_region & (road_mask > 0)):
                detected_names.add(id_to_name.get(int(cls_id), f"class_{int(cls_id)}"))

        if detected_names:
            road_type_title = "Road Type: " + " | ".join(sorted(detected_names))
        else:
            road_type_title = "Road Type: None"
    
    t2 = time.time()
    pothole_result = pothole_model(road_only_bgr, verbose=False, max_det=5)[0]
    t_pothole = time.time() - t2
    pothole_bgr, kept_potholes = render_pothole_on_road_only(road_only_bgr, road_mask, pothole_result)
    pothole_rgb = cv2.cvtColor(pothole_bgr, cv2.COLOR_BGR2RGB)

    fig, axes = plt.subplots(1, 4, figsize=(24, 6))
    axes[0].imshow(original_rgb)
    axes[0].set_title(f"{filename}")
    axes[0].axis("off")

    axes[1].imshow(road_overlay)
    axes[1].set_title(f"Road Mask")
    axes[1].axis("off")

    axes[2].imshow(road_type_rgb)
    axes[2].set_title(road_type_title)
    axes[2].axis("off")

    axes[3].imshow(pothole_rgb)
    axes[3].set_title(f"Pothole On-Road: {kept_potholes}")
    axes[3].axis("off")

    plt.tight_layout()
    plt.show()