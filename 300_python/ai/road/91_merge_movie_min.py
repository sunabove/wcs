from __future__ import annotations

import argparse
import os
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


@dataclass(frozen=True)
class VideoMeta:
	video_path: Path
	total_frames: int


def list_video_files(input_dir: Path) -> list[Path]:
	videos = [
		path for path in input_dir.iterdir()
		if path.is_file()
		and path.suffix.lower() in VIDEO_EXTENSIONS
		and not path.stem.lower().startswith("merged")
	]
	# 파일명 순으로 정렬 (알파벳 순)
	videos.sort(key=lambda p: p.name.lower())
	return videos


def split_to_1min_segments(video_path: Path) -> list[Segment]:
	"""각 파일에서 처음 20초만 추출합니다."""
	cap = open_video_capture(video_path)
	if not cap.isOpened():
		return []

	try:
		total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
		fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
	finally:
		cap.release()

	if total_frames <= 0 or fps <= 0:
		return []

	# 20초에 해당하는 프레임 수
	frames_per_clip = int(fps * 20)
	end_frame = min(frames_per_clip, total_frames)
	
	# 각 파일에서 처음 20초만 반환
	return [Segment(video_path=video_path, start_frame=0, end_frame_exclusive=end_frame)]


def read_video_meta(video_path: Path) -> VideoMeta | None:
	cap = open_video_capture(video_path)
	if not cap.isOpened():
		return None

	try:
		total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
	finally:
		cap.release()

	if total_frames <= 0:
		return None

	return VideoMeta(video_path=video_path, total_frames=total_frames)


def build_fair_segments(
	videos: list[Path],
	output_fps: float,
	clip_seconds: float,
) -> tuple[list[Segment], dict[Path, VideoMeta]]:
	"""동영상 목록의 각 파일에서 처음 clip_seconds 만큼만 잘라 순서대로 반환합니다."""
	valid_meta: dict[Path, VideoMeta] = {}
	for path in videos:
		meta = read_video_meta(path)
		if meta is not None:
			valid_meta[path] = meta

	if not valid_meta:
		return [], {}

	ordered_segments: list[Segment] = []
	clip_frames = int(max(1.0, clip_seconds) * max(1.0, output_fps))
	clip_frames = max(1, clip_frames)

	for path in videos:
		meta = valid_meta.get(path)
		if meta is None:
			continue

		take = min(clip_frames, meta.total_frames)
		if take <= 0:
			continue

		ordered_segments.append(
			Segment(
				video_path=path,
				start_frame=0,
				end_frame_exclusive=take,
			)
		)

	return ordered_segments, valid_meta


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


def merge_sequential_segments(
	input_dir: Path,
	output_name: str | None = None,
	clip_seconds: float = 20.0,
	progress_step_percent: float = 10.0,
) -> Path:
	"""동영상 목록의 각 파일에서 처음 clip_seconds만 잘라 순차 병합합니다."""
	if not input_dir.exists() or not input_dir.is_dir():
		raise FileNotFoundError(f"Input directory not found: {input_dir}")

	print(f"[1/4] Scanning videos in: {input_dir}")

	videos = list_video_files(input_dir)
	if not videos:
		raise RuntimeError(f"No video files found in: {input_dir}")
	print(f"  - Found {len(videos)} video file(s)")
	for v in videos:
		print(f"    • {v.name}")

	out_w, out_h, out_fps = pick_output_spec(videos)

	print(f"[2/4] Building segments (clip={clip_seconds:.1f}s per video)")
	ordered_segments, valid_meta = build_fair_segments(
		videos,
		output_fps=out_fps,
		clip_seconds=clip_seconds,
	)

	for path in videos:
		meta = valid_meta.get(path)
		if meta is None:
			print(f"  - {path.name}: skipped (could not read frames)")
		else:
			print(f"  - {path.name}: total_frames={meta.total_frames}")

	if not ordered_segments:
		raise RuntimeError("No valid segments were created from input videos")

	print(f"  - Total merge segments: {len(ordered_segments)}")

	# 총 프레임 수를 계산하여 재생시간으로 변환
	total_frames = sum(seg.end_frame_exclusive - seg.start_frame for seg in ordered_segments)
	total_seconds = (total_frames / out_fps) if out_fps > 0 else 0.0
	
	if output_name:
		output_path = input_dir / output_name
	else:
		output_path = input_dir / f"cobot_merged_{int(total_seconds)}s.mp4"

	print("[3/4] Preparing output writer")
	print(f"  - Output: {output_path}")
	print(f"  - Spec: {out_w}x{out_h} @ {out_fps:.2f} fps")
	print(f"  - Planned duration: {total_seconds:.1f}s")

	fourcc = cv2.VideoWriter_fourcc(*"mp4v")
	writer = cv2.VideoWriter(str(output_path), fourcc, out_fps, (out_w, out_h))
	if not writer.isOpened():
		raise RuntimeError(f"Failed to open output writer: {output_path}")

	print("[4/4] Writing merged video")
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
		description="동영상 목록을 골고루 섞어 병합하며 전체 재생시간을 제한합니다.",
	)
	parser.add_argument(
		"--input-dir",
		type=Path,
		default=Path("c:/temp"),
		help="소스 동영상이 있는 디렉토리.",
	)
	parser.add_argument(
		"--output-name",
		type=str,
		default=None,
		help="출력 파일명 (input-dir에 저장됨). 예: merged.mp4",
	)
	parser.add_argument(
		"--clip-seconds",
		type=float,
		default=20.0,
		help="각 동영상에서 잘라낼 길이(초). 기본값: 20",
	)
	parser.add_argument(
		"--progress-step-percent",
		type=float,
		default=10.0,
		help="진행 상황 로그 간격 (백분율). 기본값: 10",
	)
	return parser.parse_args()


def main() -> None:
	args = parse_args()
	if args.progress_step_percent <= 0:
		raise SystemExit("--progress-step-percent must be > 0")
	if args.clip_seconds <= 0:
		raise SystemExit("--clip-seconds must be > 0")

	try:
		output_path = merge_sequential_segments(
			input_dir=args.input_dir,
			output_name=args.output_name,
			clip_seconds=args.clip_seconds,
			progress_step_percent=args.progress_step_percent,
		)
		print(f"Done: {output_path}")
	except Exception as ex:
		raise SystemExit(f"Error: {ex}") from ex


if __name__ == "__main__":
	main()
