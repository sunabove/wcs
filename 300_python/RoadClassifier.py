import cv2
import numpy as np
import importlib


class RoadClassifier:
    def __init__(self):
        self._local_binary_pattern = None
        try:
            skimage_feature = importlib.import_module("skimage.feature")
            self._local_binary_pattern = skimage_feature.local_binary_pattern
        except Exception:
            self._local_binary_pattern = None

    @staticmethod
    def _extract_masked_gray_roi(masked_img_bgr):
        if masked_img_bgr is None or masked_img_bgr.size == 0:
            return None, None

        gray = cv2.cvtColor(masked_img_bgr, cv2.COLOR_BGR2GRAY)
        valid_mask = gray > 0
        if int(np.count_nonzero(valid_mask)) < 16:
            return None, None

        ys, xs = np.where(valid_mask)
        y_min, y_max = int(ys.min()), int(ys.max())
        x_min, x_max = int(xs.min()), int(xs.max())

        gray_roi = gray[y_min:y_max + 1, x_min:x_max + 1]
        mask_roi = valid_mask[y_min:y_max + 1, x_min:x_max + 1]
        return gray_roi, mask_roi

    @staticmethod
    def _calc_edge_density(gray_roi, mask_roi):
        edges = cv2.Canny(gray_roi, 50, 150)
        edges = np.where(mask_roi, edges, 0).astype(np.uint8)
        edge_density = float(np.count_nonzero(edges) / max(1, np.count_nonzero(mask_roi)))
        return edge_density, edges

    @staticmethod
    def _calc_hough_features(edges):
        lines = cv2.HoughLinesP(
            edges,
            rho=1,
            theta=np.pi / 180,
            threshold=30,
            minLineLength=20,
            maxLineGap=5,
        )

        if lines is None:
            return 0, 0.0

        angles = []
        for line in lines:
            x1, y1, x2, y2 = line[0]
            angle = float(np.degrees(np.arctan2(y2 - y1, x2 - x1)))
            angle = abs(angle)
            if angle > 90.0:
                angle = 180.0 - angle
            angles.append(angle)

        line_count = int(len(lines))
        if not angles:
            return line_count, 0.0

        hist, _ = np.histogram(angles, bins=18, range=(0, 90))
        dominant_ratio = float(hist.max() / max(1, line_count))
        return line_count, dominant_ratio

    def _calc_lbp_variance(self, gray_roi, mask_roi):
        if self._local_binary_pattern is None:
            return None

        lbp = self._local_binary_pattern(gray_roi, P=8, R=1, method="uniform")
        return float(np.var(lbp[mask_roi]))

    def classify(self, masked_img_bgr):
        gray_roi, mask_roi = self._extract_masked_gray_roi(masked_img_bgr)
        if gray_roi is None or mask_roi is None:
            return "dirt"

        lbp_var = self._calc_lbp_variance(gray_roi, mask_roi)
        if lbp_var is None:
            return "dirt"

        edge_density, edges = self._calc_edge_density(gray_roi, mask_roi)
        line_count, dominant_ratio = self._calc_hough_features(edges)

        if line_count > 80 and dominant_ratio > 0.35:
            return "block"
        elif edge_density > 0.12 and lbp_var > 12.0:
            return "gravel"
        elif edge_density > 0.05 and lbp_var > 8.0:
            return "dirt"
        elif edge_density < 0.03 and lbp_var < 5.0:
            return "asphalt"
        else:
            return "concrete"