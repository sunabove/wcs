# road/dataset/cobot_01/ 폴더 아래에 있는 모든 동영상 파일을 YOLO segmentation dataset 형식으로 변환합니다.
# 동영상의 파일명은 {class_name}_{index}_{train|val|test}.mp4 형식으로 되어 있습니다.
# 변환 폴더는 road/dataset/cobot_01_yolo_seg/ 입니다.
# 변환 과정에서 동영상의 모든 프레임을 추출하여 이미지로 저장하고,
# 해당 프레임에서 검출된 객체의 마스크를 YOLO segmentation 형식으로 변환합니다.

# segmentation 폴리곤은 model/01-yolo11m-road-sg.pt에서 학습된 모델을 이용하여 도로 영역을 추출합니다.
# 추출된 도로 영역 마스크들을 다음 두 단계로 필터링합니다:
# 1. cv2.connectedComponentsWithStats(mask)를 이용하여 전체 마스크 영역에서 10% 미만을 차지하는 연결된 영역(노이즈)은 제거합니다.
# 2. cv2.distanceTransform(mask, cv2.DIST_L2, 5)를 이용하여 거리가 1.5 이하인 가느다란 실 같은 부분을 제거합니다.
# 필터링된 도로 영역만 YOLO segmentation 형식으로 변환하여 라벨 파일에 저장합니다.

# 도로 영역 추출시에는 하나의 클래스 road가 추출됩니다.
# 추출한 도로 영역을 입력 파일명에 있는 {class_name}으로 고정하여 새롭게 라벨링하여 YOLO segmentation 형식으로 변환합니다.
# 매핑할 클래스명들은 입력 파일명들의 클래스로 제한하여 주세요.
# 하나의 영역이 추출되면 모두 YOLO segmentation 형식으로 변환하여 라벨 파일에 저장합니다.
# 2개 이상의 영역이 추출되면, 신뢰도 평균이상의 영역만 YOLO segmentation 형식으로 변환하여 라벨 파일에 저장합니다.

# 변환 과정에서 사용되는 YOLO segmentation dataset 형식은 다음과 같습니다.
# - images/train/ : 학습용 이미지 폴더
# - images/val/ : 검증용 이미지 폴더
# - images/test/ : 테스트용 이미지 폴더
# - labels/train/ : 학습용 라벨 폴더
# - labels/val/ : 검증용 라벨 폴더
# - labels/test/ : 테스트용 라벨 폴더

# road/dataset/cobot_01/_colormap_road.txt 파일에 정의된 클래스명에 매핑된 색상을 이용하여,
# 마스크된 이미지를 해당 변환 폴더에 생성합니다.
# 마스크된 이미지의 배경색은 백색을 사용합니다.
# 마스크 이미지의 파일명은 {class_name}_{index}_{frame_index}.png 형식으로 저장됩니다.

# Manual run:
# 1. cd ai\road
# 2. python 41_convert_cobot_to_yolo_ds.py

from __future__ import annotations

import argparse
import random
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

import cv2
import numpy as np
from ultralytics import YOLO


@dataclass(frozen=True)
class ClassSpec:
    yolo_id: int
    name: str


@dataclass(frozen=True)
class TargetClassSpec:
    target_id: int
    name: str


@dataclass
class DecodeFailureStat:
    attempted: int = 0
    failed: int = 0
    failed_frames: list[int] = field(default_factory=list)


# 스크립트 파일이 위치한 디렉터리 (300_python/ai/road/)
_SCRIPT_DIR = Path(__file__).resolve().parent


def default_cobot_root() -> Path:
    """스크립트 기준 road/dataset/cobot_01 경로를 반환합니다."""
    return _SCRIPT_DIR / "dataset" / "cobot_01"


def default_output_root() -> Path:
    """스크립트 기준 road/dataset/cobot_01_yolo_seg 경로를 반환합니다."""
    return _SCRIPT_DIR / "dataset" / "cobot_01_yolo_seg"


def default_model_path() -> Path:
    """스크립트 기준 모델 경로를 반환합니다."""
    return _SCRIPT_DIR / "model" / "01-yolo11m-road-sg.pt"


def default_colormap_path() -> Path:
    """스크립트 기준 _colormap_road.txt 경로를 반환합니다."""
    return _SCRIPT_DIR.parent.parent / "_colormap_road.txt"


def class_specs_from_model(model: YOLO) -> List[ClassSpec]:
    names = model.names
    if isinstance(names, dict):
        ordered = sorted(names.items(), key=lambda x: int(x[0]))
        return [ClassSpec(yolo_id=int(k), name=str(v)) for k, v in ordered]
    if isinstance(names, list):
        return [ClassSpec(yolo_id=i, name=str(v)) for i, v in enumerate(names)]
    raise ValueError("모델 클래스 정보를 읽을 수 없습니다.")


def collect_videos(cobot_root: Path) -> List[Path]:
    """cobot_root 폴더에서 모든 .mp4 파일을 수집하여 정렬된 목록으로 반환합니다."""
    videos = sorted(cobot_root.rglob("*.mp4"))
    if not videos:
        raise RuntimeError(f"동영상 파일(.mp4)을 찾을 수 없습니다: {cobot_root}")
    return videos


def extract_video_stem(video_path: Path) -> str:
    """동영상 파일명에서 stem을 반환합니다 (예: road_01_train <- road_01_train.mp4)."""
    return video_path.stem


def extract_class_name_from_stem(stem: str) -> str:
    """{class_name}_{index}_{split} 형식의 stem 에서 class_name 을 추출합니다."""
    if stem.count("_") < 2:
        raise ValueError(f"파일명이 {{class_name}}_{{index}}_{{split}} 형식이 아닙니다: {stem}")
    class_name, _, _ = stem.rsplit("_", 2)
    if not class_name:
        raise ValueError(f"클래스명이 비어 있습니다: {stem}")
    return class_name


def extract_split_name_from_stem(stem: str) -> str:
    """{class_name}_{index}_{split} 형식의 stem 에서 split(train/val/test)을 추출합니다."""
    if stem.count("_") < 2:
        raise ValueError(f"파일명이 {{class_name}}_{{index}}_{{split}} 형식이 아닙니다: {stem}")

    _, _, split_name = stem.rsplit("_", 2)
    if split_name not in {"train", "val", "test"}:
        raise ValueError(f"split 값이 train/val/test 중 하나가 아닙니다: {stem}")
    return split_name


def class_name_to_id_map(classes: List[ClassSpec]) -> Dict[str, int]:
    return {c.name: c.yolo_id for c in classes}


def target_class_specs_from_colormap(
    colormap: Dict[str, Tuple[int, int, int]],
    allowed_names: set[str],
) -> List[TargetClassSpec]:
    """입력 파일 클래스만 colormap 순서로 target class id를 생성합니다."""
    names = [name for name in colormap.keys() if name in allowed_names]
    return [TargetClassSpec(target_id=i, name=name) for i, name in enumerate(names)]


def collect_input_class_names(videos: List[Path]) -> set[str]:
    """입력 동영상 파일명에서 class_name 집합을 추출합니다."""
    class_names: set[str] = set()
    for video_path in videos:
        stem = extract_video_stem(video_path)
        class_names.add(extract_class_name_from_stem(stem))
    return class_names


def target_class_name_to_id_map(classes: List[TargetClassSpec]) -> Dict[str, int]:
    return {c.name: c.target_id for c in classes}


def find_model_class_id_by_name(model: YOLO, class_name: str) -> int | None:
    names = model.names
    if isinstance(names, dict):
        for k, v in names.items():
            if str(v) == class_name:
                return int(k)
    elif isinstance(names, list):
        for i, v in enumerate(names):
            if str(v) == class_name:
                return i
    return None


def find_colormap_path(cobot_root: Path, colormap_path: Path | None) -> Path:
    """cobot_root 우선, 그 다음 명시/기본 경로에서 colormap 파일을 찾습니다."""
    candidates: list[Path] = [cobot_root / "_colormap_road.txt"]
    if colormap_path is not None:
        candidates.append(colormap_path)
    else:
        candidates.append(default_colormap_path())

    for path in candidates:
        if path.exists():
            return path
    raise FileNotFoundError(
        "colormap_road.txt 파일을 찾을 수 없습니다. "
        f"확인 경로: {[str(p) for p in candidates]}"
    )


def load_colormap(colormap_path: Path) -> Dict[str, Tuple[int, int, int]]:
    """class_name R G B 형식의 colormap 파일을 읽어 RGB 딕셔너리로 반환합니다."""
    cmap: dict[str, tuple[int, int, int]] = {}
    for raw in colormap_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        class_name = parts[0]
        try:
            r, g, b = (int(parts[1]), int(parts[2]), int(parts[3]))
        except ValueError:
            continue
        cmap[class_name] = (r, g, b)
    if not cmap:
        raise RuntimeError(f"유효한 colormap 항목이 없습니다: {colormap_path}")
    return cmap


def split_items(
    items: List[Tuple[Path, int]],
    train_ratio: float,
    val_ratio: float,
    seed: int,
) -> Dict[str, List[Tuple[Path, int]]]:
    """(video_path, frame_index) 목록을 train/val/test 로 분할합니다."""
    test_ratio = 1.0 - train_ratio - val_ratio
    if test_ratio < -1e-9:
        raise ValueError("train_ratio + val_ratio 의 합이 1.0 을 초과합니다.")

    rnd = random.Random(seed)
    shuffled = items[:]
    rnd.shuffle(shuffled)

    n = len(shuffled)
    n_train = int(n * train_ratio)
    n_val = int(n * val_ratio)

    return {
        "train": shuffled[:n_train],
        "val": shuffled[n_train : n_train + n_val],
        "test": shuffled[n_train + n_val :],
    }


def ensure_dirs(output_root: Path, splits: Iterable[str]) -> None:
    for split in splits:
        (output_root / "images" / split).mkdir(parents=True, exist_ok=True)
        (output_root / "labels" / split).mkdir(parents=True, exist_ok=True)
        (output_root / "masks" / split).mkdir(parents=True, exist_ok=True)


def build_noisy_component_mask(
    binary_mask: np.ndarray,
    noisy_ratio: float = 0.10,
) -> np.ndarray:
    """연결 성분 분석으로 전체 면적의 noisy_ratio% 이하인 영역을 식별합니다.
    
    군더더기(노이즈)로 분류된 영역을 True로 반환합니다.
    """
    if binary_mask is None or binary_mask.size == 0:
        return np.zeros_like(binary_mask, dtype=bool)

    binary_mask_uint8 = (binary_mask.astype(np.uint8) * 255)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(
        binary_mask_uint8, connectivity=8
    )
    
    if num_labels <= 1:
        return np.zeros_like(binary_mask, dtype=bool)

    total_area = int(np.sum(stats[1:, cv2.CC_STAT_AREA]))
    if total_area <= 0:
        return np.zeros_like(binary_mask, dtype=bool)

    noisy_threshold = int(total_area * noisy_ratio)
    noisy_mask = np.zeros_like(binary_mask, dtype=bool)

    for label_idx in range(1, num_labels):
        component_area = int(stats[label_idx, cv2.CC_STAT_AREA])
        if component_area <= noisy_threshold:
            noisy_mask = np.logical_or(noisy_mask, labels == label_idx)

    return noisy_mask


def remove_thin_lines(
    binary_mask: np.ndarray,
    distance_threshold: float | None = None,
    distance_ratio: float = 0.005,
) -> np.ndarray:
    """cv2.distanceTransform을 이용하여 가느다란 선들을 제거합니다.
    
    거리 변환으로 각 픽셀의 가장 가까운 배경까지의 거리를 계산하고,
    거리가 distance_threshold 이상인 영역만 유지합니다 (가느다란 부분 제거).
    
    distance_threshold가 None이면 이미지 크기에 따라 동적으로 계산되며, 최소 5로 설정됩니다:
    - distance_threshold = max(5, sqrt(h^2 + w^2) * distance_ratio)
    \n    예시:
    - 480x360 이미지: max(5, sqrt(172800) * 0.005) = 5.0 (최소값)
    - 1920x1440 이미지: max(5, sqrt(2764800) * 0.005) ≈ 8.3
    """
    if binary_mask is None or binary_mask.size == 0 or not np.any(binary_mask):
        return binary_mask.astype(bool)

    binary_mask_uint8 = (binary_mask.astype(np.uint8) * 255)
    dist = cv2.distanceTransform(binary_mask_uint8, cv2.DIST_L2, 5)
    
    # 동적 임계치 계산 (최소값 5 보장)
    if distance_threshold is None:
        h, w = binary_mask.shape[:2]
        # 이미지 대각선 길이 기반: max(5, sqrt(h^2 + w^2) * ratio)
        diagonal = np.sqrt(h**2 + w**2)
        distance_threshold = max(5.0, diagonal * distance_ratio)
    
    # 거리가 distance_threshold 이상인 부분만 유지
    _, thick_mask = cv2.threshold(dist, distance_threshold, 255, cv2.THRESH_BINARY)
    
    return thick_mask.astype(bool)


def polygon_from_binary_mask(
    binary_mask: np.ndarray,
    min_area: float,
    epsilon_ratio: float,
    width: int,
    height: int,
) -> List[List[float]]:
    """이진 마스크에서 정규화된 YOLO 폴리곤 좌표 목록을 반환합니다."""
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


def build_label_lines_from_model(
    model: YOLO,
    frame_bgr: np.ndarray,
    min_area: float,
    conf_threshold: float,
    road_model_class_id: int | None,
    noisy_ratio: float = 0.10,
) -> List[np.ndarray]:
    """YOLO 세그멘테이션 모델 추론 결과에서 유지할 폴리곤 목록을 반환합니다.

    필터링 단계:
    1. 클래스 필터링 - road 클래스만 유지
    2. 신뢰도 필터링 - 2개 이상이면 평균 신뢰도 이상(conf >= mean(conf))만 유지
    3. 연결 성분 분석 필터링 - 전체 마스크 면적의 noisy_ratio% 이상인 영역만 유지
    4. 면적 필터링 - min_area 이상인 영역만 유지
    """
    h, w = frame_bgr.shape[:2]
    results = model.predict(source=frame_bgr, conf=conf_threshold, verbose=False)
    if not results:
        return []

    result = results[0]
    if result.masks is None or result.masks.xy is None:
        return []

    polygons_xy = result.masks.xy
    n = len(polygons_xy)
    if n == 0:
        return []

    if result.boxes is not None and result.boxes.conf is not None and result.boxes.cls is not None:
        confs = result.boxes.conf.detach().cpu().numpy().astype(np.float32)
        cls_ids = result.boxes.cls.detach().cpu().numpy().astype(np.int32)
    else:
        confs = np.ones(n, dtype=np.float32)
        cls_ids = np.zeros(n, dtype=np.int32)

    m = min(n, len(confs), len(cls_ids))
    polygons_xy = polygons_xy[:m]
    confs = confs[:m]
    cls_ids = cls_ids[:m]

    # Stage 1: 클래스 필터링 - road 클래스만 유지
    if road_model_class_id is not None:
        road_keep = cls_ids == road_model_class_id
        polygons_xy = [poly for poly, keep in zip(polygons_xy, road_keep) if bool(keep)]
        confs = confs[road_keep]
        m = len(polygons_xy)
        if m == 0:
            return []

    # Stage 2: 신뢰도 필터링 - 2개 이상이면 평균값 이상만 유지
    if m >= 2:
        mean_conf = float(np.mean(confs))
        keep_mask = confs >= mean_conf
    else:
        keep_mask = np.ones(m, dtype=bool)

    kept_polygons: list[np.ndarray] = []

    for i, poly_xy in enumerate(polygons_xy):
        if not bool(keep_mask[i]):
            continue

        if poly_xy is None or len(poly_xy) < 3:
            continue

        # Stage 3: 연결 성분 분석과 거리 변환으로 군더더기 및 가느다란 선 제거
        # 폴리곤을 이진 마스크로 변환
        mask_temp = np.zeros((h, w), dtype=np.uint8)
        pts_i32 = np.round(poly_xy).astype(np.int32)
        if len(pts_i32) >= 3:
            cv2.fillPoly(mask_temp, [pts_i32], 1)
        
        mask_binary = mask_temp.astype(bool)
        # Step 3.1: 10% 미만 영역(연결 성분 분석) 제거
        noisy_mask = build_noisy_component_mask(mask_binary, noisy_ratio)
        mask_after_noisy = np.logical_and(mask_binary, ~noisy_mask)
        # Step 3.2: 거리 변환으로 가느다란 선 제거 (이미지 크기에 따라 동적 임계치 적용)
        clean_mask = remove_thin_lines(mask_after_noisy, distance_threshold=None, distance_ratio=0.003)
        
        # Stage 4: 면적 필터링 - min_area 이상인 영역만 유지
        area = int(np.count_nonzero(clean_mask))
        if area < min_area:
            continue

        # 정제된 마스크에서 폴리곤 재추출
        clean_mask_uint8 = (clean_mask.astype(np.uint8) * 255)
        contours, _ = cv2.findContours(clean_mask_uint8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        for contour in contours:
            contour_area = cv2.contourArea(contour)
            if contour_area < min_area:
                continue
            
            pts = contour.reshape(-1, 2).astype(np.float32)
            if len(pts) >= 3:
                kept_polygons.append(pts)

    return kept_polygons


def build_label_lines_with_fixed_class(
    polygons_xy: List[np.ndarray],
    yolo_class_id: int,
    width: int,
    height: int,
) -> List[str]:
    lines: list[str] = []
    for poly_xy in polygons_xy:
        pts = poly_xy.astype(np.float32).copy()
        pts[:, 0] = np.clip(pts[:, 0] / width, 0.0, 1.0)
        pts[:, 1] = np.clip(pts[:, 1] / height, 0.0, 1.0)

        flat = pts.flatten().tolist()
        if len(flat) < 6:
            continue

        coord_text = " ".join(f"{x:.6f}" for x in flat)
        lines.append(f"{yolo_class_id} {coord_text}")

    return lines


def render_colored_mask_image(
    image_shape: Tuple[int, int],
    polygons_xy: List[np.ndarray],
    rgb_color: Tuple[int, int, int],
) -> np.ndarray:
    """선택된 폴리곤을 단일 클래스 색상으로 채운 마스크(BGR)를 생성합니다. 배경은 백색입니다."""
    h, w = image_shape
    mask_bgr = np.full((h, w, 3), 255, dtype=np.uint8)
    if not polygons_xy:
        return mask_bgr

    bgr = (int(rgb_color[2]), int(rgb_color[1]), int(rgb_color[0]))
    for poly_xy in polygons_xy:
        pts_i32 = np.round(poly_xy).astype(np.int32)
        if len(pts_i32) >= 3:
            cv2.fillPoly(mask_bgr, [pts_i32], bgr)

    return mask_bgr


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


def clear_output_root(output_root: Path) -> None:
    if output_root.exists():
        print(f"기존 출력 폴더를 삭제합니다: {output_root}")
        shutil.rmtree(output_root)


def _compress_frame_ranges(frame_indices: List[int]) -> List[Tuple[int, int]]:
    """정렬된 프레임 인덱스를 연속 범위(start, end) 목록으로 압축합니다."""
    if not frame_indices:
        return []

    unique_sorted = sorted(set(frame_indices))
    ranges: list[tuple[int, int]] = []
    start = unique_sorted[0]
    prev = unique_sorted[0]

    for idx in unique_sorted[1:]:
        if idx == prev + 1:
            prev = idx
            continue
        ranges.append((start, prev))
        start = idx
        prev = idx

    ranges.append((start, prev))
    return ranges


def _format_ranges_for_print(ranges: List[Tuple[int, int]], max_items: int = 12) -> str:
    if not ranges:
        return "-"

    parts: list[str] = []
    for start, end in ranges[:max_items]:
        parts.append(str(start) if start == end else f"{start}-{end}")

    if len(ranges) > max_items:
        parts.append(f"...(+{len(ranges) - max_items})")
    return ", ".join(parts)


def convert(
    cobot_root: Path,
    output_root: Path,
    model_path: Path,
    colormap_path: Path | None,
    train_ratio: float,
    val_ratio: float,
    seed: int,
    min_area: float,
    conf_threshold: float,
    frame_step: int,
) -> None:
    if not model_path.exists():
        raise FileNotFoundError(f"모델 파일을 찾을 수 없습니다: {model_path}")

    model = YOLO(str(model_path))
    model_classes = class_specs_from_model(model)
    road_model_class_id = find_model_class_id_by_name(model, "road")
    videos = collect_videos(cobot_root)
    input_class_names = collect_input_class_names(videos)

    resolved_colormap_path = find_colormap_path(cobot_root, colormap_path)
    class_to_color = load_colormap(resolved_colormap_path)

    missing_in_colormap = sorted(input_class_names - set(class_to_color.keys()))
    if missing_in_colormap:
        raise KeyError(
            "입력 파일 클래스가 colormap에 없습니다: "
            f"{missing_in_colormap}"
        )

    target_classes = target_class_specs_from_colormap(class_to_color, input_class_names)
    target_class_to_id = target_class_name_to_id_map(target_classes)

    print(f"발견된 동영상: {len(videos)} 개")
    print(f"입력 클래스: {sorted(input_class_names)}")
    print(f"모델 클래스: {[f'{c.yolo_id}:{c.name}' for c in model_classes]}")
    print(f"타깃 클래스: {[f'{c.target_id}:{c.name}' for c in target_classes]}")
    print(f"colormap 경로: {resolved_colormap_path}")
    if road_model_class_id is None:
        print("[경고] 모델에서 'road' 클래스를 찾지 못했습니다. 모든 예측 폴리곤을 사용합니다.")

    # 전체 (video_path, frame_index) 쌍 수집
    split_map: dict[str, list[tuple[Path, int]]] = {"train": [], "val": [], "test": []}
    legacy_items: list[tuple[Path, int]] = []
    for video_path in videos:
        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            print(f"[경고] 동영상을 열 수 없습니다: {video_path}")
            continue
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()

        stem = extract_video_stem(video_path)
        try:
            split_name = extract_split_name_from_stem(stem)
        except ValueError:
            split_name = None

        for fi in range(0, total_frames, frame_step):
            if split_name is None:
                legacy_items.append((video_path, fi))
            else:
                split_map[split_name].append((video_path, fi))

    if legacy_items:
        print(f"[경고] split 접미사가 없는 동영상이 있어 기존 방식으로 분할합니다: {len(legacy_items)} 프레임")
        legacy_split_map = split_items(legacy_items, train_ratio, val_ratio, seed)
        for split_name, items in legacy_split_map.items():
            split_map[split_name].extend(items)

    all_items = split_map["train"] + split_map["val"] + split_map["test"]

    if not all_items:
        raise RuntimeError("추출 가능한 프레임이 없습니다.")

    print(f"총 프레임 수 (frame_step={frame_step}): {len(all_items)}")
    clear_output_root(output_root)
    ensure_dirs(output_root, split_map.keys())

    total = len(all_items)
    processed = 0

    # 동영상 파일별로 cap 을 캐싱하여 반복 open/close 최소화
    cap_cache: dict[Path, cv2.VideoCapture] = {}
    decode_stats: dict[Path, DecodeFailureStat] = {}

    try:
        for split, items in split_map.items():
            split_total = len(items)
            print(f"\n[{split}] {split_total} 프레임 처리 중...")
            split_done = 0

            for video_path, frame_idx in items:
                stem = extract_video_stem(video_path)
                input_class_name = extract_class_name_from_stem(stem)
                if input_class_name not in target_class_to_id:
                    raise KeyError(
                        f"입력 클래스명 '{input_class_name}' 이(가) 타깃 클래스(colormap)에 없습니다: "
                        f"{sorted(target_class_to_id.keys())}"
                    )
                input_class_id = target_class_to_id[input_class_name]

                if input_class_name not in class_to_color:
                    raise KeyError(
                        f"입력 클래스명 '{input_class_name}' 이(가) colormap에 없습니다: "
                        f"{resolved_colormap_path}"
                    )

                file_id = f"{stem}_{frame_idx:06d}"

                img_dst = output_root / "images" / split / f"{file_id}.png"
                lbl_dst = output_root / "labels" / split / f"{file_id}.txt"
                mask_dst = output_root / "masks" / split / f"{file_id}.png"

                # VideoCapture 캐싱
                if video_path not in cap_cache:
                    cap_cache[video_path] = cv2.VideoCapture(str(video_path))
                cap = cap_cache[video_path]

                if video_path not in decode_stats:
                    decode_stats[video_path] = DecodeFailureStat()
                decode_stats[video_path].attempted += 1

                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                ret, frame_bgr = cap.read()
                if not ret or frame_bgr is None:
                    decode_stats[video_path].failed += 1
                    decode_stats[video_path].failed_frames.append(frame_idx)
                    print(f"\n[경고] 프레임 읽기 실패: {video_path} frame={frame_idx}")
                    continue

                # 마스크 프레임을 이미지로 저장
                cv2.imwrite(str(img_dst), frame_bgr)

                # YOLO 세그멘테이션 모델 추론 결과에서 폴리곤 추출
                # (연결 성분 분석으로 전체 면적의 10% 이상 영역만 유지)
                polygons_xy = build_label_lines_from_model(
                    model=model,
                    frame_bgr=frame_bgr,
                    min_area=min_area,
                    conf_threshold=conf_threshold,
                    road_model_class_id=road_model_class_id,
                    noisy_ratio=0.10,
                )

                # 추출된 모든 영역의 클래스는 입력 파일 클래스명으로 고정
                h, w = frame_bgr.shape[:2]
                label_lines = build_label_lines_with_fixed_class(
                    polygons_xy=polygons_xy,
                    yolo_class_id=input_class_id,
                    width=w,
                    height=h,
                )
                lbl_dst.write_text("\n".join(label_lines), encoding="utf-8")

                # colormap 기반 컬러 마스크 이미지 생성
                mask_bgr = render_colored_mask_image(
                    image_shape=(h, w),
                    polygons_xy=polygons_xy,
                    rgb_color=class_to_color[input_class_name],
                )
                cv2.imwrite(str(mask_dst), mask_bgr)

                processed += 1
                split_done += 1
                overall_pct = processed / total * 100.0
                split_pct = split_done / split_total * 100.0 if split_total else 100.0
                print(
                    f"  [{processed}/{total}] {overall_pct:6.2f}% | "
                    f"{split}: {split_done}/{split_total} ({split_pct:6.2f}%)",
                    end="\r",
                    flush=True,
                )
    finally:
        for cap in cap_cache.values():
            cap.release()

    print()
    write_dataset_yaml(
        output_root,
        [ClassSpec(yolo_id=c.target_id, name=c.name) for c in target_classes],
    )

    print("\n변환 완료.")
    print(f"입력 경로  : {cobot_root}")
    print(f"출력 경로  : {output_root}")
    print(f"모델 경로  : {model_path}")
    print(f"컬러맵 경로: {resolved_colormap_path}")
    print(f"클래스 수  : {len(target_classes)}")
    print(f"총 프레임  : {processed}")
    print(
        f"분할 결과  -> "
        f"train: {len(split_map['train'])}, "
        f"val: {len(split_map['val'])}, "
        f"test: {len(split_map['test'])}"
    )

    print("\n[디코딩 실패 통계] (mpeg4 marker/f_code 등 디코더 오류 구간 추정)")
    any_failure = False
    for video_path in sorted(decode_stats.keys(), key=lambda p: p.name.lower()):
        stat = decode_stats[video_path]
        if stat.failed <= 0:
            continue

        any_failure = True
        fail_rate = (stat.failed / stat.attempted * 100.0) if stat.attempted > 0 else 0.0
        ranges = _compress_frame_ranges(stat.failed_frames)
        print(
            f"  - {video_path.name}: "
            f"failed={stat.failed}/{stat.attempted} ({fail_rate:.2f}%), "
            f"ranges={_format_ranges_for_print(ranges)}"
        )

    if not any_failure:
        print("  - 프레임 읽기 실패가 감지되지 않았습니다.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="cobot_01 마스크 동영상을 YOLO segmentation dataset 형식으로 변환합니다."
    )
    cobot_default = default_cobot_root()
    parser.add_argument(
        "--cobot-root",
        type=Path,
        default=cobot_default,
        help=f"cobot_01 데이터 폴더 경로 (기본값: {cobot_default})",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=default_output_root(),
        help=f"출력 폴더 경로 (기본값: {default_output_root()})",
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=default_model_path(),
        help=f"세그멘테이션 모델 경로 (기본값: {default_model_path()})",
    )
    parser.add_argument(
        "--colormap",
        type=Path,
        default=None,
        help=(
            "colormap_road.txt 경로 (미지정 시 cobot_root/colormap_road.txt "
            f"또는 {default_colormap_path()} 자동 탐색)"
        ),
    )
    parser.add_argument("--train-ratio", type=float, default=0.8, help="학습 데이터 비율 (기본값: 0.8)")
    parser.add_argument("--val-ratio", type=float, default=0.1, help="검증 데이터 비율 (기본값: 0.1)")
    parser.add_argument("--seed", type=int, default=42, help="랜덤 시드 (기본값: 42)")
    parser.add_argument(
        "--min-area",
        type=float,
        default=20.0,
        help="폴리곤 최소 픽셀 면적 (기본값: 20.0)",
    )
    parser.add_argument(
        "--conf-threshold",
        type=float,
        default=0.001,
        help="모델 추론 최소 신뢰도 (기본값: 0.001)",
    )
    parser.add_argument(
        "--frame-step",
        type=int,
        default=1,
        help="프레임 샘플링 간격 (기본값: 1, 모든 프레임 사용)",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    convert(
        cobot_root=args.cobot_root,
        output_root=args.output_root,
        model_path=args.model,
        colormap_path=args.colormap,
        train_ratio=args.train_ratio,
        val_ratio=args.val_ratio,
        seed=args.seed,
        min_area=args.min_area,
        conf_threshold=args.conf_threshold,
        frame_step=args.frame_step,
    )
