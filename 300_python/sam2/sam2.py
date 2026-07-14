import argparse
import torch
from sam2.build_sam import build_sam2_video_predictor

parser = argparse.ArgumentParser()
parser.add_argument("--video", required=True)
parser.add_argument("--checkpoint", required=True)
parser.add_argument("--config", required=True)

args = parser.parse_args()

predictor = build_sam2_video_predictor(
    args.config,
    args.checkpoint
)

with torch.inference_mode():
    state = predictor.init_state(args.video)

    # TODO
    # 첫 프레임에서
    # 1. point
    # 2. bbox
    # 3. mask
    # 를 입력

    for frame_idx, obj_ids, masks in predictor.propagate_in_video(state):
        print(frame_idx)