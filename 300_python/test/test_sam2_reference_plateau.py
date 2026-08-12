import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sam2.Sam2VideoDetector import Sam2VideoDetector


def test_selects_plateau_near_prompt_including_backward_frames():
    detector = Sam2VideoDetector()
    score_history = [
        0.14, 0.82, 0.86, 0.90, 0.89, 0.12, 0.10, 0.08, 0.06, 0.04,
    ]

    start, end = detector._select_reference_plateau(score_history, prompt_frame_index=3)

    assert start is not None and end is not None
    assert start <= 3 <= end
