from __future__ import annotations

import argparse
import os
import random
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

# Reduce noisy ffmpeg decoder logs and try to skip corrupt packets.
os.environ.setdefault("OPENCV_FFMPEG_LOGLEVEL", "8")
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "fflags;+discardcorrupt|err_detect;ignore_err")

import cv2


VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".m4v"}


def open_video_capture(path: Path):
	cap = cv2.VideoCapture(str(path), cv2.CAP_FFMPEG)
	if cap.isOpened():
		return cap
	cap.release()
	return cv2.VideoCapture(str(path))


@dataclass(frozen=True)
class Segment:
	video_path: Path
	start_frame: int
	end_frame_exclusive: int


def list_video_files(input_dir: Path) -> list[Path]:
	videos = [
		path for path in input_dir.iterdir()
		if path.is_file()
		and path.suffix.lower() in VIDEO_EXTENSIONS
		and not path.stem.lower().startswith("merged")
	]
	# Keep collection order stable by time first, name second.
	videos.sort(key=lambda p: (p.stat().st_mtime, p.name.lower()))
	return videos


def split_to_segments(video_path: Path, chunks: int) -> list[Segment]:
	cap = open_video_capture(video_path)
	if not cap.isOpened():
		return []

	try:
		total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
	finally:
		cap.release()

	if total_frames <= 0:
		return []

	segments: list[Segment] = []
	for i in range(chunks):
		start = (total_frames * i) // chunks
		end = (total_frames * (i + 1)) // chunks
		if end > start:
			segments.append(Segment(video_path=video_path, start_frame=start, end_frame_exclusive=end))
	return segments


def pick_output_spec(videos: list[Path], default_fps: float = 30.0) -> tuple[int, int, float]:
	for path in videos:
		cap = open_video_capture(path)
		if not cap.isOpened():
			continue

		try:
			width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
			height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
			fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
		finally:
			cap.release()

		if width > 0 and height > 0:
			return width, height, fps if fps > 0 else default_fps

	raise RuntimeError("No readable video found for output specification")


def append_segment_frames(writer: cv2.VideoWriter, segment: Segment, out_size: tuple[int, int]) -> int:
	cap = open_video_capture(segment.video_path)
	if not cap.isOpened():
		return 0

	written = 0
	target_w, target_h = out_size
	try:
		cap.set(cv2.CAP_PROP_POS_FRAMES, segment.start_frame)
		frame_index = segment.start_frame
		while frame_index < segment.end_frame_exclusive:
			ok, frame = cap.read()
			if not ok:
				break

			if frame.shape[1] != target_w or frame.shape[0] != target_h:
				frame = cv2.resize(frame, (target_w, target_h), interpolation=cv2.INTER_AREA)

			writer.write(frame)
			written += 1
			frame_index += 1
	finally:
		cap.release()

	return written


def append_segment_frames_sequential(
	writer: cv2.VideoWriter,
	segment: Segment,
	out_size: tuple[int, int],
	capture_states: dict[Path, dict],
) -> int:
	state = capture_states.get(segment.video_path)
	if state is None:
		cap = open_video_capture(segment.video_path)
		if not cap.isOpened():
			return 0
		state = {"cap": cap, "frame_index": 0}
		capture_states[segment.video_path] = state

	cap = state["cap"]
	current_frame = int(state.get("frame_index", 0))
	target_w, target_h = out_size
	written = 0
	failure_streak = 0
	max_failure_streak = 8

	# Keep decoding sequentially to avoid MPEG4 random-seek artifacts.
	while current_frame < segment.start_frame:
		ok, _ = cap.read()
		if not ok:
			failure_streak += 1
			if failure_streak >= max_failure_streak:
				state["frame_index"] = current_frame
				return written
			current_frame += 1
			continue
		failure_streak = 0
		current_frame += 1

	while current_frame < segment.end_frame_exclusive:
		ok, frame = cap.read()
		if not ok:
			failure_streak += 1
			if failure_streak >= max_failure_streak:
				break
			current_frame += 1
			continue
		failure_streak = 0

		if frame.shape[1] != target_w or frame.shape[0] != target_h:
			frame = cv2.resize(frame, (target_w, target_h), interpolation=cv2.INTER_AREA)

		writer.write(frame)
		written += 1
		current_frame += 1

	state["frame_index"] = current_frame
	return written


def merge_shuffled_segments(
	input_dir: Path,
	chunks: int = 10,
	seed: int | None = None,
	output_name: str | None = None,
	progress_step_percent: float = 10.0,
) -> Path:
	if not input_dir.exists() or not input_dir.is_dir():
		raise FileNotFoundError(f"Input directory not found: {input_dir}")

	print(f"[1/5] Scanning videos in: {input_dir}")

	videos = list_video_files(input_dir)
	if not videos:
		raise RuntimeError(f"No video files found in: {input_dir}")
	print(f"  - Found {len(videos)} video file(s)")

	print(f"[2/5] Splitting each video into {chunks} segments")
	segments_by_video: dict[Path, list[Segment]] = {}
	for path in videos:
		segments = split_to_segments(path, chunks)
		if segments:
			segments_by_video[path] = segments
			print(f"  - {path.name}: {len(segments)} segment(s)")
		else:
			print(f"  - {path.name}: skipped (could not read frames)")

	if not segments_by_video:
		raise RuntimeError("No valid segments were created from input videos")

	print("[3/5] Shuffling merge order (while preserving per-file segment order)")
	rng = random.Random(seed)
	ordered_segments: list[Segment] = []
	active_videos = list(segments_by_video.keys())
	# Randomly interleave videos, but keep each video's segment index order.
	while active_videos:
		picked_video = rng.choice(active_videos)
		video_segments = segments_by_video[picked_video]
		ordered_segments.append(video_segments.pop(0))
		if not video_segments:
			active_videos.remove(picked_video)
	print(f"  - Total merge segments: {len(ordered_segments)}")

	out_w, out_h, out_fps = pick_output_spec(videos)
	if output_name:
		output_path = input_dir / output_name
	else:
		stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
		output_path = input_dir / f"merged_shuffled_{stamp}.mp4"

	print("[4/5] Preparing output writer")
	print(f"  - Output: {output_path}")
	print(f"  - Spec: {out_w}x{out_h} @ {out_fps:.2f} fps")

	fourcc = cv2.VideoWriter_fourcc(*"mp4v")
	writer = cv2.VideoWriter(str(output_path), fourcc, out_fps, (out_w, out_h))
	if not writer.isOpened():
		raise RuntimeError(f"Failed to open output writer: {output_path}")

	print("[5/5] Writing merged video")
	total_written = 0
	capture_states: dict[Path, dict] = {}
	try:
		total_segments = len(ordered_segments)
		next_progress_mark = max(0.1, float(progress_step_percent))
		for index, segment in enumerate(ordered_segments, start=1):
			total_written += append_segment_frames_sequential(
				writer,
				segment,
				(out_w, out_h),
				capture_states,
			)
			progress_pct = (index / total_segments) * 100.0
			is_last = index == total_segments
			if is_last or progress_pct + 1e-9 >= next_progress_mark:
				print(
					f"  - Progress {progress_pct:.1f}% ({index}/{total_segments}), "
					f"current: {segment.video_path.name} [{segment.start_frame}:{segment.end_frame_exclusive}]"
				)
				while next_progress_mark <= progress_pct + 1e-9:
					next_progress_mark += max(0.1, float(progress_step_percent))
	finally:
		for state in capture_states.values():
			cap = state.get("cap") if isinstance(state, dict) else None
			if cap is not None:
				cap.release()
		writer.release()

	if total_written <= 0:
		try:
			output_path.unlink(missing_ok=True)
		except OSError:
			pass
		raise RuntimeError("No frame was written to the output video")

	print(f"Completed. Frames written: {total_written}")

	return output_path


def parse_args() -> argparse.Namespace:
	parser = argparse.ArgumentParser(
		description="Split each video into N chunks, shuffle chunks, and merge into one output video.",
	)
	parser.add_argument(
		"--input-dir",
		type=Path,
		default=Path("c:/temp"),
		help="Directory containing source videos.",
	)
	parser.add_argument(
		"--chunks",
		type=int,
		default=10,
		help="Number of chunks per source video.",
	)
	parser.add_argument(
		"--seed",
		type=int,
		default=None,
		help="Random seed for reproducible shuffle.",
	)
	parser.add_argument(
		"--output-name",
		type=str,
		default=None,
		help="Output file name (saved in input-dir). Example: merged.mp4",
	)
	parser.add_argument(
		"--progress-step-percent",
		type=float,
		default=10.0,
		help="Progress log interval percent. Default: 10 (prints around 10%% steps).",
	)
	return parser.parse_args()


def main() -> None:
	args = parse_args()
	if args.chunks < 1:
		raise SystemExit("--chunks must be >= 1")
	if args.progress_step_percent <= 0:
		raise SystemExit("--progress-step-percent must be > 0")

	try:
		output_path = merge_shuffled_segments(
			input_dir=args.input_dir,
			chunks=args.chunks,
			seed=args.seed,
			output_name=args.output_name,
			progress_step_percent=args.progress_step_percent,
		)
		print(f"Done: {output_path}")
	except Exception as ex:
		raise SystemExit(f"Error: {ex}") from ex


if __name__ == "__main__":
	main()
