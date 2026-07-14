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
    const pointClearButton = document.getElementById('sam2-point-clear');
    const positivePointListElement = document.getElementById('sam2-positive-points');
    const positivePointCountElement = document.getElementById('sam2-positive-count');
    const pointMarkerLayerElement = document.getElementById('sam2-point-marker-layer');
    const bboxEnabledInput = document.getElementById('sam2-bbox-enabled');
    const bboxClearButton = document.getElementById('sam2-bbox-clear');
    const bboxValueElement = document.getElementById('sam2-bbox-value');
    const bboxLayerElement = document.getElementById('sam2-bbox-layer');
    const bboxCaptureLayerElement = document.getElementById('sam2-bbox-capture-layer');

    const statusElement = document.getElementById('sam2-status');
    const inputVideoElement = document.getElementById('sam2-input-video');
    const outputVideoElement = document.getElementById('sam2-output-video');

    let selectedFile = null;
    let resolvedApiBase = null;
    let inputObjectUrl = '';
    let outputObjectUrl = '';
    let uploadedHistory = [];
    let selectedServerFileName = '';
    let positivePoints = [];
    let boundingBox = null;
    let bboxDraftStart = null;
    const MAX_POINT_COUNT = 20;
    const STORAGE_TARGET_KEY = 'sam2.targetType';
    const STORAGE_CONF_KEY = 'sam2.conf';
    const STORAGE_SELECTED_VIDEO_KEY = 'sam2.selectedVideo';

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

    function saveSelectedVideo(fileName) {
        try {
            const value = String(fileName || '').trim();
            if (value) {
                localStorage.setItem(STORAGE_SELECTED_VIDEO_KEY, value);
            } else {
                localStorage.removeItem(STORAGE_SELECTED_VIDEO_KEY);
            }
        } catch (_ignore) {
            // localStorage may be unavailable in some browser/privacy modes.
        }
    }

    function loadSelectedVideo() {
        try {
            return String(localStorage.getItem(STORAGE_SELECTED_VIDEO_KEY) || '').trim();
        } catch (_ignore) {
            return '';
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

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function formatPointLabel(point, index) {
        const x = toNumber(point && point.x, 0).toFixed(1);
        const y = toNumber(point && point.y, 0).toFixed(1);
        return `${index + 1}: (${x}%, ${y}%)`;
    }

    function renderPointList(targetElement, points, chipClassName) {
        if (!targetElement) {
            return;
        }

        targetElement.innerHTML = '';
        if (!Array.isArray(points) || points.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'small text-muted';
            empty.textContent = '없음';
            targetElement.appendChild(empty);
            return;
        }

        points.forEach((point, index) => {
            const chip = document.createElement('span');
            chip.className = `sam2-point-chip ${chipClassName}`;
            chip.textContent = formatPointLabel(point, index);
            targetElement.appendChild(chip);
        });
    }

    function renderPointMarkers() {
        if (!pointMarkerLayerElement) {
            return;
        }

        pointMarkerLayerElement.innerHTML = '';

        const appendMarker = (point, className) => {
            const marker = document.createElement('div');
            marker.className = `sam2-point-marker ${className}`;
            marker.style.left = `${toNumber(point && point.x, 0)}%`;
            marker.style.top = `${toNumber(point && point.y, 0)}%`;
            pointMarkerLayerElement.appendChild(marker);
        };

        positivePoints.forEach(point => appendMarker(point, 'sam2-point-marker-positive'));
    }

    function renderPointUi() {
        if (positivePointCountElement) {
            positivePointCountElement.textContent = String(positivePoints.length);
        }
        renderPointList(positivePointListElement, positivePoints, 'sam2-point-chip-positive');
        renderPointMarkers();
    }

    function clearAllPoints() {
        positivePoints = [];
        renderPointUi();
    }

    function addPointByClick(event) {
        const point = toRelativePoint(event);
        if (!point) {
            return;
        }

        if (positivePoints.length >= MAX_POINT_COUNT) {
            positivePoints.shift();
        }
        positivePoints.push(point);
        renderPointUi();
    }

    function toRelativePoint(event) {
        if (!inputVideoElement) {
            return null;
        }

        const rect = inputVideoElement.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            return null;
        }

        const relativeX = ((event.clientX - rect.left) / rect.width) * 100;
        const relativeY = ((event.clientY - rect.top) / rect.height) * 100;
        return {
            x: clamp(relativeX, 0, 100),
            y: clamp(relativeY, 0, 100),
        };
    }

    function formatBoundingBoxText(box) {
        if (!box) {
            return '없음';
        }

        return `x:${box.x.toFixed(1)}%, y:${box.y.toFixed(1)}%, w:${box.w.toFixed(1)}%, h:${box.h.toFixed(1)}%`;
    }

    function renderBoundingBoxUi() {
        if (bboxValueElement) {
            bboxValueElement.textContent = formatBoundingBoxText(boundingBox);
        }

        if (bboxCaptureLayerElement) {
            const enabled = Boolean(bboxEnabledInput && bboxEnabledInput.checked);
            bboxCaptureLayerElement.classList.toggle('active', enabled);
        }

        if (!bboxLayerElement) {
            return;
        }

        bboxLayerElement.innerHTML = '';
        if (!boundingBox) {
            return;
        }

        const rect = document.createElement('div');
        rect.className = 'sam2-bbox-rect';
        rect.style.left = `${boundingBox.x}%`;
        rect.style.top = `${boundingBox.y}%`;
        rect.style.width = `${boundingBox.w}%`;
        rect.style.height = `${boundingBox.h}%`;
        bboxLayerElement.appendChild(rect);
    }

    function clearBoundingBox() {
        boundingBox = null;
        bboxDraftStart = null;
        renderBoundingBoxUi();
    }

    function handleBoundingBoxCapture(event) {
        if (!bboxEnabledInput || !bboxEnabledInput.checked) {
            return;
        }

        if (!hasSelectedVideo()) {
            setStatus('먼저 동영상을 선택하세요.', 'warning');
            return;
        }

        const point = toRelativePoint(event);
        if (!point) {
            return;
        }

        if (!bboxDraftStart) {
            bboxDraftStart = point;
            setStatus('BBox 시작점이 설정되었습니다. 두 번째 클릭으로 종료점을 지정하세요.', 'secondary');
            return;
        }

        const x1 = Math.min(bboxDraftStart.x, point.x);
        const y1 = Math.min(bboxDraftStart.y, point.y);
        const x2 = Math.max(bboxDraftStart.x, point.x);
        const y2 = Math.max(bboxDraftStart.y, point.y);
        boundingBox = {
            x: x1,
            y: y1,
            w: Math.max(0.1, x2 - x1),
            h: Math.max(0.1, y2 - y1),
        };
        bboxDraftStart = null;
        renderBoundingBoxUi();
        setStatus('Bounding Box가 설정되었습니다.', 'secondary');
    }

    function buildBboxQuery() {
        if (!boundingBox) {
            return '';
        }

        const payload = {
            x: toNumber(boundingBox.x, 0),
            y: toNumber(boundingBox.y, 0),
            w: toNumber(boundingBox.w, 0),
            h: toNumber(boundingBox.h, 0),
        };
        return `&bbox=${encodeURIComponent(JSON.stringify(payload))}`;
    }

    function stopCurrentOutputPlayback() {
        try {
            outputVideoElement.pause();
        } catch (_ignore) {
            // Ignore pause failures from browser state.
        }

        try {
            outputVideoElement.currentTime = 0;
        } catch (_ignore) {
            // Ignore seek failures when metadata is unavailable.
        }

        outputVideoElement.removeAttribute('src');
        outputVideoElement.load();

        if (outputObjectUrl) {
            URL.revokeObjectURL(outputObjectUrl);
            outputObjectUrl = '';
        }
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
                saveSelectedVideo(selectedServerFileName);

                stopCurrentOutputPlayback();
                clearAllPoints();
                clearBoundingBox();

                renderUploadedHistory();
                setStatus(`선택됨: ${item.name} (분할 시작 버튼을 눌러 실행)`, 'secondary');
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

            const savedSelectedVideo = loadSelectedVideo();
            const matchedSelected = mapped.find((item) => item.serverFileName === savedSelectedVideo);
            if (matchedSelected) {
                selectedServerFileName = matchedSelected.serverFileName;
                selectedFile = null;
                if (fileInput) {
                    fileInput.value = '';
                }
                setStatus(`선택 복원됨: ${matchedSelected.name}`, 'secondary');
            } else if (savedSelectedVideo) {
                selectedServerFileName = '';
                saveSelectedVideo('');
            }

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
        saveSelectedVideo('');
        syncInputWithFile(file);
        stopCurrentOutputPlayback();
        clearAllPoints();
        clearBoundingBox();
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
        const bboxQuery = buildBboxQuery();
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
                const url = `${apiBase}/fast/sam2/segment_video_upload?target_type=${encodeURIComponent(targetType)}&conf=${encodeURIComponent(conf)}${bboxQuery}`;
                response = await fetch(url, {
                    method: 'POST',
                    body: formData,
                });
            } else {
                const url = `${apiBase}/fast/sam2/segment_saved_video?file_name=${encodeURIComponent(selectedServerFileName)}&target_type=${encodeURIComponent(targetType)}&conf=${encodeURIComponent(conf)}${bboxQuery}`;
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
                saveSelectedVideo(selectedServerFileName);
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
    if (pointClearButton) {
        pointClearButton.addEventListener('click', () => {
            clearAllPoints();
            setStatus('Point 설정을 초기화했습니다.', 'secondary');
        });
    }
    if (bboxEnabledInput) {
        bboxEnabledInput.addEventListener('change', () => {
            bboxDraftStart = null;
            renderBoundingBoxUi();
        });
    }
    if (bboxClearButton) {
        bboxClearButton.addEventListener('click', () => {
            clearBoundingBox();
            setStatus('Bounding Box를 초기화했습니다.', 'secondary');
        });
    }
    if (bboxCaptureLayerElement) {
        bboxCaptureLayerElement.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            handleBoundingBoxCapture(event);
        });
    }
    if (inputVideoElement) {
        inputVideoElement.addEventListener('click', (event) => {
            if (bboxEnabledInput && bboxEnabledInput.checked) {
                return;
            }
            if (!hasSelectedVideo()) {
                return;
            }
            addPointByClick(event);
        });
    }
    if (confInput) {
        confInput.addEventListener('input', () => {
            stopCurrentOutputPlayback();
            updateConfValueLabel();
            saveUiOptions();
        });
    }
    document.querySelectorAll('input[name="sam2-target"]').forEach((input) => {
        input.addEventListener('change', () => {
            stopCurrentOutputPlayback();
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
    renderPointUi();
    renderBoundingBoxUi();

    loadUploadedHistoryFromServer();
})();
