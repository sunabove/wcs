import cv2
import numpy as np


class ChartRenderer:
    def render_bottom_stats_overlay(self, detected, stats, chart_data, class_color_map, font_face):
        if detected is None or chart_data is None:
            return detected

        x_vals, detected_vals, conf_vals, class_series, current_x, frame_label = chart_data

        height, width = detected.shape[:2]
        panel_h = max(56, min(150, int(round(height * 0.15))))
        y1 = height - panel_h
        gx1 = 8
        gx2 = width - 8
        gy1 = y1 + 6
        gy2 = height - 6
        plot_w = gx2 - gx1 + 1
        plot_h = gy2 - gy1 + 1
        if plot_w < 120 or plot_h < 36:
            return detected

        overlay = detected.copy()
        cv2.rectangle(overlay, (0, y1), (width, height), (18, 18, 18), cv2.FILLED)
        cv2.addWeighted(overlay, 0.62, detected, 0.38, 0, detected)

        max_detected = float(np.max(detected_vals)) if len(detected_vals) > 0 else 0.0
        max_class = 0.0
        for class_vals in class_series.values():
            if class_vals is not None and len(class_vals) > 0:
                max_class = max(max_class, float(np.max(class_vals)))

        y_max = max(1.0, float(np.ceil(max(max_detected, max_class) * 1.2)))
        conf_scaled = conf_vals * y_max

        x_min = 1.0
        x_max = float(max(1, int(frame_label or np.max(x_vals))))
        if x_max <= x_min:
            x_max = x_min + 1.0

        margin_left = 12
        margin_right = 8
        margin_top = 16
        margin_bottom = 18
        chart_x1 = gx1 + margin_left
        chart_x2 = gx2 - margin_right
        chart_y1 = gy1 + margin_top
        chart_y2 = gy2 - margin_bottom
        chart_w = chart_x2 - chart_x1
        chart_h = chart_y2 - chart_y1
        if chart_w <= 8 or chart_h <= 8:
            return detected

        cv2.rectangle(detected, (gx1, gy1), (gx2, gy2), (24, 24, 24), cv2.FILLED)
        cv2.rectangle(detected, (chart_x1, chart_y1), (chart_x2, chart_y2), (32, 32, 32), cv2.FILLED)
        cv2.rectangle(detected, (chart_x1, chart_y1), (chart_x2, chart_y2), (90, 90, 90), 1)

        for grid_ratio in (0.25, 0.50, 0.75):
            gy = int(round(chart_y2 - (grid_ratio * chart_h)))
            cv2.line(detected, (chart_x1, gy), (chart_x2, gy), (56, 56, 56), 1, cv2.LINE_AA)

        def map_x(x_value):
            ratio = (float(x_value) - x_min) / max(1e-6, (x_max - x_min))
            ratio = max(0.0, min(1.0, ratio))
            return int(round(chart_x1 + ratio * chart_w))

        def map_y(y_value):
            ratio = float(y_value) / max(1e-6, y_max)
            ratio = max(0.0, min(1.0, ratio))
            return int(round(chart_y2 - ratio * chart_h))

        def draw_series(y_values, color_bgr, thickness=1):
            if y_values is None or len(y_values) <= 1:
                return

            pts = []
            for xv, yv in zip(x_vals, y_values):
                pts.append([map_x(xv), map_y(yv)])

            if len(pts) > 1:
                cv2.polylines(
                    detected,
                    [np.array(pts, dtype=np.int32)],
                    False,
                    color_bgr,
                    thickness,
                    cv2.LINE_AA,
                )

        def resolve_class_color(class_name, class_index):
            bgr = class_color_map.get(class_name, class_color_map.get(class_name.lower()))
            if bgr is not None:
                return (int(bgr[0]), int(bgr[1]), int(bgr[2]))

            seed = sum(ord(ch) for ch in str(class_name)) + (class_index * 37)
            return (
                int(80 + ((seed * 29) % 150)),
                int(80 + ((seed * 53) % 150)),
                int(80 + ((seed * 97) % 150)),
            )

        def nice_step(max_value, target_ticks):
            if max_value <= 0:
                return 1.0

            rough = float(max_value) / float(max(1, target_ticks))
            exp = 10.0 ** np.floor(np.log10(max(rough, 1e-6)))
            frac = rough / exp
            if frac <= 1.0:
                nice_frac = 1.0
            elif frac <= 2.0:
                nice_frac = 2.0
            elif frac <= 5.0:
                nice_frac = 5.0
            else:
                nice_frac = 10.0
            return nice_frac * exp

        def power_ticks(max_value):
            if max_value <= 0:
                return []

            ticks = []
            max_int = max(1, int(max_value))
            exponent = 0
            while (10 ** exponent) <= max_int:
                ticks.append(10 ** exponent)
                exponent += 1

            if not ticks:
                ticks = [1]
            return ticks

        draw_series(detected_vals, (0, 210, 255), 2)
        draw_series(conf_scaled, (80, 255, 80), 1)

        class_line_colors = {}
        for idx, class_name in enumerate(sorted(class_series.keys())):
            class_vals = class_series[class_name]
            if class_vals is None or len(class_vals) == 0:
                continue

            class_bgr = resolve_class_color(class_name, idx)
            class_line_colors[class_name] = class_bgr
            draw_series(class_vals, class_bgr, 1)

        x_ticks = power_ticks(x_max)
        for x_tick in x_ticks:
            tick_x = map_x(x_tick)
            cv2.line(detected, (tick_x, chart_y2), (tick_x, chart_y2 + 3), (120, 120, 120), 1, cv2.LINE_AA)
            cv2.putText(
                detected,
                str(int(x_tick)),
                (tick_x - 10, chart_y2 + 14),
                font_face,
                0.33,
                (180, 180, 180),
                1,
                cv2.LINE_AA,
            )

        if int(x_max) not in x_ticks:
            end_tick_x = map_x(int(x_max))
            cv2.line(detected, (end_tick_x, chart_y2), (end_tick_x, chart_y2 + 3), (120, 120, 120), 1, cv2.LINE_AA)
            cv2.putText(
                detected,
                str(int(x_max)),
                (end_tick_x - 10, chart_y2 + 14),
                font_face,
                0.33,
                (180, 180, 180),
                1,
                cv2.LINE_AA,
            )

        current_x_px = map_x(current_x)
        cv2.line(detected, (current_x_px, chart_y1), (current_x_px, chart_y2), (255, 230, 0), 1, cv2.LINE_AA)

        conf_now = max(0.0, min(1.0, float(stats.get("max_confidence", 0.0))))
        info_y = gy1 + 12
        cv2.putText(detected, f"Count:{int(max_detected)}", (chart_x1 + 4, info_y), font_face, 0.35, (210, 210, 210), 1, cv2.LINE_AA)
        cv2.putText(detected, f"MaxConf:{conf_now:.2f}", (chart_x1 + 120, info_y), font_face, 0.35, (80, 255, 80), 1, cv2.LINE_AA)
        cv2.putText(detected, f"Frame:{int(frame_label)}", (chart_x2 - 96, info_y), font_face, 0.35, (210, 210, 210), 1, cv2.LINE_AA)

        legend_items = [("total", (0, 210, 255)), ("max_conf", (80, 255, 80))]
        for class_name in sorted(class_series.keys()):
            if class_name not in class_line_colors:
                continue
            legend_items.append((class_name, class_line_colors[class_name]))

        legend_x = chart_x2 - 140
        legend_y = gy1 + 6
        for item_name, item_color in legend_items[:7]:
            cv2.line(detected, (legend_x, legend_y), (legend_x + 12, legend_y), item_color, 2, cv2.LINE_AA)
            cv2.putText(detected, item_name, (legend_x + 16, legend_y + 3), font_face, 0.32, (190, 190, 190), 1, cv2.LINE_AA)
            legend_y += 10

        cv2.rectangle(detected, (gx1, gy1), (gx2, gy2), (110, 110, 110), 1)
        return detected
