(function () {
    'use strict';

    const fileInput = document.getElementById('sam2-video-file');
    const dropZone = document.getElementById('sam2-drop-zone');
    const selectedFileElement = document.getElementById('sam2-selected-file');
    const detectButton = document.getElementById('sam2-detect-btn');
    const confInput = document.getElementById('sam2-conf');
    const confValueElement = document.getElementById('sam2-conf-value');
    const loopToggleInput = document.getElementById('sam2-loop-toggle');
    const uploadedListElement = document.getElementById('sam2-uploaded-list');
    const uploadedEmptyElement = document.getElementById('sam2-uploaded-empty');

    const statusElement = document.getElementById('sam2-status');
    const inputVideoElement = document.getElementById('sam2-input-video');
    const outputVideoElement = document.getElementById('sam2-output-video');

    let selectedFile = null;
    let resolvedApiBase = null;
    let inputObjectUrl = '';
    let outputObjectUrl = '';
    let uploadedHistory = [];
    let selectedServerFileName = '';
    const STORAGE_TARGET_KEY = 'sam2.targetType';
    const STORAGE_CONF_KEY = 'sam2.conf';

    function setStatus(message, type) {
        const alertType = type || 'secondary';
        statusElement.className = `alert alert-${alertType} mt-3 mb-0`;
        statusElement.textContent = message;
    }

    function toNumber(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function updateConfValueLabel() {
        if (!confValueElement) {
            return;
        }
        confValueElement.textContent = toNumber(confInput ? confInput.value : 0.25, 0.25).toFixed(2);
    }

    function hasSelectedVideo() {
        const fileFromInput = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        return Boolean(selectedFile || fileFromInput || selectedServerFileName);
    }

    function saveUiOptions() {
        try {
            const targetType = getSelectedTargetType();
            const conf = toNumber(confInput ? confInput.value : 0.25, 0.25);
            localStorage.setItem(STORAGE_TARGET_KEY, targetType);
            localStorage.setItem(STORAGE_CONF_KEY, String(conf));
        } catch (_ignore) {
            // localStorage may be unavailable in some browser/privacy modes.
        }
    }

    function loadUiOptions() {
        try {
            const storedTargetType = String(localStorage.getItem(STORAGE_TARGET_KEY) || '').trim();
            if (storedTargetType === 'road' || storedTargetType === 'pothole' || storedTargetType === 'curb_step') {
                const targetInput = document.querySelector(`input[name="sam2-target"][value="${storedTargetType}"]`);
                if (targetInput) {
                    targetInput.checked = true;
                }
            }

            if (confInput) {
                const storedConfRaw = localStorage.getItem(STORAGE_CONF_KEY);
                if (storedConfRaw != null) {
                    const storedConf = toNumber(storedConfRaw, 0.25);
                    const normalizedConf = Math.max(0, Math.min(1, storedConf));
                    confInput.value = String(normalizedConf);
                }
            }
        } catch (_ignore) {
            // Keep defaults when localStorage is unavailable.
        }
    }

    function getSelectedTargetType() {
        const selected = document.querySelector('input[name="sam2-target"]:checked');
        const value = selected ? String(selected.value || '').trim() : '';
        if (value === 'road' || value === 'pothole' || value === 'curb_step') {
            return value;
        }
        return 'road';
    }

    function targetTypeLabel(targetType) {
        if (targetType === 'pothole') {
            return '포트홀';
        }
        if (targetType === 'curb_step') {
            return '단차';
        }
        return '도로';
    }

    function applyLoopOption() {
        const loopEnabled = Boolean(loopToggleInput && loopToggleInput.checked);
        inputVideoElement.loop = loopEnabled;
        outputVideoElement.loop = loopEnabled;
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
            const healthUrl = `${base}/fast/sam2/health`;
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
        if (!selectedFileElement) {
            return;
        }

        if (selectedFile) {
            selectedFileElement.textContent = `선택됨: ${selectedFile.name}`;
        } else {
            selectedFileElement.textContent = '선택된 파일 없음';
        }
    }

    function basename(pathOrName) {
        const text = String(pathOrName || '').trim();
        if (!text) {
            return '';
        }
        const normalized = text.replace(/\\/g, '/');
        const index = normalized.lastIndexOf('/');
        return index >= 0 ? normalized.slice(index + 1) : normalized;
    }

    function shortDisplayName(nameText) {
        const value = String(nameText || '');
        const dotIndex = value.lastIndexOf('.');
        const stem = dotIndex > 0 ? value.slice(0, dotIndex) : value;
        const maxLength = 10;
        if (stem.length <= maxLength) {
            return stem;
        }

        return `${stem.slice(0, maxLength)}...`;
    }

    function renderUploadedHistory() {
        if (!uploadedListElement) {
            return;
        }

        uploadedListElement.innerHTML = '';

        if (uploadedHistory.length === 0) {
            const emptyItem = document.createElement('li');
            emptyItem.id = 'sam2-uploaded-empty';
            emptyItem.className = 'list-group-item small text-muted';
            emptyItem.textContent = '업로드 이력 없음';
            uploadedListElement.appendChild(emptyItem);
            return;
        }

        for (const item of uploadedHistory) {
            const li = document.createElement('li');
            li.className = 'list-group-item small';

            if (item.serverFileName && item.serverFileName === selectedServerFileName) {
                li.classList.add('active');
            }

            const row = document.createElement('div');
            row.className = 'sam2-uploaded-item';
            row.style.cursor = 'pointer';

            const thumb = document.createElement('img');
            thumb.className = 'sam2-uploaded-thumb';
            thumb.alt = item.name || 'thumbnail';
            if (item.thumbnailUrl || item.thumbnailSource) {
                thumb.src = item.thumbnailUrl || item.thumbnailSource;
            }

            const meta = document.createElement('div');
            meta.className = 'sam2-uploaded-meta flex-grow-1';

            const nameDiv = document.createElement('div');
            nameDiv.className = 'text-truncate';
            nameDiv.title = item.name;
            nameDiv.textContent = shortDisplayName(item.name);

            meta.appendChild(nameDiv);
            row.appendChild(thumb);
            row.appendChild(meta);
            li.appendChild(row);

            row.addEventListener('click', () => {
                if (!item.serverFileName || detectButton.disabled) {
                    return;
                }

                selectedServerFileName = item.serverFileName;
                selectedFile = null;
                if (fileInput) {
                    fileInput.value = '';
                }

                renderUploadedHistory();
                setStatus(`선택됨: ${item.name} (재분할 중...)`, 'info');
                runSam2Segment();
            });

            uploadedListElement.appendChild(li);
        }
    }

    function addUploadedHistoryItem(fileNameHint, inputFilePath, thumbnailSource) {
        const displayName = basename(fileNameHint) || basename(inputFilePath) || 'unknown_video';
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');

        const duplicateIndex = uploadedHistory.findIndex(item => item.name === displayName);
        const record = {
            name: displayName,
            time: `${hh}:${mm}:${ss}`,
            thumbnailUrl: '',
            thumbnailSource: String(thumbnailSource || ''),
            serverFileName: String(inputFilePath || ''),
        };
        if (duplicateIndex >= 0) {
            const old = uploadedHistory[duplicateIndex];
            if (old && old.thumbnailUrl) {
                URL.revokeObjectURL(old.thumbnailUrl);
            }
            uploadedHistory.splice(duplicateIndex, 1);
        }
        uploadedHistory.unshift(record);
        if (uploadedHistory.length > 20) {
            const removed = uploadedHistory.slice(20);
            for (const item of removed) {
                if (item && item.thumbnailUrl) {
                    URL.revokeObjectURL(item.thumbnailUrl);
                }
            }
            uploadedHistory = uploadedHistory.slice(0, 20);
        }

        renderUploadedHistory();
    }

    async function loadUploadedHistoryFromServer() {
        try {
            const apiBase = await resolveApiBase();
            const response = await fetch(`${apiBase}/fast/sam2/uploaded_videos?limit=50`, {
                method: 'GET',
                cache: 'no-store',
            });
            if (!response.ok) {
                return;
            }

            const body = await response.json();
            const videos = body && Array.isArray(body.videos) ? body.videos : [];
            const mapped = videos.map((item) => ({
                name: basename(item.display_name || item.file_name),
                time: String(item.uploaded_at || '').replace('T', ' '),
                thumbnailUrl: '',
                thumbnailSource: buildThumbnailUrl(apiBase, item.file_name),
                serverFileName: String(item.file_name || ''),
            }));

            uploadedHistory = mapped;
            renderUploadedHistory();
        } catch (_ignore) {
            // Keep empty state when loading history fails.
        }
    }

    function buildAbsoluteUrl(base, pathOrUrl) {
        const text = String(pathOrUrl || '').trim();
        if (!text) {
            return '';
        }
        if (/^https?:\/\//i.test(text)) {
            return text;
        }
        return `${base}${text.startsWith('/') ? text : `/${text}`}`;
    }

    function encodePathSegments(pathText) {
        return String(pathText || '')
            .split('/')
            .map(segment => encodeURIComponent(segment))
            .join('/');
    }

    function buildThumbnailUrl(apiBase, fileName) {
        const filePath = String(fileName || '').trim();
        if (!filePath) {
            return '';
        }
        return `${apiBase}/fast/video_thumbnail/${encodePathSegments(filePath)}`;
    }

    function extractFastImagePath(pathOrUrl) {
        const text = String(pathOrUrl || '').trim();
        if (!text) {
            return '';
        }

        const marker = '/fast/image/';
        const index = text.indexOf(marker);
        if (index < 0) {
            return '';
        }

        return text.slice(index + marker.length);
    }

    async function resolvePlayableVideoUrl(apiBase, rawVideoUrl, forceTranscode) {
        const pathValue = extractFastImagePath(rawVideoUrl);
        if (!pathValue) {
            return buildAbsoluteUrl(apiBase, rawVideoUrl);
        }

        const encodedPath = pathValue
            .split('/')
            .map(segment => encodeURIComponent(segment))
            .join('/');

        const transcodeParam = forceTranscode ? '?force_transcode=true' : '';
        const playableApiUrl = `${apiBase}/fast/video_playable/${encodedPath}${transcodeParam}`;
        const response = await fetch(playableApiUrl, {
            method: 'GET',
            cache: 'no-store',
        });
        if (!response.ok) {
            throw new Error(`재생 URL 조회 실패 (${response.status})`);
        }

        const body = await response.json();
        if (body && body.video_url) {
            return buildAbsoluteUrl(apiBase, body.video_url);
        }

        throw new Error('재생 URL 응답이 올바르지 않습니다.');

    }

    async function assignVideoSource(videoElement, sourceUrl, objectUrlKey) {
        const response = await fetch(sourceUrl, {
            method: 'GET',
            cache: 'no-store',
        });
        if (!response.ok) {
            throw new Error(`동영상 로드 실패 (${response.status})`);
        }

        const blob = await response.blob();
        if (!blob || blob.size <= 0) {
            throw new Error('동영상 데이터가 비어 있습니다.');
        }

        const newObjectUrl = URL.createObjectURL(blob);
        if (objectUrlKey === 'input') {
            if (inputObjectUrl) {
                URL.revokeObjectURL(inputObjectUrl);
            }
            inputObjectUrl = newObjectUrl;
        } else {
            if (outputObjectUrl) {
                URL.revokeObjectURL(outputObjectUrl);
            }
            outputObjectUrl = newObjectUrl;
        }

        videoElement.src = newObjectUrl;
        videoElement.load();

        await new Promise((resolve, reject) => {
            const cleanup = () => {
                videoElement.removeEventListener('loadeddata', onLoadedData);
                videoElement.removeEventListener('error', onError);
            };

            const onLoadedData = () => {
                cleanup();
                resolve();
            };

            const onError = () => {
                const mediaError = videoElement.error;
                const code = mediaError && mediaError.code ? mediaError.code : 'unknown';
                cleanup();
                reject(new Error(`동영상 디코딩 실패 (code: ${code})`));
            };

            videoElement.addEventListener('loadeddata', onLoadedData, { once: true });
            videoElement.addEventListener('error', onError, { once: true });
        });
    }

    async function autoPlayVideo(videoElement) {
        if (!videoElement) {
            return;
        }

        try {
            await videoElement.play();
            return;
        } catch (_firstError) {
            // Retry with muted=true for browsers that block autoplay with audio.
        }

        const previousMuted = Boolean(videoElement.muted);
        videoElement.muted = true;
        try {
            await videoElement.play();
        } catch (_secondError) {
            videoElement.muted = previousMuted;
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
        selectedServerFileName = '';
        syncInputWithFile(file);
        renderUploadedHistory();
            setStatus('동영상 파일이 준비되었습니다. 분할 시작을 눌러주세요.', 'secondary');
    }

    async function runSam2Segment() {
        if (detectButton.disabled) {
            return;
        }

        const fileFromInput = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        const file = selectedFile || fileFromInput;
        const targetType = getSelectedTargetType();
        const conf = toNumber(confInput ? confInput.value : 0.25, 0.25);
        if (!file && !selectedServerFileName) {
            setStatus('동영상 파일을 선택하세요.', 'warning');
            return;
        }

        detectButton.disabled = true;
        setStatus(`SAM2 분할 진행 중... (대상: ${targetTypeLabel(targetType)})`, 'info');

        try {
            const apiBase = await resolveApiBase();
            let response;

            if (file) {
                const formData = new FormData();
                formData.append('file', file);
                const url = `${apiBase}/fast/sam2/segment_video_upload?target_type=${encodeURIComponent(targetType)}&conf=${encodeURIComponent(conf)}`;
                response = await fetch(url, {
                    method: 'POST',
                    body: formData,
                });
            } else {
                const url = `${apiBase}/fast/sam2/segment_saved_video?file_name=${encodeURIComponent(selectedServerFileName)}&target_type=${encodeURIComponent(targetType)}&conf=${encodeURIComponent(conf)}`;
                response = await fetch(url, {
                    method: 'POST',
                });
            }

            if (!response.ok) {
                let errorMessage = `요청 실패 (${response.status})`;
                if (response.status === 504) {
                    errorMessage = '요청 실패 (504): 처리 시간이 초과되었습니다. 짧은 영상으로 시도하거나 서버를 재시작 후 다시 실행하세요.';
                }
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

            if (file) {
                const relativeServerPath = extractFastImagePath(result.input_url) || String(result.input_file || '').trim();
                const thumbnailSource = buildThumbnailUrl(apiBase, relativeServerPath);
                addUploadedHistoryItem(file.name, relativeServerPath, thumbnailSource);
                selectedServerFileName = String(relativeServerPath || selectedServerFileName);
                renderUploadedHistory();
            }

            const inputUrl = await resolvePlayableVideoUrl(apiBase, result.input_url, true);
            const outputUrl = await resolvePlayableVideoUrl(apiBase, result.output_url, true);

            await assignVideoSource(inputVideoElement, inputUrl, 'input');
            await assignVideoSource(outputVideoElement, outputUrl, 'output');

            applyLoopOption();

            await autoPlayVideo(inputVideoElement);
            await autoPlayVideo(outputVideoElement);

            const outputTabButton = document.getElementById('sam2-output-tab');
            if (outputTabButton) {
                if (window.bootstrap && typeof window.bootstrap.Tab === 'function') {
                    window.bootstrap.Tab.getOrCreateInstance(outputTabButton).show();
                } else {
                    outputTabButton.click();
                }
            }

            setStatus('분할 완료', 'success');
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
    });

    detectButton.addEventListener('click', runSam2Segment);
    if (confInput) {
        confInput.addEventListener('input', () => {
            updateConfValueLabel();
            saveUiOptions();
        });
    }
    document.querySelectorAll('input[name="sam2-target"]').forEach((input) => {
        input.addEventListener('change', () => {
            saveUiOptions();
        });
    });
    if (loopToggleInput) {
        loopToggleInput.addEventListener('change', applyLoopOption);
    }
    if (uploadedEmptyElement) {
        renderUploadedHistory();
    }

    applyLoopOption();
    loadUiOptions();
    updateConfValueLabel();

    loadUploadedHistoryFromServer();
})();
