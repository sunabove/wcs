(function () {
    'use strict';

    const fileInput = document.getElementById('yolo-video-file');
    const dropZone = document.getElementById('yolo-drop-zone');
    const selectedFileElement = document.getElementById('yolo-selected-file');
    const detectButton = document.getElementById('yolo-detect-btn');
    const confInput = document.getElementById('yolo-conf');
    const iouInput = document.getElementById('yolo-iou');

    const statusElement = document.getElementById('yolo-status');
    const inputVideoElement = document.getElementById('yolo-input-video');
    const outputVideoElement = document.getElementById('yolo-output-video');
    const resultJsonElement = document.getElementById('yolo-result-json');

    let selectedFile = null;
    let resolvedApiBase = null;

    function setStatus(message, type) {
        const alertType = type || 'secondary';
        statusElement.className = `alert alert-${alertType} mt-3 mb-0`;
        statusElement.textContent = message;
    }

    function toNumber(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    async function resolveApiBase() {
        if (resolvedApiBase != null) {
            return resolvedApiBase;
        }

        const origin = window.location.origin;
        const host = window.location.hostname || 'localhost';
        const candidateBases = [
            '',
            `http://${host}:8000`,
            'http://localhost:8000',
            'http://127.0.0.1:8000',
        ];

        const uniqueBases = Array.from(new Set(candidateBases));
        for (const base of uniqueBases) {
            const healthUrl = `${base}/fast/yolo/health`;
            try {
                const response = await fetch(healthUrl, {
                    method: 'GET',
                    cache: 'no-store',
                });
                if (response.ok) {
                    resolvedApiBase = base;
                    return resolvedApiBase;
                }
            } catch (_ignore) {
                // Try next candidate.
            }
        }

        resolvedApiBase = '';
        return resolvedApiBase;
    }

    function setSelectedFile(file) {
        selectedFile = file || null;
        if (selectedFile) {
            selectedFileElement.textContent = `선택됨: ${selectedFile.name}`;
        } else {
            selectedFileElement.textContent = '선택된 파일 없음';
        }
    }

    function isVideoFile(file) {
        if (!file) {
            return false;
        }

        const typeText = String(file.type || '').toLowerCase();
        if (typeText.startsWith('video/')) {
            return true;
        }

        const nameText = String(file.name || '').toLowerCase();
        return /\.(mp4|avi|mov|mkv|wmv|webm|m4v)$/i.test(nameText);
    }

    function pickFirstVideoFile(fileList) {
        const files = Array.from(fileList || []);
        return files.find(isVideoFile) || null;
    }

    function syncInputWithFile(file) {
        if (!fileInput) {
            return;
        }

        if (!file) {
            fileInput.value = '';
            return;
        }

        try {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            fileInput.files = dataTransfer.files;
        } catch (_ignore) {
            // Some browsers may not allow programmatic FileList assignment.
        }
    }

    function handleChosenFile(file) {
        if (!file) {
            setSelectedFile(null);
            return;
        }

        if (!isVideoFile(file)) {
            setStatus('동영상 파일만 업로드할 수 있습니다.', 'warning');
            return;
        }

        setSelectedFile(file);
        syncInputWithFile(file);
        setStatus('동영상 파일이 준비되었습니다. 검출 시작을 눌러주세요.', 'secondary');
    }

    async function runYoloDetect() {
        if (detectButton.disabled) {
            return;
        }

        const fileFromInput = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        const file = selectedFile || fileFromInput;
        if (!file) {
            setStatus('동영상 파일을 선택하세요.', 'warning');
            return;
        }

        const conf = toNumber(confInput.value, 0.25);
        const iou = toNumber(iouInput.value, 0.45);

        detectButton.disabled = true;
        setStatus('YOLO 검출 진행 중...', 'info');

        try {
            const formData = new FormData();
            formData.append('file', file);

            const apiBase = await resolveApiBase();
            const url = `${apiBase}/fast/yolo/detect_video_upload?conf=${encodeURIComponent(conf)}&iou=${encodeURIComponent(iou)}`;
            const response = await fetch(url, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                let errorMessage = `요청 실패 (${response.status})`;
                try {
                    const errorBody = await response.json();
                    if (errorBody && errorBody.detail) {
                        errorMessage = String(errorBody.detail);
                    }
                } catch (_ignore) {
                    // Keep default message.
                }
                throw new Error(errorMessage);
            }

            const result = await response.json();

            const inputUrl = result.input_url ? `${apiBase}${result.input_url}` : '';
            const outputUrl = result.output_url ? `${apiBase}${result.output_url}` : '';

            inputVideoElement.src = inputUrl;
            outputVideoElement.src = outputUrl;
            inputVideoElement.load();
            outputVideoElement.load();

            resultJsonElement.textContent = JSON.stringify(result, null, 2);
            setStatus('검출 완료', 'success');
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            setStatus(`오류: ${message}`, 'danger');
        } finally {
            detectButton.disabled = false;
        }
    }

    fileInput.addEventListener('change', () => {
        const file = pickFirstVideoFile(fileInput.files);
        handleChosenFile(file);
    });

    dropZone.addEventListener('click', () => {
        fileInput.click();
    });

    dropZone.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            fileInput.click();
        }
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, (event) => {
            event.preventDefault();
            event.stopPropagation();
            dropZone.classList.add('drag-active');
        });
    });

    ['dragleave', 'dragend'].forEach(eventName => {
        dropZone.addEventListener(eventName, (event) => {
            event.preventDefault();
            event.stopPropagation();
            dropZone.classList.remove('drag-active');
        });
    });

    dropZone.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation();
        dropZone.classList.remove('drag-active');

        const file = pickFirstVideoFile(event.dataTransfer?.files);
        if (!file) {
            setStatus('드롭한 파일 중 동영상이 없습니다.', 'warning');
            return;
        }

        handleChosenFile(file);
        runYoloDetect();
    });

    detectButton.addEventListener('click', runYoloDetect);
})();
