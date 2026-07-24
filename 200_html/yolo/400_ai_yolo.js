(function () {
    'use strict';

    const fileInput = document.getElementById('yolo-video-file');
    const dropZone = document.getElementById('yolo-drop-zone');
    const uploadButton = document.getElementById('yolo-upload-button');
    const selectedFileElement = document.getElementById('yolo-selected-file');
    const detectButton = document.getElementById('yolo-detect-btn');
    const confInput = document.getElementById('yolo-conf');
    const iouInput = document.getElementById('yolo-iou');
    const loopToggleInput = document.getElementById('yolo-loop-toggle');
    const confValueElement = document.getElementById('yolo-conf-value');
    const iouValueElement = document.getElementById('yolo-iou-value');
    const uploadedListElement = document.getElementById('yolo-uploaded-list');
    const uploadedEmptyElement = document.getElementById('yolo-uploaded-empty');
    const inputSourceTabButtons = Array.from(document.querySelectorAll('#yolo-input-source-tabs [data-bs-toggle="tab"]'));

    const statusElement = document.getElementById('yolo-status');
    const statusTextElement = document.getElementById('yolo-status-text');
    const uploadProgressWrapElement = document.getElementById('yolo-upload-progress-wrap');
    const uploadProgressBarElement = document.getElementById('yolo-upload-progress-bar');
    const inputVideoElement = document.getElementById('yolo-input-video');
    const outputVideoElement = document.getElementById('yolo-output-video');

    let selectedFile = null;
    let resolvedApiBase = null;
    let inputObjectUrl = '';
    let outputObjectUrl = '';
    let realtimeDetectTimer = null;
    let pendingRealtimeDetect = false;
    let uploadedHistory = [];
    let selectedServerFileName = '';

    const REALTIME_DETECT_DEBOUNCE_MS = 300;
    const INPUT_SOURCE_TAB_STORAGE_KEY = 'wcs.yolo.input_source_tab.v1';
    const STATUS_ALERT_VARIANTS = ['alert-secondary', 'alert-info', 'alert-warning', 'alert-danger', 'alert-success', 'alert-primary'];

    function setStatus(message, type) {
        const alertType = type || 'secondary';
        statusElement.classList.add('alert');
        statusElement.classList.remove(...STATUS_ALERT_VARIANTS);
        statusElement.classList.add(`alert-${alertType}`);

        if (statusTextElement) {
            statusTextElement.textContent = message;
        } else {
            statusElement.textContent = message;
        }
    }

    function setUploadProgress(percent, show) {
        if (!uploadProgressWrapElement || !uploadProgressBarElement) {
            return;
        }

        const numeric = Number.isFinite(Number(percent)) ? Number(percent) : 0;
        const bounded = Math.max(0, Math.min(100, Math.round(numeric)));

        uploadProgressBarElement.style.width = `${bounded}%`;
        uploadProgressBarElement.setAttribute('aria-valuenow', String(bounded));

        if (show) {
            uploadProgressWrapElement.classList.remove('d-none');
        } else {
            uploadProgressWrapElement.classList.add('d-none');
        }
    }

    async function uploadVideoWithProgress(apiBase, file) {
        const formData = new FormData();
        formData.append('file', file);

        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${apiBase}/fast/yolo/upload_video`, true);
            xhr.responseType = 'json';

            xhr.upload.onprogress = (event) => {
                if (!event.lengthComputable) {
                    return;
                }

                const percent = (event.loaded / event.total) * 100;
                setUploadProgress(percent, true);
                setStatus(`동영상 업로드 중... ${Math.round(percent)}%`, 'info');
            };

            xhr.onerror = () => {
                reject(new Error('업로드 네트워크 오류'));
            };

            xhr.onload = () => {
                const status = Number(xhr.status || 0);
                const ok = status >= 200 && status < 300;
                const responseJson = xhr.response && typeof xhr.response === 'object'
                    ? xhr.response
                    : (() => {
                        try {
                            return xhr.responseText ? JSON.parse(xhr.responseText) : {};
                        } catch (_ignore) {
                            return {};
                        }
                    })();

                if (!ok) {
                    const detail = responseJson && responseJson.detail ? String(responseJson.detail) : `업로드 실패 (${status})`;
                    reject(new Error(detail));
                    return;
                }

                resolve(responseJson || {});
            };

            xhr.send(formData);
        });
    }

    function toNumber(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function formatParamValue(value, fallback) {
        return toNumber(value, fallback).toFixed(2);
    }

    function saveInputSourceTab(tabTarget) {
        const normalizedTarget = String(tabTarget || '').trim();
        if (!normalizedTarget) {
            return;
        }

        try {
            window.localStorage.setItem(INPUT_SOURCE_TAB_STORAGE_KEY, normalizedTarget);
        } catch (_ignore) {
            // Ignore storage failures.
        }
    }

    function restoreInputSourceTab() {
        if (inputSourceTabButtons.length === 0) {
            return;
        }

        let savedTarget = '';
        try {
            savedTarget = String(window.localStorage.getItem(INPUT_SOURCE_TAB_STORAGE_KEY) || '').trim();
        } catch (_ignore) {
            savedTarget = '';
        }

        if (!savedTarget) {
            return;
        }

        const matchedButton = inputSourceTabButtons.find((button) => {
            return String(button.getAttribute('data-bs-target') || '').trim() === savedTarget;
        });

        if (!matchedButton) {
            return;
        }

        if (window.bootstrap && typeof window.bootstrap.Tab === 'function') {
            window.bootstrap.Tab.getOrCreateInstance(matchedButton).show();
            return;
        }

        matchedButton.click();
    }

    function showInputSourceTab(tabTarget) {
        const normalizedTarget = String(tabTarget || '').trim();
        if (!normalizedTarget || inputSourceTabButtons.length === 0) {
            return;
        }

        const matchedButton = inputSourceTabButtons.find((button) => {
            return String(button.getAttribute('data-bs-target') || '').trim() === normalizedTarget;
        });

        if (!matchedButton) {
            return;
        }

        if (window.bootstrap && typeof window.bootstrap.Tab === 'function') {
            window.bootstrap.Tab.getOrCreateInstance(matchedButton).show();
            return;
        }

        matchedButton.click();
    }

    function hasSelectedVideo() {
        const fileFromInput = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        return Boolean(selectedFile || fileFromInput || selectedServerFileName);
    }

    function updateSliderValueLabels() {
        if (confValueElement) {
            confValueElement.textContent = formatParamValue(confInput.value, 0.25);
        }
        if (iouValueElement) {
            iouValueElement.textContent = formatParamValue(iouInput.value, 0.45);
        }
    }

    function applyLoopOption() {
        const loopEnabled = Boolean(loopToggleInput && loopToggleInput.checked);
        inputVideoElement.loop = loopEnabled;
        outputVideoElement.loop = loopEnabled;
    }

    function scheduleRealtimeDetect() {
        updateSliderValueLabels();

        if (!hasSelectedVideo()) {
            return;
        }

        if (realtimeDetectTimer) {
            clearTimeout(realtimeDetectTimer);
        }

        realtimeDetectTimer = setTimeout(() => {
            realtimeDetectTimer = null;

            if (detectButton.disabled) {
                pendingRealtimeDetect = true;
                return;
            }

            runYoloDetect();
        }, REALTIME_DETECT_DEBOUNCE_MS);
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

        if (dropZone) {
            dropZone.classList.toggle('file-selected', Boolean(selectedFile));
        }

        if (!selectedFileElement) {
            if (uploadButton) {
                uploadButton.disabled = !selectedFile;
            }
            return;
        }

        if (selectedFile) {
            selectedFileElement.textContent = `선택됨: ${selectedFile.name}`;
        } else {
            selectedFileElement.textContent = '선택된 파일 없음';
        }

        if (uploadButton) {
            uploadButton.disabled = !selectedFile;
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
            emptyItem.id = 'yolo-uploaded-empty';
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
            row.className = 'yolo-uploaded-item';
            row.style.cursor = 'pointer';

            const thumb = document.createElement('img');
            thumb.className = 'yolo-uploaded-thumb';
            thumb.alt = item.name || 'thumbnail';
            const thumbnailSrc = item.thumbnailSource || item.thumbnailUrl;
            if (thumbnailSrc) {
                thumb.src = thumbnailSrc;
            } else {
                thumb.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="100%" height="100%" fill="%23e9ecef"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%236c757d" font-size="12">NO THUMB</text></svg>';
            }

            const meta = document.createElement('div');
            meta.className = 'yolo-uploaded-meta flex-grow-1';

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
                setSelectedFile(null);
                if (fileInput) {
                    fileInput.value = '';
                }

                renderUploadedHistory();
                setStatus(`선택됨: ${item.name}. 검출 시작을 눌러주세요.`, 'info');
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
            uploadedHistory.splice(duplicateIndex, 1);
        }
        uploadedHistory.unshift(record);
        if (uploadedHistory.length > 20) {
            uploadedHistory = uploadedHistory.slice(0, 20);
        }

        renderUploadedHistory();
    }

    async function loadUploadedHistoryFromServer() {
        try {
            const apiBase = await resolveApiBase();
            const response = await fetch(`${apiBase}/fast/yolo/uploaded_videos?limit=50`, {
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
                thumbnailSource: buildAbsoluteUrl(apiBase, item.thumbnail_url),
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
        setStatus('동영상 파일이 준비되었습니다. 동영상 업로드를 눌러주세요.', 'secondary');
    }

    async function uploadSelectedVideo() {
        if (uploadButton?.disabled) {
            return;
        }

        const fileFromInput = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        const file = selectedFile || fileFromInput;
        if (!file) {
            setStatus('업로드할 동영상 파일을 선택하세요.', 'warning');
            return;
        }

        uploadButton.disabled = true;
        setUploadProgress(0, true);
        setStatus('동영상 업로드 중...', 'info');

        try {
            const apiBase = await resolveApiBase();
            const result = await uploadVideoWithProgress(apiBase, file);
            setUploadProgress(100, true);
            addUploadedHistoryItem(
                result.display_name || file.name,
                result.file_name,
                buildAbsoluteUrl(apiBase, result.thumbnail_url)
            );
            selectedServerFileName = String(result.file_name || '');
            setSelectedFile(null);
            syncInputWithFile(null);
            renderUploadedHistory();
            showInputSourceTab('#yolo-uploaded-source-pane');
            setStatus('동영상 업로드 완료. 업로드 동영상 탭에서 선택되었습니다.', 'success');
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            setStatus(`오류: ${message}`, 'danger');
        } finally {
            setUploadProgress(0, false);
            if (uploadButton) {
                uploadButton.disabled = !selectedFile;
            }
        }
    }

    async function runYoloDetect() {
        if (detectButton.disabled) {
            return;
        }

        if (!selectedServerFileName) {
            if (selectedFile) {
                setStatus('선택한 파일은 아직 업로드되지 않았습니다. 먼저 동영상 업로드를 실행하세요.', 'warning');
            } else {
                setStatus('업로드 동영상을 선택하세요.', 'warning');
            }
            return;
        }

        const conf = toNumber(confInput.value, 0.25);
        const iou = toNumber(iouInput.value, 0.45);

        detectButton.disabled = true;
        setStatus('YOLO 검출 진행 중...', 'info');

        try {
            const apiBase = await resolveApiBase();
            const url = `${apiBase}/fast/yolo/detect_saved_video?file_name=${encodeURIComponent(selectedServerFileName)}&conf=${encodeURIComponent(conf)}&iou=${encodeURIComponent(iou)}`;
            const response = await fetch(url, {
                method: 'POST',
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

            const inputUrl = await resolvePlayableVideoUrl(apiBase, result.input_url, true);
            const outputUrl = await resolvePlayableVideoUrl(apiBase, result.output_url, true);

            await assignVideoSource(inputVideoElement, inputUrl, 'input');
            await assignVideoSource(outputVideoElement, outputUrl, 'output');

            applyLoopOption();

            await autoPlayVideo(inputVideoElement);
            await autoPlayVideo(outputVideoElement);

            const outputTabButton = document.getElementById('yolo-output-tab');
            if (outputTabButton) {
                if (window.bootstrap && typeof window.bootstrap.Tab === 'function') {
                    window.bootstrap.Tab.getOrCreateInstance(outputTabButton).show();
                } else {
                    outputTabButton.click();
                }
            }

            setStatus('검출 완료', 'success');
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            setStatus(`오류: ${message}`, 'danger');
        } finally {
            detectButton.disabled = false;

            if (pendingRealtimeDetect) {
                pendingRealtimeDetect = false;
                runYoloDetect();
            }
        }
    }

    fileInput.addEventListener('change', () => {
        const file = pickFirstVideoFile(fileInput.files);
        handleChosenFile(file);
    });

    dropZone.addEventListener('click', () => {
        fileInput.click();
    });

    if (uploadButton) {
        uploadButton.addEventListener('click', () => {
            if (uploadButton.disabled) {
                return;
            }

            uploadSelectedVideo();
        });
    }

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

    detectButton.addEventListener('click', runYoloDetect);
    confInput.addEventListener('input', scheduleRealtimeDetect);
    iouInput.addEventListener('input', scheduleRealtimeDetect);
    if (loopToggleInput) {
        loopToggleInput.addEventListener('change', applyLoopOption);
    }

    inputSourceTabButtons.forEach((button) => {
        button.addEventListener('shown.bs.tab', (event) => {
            const shownButton = event?.target || button;
            saveInputSourceTab(shownButton.getAttribute('data-bs-target'));
        });
    });

    updateSliderValueLabels();
    if (uploadedEmptyElement) {
        renderUploadedHistory();
    }

    applyLoopOption();
    restoreInputSourceTab();

    loadUploadedHistoryFromServer();
})();
