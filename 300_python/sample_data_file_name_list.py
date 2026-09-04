from fastapi import HTTPException

from config import IMAGE_EXTENSIONS, SAMPLES_DIR, VIDEO_EXTENSIONS


def _resolve_target_path(folder_name: str):
    samples_path = SAMPLES_DIR.resolve()
    target_path = (samples_path / folder_name).resolve()

    # Prevent path traversal outside the samples directory.
    try:
        target_path.relative_to(samples_path)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid folder path")

    return samples_path, target_path


def _is_valid_sample_file(file_path):
    if not file_path.is_file():
        return False

    # Exclude files starting with underscore and detected files.
    if file_path.name.startswith("_"):
        return False

    ext = file_path.suffix.lower()
    if ext not in IMAGE_EXTENSIONS and ext not in VIDEO_EXTENSIONS:
        return False

    stem_lower = file_path.stem.lower()
    if "_detected" in stem_lower or ".playable" in stem_lower:
        return False

    return True

def sample_data_file_name_list(folder_name: str) -> list[str]:
    samples_path, target_path = _resolve_target_path(folder_name)

    file_names = []

    if target_path.exists() and target_path.is_dir():
        for file_path in target_path.rglob("*"):
            if not _is_valid_sample_file(file_path):
                continue

            relative_path = file_path.relative_to(samples_path).as_posix()
            file_names.append(f"samples/{relative_path}")

        file_names.sort() 

    return file_names
pass # sample_data_file_name_list


def sample_data_folder_name_list(folder_name: str) -> list[str]:
    samples_path, target_path = _resolve_target_path(folder_name)

    if not target_path.exists() or not target_path.is_dir():
        return []

    folder_set = set()
    for file_path in target_path.rglob("*"):
        if not _is_valid_sample_file(file_path):
            continue

        folder_relative_to_samples = file_path.parent.relative_to(samples_path).as_posix()
        folder_set.add(folder_relative_to_samples)

    folder_names = [f"samples/{name}" for name in sorted(folder_set)]
    return folder_names
pass # sample_data_folder_name_list


def _contains_valid_sample_file(folder_path):
    if not folder_path.exists() or not folder_path.is_dir():
        return False

    for child in folder_path.rglob("*"):
        if _is_valid_sample_file(child):
            return True
    return False


def sample_data_browser_list(folder_name: str) -> dict:
    samples_path, target_path = _resolve_target_path(folder_name)

    current_relative = target_path.relative_to(samples_path).as_posix() if target_path.exists() else folder_name
    current_folder = f"samples/{current_relative.strip('/')}".rstrip("/")

    if not target_path.exists() or not target_path.is_dir():
        return {
            "current_folder": current_folder,
            "folders": [],
            "files": [],
        }

    folders = []
    files = []

    for child in sorted(target_path.iterdir(), key=lambda p: p.name.lower()):
        if child.is_dir():
            if _contains_valid_sample_file(child):
                rel = child.relative_to(samples_path).as_posix()
                folders.append(f"samples/{rel}")
            continue

        if _is_valid_sample_file(child):
            rel = child.relative_to(samples_path).as_posix()
            files.append(f"samples/{rel}")

    return {
        "current_folder": current_folder,
        "folders": folders,
        "files": files,
    }
pass # sample_data_browser_list


def delete_sample_file(file_name: str) -> dict:
    # file_name is whatever sample_data_browser_list()/sample_data_file_name_list() above
    # returned (e.g. "samples/video/cobot/foo.mp4") - accept that "samples/" prefix, but
    # also a bare "video/cobot/foo.mp4" for robustness.
    normalized = str(file_name or "").strip().replace("\\", "/")
    if normalized.startswith("samples/"):
        normalized = normalized[len("samples/"):]
    if not normalized or normalized in {".", ".."}:
        raise HTTPException(status_code=400, detail="Invalid file name")

    samples_path, target_path = _resolve_target_path(normalized)

    if not target_path.is_file():
        raise HTTPException(status_code=404, detail="Sample file not found")

    deleted_names = []

    def remove_file(path):
        if path.is_file() or path.is_symlink():
            path.unlink(missing_ok=True)
            deleted_names.append(path.relative_to(samples_path).as_posix())

    remove_file(target_path)
    # A transcoded .playable.mp4 sibling get_browser_playable_video_url() (send_image.py)
    # may have created next to a non-mp4/m4v/webm source - clean that up too, same as
    # Sam2VideoService.delete_uploaded_video() does for its own uploaded videos.
    remove_file(target_path.with_name(f"{target_path.stem}.playable.mp4"))

    return {
        "file_name": f"samples/{normalized}",
        "deleted": True,
        "deleted_count": len(deleted_names),
    }
pass # delete_sample_file