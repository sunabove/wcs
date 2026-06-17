from fastapi import HTTPException

from config import IMAGE_EXTENSIONS, SAMPLES_DIR, VIDEO_EXTENSIONS

def sample_data_file_name_list(folder_name: str) -> list[str]:
    samples_path = SAMPLES_DIR.resolve()
    target_path = (samples_path / folder_name).resolve()

    # Prevent path traversal outside the samples directory.
    try:
        target_path.relative_to(samples_path)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid folder path")

    file_names = []
    if target_path.exists() and target_path.is_dir():
        for file_path in target_path.rglob("*"):
            if file_path.is_file():
                ext = file_path.suffix.lower()
                if ext in IMAGE_EXTENSIONS or ext in VIDEO_EXTENSIONS:
                    file_names.append(file_path.name)
                pass
            pass
        pass

        file_names.sort()
    pass

    return file_names
pass # sample_data_file_name_list