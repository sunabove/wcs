import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import cv2
from fastapi import HTTPException, UploadFile

from config import BASE_DIR
from send_image import get_browser_playable_video_url
from sam2.Sam2VideoConfig import (
    SAM2_DEFAULT_MODEL,
    SAM2_OUTPUT_DIR,
    SAM2_UPLOAD_DIR,
    SAM2_VIDEO_EXTENSIONS,
    SAM2_YOLO_DIR,
)
from sam2.Sam2VideoDetector import Sam2VideoDetector


DEFAULT_UPLOAD_LIMIT_BYTES = 1024 * 1024 * 1024


class Sam2VideoService:
    def __init__(self):
        self.detector = Sam2VideoDetector()
        self._job_executor = ThreadPoolExecutor(max_workers=1)
        self._jobs = {}
        self._jobs_lock = threading.Lock()
        self._training_executor = ThreadPoolExecutor(max_workers=1)
        self._training_jobs = {}
        self._training_jobs_lock = threading.Lock()
        self._active_training_job_id = ""

    def _create_job(self):
        job_id = uuid.uuid4().hex
        with self._jobs_lock:
            self._jobs[job_id] = {
                "status": "queued",
                "progress": 0,
                "processed_frames": 0,
                "total_frames": 0,
                "result": None,
                "error": "",
            }
        return job_id

    def _update_job_progress(self, job_id, processed_frames, total_frames):
        progress = 0
        if total_frames > 0:
            progress = min(99, int((processed_frames / total_frames) * 100))
        with self._jobs_lock:
            job = self._jobs.get(job_id)
            if job:
                job.update({
                    "status": "running",
                    "progress": progress,
                    "processed_frames": processed_frames,
                    "total_frames": total_frames,
                })

    def _run_detection_job(self, job_id, input_path, model_name, prompt_frame, bbox, points, point_labels, multimask_output, mask_input, clahe, iou_mask_filter, reference_score):
        try:
            with self._jobs_lock:
                self._jobs[job_id]["status"] = "running"
            result = self.detector.detect_video_file(
                input_path=input_path,
                model_name=model_name,
                prompt_frame=prompt_frame,
                bbox=bbox,
                points=points,
                point_labels=point_labels,
                multimask_output=multimask_output,
                mask_input=mask_input,
                clahe=clahe,
                iou_mask_filter=iou_mask_filter,
                reference_score=reference_score,
                progress_callback=lambda processed, total: self._update_job_progress(job_id, processed, total),
            )
            with self._jobs_lock:
                self._jobs[job_id].update({
                    "status": "completed",
                    "progress": 100,
                    "processed_frames": result.get("processed_frames", 0),
                    "total_frames": result.get("input_total_frames", 0),
                    "result": result,
                })
        except Exception as ex:
            with self._jobs_lock:
                self._jobs[job_id].update({"status": "failed", "error": str(ex)})

    def _start_detection_job(self, input_path, model_name, prompt_frame, bbox, points, point_labels, multimask_output, mask_input, clahe, iou_mask_filter, reference_score=0.5):
        job_id = self._create_job()
        self._job_executor.submit(
            self._run_detection_job,
            job_id,
            input_path,
            model_name,
            prompt_frame,
            bbox,
            points,
            point_labels,
            multimask_output,
            mask_input,
            clahe,
            iou_mask_filter,
            reference_score,
        )
        return {"job_id": job_id, "status": "queued", "progress": 0}

    def get_segment_status(self, job_id):
        with self._jobs_lock:
            job = self._jobs.get(str(job_id or "").strip())
            if not job:
                raise HTTPException(status_code=404, detail="Segmentation job not found")
            return {"job_id": job_id, **job}

    def convert_yolo_dataset(self, file_name: str):
        input_path = self._resolve_uploaded_video_path(file_name)
        try:
            return self.detector.convert_yolo_dataset(input_path)
        except ValueError as ex:
            raise HTTPException(status_code=409, detail=str(ex)) from ex

    def get_yolo_dataset_frames(self, file_name: str):
        input_path = self._resolve_uploaded_video_path(file_name)
        frames = self.detector.list_yolo_dataset_frames(input_path)
        return {
            "input_file_stem": input_path.stem,
            "frame_count": len(frames),
            "frames": frames,
        }

    def get_yolo_dataset_summary(self):
        return self.detector.get_yolo_dataset_summary()

    def _get_yolo_dataset_fingerprint(self):
        hasher = hashlib.sha256()
        for relative_root, pattern in (
            (Path("images/train"), "*.jpg"),
            (Path("labels/train"), "*.txt"),
            (Path("masks/train"), "*.png"),
        ):
            root = SAM2_YOLO_DIR / relative_root
            if not root.is_dir():
                continue
            for file_path in sorted(root.glob(pattern), key=lambda path: path.name):
                hasher.update(file_path.relative_to(SAM2_YOLO_DIR).as_posix().encode("utf-8"))
                hasher.update(self._hash_file(file_path).encode("ascii"))
        classes_path = SAM2_YOLO_DIR / "classes.json"
        if classes_path.is_file():
            hasher.update(classes_path.read_bytes())
        return hasher.hexdigest()

    def _get_yolo_training_plan(self, dataset_fingerprint, force_retrain=False):
        run_dir = SAM2_YOLO_DIR / "runs" / "obstacle-seg"
        checkpoint_path = run_dir / "weights" / "last.pt"
        metadata_path = run_dir / "training_state.json"
        previous_fingerprint = ""
        if metadata_path.is_file():
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                previous_fingerprint = str(metadata.get("dataset_fingerprint", ""))
            except (OSError, json.JSONDecodeError):
                previous_fingerprint = ""
        continue_training = (
            not force_retrain
            and checkpoint_path.is_file()
            and previous_fingerprint == dataset_fingerprint
        )
        return {
            "continue_training": continue_training,
            "force_retrain": bool(force_retrain),
            "model_source": str(checkpoint_path) if continue_training else os.getenv(
                "SAM2_YOLO_TRAIN_MODEL",
                "yolo11m-seg.pt",
            ),
            "metadata_path": metadata_path,
        }

    def _run_yolo_training_job(self, job_id):
        with self._training_jobs_lock:
            self._training_jobs[job_id]["started_at"] = time.time()
        try:
            from ultralytics import YOLO

            dataset_yaml = self.detector.ensure_yolo_dataset_yaml()
            epochs = max(1, int(os.getenv("SAM2_YOLO_TRAIN_EPOCHS", "100")))
            with self._training_jobs_lock:
                dataset_fingerprint = self._training_jobs[job_id]["dataset_fingerprint"]
                training_plan = self._training_jobs[job_id]["training_plan"]
                model_source = training_plan["model_source"]
                continue_training = bool(training_plan["continue_training"])
                force_retrain = bool(training_plan["force_retrain"])
                self._training_jobs[job_id].update({
                    "status": "running",
                    "message": (
                        "기존 가중치에서 이어서 학습을 준비하는 중..."
                        if continue_training
                        else "기본 모델에서 재학습을 준비하는 중..."
                        if force_retrain
                        else "새 학습 모델을 준비하는 중..."
                    ),
                    "total_epochs": epochs,
                })

            model = YOLO(model_source)
            batch_progress = {"epoch": -1, "batch": 0}
            metric_history = []

            def stop_if_requested(trainer):
                with self._training_jobs_lock:
                    job = self._training_jobs[job_id]
                    if not job.get("stop_requested"):
                        return False
                    trainer.stop = True
                    job.update({
                        "status": "stopping",
                        "message": "현재 Batch 완료 후 학습을 중지하는 중...",
                    })
                    return True

            def update_batch(trainer):
                if stop_if_requested(trainer):
                    return
                current_epoch_index = int(getattr(trainer, "epoch", 0))
                if batch_progress["epoch"] != current_epoch_index:
                    batch_progress.update({"epoch": current_epoch_index, "batch": 0})
                batch_progress["batch"] += 1
                total_batches = max(1, len(trainer.train_loader))
                current_batch = min(total_batches, batch_progress["batch"])
                current_epoch = min(epochs, current_epoch_index + 1)
                completed_batches = current_epoch_index * total_batches + current_batch
                total_training_batches = max(1, epochs * total_batches)
                progress = min(99.99, round((completed_batches / total_training_batches) * 100, 2))
                loss_values = []
                for name, value in (getattr(trainer, "tloss", {}) or {}).items():
                    try:
                        loss_values.append(f"{name} {float(value):.4f}")
                    except (TypeError, ValueError):
                        continue
                loss_text = f" · {' · '.join(loss_values)}" if loss_values else ""
                with self._training_jobs_lock:
                    self._training_jobs[job_id].update({
                        "progress": progress,
                        "current_epoch": current_epoch,
                        "current_batch": current_batch,
                        "total_batches": total_batches,
                        "message": (
                            f"학습 중: Epoch {current_epoch} / {epochs} · "
                            f"Batch {current_batch} / {total_batches}{loss_text}"
                        ),
                    })

            def update_epoch(trainer):
                if stop_if_requested(trainer):
                    return
                current_epoch = min(epochs, int(getattr(trainer, "epoch", 0)) + 1)
                with self._training_jobs_lock:
                    self._training_jobs[job_id].update({
                        "progress": min(99, int((current_epoch / epochs) * 100)),
                        "current_epoch": current_epoch,
                        "message": f"학습 중: Epoch {current_epoch} / {epochs}",
                    })

            def update_metrics(trainer):
                current_epoch = min(epochs, int(getattr(trainer, "epoch", 0)) + 1)
                metrics = getattr(trainer, "metrics", {}) or {}
                metric_point = {
                    "epoch": current_epoch,
                    "precision": float(metrics.get("metrics/precision(M)", 0.0)),
                    "recall": float(metrics.get("metrics/recall(M)", 0.0)),
                    "map50": float(metrics.get("metrics/mAP50(M)", 0.0)),
                    "map50_95": float(metrics.get("metrics/mAP50-95(M)", 0.0)),
                }
                metric_history.append(metric_point)
                with self._training_jobs_lock:
                    self._training_jobs[job_id]["metric_history"] = list(metric_history)

            model.add_callback("on_train_batch_end", update_batch)
            model.add_callback("on_train_epoch_end", update_epoch)
            model.add_callback("on_fit_epoch_end", update_metrics)
            device = "0" if __import__("torch").cuda.is_available() else "cpu"
            results = model.train(
                data=str(dataset_yaml),
                epochs=epochs,
                imgsz=640,
                batch=4,
                workers=0,
                patience=30,
                device=device,
                project=str(SAM2_YOLO_DIR / "runs"),
                name="obstacle-seg",
                exist_ok=True,
            )
            save_dir = str(getattr(results, "save_dir", "") or "")
            with self._training_jobs_lock:
                stopped = bool(self._training_jobs[job_id].get("stop_requested"))
            if stopped:
                checkpoint_path = Path(save_dir) / "weights" / "last.pt" if save_dir else None
                metadata_path = Path(training_plan["metadata_path"])
                if checkpoint_path and checkpoint_path.is_file():
                    metadata_path.parent.mkdir(parents=True, exist_ok=True)
                    metadata_path.write_text(
                        json.dumps({
                            "dataset_fingerprint": dataset_fingerprint,
                            "interrupted_at": datetime.now().isoformat(timespec="seconds"),
                            "continued_from_checkpoint": continue_training,
                            "checkpoint_path": str(checkpoint_path),
                        }, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                with self._training_jobs_lock:
                    self._training_jobs[job_id].update({
                        "status": "stopped",
                        "completed_at": time.time(),
                        "message": "YOLO 학습이 중지되었습니다.",
                        "result": {
                            "checkpoint_path": str(checkpoint_path) if checkpoint_path else "",
                        },
                    })
                return
            best_model_path = Path(save_dir) / "weights" / "best.pt" if save_dir else None
            if not best_model_path or not best_model_path.is_file():
                raise RuntimeError("학습 결과 best.pt 파일을 찾을 수 없습니다")
            output_model_name = f"05_yolo11m-obstacle-sg-{datetime.now().strftime('%y%m%d')}.pt"
            output_model_path = (
                BASE_DIR
                / "ai"
                / "road"
                / "model"
                / output_model_name
            )
            yolo_model_path = BASE_DIR / "yolo" / "model" / output_model_name
            output_model_path.parent.mkdir(parents=True, exist_ok=True)
            yolo_model_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(best_model_path, output_model_path)
            shutil.copy2(best_model_path, yolo_model_path)
            metadata_path = Path(training_plan["metadata_path"])
            metadata_path.parent.mkdir(parents=True, exist_ok=True)
            metadata_path.write_text(
                json.dumps({
                    "dataset_fingerprint": dataset_fingerprint,
                    "completed_at": datetime.now().isoformat(timespec="seconds"),
                    "continued_from_checkpoint": continue_training,
                    "checkpoint_path": str(Path(save_dir) / "weights" / "last.pt"),
                    "output_model_path": str(output_model_path),
                    "yolo_model_path": str(yolo_model_path),
                }, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            with self._training_jobs_lock:
                self._training_jobs[job_id].update({
                    "status": "completed",
                    "progress": 100,
                    "current_epoch": epochs,
                    "completed_at": time.time(),
                    "message": "YOLO 학습이 완료되었습니다.",
                    "result": {
                        "continued_training": continue_training,
                        "forced_retraining": force_retrain,
                        "save_dir": save_dir,
                        "training_best_model_path": str(best_model_path),
                        "best_model_path": str(output_model_path),
                        "yolo_model_path": str(yolo_model_path),
                    },
                })
        except Exception as ex:
            with self._training_jobs_lock:
                self._training_jobs[job_id].update({
                    "status": "failed",
                    "completed_at": time.time(),
                    "message": "YOLO 학습에 실패했습니다.",
                    "error": str(ex),
                })
        finally:
            with self._training_jobs_lock:
                if self._active_training_job_id == job_id:
                    self._active_training_job_id = ""

    def start_yolo_training(self, force_retrain=False):
        summary = self.detector.get_yolo_dataset_summary()
        if int(summary.get("frame_count", 0)) <= 0:
            raise HTTPException(status_code=409, detail="변환된 YOLO 학습 데이터가 없습니다")
        try:
            self.detector.ensure_yolo_dataset_yaml()
        except (FileNotFoundError, ValueError) as ex:
            raise HTTPException(status_code=409, detail=str(ex)) from ex

        dataset_fingerprint = self._get_yolo_dataset_fingerprint()
        training_plan = self._get_yolo_training_plan(
            dataset_fingerprint,
            force_retrain=bool(force_retrain),
        )

        with self._training_jobs_lock:
            if self._active_training_job_id:
                active_job = self._training_jobs.get(self._active_training_job_id, {})
                if active_job.get("status") in {"queued", "running", "stopping"}:
                    raise HTTPException(status_code=409, detail="YOLO 학습이 이미 진행 중입니다")
            job_id = uuid.uuid4().hex
            self._training_jobs[job_id] = {
                "status": "queued",
                "progress": 0,
                "current_epoch": 0,
                "total_epochs": 0,
                "message": "YOLO 재학습 대기 중..." if force_retrain else "YOLO 학습 대기 중...",
                "metric_history": [],
                "started_at": None,
                "completed_at": None,
                "stop_requested": False,
                "dataset_fingerprint": dataset_fingerprint,
                "training_plan": training_plan,
                "result": None,
                "error": "",
            }
            self._active_training_job_id = job_id
        self._training_executor.submit(self._run_yolo_training_job, job_id)
        return self.get_yolo_training_status(job_id)

    def stop_yolo_training(self, job_id: str):
        normalized_job_id = str(job_id or "").strip()
        with self._training_jobs_lock:
            job = self._training_jobs.get(normalized_job_id)
            if not job:
                raise HTTPException(status_code=404, detail="YOLO training job not found")
            if job.get("status") not in {"queued", "running", "stopping"}:
                raise HTTPException(status_code=409, detail="진행 중인 YOLO 학습이 아닙니다")
            job.update({
                "stop_requested": True,
                "status": "stopping",
                "message": "학습 중지를 요청했습니다. 현재 Batch 완료를 기다리는 중...",
            })
            return self._get_yolo_training_snapshot(normalized_job_id, job)

    def _get_yolo_training_snapshot(self, job_id, job):
        snapshot = {"job_id": job_id, **job}
        started_at = job.get("started_at")
        if started_at is None:
            snapshot.update({"elapsed_seconds": 0, "estimated_total_seconds": None})
            return snapshot

        end_time = job.get("completed_at") or time.time()
        elapsed_seconds = max(0, int(end_time - float(started_at)))
        progress = max(0.0, min(100.0, float(job.get("progress") or 0)))
        estimated_total_seconds = None
        if progress >= 100:
            estimated_total_seconds = elapsed_seconds
        elif progress > 0:
            estimated_total_seconds = max(elapsed_seconds, int(elapsed_seconds * 100 / progress))
        snapshot.update({
            "elapsed_seconds": elapsed_seconds,
            "estimated_total_seconds": estimated_total_seconds,
        })
        return snapshot

    def get_yolo_training_status(self, job_id: str):
        with self._training_jobs_lock:
            job = self._training_jobs.get(str(job_id or "").strip())
            if not job:
                raise HTTPException(status_code=404, detail="YOLO training job not found")
            return self._get_yolo_training_snapshot(job_id, job)

    def get_active_yolo_training(self):
        with self._training_jobs_lock:
            job_id = self._active_training_job_id
            job = self._training_jobs.get(job_id)
            if not job or job.get("status") not in {"queued", "running", "stopping"}:
                return {"active": False}
            return {"active": True, **self._get_yolo_training_snapshot(job_id, job)}

    def delete_yolo_dataset(self, file_name: str):
        input_path = self._resolve_uploaded_video_path(file_name)
        deleted_count = self.detector.delete_yolo_dataset(input_path)
        return {
            "input_file_stem": input_path.stem,
            "deleted_count": deleted_count,
        }

    def _safe_suffix(self, file_name: str) -> str:
        suffix = Path(str(file_name or "")).suffix.lower()
        if suffix not in SAM2_VIDEO_EXTENSIONS:
            raise HTTPException(status_code=400, detail="Only video files are supported")
        return suffix

    def _parse_size_to_bytes(self, size_text: str):
        value = str(size_text or "").strip().lower().rstrip(";")
        if not value:
            return None

        if value == "0":
            return 0

        match = re.match(r"^(\d+)([kmg])?$", value)
        if not match:
            return None

        amount = int(match.group(1))
        suffix = match.group(2)
        if suffix == "k":
            return amount * 1024
        if suffix == "m":
            return amount * 1024 * 1024
        if suffix == "g":
            return amount * 1024 * 1024 * 1024
        return amount

    def _resolve_nginx_upload_limit(self):
        env_value = os.getenv("NGINX_CLIENT_MAX_BODY_SIZE") or os.getenv("CLIENT_MAX_BODY_SIZE")
        env_bytes = self._parse_size_to_bytes(env_value)
        if env_bytes is not None:
            return env_bytes, "env", str(env_value).strip()

        conf_limit = self._resolve_nginx_upload_limit_from_files()
        if conf_limit is not None:
            conf_bytes = self._parse_size_to_bytes(conf_limit)
            if conf_bytes is not None:
                return conf_bytes, "nginx", conf_limit

        try:
            result = subprocess.run(
                ["nginx", "-T"],
                capture_output=True,
                text=True,
                check=False,
            )
            output_text = (result.stdout or "") + "\n" + (result.stderr or "")
            matches = re.findall(r"client_max_body_size\s+([^\s;]+)", output_text, flags=re.IGNORECASE)
            for raw_value in reversed(matches):
                parsed = self._parse_size_to_bytes(raw_value)
                if parsed is not None:
                    return parsed, "nginx", str(raw_value).strip()
        except Exception:
            pass

        return DEFAULT_UPLOAD_LIMIT_BYTES, "default", "1g"

    def _resolve_nginx_upload_limit_from_files(self):
        candidate_files = [
            os.getenv("NGINX_CONF_PATH", "").strip(),
            "/etc/nginx/nginx.conf",
            "/etc/nginx/conf.d/default.conf",
            "/etc/nginx/sites-enabled/default",
            "/etc/nginx/sites-available/default",
        ]

        merged_text_parts = []
        for file_path in candidate_files:
            if not file_path:
                continue
            try:
                path = Path(file_path)
                if path.exists() and path.is_file():
                    merged_text_parts.append(path.read_text(encoding="utf-8", errors="ignore"))
            except OSError:
                continue

        if not merged_text_parts:
            return None

        merged_text = "\n".join(merged_text_parts)
        matches = re.findall(r"client_max_body_size\s+([^\s;]+)", merged_text, flags=re.IGNORECASE)
        for raw_value in reversed(matches):
            parsed = self._parse_size_to_bytes(raw_value)
            if parsed is not None:
                return str(raw_value).strip()

        return None

    def get_upload_limit(self):
        max_upload_bytes, source, configured_value = self._resolve_nginx_upload_limit()
        return {
            "max_upload_bytes": int(max_upload_bytes),
            "source": source,
            "configured_value": configured_value,
        }

    def _safe_uploaded_file_name(self, file_name: str) -> str:
        value = str(file_name or "").strip()
        if not value:
            raise HTTPException(status_code=400, detail="file_name is required")

        name = Path(value).name
        if not name or name in {".", ".."}:
            raise HTTPException(status_code=400, detail="Invalid file name")

        return name

    def _resolve_model_name(self, model_name: str) -> str:
        value = str(model_name or "").strip()
        if value and value.lower() not in {"auto", "default"}:
            return value
        return SAM2_DEFAULT_MODEL

    def _to_relative_under_base(self, file_path: Path) -> str:
        base_dir = BASE_DIR.resolve()
        return file_path.resolve().relative_to(base_dir).as_posix()

    def _hash_file(self, file_path: Path) -> str:
        hasher = hashlib.sha256()
        with file_path.open("rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                hasher.update(chunk)
        return hasher.hexdigest()

    def _resolve_uploaded_video_path(self, file_name: str) -> Path:
        value = str(file_name or "").strip()
        if not value:
            raise HTTPException(status_code=400, detail="file_name is required")

        candidate = Path(value)
        if candidate.is_absolute():
            resolved = candidate.resolve()
        else:
            resolved = (BASE_DIR / candidate).resolve()

        upload_root = SAM2_UPLOAD_DIR.resolve()
        if resolved != upload_root and upload_root not in resolved.parents:
            raise HTTPException(status_code=400, detail="Invalid file_name path")

        suffix = resolved.suffix.lower()
        if suffix not in SAM2_VIDEO_EXTENSIONS:
            raise HTTPException(status_code=400, detail="Only video files are supported")

        if not resolved.exists() or not resolved.is_file():
            raise HTTPException(status_code=404, detail="Uploaded video not found")

        return resolved

    def _is_listable_uploaded_video(self, path: Path) -> bool:
        if not path.is_file():
            return False

        if path.suffix.lower() not in SAM2_VIDEO_EXTENSIONS:
            return False

        name_lower = path.name.lower()
        if ".playable." in name_lower or ".uploading" in name_lower or name_lower.startswith("_"):
            return False

        return True

    def _options_path(self, input_path: Path) -> Path:
        return input_path.with_suffix(".sam2")

    def _parse_options_json(self, value: str, default):
        if not str(value or "").strip():
            return default
        try:
            return json.loads(value)
        except json.JSONDecodeError as ex:
            raise HTTPException(status_code=400, detail="Detection options must be valid JSON") from ex

    def _save_detection_options(
        self,
        input_path: Path,
        model_name: str,
        prompt_frame: int,
        bbox: str,
        points: str,
        point_labels: str,
        multimask_output: bool = False,
        mask_input: bool = True,
        clahe: bool = False,
        iou_mask_filter: bool = True,
        reference_score: float = 0.5,
    ) -> None:
        try:
            reference_value = float(reference_score)
        except (TypeError, ValueError):
            reference_value = 0.5
        reference_value = max(0.0, min(1.0, reference_value))

        options = {
            "model_name": model_name,
            "prompt_frame": max(1, int(prompt_frame)),
            "bbox": self._parse_options_json(bbox, None),
            "points": self._parse_options_json(points, []),
            "point_labels": self._parse_options_json(point_labels, []),
            "multimask_output": bool(multimask_output),
            "mask_input": bool(mask_input),
            "clahe": bool(clahe),
            "iou_mask_filter": bool(iou_mask_filter),
            "reference_score": round(reference_value, 3),
            "saved_at": datetime.now().isoformat(timespec="seconds"),
        }
        options_path = self._options_path(input_path)
        try:
            options_path.write_text(json.dumps(options, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as ex:
            raise HTTPException(status_code=500, detail=f"Failed to save detection options: {ex}") from ex

    def _save_uploaded_video(self, upload_file: UploadFile) -> Path:
        original_file_name = self._safe_uploaded_file_name(upload_file.filename)
        suffix = self._safe_suffix(original_file_name)
        SAM2_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        job_id = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        temp_path = SAM2_UPLOAD_DIR / f"{Path(original_file_name).stem}.{job_id}.uploading{suffix}"

        hasher = hashlib.sha256()
        written_size = 0

        try:
            upload_file.file.seek(0)
            with temp_path.open("wb") as target_file:
                while True:
                    chunk = upload_file.file.read(1024 * 1024)
                    if not chunk:
                        break
                    hasher.update(chunk)
                    target_file.write(chunk)
                    written_size += len(chunk)
        finally:
            upload_file.file.close()

        new_digest = hasher.hexdigest()
        target_name = original_file_name

        for existing_path in SAM2_UPLOAD_DIR.glob(f"*{suffix}"):
            if not existing_path.is_file() or existing_path == temp_path:
                continue

            try:
                if existing_path.stat().st_size != written_size:
                    continue
            except OSError:
                continue

            existing_digest = self._hash_file(existing_path)
            if existing_digest == new_digest:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
                return existing_path

        input_path = SAM2_UPLOAD_DIR / target_name
        if input_path.exists():
            stem = Path(original_file_name).stem
            input_path = SAM2_UPLOAD_DIR / f"{stem}_{job_id}{suffix}"

        temp_path.replace(input_path)
        return input_path

    def detect_uploaded_video(
        self,
        upload_file: UploadFile,
        model_name: str = "auto",
        prompt_frame: int = 1,
        bbox: str = "",
        points: str = "",
        point_labels: str = "",
        multimask_output: bool = False,
        mask_input: bool = True,
        clahe: bool = False,
        iou_mask_filter: bool = True,
        reference_score: float = 0.5,
    ):
        input_path = self._save_uploaded_video(upload_file)
        resolved_model_name = self._resolve_model_name(model_name)
        self._save_detection_options(
            input_path=input_path,
            model_name=resolved_model_name,
            prompt_frame=prompt_frame,
            bbox=bbox,
            points=points,
            point_labels=point_labels,
            multimask_output=multimask_output,
            mask_input=mask_input,
            clahe=clahe,
            iou_mask_filter=iou_mask_filter,
            reference_score=reference_score,
        )

        return self._start_detection_job(
            input_path=input_path,
            model_name=resolved_model_name,
            prompt_frame=prompt_frame,
            bbox=bbox,
            points=points,
            point_labels=point_labels,
            multimask_output=multimask_output,
            mask_input=mask_input,
            clahe=clahe,
            iou_mask_filter=iou_mask_filter,
            reference_score=reference_score,
        )

    def upload_video_only(self, upload_file: UploadFile):
        input_path = self._save_uploaded_video(upload_file)
        relative = self._to_relative_under_base(input_path)
        playable_result = get_browser_playable_video_url(relative, force_transcode=True)

        return {
            "file_name": relative,
            "display_name": input_path.name,
            "size": int(input_path.stat().st_size),
            "uploaded_at": datetime.fromtimestamp(input_path.stat().st_mtime).isoformat(timespec="seconds"),
            "input_url": f"/fast/image/{relative}",
            "playable_url": playable_result["video_url"],
            "thumbnail_url": f"/fast/video_thumbnail/{relative}",
        }

    def detect_saved_video(
        self,
        file_name: str,
        model_name: str = "auto",
        prompt_frame: int = 1,
        bbox: str = "",
        points: str = "",
        point_labels: str = "",
        multimask_output: bool = False,
        mask_input: bool = True,
        clahe: bool = False,
        iou_mask_filter: bool = True,
        reference_score: float = 0.5,
    ):
        input_path = self._resolve_uploaded_video_path(file_name)
        resolved_model_name = self._resolve_model_name(model_name)
        self._save_detection_options(
            input_path=input_path,
            model_name=resolved_model_name,
            prompt_frame=prompt_frame,
            bbox=bbox,
            points=points,
            point_labels=point_labels,
            multimask_output=multimask_output,
            mask_input=mask_input,
            clahe=clahe,
            iou_mask_filter=iou_mask_filter,
            reference_score=reference_score,
        )

        return self._start_detection_job(
            input_path=input_path,
            model_name=resolved_model_name,
            prompt_frame=prompt_frame,
            bbox=bbox,
            points=points,
            point_labels=point_labels,
            multimask_output=multimask_output,
            mask_input=mask_input,
            clahe=clahe,
            iou_mask_filter=iou_mask_filter,
            reference_score=reference_score,
        )

    def list_uploaded_videos(self, limit: int = 50):
        SAM2_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

        items = []
        for path in SAM2_UPLOAD_DIR.glob("*"):
            if not self._is_listable_uploaded_video(path):
                continue

            stat = path.stat()
            relative = self._to_relative_under_base(path)
            output_path = SAM2_OUTPUT_DIR / f"{path.stem}.mp4"
            has_output = output_path.is_file()
            playable_path = path.with_name(f"{path.stem}.playable.mp4")
            items.append(
                {
                    "file_name": relative,
                    "display_name": path.name,
                    "size": int(stat.st_size),
                    "uploaded_at": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                    "input_url": f"/fast/image/{relative}",
                    "playable_url": (
                        f"/fast/image/{self._to_relative_under_base(playable_path)}"
                        if playable_path.is_file()
                        else ""
                    ),
                    "thumbnail_url": f"/fast/video_thumbnail/{relative}",
                    "output_url": (
                        f"/fast/image/{self._to_relative_under_base(output_path)}"
                        if has_output
                        else ""
                    ),
                    "yolo_conversion_available": bool(
                        has_output and self.detector.has_yolo_conversion_cache(path)
                    ),
                    "has_yolo_dataset": self.detector.has_yolo_dataset(path),
                }
            )

        items.sort(key=lambda item: item.get("uploaded_at", ""), reverse=True)
        return {"videos": items[: max(1, int(limit))]}

    def get_video_metadata(self, file_name: str, output: bool = False):
        input_path = self._resolve_uploaded_video_path(file_name)
        if output:
            metadata_path = SAM2_OUTPUT_DIR / f"{input_path.stem}.mp4"
            if not metadata_path.is_file():
                raise HTTPException(status_code=404, detail="Detected video not found")
        else:
            playable_path = input_path.with_name(f"{input_path.stem}.playable.mp4")
            metadata_path = playable_path if playable_path.is_file() else input_path
        capture = cv2.VideoCapture(str(metadata_path))
        try:
            if not capture.isOpened():
                raise HTTPException(status_code=422, detail="Unable to read video metadata")
            fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
            frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        finally:
            capture.release()

        if fps <= 0 or frame_count <= 0:
            raise HTTPException(status_code=422, detail="Video frame metadata is unavailable")

        return {
            "fps": round(fps, 6),
            "frame_count": frame_count,
        }

    def delete_uploaded_video(self, file_name: str):
        input_path = self._resolve_uploaded_video_path(file_name)
        input_stem = input_path.stem
        deleted_paths = []

        def remove_file(path: Path):
            if path.is_file() or path.is_symlink():
                path.unlink(missing_ok=True)
                deleted_paths.append(str(path))

        remove_file(input_path)
        remove_file(self._options_path(input_path))
        remove_file(input_path.with_name(f"{input_stem}.playable.mp4"))
        remove_file(input_path.with_name(f"{input_stem}.playable.tmp.mp4"))
        for path in SAM2_UPLOAD_DIR.glob(f"_{input_stem}.*"):
            remove_file(path)
        for path in SAM2_OUTPUT_DIR.glob(f"{input_stem}*"):
            if path.is_file() or path.is_symlink():
                remove_file(path)

        self.detector._yolo_conversion_cache.pop(str(input_path.resolve()), None)
        return {
            "file_name": self._to_relative_under_base(input_path),
            "deleted": True,
            "deleted_count": len(deleted_paths),
        }

    def get_video_options(self, file_name: str):
        input_path = self._resolve_uploaded_video_path(file_name)
        options_path = self._options_path(input_path)
        if not options_path.is_file():
            return {"exists": False}

        try:
            options = json.loads(options_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as ex:
            raise HTTPException(status_code=500, detail=f"Failed to load detection options: {ex}") from ex

        if not isinstance(options, dict):
            raise HTTPException(status_code=500, detail="Detection options must be a JSON object")

        try:
            reference_score = float(options.get("reference_score", 0.5))
        except (TypeError, ValueError):
            reference_score = 0.5
        reference_score = max(0.0, min(1.0, reference_score))

        return {
            "exists": True,
            "model_name": options.get("model_name", ""),
            "prompt_frame": max(1, int(options.get("prompt_frame", 1))),
            "bbox": options.get("bbox"),
            "points": options.get("points", []),
            "point_labels": options.get("point_labels", []),
            "multimask_output": options.get("multimask_output", False) is True,
            "mask_input": options.get("mask_input", True) is not False,
            "clahe": options.get("clahe", False) is True,
            "iou_mask_filter": options.get("iou_mask_filter", True) is not False,
            "reference_score": round(reference_score, 3),
            "saved_at": options.get("saved_at", ""),
        }

    def save_video_options(
        self,
        file_name: str,
        model_name: str = "auto",
        prompt_frame: int = 1,
        bbox: str = "",
        points: str = "",
        point_labels: str = "",
        multimask_output: bool = False,
        mask_input: bool = True,
        clahe: bool = False,
        iou_mask_filter: bool = True,
        reference_score: float = 0.5,
    ):
        input_path = self._resolve_uploaded_video_path(file_name)
        resolved_model_name = self._resolve_model_name(model_name)
        self._save_detection_options(
            input_path=input_path,
            model_name=resolved_model_name,
            prompt_frame=prompt_frame,
            bbox=bbox,
            points=points,
            point_labels=point_labels,
            multimask_output=multimask_output,
            mask_input=mask_input,
            clahe=clahe,
            iou_mask_filter=iou_mask_filter,
            reference_score=reference_score,
        )
        return {
            "saved": True,
            "file_name": self._to_relative_under_base(input_path),
            "saved_at": datetime.now().isoformat(timespec="seconds"),
        }
