from fastapi import HTTPException

from config import IMAGE_EXTENSIONS, SAMPLES_DIR, VIDEO_EXTENSIONS

def sample_data_file_name_list(folder_name: str) -> dict:
    base_path = SAMPLES_DIR.resolve()
    target_path = (base_path / folder_name).resolve()

    # Prevent path traversal outside the samples directory.
    try:
        target_path.relative_to(base_path)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid folder path")

    if not target_path.exists() or not target_path.is_dir():
        raise HTTPException(status_code=404, detail="Sample folder not found")

    image_files = []
    video_files = []

    for file_path in target_path.rglob("*"):
        if not file_path.is_file():
            continue

        ext = file_path.suffix.lower()
        relative_file = str(file_path.relative_to(base_path)).replace("\\", "/")

        if ext in IMAGE_EXTENSIONS:
            image_files.append(relative_file)
        elif ext in VIDEO_EXTENSIONS:
            video_files.append(relative_file)

    image_files.sort()
    video_files.sort()

    return {
        "folder": folder_name,
        "image_files": image_files,
        "video_files": video_files,
        "total_count": len(image_files) + len(video_files),
    }
