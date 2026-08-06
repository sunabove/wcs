(function () {
    'use strict';

    const fileInput = document.getElementById('sam2-video-file');
    const dropZone = document.getElementById('sam2-drop-zone');
    const selectedFileElement = document.getElementById('sam2-selected-file');
    const detectButton = document.getElementById('sam2-detect-btn');
    const loopToggleInput = document.getElementById('sam2-loop-toggle');
    const uploadedListElement = document.getElementById('sam2-uploaded-list');
    const uploadedEmptyElement = document.getElementById('sam2-uploaded-empty');
    const uploadedLoadingElement = document.getElementById('sam2-uploaded-loading');
    const uploadedLoadingTextElement = document.getElementById('sam2-uploaded-loading-text');
    const uploadedLoadingSpinnerElement = uploadedLoadingElement
        ? uploadedLoadingElement.querySelector('.spinner-border')
        : null;
    const uploadMaxSizeElement = document.getElementById('sam2-upload-max-size');
    const uploadProgressWrapElement = document.getElementById('sam2-upload-progress-wrap');
    const uploadProgressBarElement = document.getElementById('sam2-upload-progress-bar');
    const uploadProgressTextElement = document.getElementById('sam2-upload-progress-text');
    const pointModeButton = document.getElementById('sam2-point-mode');
    const bboxModeButton = document.getElementById('sam2-bbox-mode');
    const pointClearButton = document.getElementById('sam2-point-clear');
    const bboxClearButton = document.getElementById('sam2-bbox-clear');
    const optionsCancelButton = document.getElementById('sam2-options-cancel');
    const pointLabelCheckbox = document.getElementById('sam2-point-label');
    const pointLabelText = document.getElementById('sam2-point-label-text');
    const positivePointListElement = document.getElementById('sam2-positive-points');
    const positivePointCountElement = document.getElementById('sam2-positive-count');
    const pointMarkerLayerElement = document.getElementById('sam2-point-marker-layer');
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
    let highlightedServerFileName = '';
    let positivePoints = [];
    let boundingBox = null;
    let bboxDragStart = null;
    let bboxDragging = false;
    let bboxResizeHandle = '';
    let bboxResizeStartPoint = null;
    let bboxResizeStartBox = null;
    let detectionMode = 'point';
    let isUploadingImmediately = false;
    let uploadedListLoadingStartedAt = 0;
    let isUploadedListLoading = false;
    let uploadedListLoadingMessage = '동영상 목록을 불러오는 중...';
    let uploadedListRequestSeq = 0;
    let uploadedListLatestRequestSeq = 0;
    let uploadedListInFlightCount = 0;
    let hasCompletedInitialUploadedListLoad = false;
    const MAX_POINT_COUNT = 20;
    const STORAGE_SELECTED_VIDEO_KEY = 'sam2.selectedVideo';
    const STORAGE_INPUT_SOURCE_TAB_KEY = 'sam2.inputSourceTab';
    const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB
    let maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES;
    let maxUploadConfiguredValue = '1g';

    function setStatus(message, type) {
        const alertType = type || 'secondary';
        statusElement.className = `alert alert-${alertType}`;
        statusElement.textContent = message;
    }

    function formatBytes(bytes) {
        const value = Number(bytes);
        if (!Number.isFinite(value) || value <= 0) {
            return '0 B';
        }

        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = value;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex += 1;
        }

        const precision = unitIndex === 0 ? 0 : 1;
        return `${size.toFixed(precision)} ${units[unitIndex]}`;
    }

    function updateUploadLimitLabel(source) {
        if (!uploadMaxSizeElement) {
            return;
        }

        const configuredText = String(maxUploadConfiguredValue || '').trim();
        const sizeText = maxUploadBytes <= 0
            ? '제한 없음'
            : (configuredText || formatBytes(maxUploadBytes));
        uploadMaxSizeElement.textContent = `최대 업로드 용량: ${sizeText}`;
    }

    function setUploadProgress(percent, text) {
        const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
        if (uploadProgressWrapElement) {
            uploadProgressWrapElement.classList.remove('d-none');
        }
        if (uploadProgressBarElement) {
            uploadProgressBarElement.style.width = `${normalized}%`;
            uploadProgressBarElement.textContent = `${normalized}%`;
            uploadProgressBarElement.setAttribute('aria-valuenow', String(normalized));
        }
        if (uploadProgressTextElement && text) {
            uploadProgressTextElement.textContent = String(text);
        }
    }

    function hideUploadProgress() {
        if (uploadProgressWrapElement) {
            uploadProgressWrapElement.classList.add('d-none');
        }
        if (uploadProgressBarElement) {
            uploadProgressBarElement.style.width = '0%';
            uploadProgressBarElement.textContent = '0%';
            uploadProgressBarElement.setAttribute('aria-valuenow', '0');
        }
        if (uploadProgressTextElement) {
            uploadProgressTextElement.textContent = '업로드 준비 중...';
        }
    }

    function uploadVideoWithProgress(apiBase, file) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${apiBase}/fast/sam2/upload_video`, true);
            xhr.timeout = 10 * 60 * 1000;

            xhr.addEventListener('loadstart', () => {
                setUploadProgress(0, '업로드 시작...');
            });

            xhr.upload.addEventListener('progress', (event) => {
                if (event && event.lengthComputable && event.total > 0) {
                    const percent = Math.round((event.loaded / event.total) * 100);
                    setUploadProgress(percent, `업로드 중... ${percent}% (${formatBytes(event.loaded)} / ${formatBytes(event.total)})`);
                } else {
                    setUploadProgress(0, '업로드 중...');
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const body = JSON.parse(xhr.responseText || '{}');
                        setUploadProgress(100, '업로드 완료');
                        resolve(body);
                    } catch (_ignore) {
                        reject(new Error('업로드 응답 파싱 실패'));
                    }
                    return;
                }

                let errorMessage = `업로드 실패 (${xhr.status})`;
                try {
                    const body = JSON.parse(xhr.responseText || '{}');
                    if (body && body.detail) {
                        errorMessage = String(body.detail);
                    }
                } catch (_ignore) {
                    // Keep default error message.
                }
                reject(new Error(errorMessage));
            });

            xhr.addEventListener('error', () => {
                reject(new Error('업로드 중 네트워크 오류가 발생했습니다.'));
            });

            xhr.addEventListener('timeout', () => {
                reject(new Error('업로드 시간이 초과되었습니다.'));
            });

            xhr.addEventListener('abort', () => {
                reject(new Error('업로드가 취소되었습니다.'));
            });

            const formData = new FormData();
            formData.append('file', file);
            xhr.send(formData);
        });
    }

    async function loadUploadLimitFromServer() {
        try {
            const apiBase = await resolveApiBase();
            const response = await fetch(`${apiBase}/fast/sam2/upload_limit`, {
                method: 'GET',
                cache: 'no-store',
            });
            if (!response.ok) {
                updateUploadLimitLabel('default');
                return;
            }

            const body = await response.json();
            const candidate = Number(body && body.max_upload_bytes);
            if (Number.isFinite(candidate) && candidate >= 0) {
                maxUploadBytes = candidate;
            }

            const configuredValue = String((body && body.configured_value) || '').trim();
            if (configuredValue) {
                maxUploadConfiguredValue = configuredValue;
            }

            const source = String((body && body.source) || 'default').toLowerCase();
            updateUploadLimitLabel(source);
        } catch (_ignore) {
            updateUploadLimitLabel('default');
        }
    }

    function toNumber(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function hasSelectedVideo() {
        const fileFromInput = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        return Boolean(selectedFile || fileFromInput || selectedServerFileName);
    }

    function updatePointLabelText() {
        if (pointLabelText) {
            pointLabelText.textContent = pointLabelCheckbox && pointLabelCheckbox.checked
                ? 'Positive'
                : 'Negative';
        }
    }

    function updateDetectionControlState() {
        const enabled = hasSelectedVideo();
        [pointModeButton, bboxModeButton, pointClearButton, bboxClearButton, optionsCancelButton, pointLabelCheckbox].forEach((control) => {
            if (control) {
                control.disabled = !enabled;
            }
        });
        if (bboxCaptureLayerElement) {
            bboxCaptureLayerElement.style.pointerEvents = enabled ? 'auto' : 'none';
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

    async function loadVideoOptions(fileName) {
        const value = String(fileName || '').trim();
        if (!value) {
            return false;
        }

        try {
            const apiBase = await resolveApiBase();
            const response = await fetch(`${apiBase}/fast/sam2/video_options?file_name=${encodeURIComponent(value)}`);
            if (!response.ok) {
                return false;
            }

            const options = await response.json();
            if (!options || options.exists !== true) {
                return false;
            }

            const points = Array.isArray(options.points) ? options.points : [];
            const labels = Array.isArray(options.point_labels) ? options.point_labels : [];
            positivePoints = points.slice(0, MAX_POINT_COUNT).map((point, index) => ({
                x: clamp(toNumber(point && point.x, 0), 0, 100),
                y: clamp(toNumber(point && point.y, 0), 0, 100),
                label: Number(labels[index]) === 0 ? 0 : 1,
            }));

            const savedBox = options.bbox;
            if (savedBox && typeof savedBox === 'object') {
                boundingBox = {
                    x: clamp(toNumber(savedBox.x, 0), 0, 100),
                    y: clamp(toNumber(savedBox.y, 0), 0, 100),
                    w: clamp(toNumber(savedBox.w, 100), 0, 100),
                    h: clamp(toNumber(savedBox.h, 100), 0, 100),
                };
            } else {
                boundingBox = createFullBoundingBox();
            }

            if (pointLabelCheckbox) {
                const lastPoint = positivePoints[positivePoints.length - 1];
                pointLabelCheckbox.checked = !lastPoint || lastPoint.label === 1;
                updatePointLabelText();
            }
            renderPointUi();
            renderBoundingBoxUi();
            return true;
        } catch (_ignore) {
            return false;
        }
    }

    function showInputSourceTab(tabId, persist) {
        const tabButton = document.getElementById(tabId);
        if (!tabButton) {
            return;
        }

        if (window.bootstrap && typeof window.bootstrap.Tab === 'function') {
            window.bootstrap.Tab.getOrCreateInstance(tabButton).show();
        } else {
            tabButton.click();
        }

        if (persist !== false) {
            try {
                localStorage.setItem(STORAGE_INPUT_SOURCE_TAB_KEY, tabId);
            } catch (_ignore) {
                // Keep the current tab when localStorage is unavailable.
            }
        }
    }

    function loadInputSourceTab() {
        let tabId = 'sam2-file-source-tab';
        try {
            const storedTabId = String(localStorage.getItem(STORAGE_INPUT_SOURCE_TAB_KEY) || '').trim();
            if (storedTabId === 'sam2-file-source-tab' || storedTabId === 'sam2-uploaded-source-tab') {
                tabId = storedTabId;
            }
        } catch (_ignore) {
            // Keep the file input tab as the default.
        }
        showInputSourceTab(tabId, false);
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
        const label = Number(point && point.label) === 0 ? 'Negative' : 'Positive';
        return `${index + 1}: ${label} (${x}%, ${y}%)`;
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

        positivePoints.forEach(point => {
            const markerClass = Number(point && point.label) === 0
                ? 'sam2-point-marker-negative'
                : 'sam2-point-marker-positive';
            appendMarker(point, markerClass);
        });
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

    function findNearestPointIndex(point) {
        if (!Array.isArray(positivePoints) || positivePoints.length === 0) {
            return -1;
        }

        let nearestIndex = 0;
        let nearestDistSq = Number.POSITIVE_INFINITY;
        positivePoints.forEach((candidate, index) => {
            const dx = toNumber(candidate && candidate.x, 0) - point.x;
            const dy = toNumber(candidate && candidate.y, 0) - point.y;
            const distSq = (dx * dx) + (dy * dy);
            if (distSq < nearestDistSq) {
                nearestDistSq = distSq;
                nearestIndex = index;
            }
        });

        return nearestIndex;
    }

    function addPointByClick(event) {
        if (!hasSelectedVideo()) {
            setStatus('먼저 동영상을 선택하세요.', 'warning');
            return;
        }
        const point = toRelativePoint(event);
        if (!point) {
            return;
        }
        point.label = pointLabelCheckbox && pointLabelCheckbox.checked ? 1 : 0;

        if (event && event.ctrlKey) {
            if (positivePoints.length >= MAX_POINT_COUNT) {
                positivePoints.shift();
            }
            positivePoints.push(point);
            renderPointUi();
            setStatus('Positive Point가 추가되었습니다. (Ctrl+클릭)', 'secondary');
            return;
        }

        if (positivePoints.length === 0) {
            positivePoints.push(point);
            renderPointUi();
            setStatus('Positive Point가 추가되었습니다.', 'secondary');
            return;
        }

        const nearestIndex = findNearestPointIndex(point);
        if (nearestIndex >= 0) {
            positivePoints[nearestIndex] = point;
        }
        renderPointUi();
        setStatus('가장 가까운 Positive Point 위치를 수정했습니다.', 'secondary');
    }

    function toRelativePoint(event) {
        if (!inputVideoElement) {
            return null;
        }

        const rect = bboxCaptureLayerElement
            ? bboxCaptureLayerElement.getBoundingClientRect()
            : inputVideoElement.getBoundingClientRect();
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

    function createFullBoundingBox() {
        return {
            x: 0,
            y: 0,
            w: 100,
            h: 100,
        };
    }

    function ensureDefaultBoundingBox() {
        if (!hasSelectedVideo()) {
            return;
        }
        if (boundingBox) {
            return;
        }
        boundingBox = createFullBoundingBox();
    }

    function updateBoundingBoxFromPoints(startPoint, endPoint) {
        if (!startPoint || !endPoint) {
            return;
        }

        const x1 = Math.min(startPoint.x, endPoint.x);
        const y1 = Math.min(startPoint.y, endPoint.y);
        const x2 = Math.max(startPoint.x, endPoint.x);
        const y2 = Math.max(startPoint.y, endPoint.y);
        boundingBox = {
            x: x1,
            y: y1,
            w: Math.max(0.1, x2 - x1),
            h: Math.max(0.1, y2 - y1),
        };
    }

    function renderBboxControlPoints() {
        if (!bboxCaptureLayerElement) {
            return;
        }

        bboxCaptureLayerElement.querySelectorAll('.sam2-bbox-control-point').forEach((node) => {
            node.remove();
        });

        if (!boundingBox) {
            return;
        }

        const left = toNumber(boundingBox.x, 0);
        const top = toNumber(boundingBox.y, 0);
        const width = toNumber(boundingBox.w, 0);
        const height = toNumber(boundingBox.h, 0);
        const layerRect = bboxCaptureLayerElement.getBoundingClientRect();
        const controlInsetX = layerRect.width > 0 ? (14 / layerRect.width) * 100 : 1.5;
        const controlInsetY = layerRect.height > 0 ? (14 / layerRect.height) * 100 : 1.5;
        const insetX = Math.min(width / 2, Math.max(0.05, controlInsetX));
        const insetY = Math.min(height / 2, Math.max(0.05, controlInsetY));
        const handles = [
            { key: 'nw', x: left + insetX, y: top + insetY },
            { key: 'ne', x: left + width - insetX, y: top + insetY },
            { key: 'sw', x: left + insetX, y: top + height - insetY },
            { key: 'se', x: left + width - insetX, y: top + height - insetY },
        ];

        handles.forEach((handle) => {
            const controlPoint = document.createElement('div');
            controlPoint.className = `sam2-bbox-control-point sam2-bbox-control-point-${handle.key}`;
            controlPoint.style.left = `${clamp(handle.x, 0, 100)}%`;
            controlPoint.style.top = `${clamp(handle.y, 0, 100)}%`;
            controlPoint.dataset.handle = handle.key;
            controlPoint.addEventListener('mousedown', (event) => {
                event.preventDefault();
                event.stopPropagation();
                startBboxResize(handle.key, event);
            });
            bboxCaptureLayerElement.appendChild(controlPoint);
        });
    }

    function resizeBoundingBoxFromHandle(handleKey, currentPoint) {
        if (!bboxResizeStartBox || !bboxResizeStartPoint || !currentPoint) {
            return;
        }

        let left = toNumber(bboxResizeStartBox.x, 0);
        let top = toNumber(bboxResizeStartBox.y, 0);
        let right = left + toNumber(bboxResizeStartBox.w, 0);
        let bottom = top + toNumber(bboxResizeStartBox.h, 0);
        const dx = currentPoint.x - bboxResizeStartPoint.x;
        const dy = currentPoint.y - bboxResizeStartPoint.y;

        if (handleKey.includes('w')) {
            left = clamp(left + dx, 0, right - 0.1);
        }
        if (handleKey.includes('e')) {
            right = clamp(right + dx, left + 0.1, 100);
        }
        if (handleKey.includes('n')) {
            top = clamp(top + dy, 0, bottom - 0.1);
        }
        if (handleKey.includes('s')) {
            bottom = clamp(bottom + dy, top + 0.1, 100);
        }

        boundingBox = {
            x: left,
            y: top,
            w: Math.max(0.1, right - left),
            h: Math.max(0.1, bottom - top),
        };
    }

    function handleBboxResizeMove(event) {
        if (!bboxResizeHandle) {
            return;
        }

        const point = toRelativePoint(event);
        if (!point) {
            return;
        }

        resizeBoundingBoxFromHandle(bboxResizeHandle, point);
        renderBoundingBoxUi();
    }

    function handleBboxResizeEnd() {
        if (!bboxResizeHandle) {
            return;
        }

        bboxResizeHandle = '';
        bboxResizeStartPoint = null;
        bboxResizeStartBox = null;
        document.removeEventListener('mousemove', handleBboxResizeMove);
        document.removeEventListener('mouseup', handleBboxResizeEnd);
        setStatus('Bounding Box control point로 수정되었습니다.', 'secondary');
    }

    function startBboxResize(handleKey, event) {
        if (detectionMode !== 'bbox' || !boundingBox) {
            return;
        }

        const point = {
            x: handleKey.includes('e')
                ? boundingBox.x + boundingBox.w
                : boundingBox.x,
            y: handleKey.includes('s')
                ? boundingBox.y + boundingBox.h
                : boundingBox.y,
        };

        bboxDragging = false;
        bboxDragStart = null;
        bboxResizeHandle = String(handleKey || '').toLowerCase();
        bboxResizeStartPoint = point;
        bboxResizeStartBox = {
            x: toNumber(boundingBox.x, 0),
            y: toNumber(boundingBox.y, 0),
            w: toNumber(boundingBox.w, 100),
            h: toNumber(boundingBox.h, 100),
        };

        document.addEventListener('mousemove', handleBboxResizeMove);
        document.addEventListener('mouseup', handleBboxResizeEnd);
    }

    function renderBoundingBoxUi() {
        ensureDefaultBoundingBox();

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
        renderBboxControlPoints();
    }

    function clearBoundingBox() {
        bboxDragging = false;
        bboxDragStart = null;
        boundingBox = createFullBoundingBox();
        renderBoundingBoxUi();
    }

    function handleBoundingBoxDragStart(event) {
        if (detectionMode !== 'bbox') {
            return;
        }
        if (bboxResizeHandle) {
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

        bboxDragging = true;
        bboxDragStart = point;
        updateBoundingBoxFromPoints(point, point);
        renderBoundingBoxUi();
    }

    function handleBoundingBoxDragMove(event) {
        if (!bboxDragging || !bboxDragStart) {
            return;
        }
        if (bboxResizeHandle) {
            return;
        }

        const point = toRelativePoint(event);
        if (!point) {
            return;
        }

        updateBoundingBoxFromPoints(bboxDragStart, point);
        renderBoundingBoxUi();
    }

    function handleBoundingBoxDragEnd(event) {
        if (!bboxDragging || !bboxDragStart) {
            return;
        }
        if (bboxResizeHandle) {
            return;
        }

        const point = toRelativePoint(event);
        if (point) {
            updateBoundingBoxFromPoints(bboxDragStart, point);
        }

        bboxDragging = false;
        bboxDragStart = null;
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

    function buildPointsQuery() {
        const points = Array.isArray(positivePoints)
            ? positivePoints.map((point) => ({
                x: toNumber(point && point.x, 0),
                y: toNumber(point && point.y, 0),
            }))
            : [];
        return `&points=${encodeURIComponent(JSON.stringify(points))}`;
    }

    function buildPointLabelsQuery() {
        const labels = Array.isArray(positivePoints)
            ? positivePoints.map((point) => Number(point && point.label) === 0 ? 0 : 1)
            : [];
        return `&point_labels=${encodeURIComponent(JSON.stringify(labels))}`;
    }

    async function previewSelectedVideoFirstFrame(showInputTab) {
        if (!selectedServerFileName) {
            return;
        }

        const apiBase = await resolveApiBase();
        const inputPathUrl = `/fast/image/${selectedServerFileName}`;
        const inputUrl = await resolvePlayableVideoUrl(apiBase, inputPathUrl, true);
        await assignVideoSource(inputVideoElement, inputUrl, 'input');
        inputVideoElement.pause();
        inputVideoElement.currentTime = 0;
        ensureDefaultBoundingBox();
        renderBoundingBoxUi();

        if (!showInputTab) {
            return;
        }

        const inputTabButton = document.getElementById('sam2-input-tab');
        if (inputTabButton) {
            if (window.bootstrap && typeof window.bootstrap.Tab === 'function') {
                window.bootstrap.Tab.getOrCreateInstance(inputTabButton).show();
            } else {
                inputTabButton.click();
            }
        }
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
        updateDetectionControlState();
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
            if (isUploadedListLoading) {
                return;
            }
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

            if (item.serverFileName && item.serverFileName === highlightedServerFileName) {
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

            row.addEventListener('click', async () => {
                if (!item.serverFileName) {
                    return;
                }

                showInputSourceTab('sam2-uploaded-source-tab');

                selectedServerFileName = item.serverFileName;
                highlightedServerFileName = item.serverFileName;
                selectedFile = null;
                if (fileInput) {
                    fileInput.value = '';
                }
                saveSelectedVideo(selectedServerFileName);
                updateDetectionControlState();

                stopCurrentOutputPlayback();
                clearAllPoints();
                clearBoundingBox();

                try {
                    await previewSelectedVideoFirstFrame(true);
                } catch (_ignore) {
                    // Keep selection behavior even when preview loading fails.
                }

                await loadVideoOptions(selectedServerFileName);

                renderUploadedHistory();
                setStatus(`선택됨: ${item.name} (분할 시작 버튼을 눌러 실행)`, 'secondary');
            });

            uploadedListElement.appendChild(li);
        }
    }

    function setUploadedListLoading(isLoading, message) {
        if (!uploadedLoadingElement) {
            // Continue to list placeholder handling below even when header text is absent.
        }

        isUploadedListLoading = Boolean(isLoading);
        uploadedListLoadingMessage = String(message || uploadedListLoadingMessage || '동영상 목록을 불러오는 중...');

        if (uploadedLoadingElement) {
            if (isLoading) {
                uploadedLoadingElement.classList.remove('text-success');
                uploadedLoadingElement.classList.add('text-primary');
                if (uploadedLoadingSpinnerElement) {
                    uploadedLoadingSpinnerElement.classList.remove('d-none');
                }
                if (uploadedLoadingTextElement) {
                    uploadedLoadingTextElement.textContent = uploadedListLoadingMessage;
                }
                uploadedLoadingElement.classList.remove('d-none');
            } else {
                uploadedLoadingElement.classList.add('d-none');
                uploadedLoadingElement.classList.remove('text-success');
                uploadedLoadingElement.classList.add('text-primary');
                if (uploadedLoadingSpinnerElement) {
                    uploadedLoadingSpinnerElement.classList.remove('d-none');
                }
            }
        }

        if (uploadedListElement) {
            uploadedListElement.style.opacity = isLoading ? '0.65' : '1';
        }

        if (!uploadedListElement) {
            return;
        }

        if (isLoading) {
            if (!uploadedListLoadingStartedAt) {
                uploadedListLoadingStartedAt = Date.now();
            }
            return;
        }

        uploadedListLoadingStartedAt = 0;
    }

    async function finishUploadedListLoading(doneMessage) {
        uploadedListInFlightCount = Math.max(0, uploadedListInFlightCount - 1);
        if (uploadedListInFlightCount > 0) {
            return;
        }

        const elapsed = Date.now() - uploadedListLoadingStartedAt;
        const minVisibleMs = hasCompletedInitialUploadedListLoad ? 450 : 2200;
        if (elapsed < minVisibleMs) {
            await new Promise((resolve) => {
                setTimeout(resolve, minVisibleMs - elapsed);
            });
        }
        hasCompletedInitialUploadedListLoad = true;

        const completionText = String(doneMessage || '').trim();
        if (completionText && uploadedLoadingElement && uploadedLoadingTextElement) {
            uploadedLoadingElement.classList.remove('text-primary');
            uploadedLoadingElement.classList.add('text-success');
            if (uploadedLoadingSpinnerElement) {
                uploadedLoadingSpinnerElement.classList.add('d-none');
            }
            uploadedLoadingTextElement.textContent = completionText;
            await new Promise((resolve) => {
                setTimeout(resolve, 1200);
            });
        }

        setUploadedListLoading(false);
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
        const requestSeq = ++uploadedListRequestSeq;
        uploadedListLatestRequestSeq = requestSeq;
        uploadedListInFlightCount += 1;
        let doneMessage = '';
        setUploadedListLoading(true, '동영상 목록을 불러오는 중...');
        setStatus('업로드 목록을 가져오는 중...', 'info');
        try {
            let apiBase = '';
            let response = await fetch(`/fast/sam2/uploaded_videos?limit=500`, {
                method: 'GET',
                cache: 'no-store',
            });

            if (!response.ok) {
                apiBase = await resolveApiBase();
                response = await fetch(`${apiBase}/fast/sam2/uploaded_videos?limit=500`, {
                    method: 'GET',
                    cache: 'no-store',
                });
            }

            if (!response.ok) {
                if (requestSeq === uploadedListLatestRequestSeq) {
                    setStatus(`업로드 목록 조회 실패 (${response.status})`, 'warning');
                }
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

            if (requestSeq !== uploadedListLatestRequestSeq) {
                return;
            }

            uploadedHistory = mapped;

            // Keep active selection and visual highlight independent.
            if (selectedServerFileName) {
                highlightedServerFileName = selectedServerFileName;
            }

            renderUploadedHistory();
            doneMessage = `동영상 목록 ${mapped.length}건 불러오기 완료`;

            const savedSelectedVideo = loadSelectedVideo();
            const matchedSelected = mapped.find((item) => item.serverFileName === savedSelectedVideo);
            if (matchedSelected) {
                if (!selectedServerFileName) {
                    showInputSourceTab('sam2-uploaded-source-tab');
                    selectedServerFileName = matchedSelected.serverFileName;
                    highlightedServerFileName = matchedSelected.serverFileName;
                    selectedFile = null;
                    if (fileInput) {
                        fileInput.value = '';
                    }
                    updateDetectionControlState();
                    clearAllPoints();
                    clearBoundingBox();
                    try {
                        await previewSelectedVideoFirstFrame(true);
                    } catch (_ignore) {
                        // Keep the selected video even when preview loading fails.
                    }
                    await loadVideoOptions(selectedServerFileName);
                    renderUploadedHistory();
                    setStatus(`이전 선택 복원: ${matchedSelected.name}`, 'secondary');
                }
            } else if (savedSelectedVideo) {
                if (!selectedServerFileName) {
                    highlightedServerFileName = '';
                }
                saveSelectedVideo('');
                setStatus(`업로드 목록 ${mapped.length}건을 불러왔습니다.`, 'secondary');
            } else {
                setStatus(`업로드 목록 ${mapped.length}건을 불러왔습니다.`, 'secondary');
            }
        } catch (_ignore) {
            if (requestSeq === uploadedListLatestRequestSeq) {
                setStatus('업로드 목록을 불러오지 못했습니다. API 연결 상태를 확인하세요.', 'warning');
            }
        } finally {
            await finishUploadedListLoading(doneMessage);
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

    async function handleChosenFile(file) {
        if (!file) {
            setSelectedFile(null);
            return;
        }

        if (!isVideoFile(file)) {
            setStatus('동영상 파일만 업로드할 수 있습니다.', 'warning');
            return;
        }

        if (maxUploadBytes > 0 && Number(file.size || 0) > maxUploadBytes) {
            setSelectedFile(null);
            syncInputWithFile(null);
            const maxText = formatBytes(maxUploadBytes);
            setStatus(`파일 용량이 너무 큽니다. 최대 업로드 용량은 ${maxText} 입니다.`, 'warning');
            return;
        }

        setSelectedFile(file);
        showInputSourceTab('sam2-file-source-tab');
        selectedServerFileName = '';
        highlightedServerFileName = '';
        saveSelectedVideo('');
        syncInputWithFile(file);
        stopCurrentOutputPlayback();
        clearAllPoints();
        clearBoundingBox();
        renderUploadedHistory();

        if (isUploadingImmediately) {
            setStatus('다른 동영상 업로드가 진행 중입니다. 잠시 후 다시 시도하세요.', 'warning');
            return;
        }

        isUploadingImmediately = true;
        setStatus('동영상 업로드 중...', 'info');
        setUploadProgress(0, '업로드 시작...');
        let uploadCompleted = false;

        try {
            const apiBase = await resolveApiBase();
            const uploadResult = await uploadVideoWithProgress(apiBase, file);
            const uploadedPath = extractFastImagePath(uploadResult.input_url) || String(uploadResult.file_name || '').trim();
            selectedFile = null;
            if (fileInput) {
                fileInput.value = '';
            }
            selectedServerFileName = uploadedPath;
            highlightedServerFileName = uploadedPath;
            saveSelectedVideo(selectedServerFileName);
            updateDetectionControlState();

            await loadUploadedHistoryFromServer();
            try {
                await previewSelectedVideoFirstFrame(false);
            } catch (_ignore) {
                // Keep successful upload flow even if preview fails.
            }
            await loadVideoOptions(selectedServerFileName);

            uploadCompleted = true;
            setStatus('동영상 업로드 완료. 분할 시작 버튼을 눌러주세요.', 'success');
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            // Fallback: keep selected file so segment_video_upload can still upload+segment.
            if (uploadProgressTextElement) {
                uploadProgressTextElement.textContent = `업로드 실패: ${message}`;
            }
            if (uploadProgressBarElement) {
                uploadProgressBarElement.style.width = '100%';
                uploadProgressBarElement.textContent = '실패';
                uploadProgressBarElement.setAttribute('aria-valuenow', '100');
                uploadProgressBarElement.classList.remove('progress-bar-animated');
                uploadProgressBarElement.classList.remove('progress-bar-striped');
                uploadProgressBarElement.classList.add('bg-danger');
            }
            setStatus(`업로드 오류: ${message} (분할 시작 시 업로드 재시도)`, 'danger');
        } finally {
            isUploadingImmediately = false;
            if (uploadCompleted) {
                if (uploadProgressBarElement) {
                    uploadProgressBarElement.classList.add('progress-bar-animated');
                    uploadProgressBarElement.classList.add('progress-bar-striped');
                    uploadProgressBarElement.classList.remove('bg-danger');
                }
                setTimeout(() => {
                    if (!isUploadingImmediately) {
                        hideUploadProgress();
                    }
                }, 1800);
            }
        }
    }

    async function runSam2Segment() {
        if (detectButton.disabled) {
            return;
        }

        const fileFromInput = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        const file = selectedFile || fileFromInput;
        ensureDefaultBoundingBox();
        const bboxQuery = buildBboxQuery();
        const pointsQuery = buildPointsQuery();
        const pointLabelsQuery = buildPointLabelsQuery();

        if (!file && !selectedServerFileName && highlightedServerFileName) {
            const highlightedExists = uploadedHistory.some((item) => item.serverFileName === highlightedServerFileName);
            if (highlightedExists) {
                selectedServerFileName = highlightedServerFileName;
                saveSelectedVideo(selectedServerFileName);
                setStatus('하이라이트된 동영상을 자동 선택하여 분할을 시작합니다.', 'secondary');
            }
        }

        if (!file && !selectedServerFileName) {
            setStatus('동영상 파일을 선택하세요.', 'warning');
            return;
        }

        detectButton.disabled = true;
        setStatus('SAM2 분할 진행 중...', 'info');

        const outputTabButton = document.getElementById('sam2-output-tab');
        if (outputTabButton) {
            if (window.bootstrap && typeof window.bootstrap.Tab === 'function') {
                window.bootstrap.Tab.getOrCreateInstance(outputTabButton).show();
            } else {
                outputTabButton.click();
            }
        }

        try {
            const apiBase = await resolveApiBase();
            let response;

            if (file) {
                const formData = new FormData();
                formData.append('file', file);
                const url = `${apiBase}/fast/sam2/segment_video_upload?${bboxQuery.slice(1)}${pointsQuery}${pointLabelsQuery}`;
                response = await fetch(url, {
                    method: 'POST',
                    body: formData,
                });
            } else {
                const url = `${apiBase}/fast/sam2/segment_saved_video?file_name=${encodeURIComponent(selectedServerFileName)}${bboxQuery}${pointsQuery}${pointLabelsQuery}`;
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
                selectedServerFileName = String(relativeServerPath || selectedServerFileName);
                highlightedServerFileName = selectedServerFileName;
                saveSelectedVideo(selectedServerFileName);
                await loadUploadedHistoryFromServer();
            }

            const inputUrl = await resolvePlayableVideoUrl(apiBase, result.input_url, true);
            const outputUrl = await resolvePlayableVideoUrl(apiBase, result.output_url, true);

            await assignVideoSource(inputVideoElement, inputUrl, 'input');
            await assignVideoSource(outputVideoElement, outputUrl, 'output');

            applyLoopOption();

            setStatus('분할 완료', 'success');
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            if (file) {
                try {
                    const apiBase = await resolveApiBase();
                    const fallbackFormData = new FormData();
                    fallbackFormData.append('file', file);
                    const uploadResponse = await fetch(`${apiBase}/fast/sam2/upload_video`, {
                        method: 'POST',
                        body: fallbackFormData,
                    });

                    if (uploadResponse.ok) {
                        const uploadResult = await uploadResponse.json();
                        const uploadedPath = extractFastImagePath(uploadResult.input_url) || String(uploadResult.file_name || '').trim();
                        if (uploadedPath) {
                            selectedServerFileName = uploadedPath;
                            highlightedServerFileName = uploadedPath;
                            saveSelectedVideo(selectedServerFileName);
                        }
                    }

                    await loadUploadedHistoryFromServer();
                } catch (_ignore) {
                    // Keep original error message when history refresh fails.
                }
            }
            setStatus(`오류: ${message}`, 'danger');
        } finally {
            detectButton.disabled = false;
        }
    }

    fileInput.addEventListener('change', () => {
        const file = pickFirstVideoFile(fileInput.files);
        void handleChosenFile(file);
    });

    document.querySelectorAll('#sam2-input-source-tabs [data-bs-toggle="tab"]').forEach((tabButton) => {
        tabButton.addEventListener('shown.bs.tab', (event) => {
            const tabId = event.target && event.target.id;
            if (tabId) {
                try {
                    localStorage.setItem(STORAGE_INPUT_SOURCE_TAB_KEY, tabId);
                } catch (_ignore) {
                    // Keep the current tab when localStorage is unavailable.
                }
            }
        });
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

        void handleChosenFile(file);
    });

    detectButton.addEventListener('click', runSam2Segment);
    if (pointModeButton) {
        pointModeButton.addEventListener('click', () => {
            if (!hasSelectedVideo()) {
                setStatus('먼저 동영상을 선택하세요.', 'warning');
                return;
            }
            detectionMode = 'point';
            pointModeButton.classList.add('btn-primary');
            pointModeButton.classList.remove('btn-outline-primary');
            bboxModeButton?.classList.add('btn-outline-primary');
            bboxModeButton?.classList.remove('btn-primary');
            setStatus('Point 설정 모드입니다.', 'secondary');
        });
    }
    if (bboxModeButton) {
        bboxModeButton.addEventListener('click', () => {
            if (!hasSelectedVideo()) {
                setStatus('먼저 동영상을 선택하세요.', 'warning');
                return;
            }
            detectionMode = 'bbox';
            bboxModeButton.classList.add('btn-primary');
            bboxModeButton.classList.remove('btn-outline-primary');
            pointModeButton?.classList.add('btn-outline-primary');
            pointModeButton?.classList.remove('btn-primary');
            setStatus('BBox 설정 모드입니다.', 'secondary');
        });
    }
    if (pointClearButton) {
        pointClearButton.addEventListener('click', () => {
            clearAllPoints();
            setStatus('Point 설정을 초기화했습니다.', 'secondary');
        });
    }
    if (bboxClearButton) {
        bboxClearButton.addEventListener('click', () => {
            clearBoundingBox();
            setStatus('BBox 설정을 초기화했습니다.', 'secondary');
        });
    }
    if (optionsCancelButton) {
        optionsCancelButton.addEventListener('click', async () => {
            if (!selectedServerFileName) {
                setStatus('서버에 저장된 검출 설정을 찾을 수 없습니다.', 'warning');
                return;
            }

            optionsCancelButton.disabled = true;
            const restored = await loadVideoOptions(selectedServerFileName);
            updateDetectionControlState();
            setStatus(
                restored ? '서버에 저장된 검출 설정으로 초기화했습니다.' : '서버 검출 설정을 불러오지 못했습니다.',
                restored ? 'secondary' : 'warning'
            );
        });
    }
    if (bboxCaptureLayerElement) {
        bboxCaptureLayerElement.addEventListener('click', (event) => {
            if (detectionMode === 'point') {
                addPointByClick(event);
            }
        });
        bboxCaptureLayerElement.addEventListener('mousedown', (event) => {
            if (detectionMode === 'bbox') {
                handleBoundingBoxDragStart(event);
            }
        });
        bboxCaptureLayerElement.addEventListener('mousemove', (event) => {
            if (detectionMode === 'bbox') {
                handleBoundingBoxDragMove(event);
            }
        });
        bboxCaptureLayerElement.addEventListener('mouseup', (event) => {
            if (detectionMode === 'bbox') {
                handleBoundingBoxDragEnd(event);
            }
        });
        bboxCaptureLayerElement.addEventListener('mouseleave', (event) => {
            if (detectionMode === 'bbox') {
                handleBoundingBoxDragEnd(event);
            }
        });
    }
    if (loopToggleInput) {
        loopToggleInput.addEventListener('change', applyLoopOption);
    }
    if (pointLabelCheckbox) {
        pointLabelCheckbox.addEventListener('change', updatePointLabelText);
        updatePointLabelText();
    }
    setUploadedListLoading(true, '동영상 목록을 불러오는 중...');
    setStatus('업로드 목록을 가져오는 중...', 'info');

    if (uploadedEmptyElement) {
        uploadedEmptyElement.remove();
    }
    updateUploadLimitLabel('default');

    applyLoopOption();
    loadInputSourceTab();
    updateDetectionControlState();
    renderPointUi();
    renderBoundingBoxUi();

    loadUploadLimitFromServer();
    loadUploadedHistoryFromServer();
})();
