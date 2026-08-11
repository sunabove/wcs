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
    const uploadProgressStatusElement = document.getElementById('sam2-upload-progress-status');
    const promptFrameInput = document.getElementById('sam2-prompt-frame-input');
    const foregroundPointModeButton = document.getElementById('sam2-foreground-point-mode');
    const backgroundPointModeButton = document.getElementById('sam2-background-point-mode');
    if (foregroundPointModeButton) {
        foregroundPointModeButton.textContent = '전경 Point';
    }
    if (backgroundPointModeButton) {
        backgroundPointModeButton.textContent = '배경 Point';
    }
    const pointToolbarTitle = document.querySelector('#sam2-input-pane .sam2-point-toolbar > div > .fw-semibold');
    pointToolbarTitle?.classList.add('d-none');
    const bboxModeButton = document.getElementById('sam2-bbox-mode');
    const pointClearButton = document.getElementById('sam2-point-clear');
    const bboxClearButton = document.getElementById('sam2-bbox-clear');
    const optionsSaveButton = document.getElementById('sam2-options-save');
    const optionsResetButton = document.getElementById('sam2-options-reset');
    const multimaskOutputCheckbox = document.getElementById('sam2-multimask-output');
    const maskInputCheckbox = document.getElementById('sam2-mask-input');
    const claheCheckbox = document.getElementById('sam2-clahe');
    const claheText = document.getElementById('sam2-clahe-text');
    const iouMaskFilterCheckbox = document.getElementById('sam2-iou-mask-filter');
    const iouMaskFilterText = document.getElementById('sam2-iou-mask-filter-text');
    document.getElementById('sam2-point-label-text')?.closest('.form-switch')?.remove();
    const multimaskOutputText = document.getElementById('sam2-multimask-output-text');
    const maskInputText = document.getElementById('sam2-mask-input-text');
    const positivePointListElement = document.getElementById('sam2-positive-points');
    const positivePointCountElement = document.getElementById('sam2-positive-count');
    const pointMarkerLayerElement = document.getElementById('sam2-point-marker-layer');
    const bboxLayerElement = document.getElementById('sam2-bbox-layer');
    const bboxCaptureLayerElement = document.getElementById('sam2-bbox-capture-layer');

    const statusElement = document.getElementById('sam2-status');
    const inputVideoElement = document.getElementById('sam2-input-video');
    const inputFrameCounterElement = document.getElementById('sam2-input-frame-counter');
    const outputVideoElement = document.getElementById('sam2-output-video');
    const outputDownloadButton = document.getElementById('sam2-output-download');
    const yoloConvertButton = document.getElementById('sam2-yolo-convert');
    const yoloDatasetSummaryElement = document.getElementById('sam2-yolo-dataset-summary');
    const yoloClassTabTemplate = document.getElementById('sam2-yolo-class-template');
    const yoloFileTabTemplate = document.getElementById('sam2-yolo-file-template');
    const yoloClassEmptyTemplate = document.getElementById('sam2-yolo-class-empty-template');
    const yoloTrainTabElement = document.getElementById('sam2-yolo-train-tab');
    const yoloTrainClassCountElement = document.getElementById('sam2-yolo-train-class-count');
    const yoloTrainClassNamesElement = document.getElementById('sam2-yolo-train-class-names');
    const yoloTrainDataSummaryElement = document.getElementById('sam2-yolo-train-data-summary');
    const yoloTrainSummaryStatusElement = document.getElementById('sam2-yolo-train-summary-status');
    const yoloTrainStartButton = document.getElementById('sam2-yolo-train-start');
    const yoloRetrainStartButton = document.getElementById('sam2-yolo-retrain-start');
    const yoloTrainStopButton = document.getElementById('sam2-yolo-train-stop');
    const yoloTrainButtonGroup = yoloTrainStartButton?.parentElement;
    if (yoloTrainButtonGroup) {
        yoloTrainButtonGroup.classList.remove('d-grid');
        yoloTrainButtonGroup.classList.add('d-flex', 'flex-nowrap', 'justify-content-md-end');
        const buttonColumn = yoloTrainButtonGroup.parentElement;
        buttonColumn?.parentElement?.querySelectorAll(':scope > [class*="col-md-"]').forEach((column) => {
            column.classList.remove('col-md-2', 'col-md-5');
            column.classList.add('col-md-4');
        });
        [yoloTrainStartButton, yoloRetrainStartButton, yoloTrainStopButton].forEach((button) => {
            button?.classList.add('text-nowrap');
        });
    }
    const yoloTrainProgressElement = document.getElementById('sam2-yolo-train-progress');
    const yoloTrainProgressTextElement = document.getElementById('sam2-yolo-train-progress-text');
    const yoloTrainStatusElement = document.getElementById('sam2-yolo-train-status');
    const yoloTrainMetricsCanvas = document.getElementById('sam2-yolo-train-metrics-chart');
    document.querySelector('#sam2-yolo-train-pane > section > .fw-semibold.mb-2')?.remove();

    let selectedFile = null;
    let resolvedApiBase = null;
    let inputObjectUrl = '';
    let outputObjectUrl = '';
    let yoloInputFileName = '';
    let yoloConversionAvailable = false;
    let yoloClassTabsElement = null;
    let yoloClassTabContentElement = null;
    let yoloTrainingJobId = '';
    let yoloTrainingRecoveryPending = false;
    let yoloTrainingMetricsChart = null;
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
    let pointDragIndex = -1;
    let pointDragging = false;
    let suppressPointClick = false;
    let pointContextMenuElement = null;
    let pointContextMenuIndex = -1;
    let uploadedContextMenuElement = null;
    let outputControlsHideTimer = 0;
    let detectionMode = 'foreground';
    let isUploadingImmediately = false;
    let uploadedListLoadingStartedAt = 0;
    let isUploadedListLoading = false;
    let uploadedListLoadingMessage = '동영상 목록을 불러오는 중...';
    let uploadedListRequestSeq = 0;
    let uploadedListLatestRequestSeq = 0;
    let uploadedListInFlightCount = 0;
    let hasCompletedInitialUploadedListLoad = false;
    let inputVideoFps = 0;
    let inputVideoFrameCount = 0;
    let inputVideoMetadataRequestSeq = 0;
    let pendingPromptFrame = null;
    const MAX_POINT_COUNT = 20;
    const STORAGE_SELECTED_VIDEO_KEY = 'sam2.selectedVideo';
    const STORAGE_INPUT_SOURCE_TAB_KEY = 'sam2.inputSourceTab';
    const STORAGE_OUTPUT_TAB_KEY = 'sam2.outputTab';
    const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB
    let maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES;
    let maxUploadConfiguredValue = '1g';

    function debugSam2(message, details) {
        return undefined;
    }

    window.addEventListener('error', (event) => {
        console.error('[SAM2] 전역 JavaScript 오류', {
            message: event.message,
            source: event.filename,
            line: event.lineno,
            column: event.colno,
            error: event.error,
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        console.error('[SAM2] 처리되지 않은 Promise 오류', event.reason);
    });

    function setStatus(message, type) {
        const alertType = type || 'secondary';
        statusElement.classList.remove(
            'alert-secondary',
            'alert-primary',
            'alert-success',
            'alert-warning',
            'alert-danger',
            'alert-info',
            'alert-light',
            'alert-dark'
        );
        statusElement.classList.add(`alert-${alertType}`);
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
        setUploadText(uploadMaxSizeElement, `최대 크기: ${sizeText}`);
    }

    function setUploadText(element, text) {
        if (!element) {
            return;
        }

        const value = String(text || '');
        element.textContent = value;
        element.title = value;
    }

    function setUploadProgress(percent) {
        const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
        if (uploadProgressWrapElement) {
            uploadProgressWrapElement.classList.remove('d-none');
        }
        if (uploadProgressBarElement) {
            uploadProgressBarElement.style.width = `${normalized}%`;
            uploadProgressBarElement.setAttribute('aria-valuenow', String(normalized));
        }
        setUploadText(uploadProgressStatusElement, `${normalized}%`);
    }

    function hideUploadProgress() {
        if (uploadProgressWrapElement) {
            uploadProgressWrapElement.classList.add('d-none');
        }
        if (uploadProgressBarElement) {
            uploadProgressBarElement.style.width = '0%';
            uploadProgressBarElement.setAttribute('aria-valuenow', '0');
        }
        setUploadText(uploadProgressStatusElement, '0%');
    }

    function uploadVideoWithProgress(apiBase, file) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${apiBase}/fast/sam2/upload_video`, true);
            xhr.timeout = 10 * 60 * 1000;

            xhr.addEventListener('loadstart', () => {
                setUploadProgress(0);
            });

            xhr.upload.addEventListener('progress', (event) => {
                if (event && event.lengthComputable && event.total > 0) {
                    const percent = Math.round((event.loaded / event.total) * 100);
                    setUploadProgress(percent);
                } else {
                    setUploadProgress(0);
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const body = JSON.parse(xhr.responseText || '{}');
                        setUploadProgress(100);
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

    function getPromptFrame() {
        const maximumFrame = inputVideoFrameCount > 0
            ? inputVideoFrameCount
            : Number.MAX_SAFE_INTEGER;
        return clamp(
            Math.trunc(toNumber(promptFrameInput && promptFrameInput.value, 1)),
            1,
            maximumFrame
        );
    }

    function buildPromptFrameQuery() {
        return `&prompt_frame=${encodeURIComponent(String(getPromptFrame()))}`;
    }

    function restorePendingPromptFrame() {
        if (!promptFrameInput || pendingPromptFrame === null) {
            return;
        }

        const maximumFrame = inputVideoFrameCount > 0
            ? inputVideoFrameCount
            : Number.MAX_SAFE_INTEGER;
        const targetFrame = clamp(Math.trunc(toNumber(pendingPromptFrame, 1)), 1, maximumFrame);
        promptFrameInput.value = String(targetFrame);
        if (inputVideoFps <= 0 || inputVideoFrameCount <= 0) {
            return;
        }

        pendingPromptFrame = null;
        inputVideoElement.pause();
        inputVideoElement.currentTime = (targetFrame - 1) / inputVideoFps;
        updateInputFrameCounter(inputVideoElement.currentTime);
    }

    function hasSelectedVideo() {
        const fileFromInput = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        return Boolean(selectedFile || fileFromInput || selectedServerFileName);
    }

    function updateInputFrameCounter(mediaTime) {
        if (!inputFrameCounterElement) {
            return;
        }
        if (inputVideoFps <= 0 || inputVideoFrameCount <= 0) {
            inputFrameCounterElement.textContent = '프레임 - / -';
            if (promptFrameInput) {
                promptFrameInput.min = '1';
                promptFrameInput.max = '1';
                promptFrameInput.value = '1';
                promptFrameInput.disabled = true;
            }
            return;
        }

        const frameTime = Number.isFinite(mediaTime) ? mediaTime : inputVideoElement.currentTime;
        const currentTime = Math.max(0, Number(frameTime) || 0);
        const currentFrame = clamp(
            Math.floor(currentTime * inputVideoFps) + 1,
            1,
            inputVideoFrameCount
        );
        inputFrameCounterElement.textContent = `프레임 ${currentFrame.toLocaleString()} / ${inputVideoFrameCount.toLocaleString()}`;
        if (promptFrameInput && document.activeElement !== promptFrameInput) {
            promptFrameInput.max = String(inputVideoFrameCount);
            promptFrameInput.value = String(currentFrame);
            promptFrameInput.disabled = !hasSelectedVideo();
        }
    }

    async function loadInputVideoMetadata(fileName) {
        const requestSeq = ++inputVideoMetadataRequestSeq;
        inputVideoFps = 0;
        inputVideoFrameCount = 0;
        updateInputFrameCounter();

        try {
            const apiBase = await resolveApiBase();
            const response = await fetch(`${apiBase}/fast/sam2/video_metadata?file_name=${encodeURIComponent(fileName)}`, {
                cache: 'no-store',
            });
            if (!response.ok) {
                return;
            }
            const metadata = await response.json();
            if (requestSeq !== inputVideoMetadataRequestSeq) {
                return;
            }
            inputVideoFps = Math.max(0, Number(metadata.fps) || 0);
            inputVideoFrameCount = Math.max(0, Math.trunc(Number(metadata.frame_count) || 0));
            updateInputFrameCounter();
            restorePendingPromptFrame();
        } catch (_ignore) {
            if (requestSeq === inputVideoMetadataRequestSeq) {
                inputVideoFps = 0;
                inputVideoFrameCount = 0;
                updateInputFrameCounter();
            }
        }
    }

    inputVideoElement.addEventListener('loadedmetadata', updateInputFrameCounter);
    inputVideoElement.addEventListener('timeupdate', updateInputFrameCounter);
    inputVideoElement.addEventListener('seeked', updateInputFrameCounter);
    promptFrameInput?.addEventListener('change', () => {
        if (inputVideoFps <= 0 || inputVideoFrameCount <= 0) {
            return;
        }
        const targetFrame = clamp(
            Math.trunc(toNumber(promptFrameInput.value, 1)),
            1,
            inputVideoFrameCount
        );
        pendingPromptFrame = null;
        promptFrameInput.value = String(targetFrame);
        inputVideoElement.pause();
        inputVideoElement.currentTime = (targetFrame - 1) / inputVideoFps;
        updateInputFrameCounter(inputVideoElement.currentTime);
    });
    if (typeof inputVideoElement.requestVideoFrameCallback === 'function') {
        const updateOnVideoFrame = (_now, metadata) => {
            updateInputFrameCounter(metadata.mediaTime);
            inputVideoElement.requestVideoFrameCallback(updateOnVideoFrame);
        };
        inputVideoElement.requestVideoFrameCallback(updateOnVideoFrame);
    }

    function updateMultimaskOutputText() {
        if (multimaskOutputText) {
            multimaskOutputText.textContent = multimaskOutputCheckbox && multimaskOutputCheckbox.checked
                ? 'Multi mask'
                : 'Single mask';
        }
    }

    function applyUploadDefaultOptions() {
        pendingPromptFrame = null;
        if (maskInputCheckbox) {
            maskInputCheckbox.checked = true;
            updateMaskInputText();
        }
        if (claheCheckbox) {
            claheCheckbox.checked = true;
            updateClaheText();
        }
        if (iouMaskFilterCheckbox) {
            iouMaskFilterCheckbox.checked = true;
            updateIouMaskFilterText();
        }
        if (multimaskOutputCheckbox) {
            multimaskOutputCheckbox.checked = false;
            updateMultimaskOutputText();
        }
    }

    function updateDetectionControlState() {
        const enabled = hasSelectedVideo();
            [foregroundPointModeButton, backgroundPointModeButton, bboxModeButton, pointClearButton, bboxClearButton, optionsSaveButton, optionsResetButton, multimaskOutputCheckbox, maskInputCheckbox, claheCheckbox, iouMaskFilterCheckbox].forEach((control) => {
            if (control) {
                control.disabled = !enabled;
            }
        });
        if (promptFrameInput) {
            promptFrameInput.disabled = !enabled || inputVideoFps <= 0 || inputVideoFrameCount <= 0;
        }
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

            pendingPromptFrame = Math.max(1, Math.trunc(toNumber(options.prompt_frame, 1)));
            restorePendingPromptFrame();

            const points = Array.isArray(options.points) ? options.points : [];
            const labels = Array.isArray(options.point_labels) ? options.point_labels : [];
            positivePoints = points.slice(0, MAX_POINT_COUNT).map((point, index) => ({
                x: clamp(toNumber(point && point.x, 0), 0, 100),
                y: clamp(toNumber(point && point.y, 0), 0, 100),
                label: labels[index] === undefined
                    ? (index % 2 === 0 ? 1 : 0)
                    : (Number(labels[index]) === 0 ? 0 : 1),
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

            if (multimaskOutputCheckbox) {
                multimaskOutputCheckbox.checked = options.multimask_output === true;
                updateMultimaskOutputText();
            }
            if (maskInputCheckbox) {
                maskInputCheckbox.checked = options.mask_input !== false;
                updateMaskInputText();
            }
            if (claheCheckbox) {
                claheCheckbox.checked = options.clahe === true;
                updateClaheText();
            }
            if (iouMaskFilterCheckbox) {
                iouMaskFilterCheckbox.checked = options.iou_mask_filter !== false;
                updateIouMaskFilterText();
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
        showInputSourceTab('sam2-uploaded-source-tab', false);
    }

    function loadOutputTab() {
        let tabId = '';
        try {
            tabId = String(localStorage.getItem(STORAGE_OUTPUT_TAB_KEY) || '').trim();
        } catch (_ignore) {
            // Use the default tab when localStorage is unavailable.
        }

        const tabButton = document.getElementById(tabId);
        const isOutputTab = tabButton
            && tabButton.matches('[data-bs-toggle="tab"]')
            && tabButton.closest('#sam2-video-tabs');
        if (isOutputTab && window.bootstrap && typeof window.bootstrap.Tab === 'function') {
            window.bootstrap.Tab.getOrCreateInstance(tabButton).show();
        }
    }

    function applyLoopOption() {
        const loopEnabled = Boolean(loopToggleInput && loopToggleInput.checked);
        inputVideoElement.loop = loopEnabled;
        outputVideoElement.loop = loopEnabled;
    }

    function showOutputVideoControls() {
        if (outputControlsHideTimer) {
            window.clearTimeout(outputControlsHideTimer);
            outputControlsHideTimer = 0;
        }
        outputVideoElement.setAttribute('controls', 'controls');
    }

    function hideOutputVideoControls() {
        if (document.activeElement === outputVideoElement) {
            return;
        }
        outputControlsHideTimer = window.setTimeout(() => {
            if (document.activeElement !== outputVideoElement) {
                outputVideoElement.removeAttribute('controls');
            }
            outputControlsHideTimer = 0;
        }, 250);
    }

    function initializeOutputVideoControls() {
        if (!outputVideoElement) {
            return;
        }
        const outputVideoWrap = outputVideoElement.closest('.sam2-video-wrap');
        if (outputVideoWrap) {
            outputVideoWrap.classList.add('sam2-output-video-wrap');
            if (outputDownloadButton) {
                outputDownloadButton.classList.add('sam2-output-download-button');
                outputVideoWrap.insertBefore(outputDownloadButton, outputVideoElement);
            }
            const loopToggleContainer = loopToggleInput?.closest('.form-switch');
            if (loopToggleContainer) {
                loopToggleContainer.classList.remove('ms-2');
                loopToggleContainer.classList.add('sam2-output-loop-toggle');
                outputVideoWrap.insertBefore(loopToggleContainer, outputVideoElement);
            }
        }
        outputVideoElement.removeAttribute('controls');
        outputVideoElement.addEventListener('mouseenter', showOutputVideoControls);
        outputVideoElement.addEventListener('mouseleave', hideOutputVideoControls);
        outputVideoElement.addEventListener('focus', showOutputVideoControls);
        outputVideoElement.addEventListener('blur', hideOutputVideoControls);
    }

    function initializeYoloOutputTab() {
        yoloClassTabsElement = document.getElementById('sam2-yolo-class-tabs');
        yoloClassTabContentElement = document.getElementById('sam2-yolo-class-tab-content');
        updateYoloClassTabs();
        yoloTrainTabElement?.addEventListener('shown.bs.tab', () => {
            recoverActiveYoloTraining();
            updateYoloTrainingOverview();
        });
        yoloTrainStartButton?.addEventListener('click', () => startYoloTraining(false));
        yoloRetrainStartButton?.addEventListener('click', () => startYoloTraining(true));
        yoloTrainStopButton?.addEventListener('click', stopYoloTraining);
        recoverActiveYoloTraining();
    }

    function formatYoloTrainingDuration(seconds) {
        const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const remainingSeconds = totalSeconds % 60;
        return [hours, minutes, remainingSeconds]
            .map(value => String(value).padStart(2, '0'))
            .join(':');
    }

    function renderYoloTrainingProgress(progress, message, status, elapsedSeconds, estimatedTotalSeconds) {
        const normalizedProgress = Math.max(0, Math.min(100, Number(progress || 0)));
        const progressText = Number.isInteger(normalizedProgress)
            ? String(normalizedProgress)
            : normalizedProgress.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
        if (yoloTrainProgressElement) {
            yoloTrainProgressElement.style.width = `${normalizedProgress}%`;
            yoloTrainProgressElement.closest('.progress')?.setAttribute('aria-valuenow', String(normalizedProgress));
            yoloTrainProgressElement.classList.toggle('progress-bar-animated', status === 'running');
            yoloTrainProgressElement.classList.toggle('bg-success', status === 'completed');
            yoloTrainProgressElement.classList.toggle('bg-danger', status === 'failed');
        }
        if (yoloTrainProgressTextElement) {
            yoloTrainProgressTextElement.textContent = `${progressText}%`;
        }
        if (yoloTrainStatusElement) {
            const hasTiming = elapsedSeconds !== undefined && elapsedSeconds !== null;
            const timingText = hasTiming
                ? ` · 진행 시간 ${formatYoloTrainingDuration(elapsedSeconds)} · 총 예상 시간 ${estimatedTotalSeconds === null || estimatedTotalSeconds === undefined ? '계산 중' : formatYoloTrainingDuration(estimatedTotalSeconds)}`
                : '';
            yoloTrainStatusElement.textContent = `${message || '학습 대기 중'}${timingText}`;
        }
    }

    function renderYoloTrainingMetrics(metricHistory) {
        if (!yoloTrainMetricsCanvas || typeof Chart !== 'function') {
            return;
        }
        const history = Array.isArray(metricHistory) ? metricHistory : [];
        const labels = history.map((item) => Number(item.epoch || 0));
        const datasetDefinitions = [
            ['Precision', 'precision', '#0d6efd'],
            ['Recall', 'recall', '#198754'],
            ['mAP50', 'map50', '#fd7e14'],
            ['mAP50-95', 'map50_95', '#6f42c1'],
        ];
        if (!yoloTrainingMetricsChart) {
            yoloTrainingMetricsChart = new Chart(yoloTrainMetricsCanvas, {
                type: 'line',
                data: {
                    labels,
                    datasets: datasetDefinitions.map(([label, key, color]) => ({
                        label,
                        data: history.map((item) => Number(item[key] || 0)),
                        borderColor: color,
                        backgroundColor: color,
                        borderWidth: 2,
                        pointRadius: 2,
                        tension: 0.15,
                    })),
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    interaction: { mode: 'index', intersect: false },
                    scales: {
                        x: { title: { display: true, text: 'Epoch' } },
                        y: { min: 0, max: 1, title: { display: true, text: 'Score' } },
                    },
                },
            });
            return;
        }
        yoloTrainingMetricsChart.data.labels = labels;
        yoloTrainingMetricsChart.data.datasets.forEach((dataset, index) => {
            const key = datasetDefinitions[index][1];
            dataset.data = history.map((item) => Number(item[key] || 0));
        });
        yoloTrainingMetricsChart.update('none');
    }

    async function pollYoloTrainingStatus() {
        if (!yoloTrainingJobId) {
            return;
        }
        try {
            const apiBase = await resolveApiBase();
            const response = await fetch(`${apiBase}/fast/sam2/yolo_training_status/${encodeURIComponent(yoloTrainingJobId)}`, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`학습 상태 조회 실패 (${response.status})`);
            }
            const job = await response.json();
            const status = String(job.status || 'queued');
            const copiedWeightPath = String(job.result && job.result.best_model_path || '').trim();
            const message = status === 'completed' && copiedWeightPath
                ? `YOLO 학습 완료 · 가중치 파일 복사 완료: ${copiedWeightPath}`
                : job.error || job.message || 'YOLO 학습 진행 중...';
            renderYoloTrainingProgress(
                job.progress,
                message,
                status,
                job.elapsed_seconds,
                job.estimated_total_seconds
            );
            renderYoloTrainingMetrics(job.metric_history);
            if (yoloTrainStopButton) {
                yoloTrainStopButton.disabled = status === 'stopping';
            }
            if (status === 'queued' || status === 'running' || status === 'stopping') {
                window.setTimeout(pollYoloTrainingStatus, 1000);
                return;
            }
            yoloTrainingJobId = '';
            if (yoloTrainStartButton) {
                yoloTrainStartButton.disabled = false;
            }
            if (yoloRetrainStartButton) {
                yoloRetrainStartButton.disabled = false;
            }
            if (yoloTrainStopButton) {
                yoloTrainStopButton.disabled = true;
            }
        } catch (error) {
            yoloTrainingJobId = '';
            if (yoloTrainStartButton) {
                yoloTrainStartButton.disabled = false;
            }
            if (yoloRetrainStartButton) {
                yoloRetrainStartButton.disabled = false;
            }
            if (yoloTrainStopButton) {
                yoloTrainStopButton.disabled = true;
            }
            renderYoloTrainingProgress(0, error && error.message ? error.message : '학습 상태를 조회하지 못했습니다.', 'failed');
        }
    }

    async function recoverActiveYoloTraining() {
        if (yoloTrainingJobId || yoloTrainingRecoveryPending) {
            return;
        }
        yoloTrainingRecoveryPending = true;
        try {
            const apiBase = await resolveApiBase();
            const response = await fetch(`${apiBase}/fast/sam2/yolo_training_status`, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`진행 중인 학습 조회 실패 (${response.status})`);
            }
            const job = await response.json();
            if (!job.active || !job.job_id) {
                return;
            }
            yoloTrainingJobId = String(job.job_id);
            if (yoloTrainStartButton) {
                yoloTrainStartButton.disabled = true;
            }
            if (yoloRetrainStartButton) {
                yoloRetrainStartButton.disabled = true;
            }
            if (yoloTrainStopButton) {
                yoloTrainStopButton.disabled = job.status === 'stopping';
            }
            renderYoloTrainingProgress(
                job.progress,
                job.error || job.message,
                job.status,
                job.elapsed_seconds,
                job.estimated_total_seconds
            );
            renderYoloTrainingMetrics(job.metric_history);
            pollYoloTrainingStatus();
        } catch (error) {
            console.error('[SAM2] 진행 중인 YOLO 학습 복구 실패', error);
        } finally {
            yoloTrainingRecoveryPending = false;
        }
    }

    async function startYoloTraining(forceRetrain) {
        if (!yoloTrainStartButton || !yoloRetrainStartButton || yoloTrainingJobId) {
            return;
        }
        yoloTrainStartButton.disabled = true;
        yoloRetrainStartButton.disabled = true;
        if (yoloTrainStopButton) {
            yoloTrainStopButton.disabled = true;
        }
        renderYoloTrainingProgress(0, forceRetrain ? 'YOLO 재학습을 요청하는 중...' : 'YOLO 학습을 요청하는 중...', 'queued');
        renderYoloTrainingMetrics([]);
        try {
            const apiBase = await resolveApiBase();
            const response = await fetch(
                `${apiBase}/fast/sam2/train_yolo_dataset?force_retrain=${forceRetrain ? 'true' : 'false'}`,
                { method: 'POST' }
            );
            if (!response.ok) {
                let message = `YOLO 학습 시작 실패 (${response.status})`;
                try {
                    const errorBody = await response.json();
                    message = errorBody.detail || message;
                } catch (_ignore) {
                    // Keep the status-based error message.
                }
                throw new Error(message);
            }
            const job = await response.json();
            yoloTrainingJobId = String(job.job_id || '');
            if (yoloTrainStopButton) {
                yoloTrainStopButton.disabled = !yoloTrainingJobId;
            }
            renderYoloTrainingProgress(
                job.progress,
                job.message,
                job.status,
                job.elapsed_seconds,
                job.estimated_total_seconds
            );
            pollYoloTrainingStatus();
        } catch (error) {
            yoloTrainStartButton.disabled = false;
            yoloRetrainStartButton.disabled = false;
            if (yoloTrainStopButton) {
                yoloTrainStopButton.disabled = true;
            }
            renderYoloTrainingProgress(0, error && error.message ? error.message : 'YOLO 학습을 시작하지 못했습니다.', 'failed');
        }
    }

    async function stopYoloTraining() {
        if (!yoloTrainingJobId || !yoloTrainStopButton || yoloTrainStopButton.disabled) {
            return;
        }
        yoloTrainStopButton.disabled = true;
        try {
            const apiBase = await resolveApiBase();
            const response = await fetch(
                `${apiBase}/fast/sam2/yolo_training_stop/${encodeURIComponent(yoloTrainingJobId)}`,
                { method: 'POST' }
            );
            if (!response.ok) {
                let message = `YOLO 학습 중지 실패 (${response.status})`;
                try {
                    const errorBody = await response.json();
                    message = errorBody.detail || message;
                } catch (_ignore) {
                    // Keep the status-based error message.
                }
                throw new Error(message);
            }
            const job = await response.json();
            renderYoloTrainingProgress(
                job.progress,
                job.message,
                job.status,
                job.elapsed_seconds,
                job.estimated_total_seconds
            );
        } catch (error) {
            yoloTrainStopButton.disabled = false;
            if (yoloTrainStatusElement) {
                yoloTrainStatusElement.textContent = error && error.message
                    ? error.message
                    : 'YOLO 학습을 중지하지 못했습니다.';
            }
        }
    }

    async function updateYoloTrainingOverview() {
        if (!yoloTrainClassCountElement || !yoloTrainClassNamesElement || !yoloTrainDataSummaryElement || !yoloTrainSummaryStatusElement) {
            return;
        }
        yoloTrainSummaryStatusElement.textContent = '학습 데이터 개요를 불러오는 중...';
        try {
            const apiBase = await resolveApiBase();
            const response = await fetch(`${apiBase}/fast/sam2/yolo_dataset_summary`, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`학습 데이터 개요 조회 실패 (${response.status})`);
            }
            const summary = await response.json();
            const classNames = Array.isArray(summary.class_names) ? summary.class_names : [];
            const classCount = Number(summary.class_count || 0);
            const inputFileCount = Number(summary.input_file_count || 0);
            const frameCount = Number(summary.frame_count || 0);
            const segmentCount = Number(summary.segment_count || 0);
            yoloTrainClassCountElement.textContent = `클래스 ${classCount}개`;
            yoloTrainClassNamesElement.textContent = classNames.length > 0
                ? classNames.join(', ')
                : '등록된 클래스가 없습니다.';
            yoloTrainDataSummaryElement.textContent = `입력파일 ${inputFileCount}개 · 프레임 ${frameCount}장 · Seg Polygon ${segmentCount}개`;
            if (yoloTrainStartButton && !yoloTrainingJobId) {
                yoloTrainStartButton.disabled = frameCount <= 0;
            }
            if (yoloRetrainStartButton && !yoloTrainingJobId) {
                yoloRetrainStartButton.disabled = frameCount <= 0;
            }
            yoloTrainSummaryStatusElement.textContent = frameCount > 0
                ? '학습 데이터 준비 완료'
                : '변환된 학습 데이터가 없습니다.';
        } catch (error) {
            yoloTrainSummaryStatusElement.textContent = error && error.message
                ? error.message
                : '학습 데이터 개요를 불러오지 못했습니다.';
        }
    }

    function updateOutputDownloadState() {
        if (outputDownloadButton) {
            outputDownloadButton.disabled = !outputObjectUrl;
        }
        if (yoloConvertButton) {
            yoloConvertButton.disabled = !yoloConversionAvailable || !yoloInputFileName;
        }
    }

    async function convertYoloDataset() {
        if (!yoloConversionAvailable || !yoloInputFileName) {
            setStatus('영상을 먼저 검출하세요.', 'warning');
            return;
        }

        const className = extractYoloClassName(yoloInputFileName) || basename(yoloInputFileName).replace(/\.[^.]+$/, '');
        if (yoloConvertButton) {
            yoloConvertButton.disabled = true;
        }
        setStatus(`${className} 클래스 YOLO 학습 데이터 변환 중 ...`, 'info');

        try {
            const apiBase = await resolveApiBase();
            const response = await fetch(
                `${apiBase}/fast/sam2/convert_yolo_dataset?file_name=${encodeURIComponent(yoloInputFileName)}`,
                { method: 'POST' }
            );
            if (!response.ok) {
                let errorMessage = `YOLO 변환 실패 (${response.status})`;
                try {
                    const errorBody = await response.json();
                    if (errorBody && errorBody.detail) {
                        errorMessage = String(errorBody.detail);
                    }
                } catch (_ignore) {
                    // Keep default error message.
                }
                throw new Error(errorMessage);
            }

            const result = await response.json();
            const imageCount = Number(result.yolo_dataset_image_count || 0);
            const labelCount = Number(result.yolo_dataset_label_count || 0);
            const conversionCompleted = imageCount > 0;
            const summary = conversionCompleted
                ? `변환 완료: 이미지 ${imageCount}장, 세그먼트 ${labelCount}개`
                : '기준 스코어 이상인 학습 데이터가 없습니다.';
            if (conversionCompleted) {
                const convertedInputName = basename(yoloInputFileName);
                const convertedItem = uploadedHistory.find((item) => basename(item && item.name) === convertedInputName);
                if (convertedItem) {
                    convertedItem.hasYoloDataset = true;
                }
                updateYoloClassTabs(className);
                updateYoloTrainingOverview();
            }
            if (yoloDatasetSummaryElement) {
                yoloDatasetSummaryElement.textContent = summary;
            }
            updateOutputDownloadState();
            setStatus(conversionCompleted ? `${className} 클래스 YOLO 변환 완료` : '변환할 학습 데이터가 없습니다.', conversionCompleted ? 'success' : 'warning');
        } catch (error) {
            yoloConversionAvailable = true;
            updateOutputDownloadState();
            setStatus(error && error.message ? error.message : 'YOLO 변환에 실패했습니다.', 'danger');
        }
    }

    function buildOutputDownloadFileName() {
        const sourceName = selectedServerFileName
            || (selectedFile && selectedFile.name)
            || 'sam2_video';
        const baseName = String(sourceName).split('/').pop() || 'sam2_video';
        const dotIndex = baseName.lastIndexOf('.');
        const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
        return `${stem}_detected.mp4`;
    }

    function downloadDetectedVideo() {
        if (!outputObjectUrl) {
            setStatus('먼저 검출 영상을 생성하세요.', 'warning');
            return;
        }

        const downloadLink = document.createElement('a');
        downloadLink.href = outputObjectUrl;
        downloadLink.download = buildOutputDownloadFileName();
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
        setStatus('검출 영상 다운로드를 시작했습니다.', 'success');
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
        hidePointContextMenu();
        positivePoints = [];
        renderPointUi();
    }

    function hidePointContextMenu() {
        if (pointContextMenuElement) {
            pointContextMenuElement.remove();
            pointContextMenuElement = null;
        }
        pointContextMenuIndex = -1;
    }

    function showPointContextMenu(event, pointIndex) {
        hidePointContextMenu();
        if (!bboxCaptureLayerElement || !positivePoints[pointIndex]) {
            return;
        }

        const point = positivePoints[pointIndex];
        const layerRect = bboxCaptureLayerElement.getBoundingClientRect();
        const menu = document.createElement('div');
        const pointType = Number(point.label) === 0 ? '배경 Point' : '전경 Point';
        menu.className = 'bg-white border rounded shadow-sm p-2';
        menu.style.position = 'absolute';
        menu.style.zIndex = '20';
        menu.style.minWidth = '132px';
        menu.style.left = `${Math.max(4, Math.min(layerRect.width - 136, event.clientX - layerRect.left + 6))}px`;
        menu.style.top = `${Math.max(4, Math.min(layerRect.height - 78, event.clientY - layerRect.top + 6))}px`;
        menu.addEventListener('click', (menuEvent) => {
            menuEvent.stopPropagation();
        });
        menu.addEventListener('contextmenu', (menuEvent) => {
            menuEvent.preventDefault();
            menuEvent.stopPropagation();
        });

        const title = document.createElement('div');
        title.className = 'small text-secondary mb-2';
        title.textContent = `${pointType} 선택됨`;
        menu.appendChild(title);

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'btn btn-danger btn-sm w-100 mb-1';
        deleteButton.textContent = '삭제';
        deleteButton.addEventListener('click', () => {
            const selectedPoint = positivePoints[pointContextMenuIndex];
            if (selectedPoint) {
                positivePoints.splice(pointContextMenuIndex, 1);
                renderPointUi();
                setStatus(`${Number(selectedPoint.label) === 0 ? 'Background' : 'Foreground'} Point를 삭제했습니다.`, 'secondary');
            }
            hidePointContextMenu();
        });
        menu.appendChild(deleteButton);

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'btn btn-outline-secondary btn-sm w-100';
        cancelButton.textContent = '취소';
        cancelButton.addEventListener('click', hidePointContextMenu);
        menu.appendChild(cancelButton);

        pointContextMenuIndex = pointIndex;
        pointContextMenuElement = menu;
        bboxCaptureLayerElement.appendChild(menu);
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

    function findPointIndexAtPosition(point) {
        if (!pointMarkerLayerElement || !point || positivePoints.length === 0) {
            return -1;
        }

        const rect = pointMarkerLayerElement.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            return -1;
        }

        const thresholdX = (16 / rect.width) * 100;
        const thresholdY = (16 / rect.height) * 100;
        let nearestIndex = -1;
        let nearestDistance = Number.POSITIVE_INFINITY;
        positivePoints.forEach((candidate, index) => {
            const dx = (toNumber(candidate && candidate.x, 0) - point.x) / thresholdX;
            const dy = (toNumber(candidate && candidate.y, 0) - point.y) / thresholdY;
            const distance = (dx * dx) + (dy * dy);
            if (distance <= 1 && distance < nearestDistance) {
                nearestIndex = index;
                nearestDistance = distance;
            }
        });
        return nearestIndex;
    }

    function startPointDrag(event) {
        if (event.button !== 0 || !hasSelectedVideo()) {
            return;
        }

        const point = toRelativePoint(event);
        if (!isPointInsideBoundingBox(point)) {
            return;
        }
        const index = findPointIndexAtPosition(point);
        if (index < 0) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        pointDragIndex = index;
        pointDragging = false;
        suppressPointClick = false;
        document.addEventListener('mousemove', handlePointDragMove);
        document.addEventListener('mouseup', endPointDrag);
    }

    function handlePointDragMove(event) {
        if (pointDragIndex < 0) {
            return;
        }

        const point = toRelativePoint(event);
        if (!point) {
            return;
        }

        const boundedPoint = clampPointToBoundingBox(point);
        pointDragging = true;
        suppressPointClick = true;
        positivePoints[pointDragIndex] = {
            ...positivePoints[pointDragIndex],
            x: boundedPoint.x,
            y: boundedPoint.y,
        };
        renderPointUi();
    }

    function endPointDrag() {
        if (pointDragIndex < 0) {
            return;
        }

        const wasDragging = pointDragging;
        pointDragIndex = -1;
        pointDragging = false;
        document.removeEventListener('mousemove', handlePointDragMove);
        document.removeEventListener('mouseup', endPointDrag);
        if (wasDragging) {
            setStatus('Point 위치가 수정되었습니다.', 'secondary');
        }
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
        if (!isPointInsideBoundingBox(point)) {
            setStatus('BBox 내부에서만 Point를 입력할 수 있습니다.', 'warning');
            return;
        }
        point.label = detectionMode === 'background' ? 0 : 1;

        if (positivePoints.length >= MAX_POINT_COUNT) {
            setStatus(`Point는 최대 ${MAX_POINT_COUNT}개까지 입력할 수 있습니다.`, 'warning');
            return;
        }

        positivePoints.push(point);
        renderPointUi();
        setStatus(`${point.label === 1 ? 'Foreground' : 'Background'} Point가 추가되었습니다.`, 'secondary');
    }

    function selectPointByRightClick(event) {
        if (!hasSelectedVideo()) {
            return;
        }

        const point = toRelativePoint(event);
        if (!isPointInsideBoundingBox(point)) {
            return;
        }
        const index = findPointIndexAtPosition(point);
        if (index < 0) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        showPointContextMenu(event, index);
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

    function isPointInsideBoundingBox(point) {
        if (!point) {
            return false;
        }

        const box = boundingBox || createFullBoundingBox();
        const left = toNumber(box.x, 0);
        const top = toNumber(box.y, 0);
        const right = left + toNumber(box.w, 0);
        const bottom = top + toNumber(box.h, 0);
        return point.x >= left
            && point.x <= right
            && point.y >= top
            && point.y <= bottom;
    }

    function clampPointToBoundingBox(point) {
        if (!point) {
            return null;
        }

        const box = boundingBox || createFullBoundingBox();
        return {
            x: clamp(point.x, toNumber(box.x, 0), toNumber(box.x, 0) + toNumber(box.w, 0)),
            y: clamp(point.y, toNumber(box.y, 0), toNumber(box.y, 0) + toNumber(box.h, 0)),
        };
    }

    function updatePointInputCursor(event) {
        if (!bboxCaptureLayerElement) {
            return;
        }

        if (detectionMode !== 'foreground' && detectionMode !== 'background') {
            bboxCaptureLayerElement.style.cursor = 'default';
            return;
        }

        const point = toRelativePoint(event);
        bboxCaptureLayerElement.style.cursor = isPointInsideBoundingBox(point)
            ? 'crosshair'
            : 'default';
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
        const handles = [
            { key: 'nw', x: left, y: top },
            { key: 'ne', x: left + width, y: top },
            { key: 'sw', x: left, y: top + height },
            { key: 'se', x: left + width, y: top + height },
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
        if (!boundingBox) {
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

    function buildMultimaskOutputQuery() {
        const value = Boolean(multimaskOutputCheckbox && multimaskOutputCheckbox.checked);
        return `&multimask_output=${encodeURIComponent(String(value))}`;
    }

    function updateMaskInputText() {
        if (maskInputText) {
            maskInputText.textContent = maskInputCheckbox && maskInputCheckbox.checked ? 'On' : 'Off';
        }
    }

    function buildMaskInputQuery() {
        const value = Boolean(maskInputCheckbox && maskInputCheckbox.checked);
        return `&mask_input=${encodeURIComponent(String(value))}`;
    }

    function updateClaheText() {
        if (claheText) {
            claheText.textContent = claheCheckbox && claheCheckbox.checked ? 'On' : 'Off';
        }
    }

    function buildClaheQuery() {
        const value = Boolean(claheCheckbox && claheCheckbox.checked);
        return `&clahe=${encodeURIComponent(String(value))}`;
    }

    function updateIouMaskFilterText() {
        if (iouMaskFilterText) {
            iouMaskFilterText.textContent = iouMaskFilterCheckbox && iouMaskFilterCheckbox.checked ? 'On' : 'Off';
        }
    }

    function buildIouMaskFilterQuery() {
        const value = Boolean(iouMaskFilterCheckbox && iouMaskFilterCheckbox.checked);
        return `&iou_mask_filter=${encodeURIComponent(String(value))}`;
    }

    async function saveVideoOptions(fileName) {
        const value = String(fileName || '').trim();
        if (!value) {
            return false;
        }

        const apiBase = await resolveApiBase();
        const url = `${apiBase}/fast/sam2/video_options?file_name=${encodeURIComponent(value)}&model_name=auto${buildPromptFrameQuery()}${buildBboxQuery()}${buildPointsQuery()}${buildPointLabelsQuery()}${buildMultimaskOutputQuery()}${buildMaskInputQuery()}${buildClaheQuery()}${buildIouMaskFilterQuery()}`;
        const response = await fetch(url, { method: 'POST' });
        if (!response.ok) {
            return false;
        }
        const result = await response.json();
        return result && result.saved === true;
    }

    async function waitForSegmentResult(apiBase, response) {
        const initialResult = await response.json();
        if (!initialResult || !initialResult.job_id) {
            return initialResult;
        }

        const statusUrl = `${apiBase}/fast/sam2/segment_status/${encodeURIComponent(initialResult.job_id)}`;
        while (true) {
            await new Promise((resolve) => window.setTimeout(resolve, 500));
            const statusResponse = await fetch(statusUrl, { cache: 'no-store' });
            const statusResult = await statusResponse.json();
            const progress = Math.max(0, Math.min(99, Number(statusResult.progress) || 0));
            setStatus(`SAM2 검출 진행중 ... (${progress}%)`, 'info');

            if (statusResult.status === 'completed') {
                return statusResult.result && typeof statusResult.result === 'object'
                    ? statusResult.result
                    : statusResult;
            }
            if (statusResult.status === 'failed') {
                throw new Error(statusResult.error || 'SAM2 segmentation failed');
            }
        }
    }

    async function previewSelectedVideoFirstFrame(showInputTab, inputPath) {
        if (!selectedServerFileName) {
            debugSam2('원본 영상 미리보기 건너뜀: 선택된 서버 파일 없음');
            return;
        }

        debugSam2('원본 영상 미리보기 시작', {
            selectedServerFileName,
            inputPath: String(inputPath || ''),
            showInputTab: Boolean(showInputTab),
        });

        if (showInputTab) {
            const inputTabButton = document.getElementById('sam2-input-tab');
            if (inputTabButton) {
                if (window.bootstrap && typeof window.bootstrap.Tab === 'function') {
                    window.bootstrap.Tab.getOrCreateInstance(inputTabButton).show();
                } else {
                    inputTabButton.click();
                }
            }
        }

        const apiBase = await resolveApiBase();
        const inputPathUrl = String(inputPath || '').trim() || `/fast/image/${selectedServerFileName}`;
        debugSam2('원본 영상 URL 확인', { apiBase, inputPathUrl });
        try {
            const inputUrl = await resolvePlayableVideoUrl(apiBase, inputPathUrl, true);
            debugSam2('원본 재생 URL 확인 완료', { inputUrl });
            await assignInputVideoSource(inputVideoElement, inputUrl);
            debugSam2('원본 영상 source 연결 완료', {
                src: inputVideoElement.currentSrc || inputVideoElement.src,
                readyState: inputVideoElement.readyState,
                networkState: inputVideoElement.networkState,
                duration: inputVideoElement.duration,
            });
        } catch (playableError) {
            const directInputUrl = buildAbsoluteUrl(apiBase, inputPathUrl);
            console.warn('[SAM2] 재생 URL 로드 실패, 원본 URL fallback 시도', {
                error: playableError,
                directInputUrl,
            });
            try {
                await assignInputVideoSource(inputVideoElement, directInputUrl);
                debugSam2('원본 URL fallback 연결 완료', {
                    src: inputVideoElement.currentSrc || inputVideoElement.src,
                    readyState: inputVideoElement.readyState,
                    networkState: inputVideoElement.networkState,
                    duration: inputVideoElement.duration,
                });
            } catch (_directError) {
                console.error('[SAM2] 원본 영상 URL과 fallback 모두 로드 실패', {
                    playableError,
                    directError: _directError,
                    mediaError: inputVideoElement.error,
                    src: inputVideoElement.currentSrc || inputVideoElement.src,
                    readyState: inputVideoElement.readyState,
                    networkState: inputVideoElement.networkState,
                });
                throw playableError;
            }
        }
        inputVideoElement.pause();
        inputVideoElement.currentTime = 0;
        await loadInputVideoMetadata(selectedServerFileName);
        ensureDefaultBoundingBox();
        renderBoundingBoxUi();

        if (!showInputTab) {
            return;
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
        yoloInputFileName = '';
        yoloConversionAvailable = false;
        if (yoloDatasetSummaryElement) {
            yoloDatasetSummaryElement.textContent = '';
        }
        updateYoloClassTabs();
        updateOutputDownloadState();
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
            setUploadText(selectedFileElement, `선택됨: ${selectedFile.name}`);
        } else {
            setUploadText(selectedFileElement, '선택된 파일 없음');
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

    function fileStem(pathOrName) {
        const name = basename(pathOrName);
        const dotIndex = name.lastIndexOf('.');
        return dotIndex > 0 ? name.slice(0, dotIndex) : name;
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

    function sortUploadedHistoryByName(items) {
        return items.sort((left, right) => String(left && left.name || '').localeCompare(
            String(right && right.name || ''),
            undefined,
            { numeric: true, sensitivity: 'base' },
        ));
    }

    function extractYoloClassName(fileName) {
        const name = basename(fileName);
        const match = name.match(/^(.+?)_?\d+\.mp4$/i);
        return match ? match[1] : '';
    }

    function getYoloClassNames() {
        return Array.from(new Set(
            uploadedHistory
                .map((item) => extractYoloClassName(item && item.name))
                .filter(Boolean)
        )).sort((left, right) => left.localeCompare(right, undefined, {
            numeric: true,
            sensitivity: 'base',
        }));
    }

    async function deleteYoloDataset(item, deleteButton) {
        if (deleteButton.getAttribute('aria-disabled') === 'true') {
            return;
        }
        const inputStem = fileStem(item.name);
        if (!window.confirm(`${inputStem}의 YOLO 학습 데이터를 삭제하시겠습니까?`)) {
            return;
        }

        deleteButton.classList.add('disabled');
        deleteButton.setAttribute('aria-disabled', 'true');
        try {
            const deleteApiBase = await resolveApiBase();
            const fileName = item.serverFileName || item.name;
            const response = await fetch(
                `${deleteApiBase}/fast/sam2/yolo_dataset?file_name=${encodeURIComponent(fileName)}`,
                { method: 'DELETE' }
            );
            if (!response.ok) {
                let errorMessage = `학습 데이터 삭제 실패 (${response.status})`;
                try {
                    const errorBody = await response.json();
                    if (errorBody && errorBody.detail) {
                        errorMessage = String(errorBody.detail);
                    }
                } catch (_ignore) {
                    // Keep default error message.
                }
                throw new Error(errorMessage);
            }

            const result = await response.json();
            item.hasYoloDataset = false;
            updateYoloClassTabs(extractYoloClassName(item.name));
            updateYoloTrainingOverview();
            setStatus(`${inputStem} 학습 데이터 ${Number(result.deleted_count || 0)}개 삭제 완료`, 'success');
        } catch (error) {
            deleteButton.classList.remove('disabled');
            deleteButton.removeAttribute('aria-disabled');
            setStatus(error && error.message ? error.message : '학습 데이터 삭제에 실패했습니다.', 'danger');
        }
    }

    function initializeYoloFrameViewer(item, fileTabPane) {
        const loadingElement = fileTabPane.querySelector('[data-role="frame-loading"]');
        const viewerElement = fileTabPane.querySelector('[data-role="frame-viewer"]');
        const frameSlider = fileTabPane.querySelector('[data-role="frame-slider"]');
        const increaseFrameButton = fileTabPane.querySelector('[data-role="frame-increase"]');
        const decreaseFrameButton = fileTabPane.querySelector('[data-role="frame-decrease"]');
        const counterElement = fileTabPane.querySelector('[data-role="frame-counter"]');
        const imageTabButton = fileTabPane.querySelector('[data-role="frame-image-tab"]');
        const maskTabButton = fileTabPane.querySelector('[data-role="frame-mask-tab"]');
        const overlayTabButton = fileTabPane.querySelector('[data-role="frame-overlay-tab"]');
        const segTabButton = fileTabPane.querySelector('[data-role="frame-seg-tab"]');
        const imageTabPane = fileTabPane.querySelector('[data-role="frame-image-pane"]');
        const maskTabPane = fileTabPane.querySelector('[data-role="frame-mask-pane"]');
        const overlayTabPane = fileTabPane.querySelector('[data-role="frame-overlay-pane"]');
        const segTabPane = fileTabPane.querySelector('[data-role="frame-seg-pane"]');
        const imageElement = fileTabPane.querySelector('[data-role="frame-image"]');
        const maskElement = fileTabPane.querySelector('[data-role="frame-mask"]');
        const overlayImageElement = fileTabPane.querySelector('[data-role="frame-overlay-image"]');
        const overlayMaskElement = fileTabPane.querySelector('[data-role="frame-overlay-mask"]');
        const classIdElement = fileTabPane.querySelector('[data-role="frame-class-id"]');
        const classNameElement = fileTabPane.querySelector('[data-role="frame-class-name"]');
        const labelElement = fileTabPane.querySelector('[data-role="frame-label"]');
        if (!loadingElement || !viewerElement || !frameSlider || !increaseFrameButton || !decreaseFrameButton || !counterElement || !imageTabButton || !maskTabButton || !overlayTabButton || !segTabButton || !imageTabPane || !maskTabPane || !overlayTabPane || !segTabPane || !imageElement || !maskElement || !overlayImageElement || !overlayMaskElement || !classIdElement || !classNameElement || !labelElement) {
            return async function () {};
        }

        [
            [imageTabButton, imageTabPane, 'image'],
            [maskTabButton, maskTabPane, 'mask'],
            [overlayTabButton, overlayTabPane, 'overlay'],
            [segTabButton, segTabPane, 'seg'],
        ].forEach(([tabButton, tabPane, suffix]) => {
            const tabId = `${fileTabPane.id}-${suffix}-tab`;
            const paneId = `${fileTabPane.id}-${suffix}-pane`;
            tabButton.id = tabId;
            tabButton.setAttribute('data-bs-target', `#${paneId}`);
            tabButton.setAttribute('aria-controls', paneId);
            tabPane.id = paneId;
            tabPane.setAttribute('aria-labelledby', tabId);
        });

        let frames = [];
        let framePosition = 0;
        let apiBase = '';
        let loaded = false;
        let loading = false;
        let labelRequestSequence = 0;
        const yoloClassName = extractYoloClassName(item.serverFileName || item.name) || '-';

        function renderSegmentationData(labelText) {
            const labelLines = String(labelText || '').trim().split(/\r?\n/).filter(Boolean);
            const classIds = [];
            const polygons = [];
            labelLines.forEach((line) => {
                const parts = line.trim().split(/\s+/);
                if (parts.length === 0) {
                    return;
                }
                if (!classIds.includes(parts[0])) {
                    classIds.push(parts[0]);
                }
                if (parts.length > 1) {
                    polygons.push(parts.slice(1).join(' '));
                }
            });
            classIdElement.textContent = classIds.join(', ') || '-';
            classNameElement.textContent = yoloClassName;
            labelElement.textContent = polygons.join('\n') || 'Seg Polygon 데이터가 없습니다.';
        }

        async function renderFrame() {
            const frame = frames[framePosition];
            if (!frame) {
                return;
            }

            const requestSequence = ++labelRequestSequence;
            counterElement.textContent = `${framePosition + 1} / ${frames.length} · (원본 프레임 ${frame.frame_index})`;
            frameSlider.value = String(framePosition);
            increaseFrameButton.disabled = framePosition >= frames.length - 1;
            decreaseFrameButton.disabled = framePosition <= 0;
            imageElement.src = `${apiBase}${frame.image_url}`;
            maskElement.src = `${apiBase}${frame.mask_url}`;
            overlayImageElement.src = `${apiBase}${frame.image_url}`;
            overlayMaskElement.style.maskImage = `url("${apiBase}${frame.mask_url}")`;
            classIdElement.textContent = '-';
            classNameElement.textContent = yoloClassName;
            labelElement.textContent = 'Seg Polygon 데이터를 불러오는 중...';
            try {
                const response = await fetch(`${apiBase}${frame.label_url}`, { cache: 'no-store' });
                if (!response.ok) {
                    throw new Error(`라벨 조회 실패 (${response.status})`);
                }
                const labelText = await response.text();
                if (requestSequence === labelRequestSequence) {
                    renderSegmentationData(labelText);
                }
            } catch (error) {
                if (requestSequence === labelRequestSequence) {
                    classIdElement.textContent = '-';
                    labelElement.textContent = error && error.message ? error.message : '라벨을 불러오지 못했습니다.';
                }
            }
        }

        frameSlider.addEventListener('input', () => {
            framePosition = Number.parseInt(frameSlider.value, 10) || 0;
            renderFrame();
        });

        increaseFrameButton.addEventListener('click', () => {
            framePosition = Math.min(frames.length - 1, framePosition + 1);
            renderFrame();
        });

        decreaseFrameButton.addEventListener('click', () => {
            framePosition = Math.max(0, framePosition - 1);
            renderFrame();
        });

        return async function loadYoloFrames() {
            if (loaded || loading) {
                return;
            }
            loading = true;
            loadingElement.classList.remove('d-none');
            loadingElement.textContent = '프레임 데이터를 불러오는 중...';
            try {
                apiBase = await resolveApiBase();
                const fileName = item.serverFileName || item.name;
                const response = await fetch(
                    `${apiBase}/fast/sam2/yolo_dataset_frames?file_name=${encodeURIComponent(fileName)}`,
                    { cache: 'no-store' }
                );
                if (!response.ok) {
                    throw new Error(`프레임 목록 조회 실패 (${response.status})`);
                }
                const result = await response.json();
                frames = Array.isArray(result.frames) ? result.frames : [];
                loaded = true;
                if (frames.length === 0) {
                    loadingElement.textContent = '확인할 YOLO 변환 프레임이 없습니다.';
                    return;
                }
                loadingElement.classList.add('d-none');
                viewerElement.classList.remove('d-none');
                framePosition = 0;
                frameSlider.min = '0';
                frameSlider.max = String(frames.length - 1);
                frameSlider.step = '1';
                frameSlider.value = '0';
                frameSlider.disabled = frames.length <= 1;
                await renderFrame();
            } catch (error) {
                loadingElement.textContent = error && error.message ? error.message : '프레임 데이터를 불러오지 못했습니다.';
            } finally {
                loading = false;
            }
        };
    }

    function updateYoloClassTabs(preferredClassName) {
        if (!yoloClassTabsElement || !yoloClassTabContentElement || !yoloClassTabTemplate || !yoloFileTabTemplate || !yoloClassEmptyTemplate) {
            return;
        }

        const classNames = getYoloClassNames();
        const currentActiveClassName = yoloClassTabsElement.querySelector('.nav-link.active')?.dataset.className || '';
        const detectedClassName = extractYoloClassName(yoloInputFileName);
        const requestedClassName = String(preferredClassName || '').trim();
        const activeClassName = [requestedClassName, currentActiveClassName, detectedClassName, classNames[0]]
            .find((className) => classNames.includes(className)) || '';

        yoloClassTabsElement.innerHTML = '';
        yoloClassTabContentElement.innerHTML = '';

        if (classNames.length === 0) {
            yoloClassTabContentElement.appendChild(yoloClassEmptyTemplate.content.cloneNode(true));
            return;
        }

        classNames.forEach((className, index) => {
            const isActive = className === activeClassName;
            const tabId = `sam2-yolo-class-tab-${index}`;
            const paneId = `sam2-yolo-class-pane-${index}`;
            const classVideos = uploadedHistory.filter((item) => (
                item
                && item.hasYoloDataset === true
                && extractYoloClassName(item.name) === className
            ));
            const activeInputName = basename(yoloInputFileName);

            const fragment = yoloClassTabTemplate.content.cloneNode(true);
            const tabItem = fragment.querySelector('[data-role="tab-item"]');
            const tabButton = fragment.querySelector('[data-role="tab-button"]');
            const tabPane = fragment.querySelector('[data-role="tab-pane"]');
            const fileTabsElement = fragment.querySelector('[data-role="file-tabs"]');
            const fileTabContentElement = fragment.querySelector('[data-role="file-tab-content"]');
            if (!tabItem || !tabButton || !tabPane || !fileTabsElement || !fileTabContentElement) {
                return;
            }

            tabButton.className = `nav-link${isActive ? ' active' : ''}`;
            tabButton.id = tabId;
            tabButton.setAttribute('data-bs-target', `#${paneId}`);
            tabButton.setAttribute('aria-controls', paneId);
            tabButton.setAttribute('aria-selected', String(isActive));
            tabButton.dataset.className = className;
            tabButton.textContent = `${className} (${classVideos.length})`;
            tabPane.className = `tab-pane fade${isActive ? ' show active' : ''}`;
            tabPane.id = paneId;
            tabPane.setAttribute('role', 'tabpanel');
            tabPane.setAttribute('aria-labelledby', tabId);

            let activeFileViewerLoader = null;
            const activeFileIndex = Math.max(0, classVideos.findIndex((item) => basename(item && item.name) === activeInputName));
            if (classVideos.length === 0) {
                fileTabContentElement.appendChild(yoloClassEmptyTemplate.content.cloneNode(true));
            }
            classVideos.forEach((item, fileIndex) => {
                const isActiveFile = fileIndex === activeFileIndex;
                const fileTabId = `sam2-yolo-file-tab-${index}-${fileIndex}`;
                const filePaneId = `sam2-yolo-file-pane-${index}-${fileIndex}`;
                const fileFragment = yoloFileTabTemplate.content.cloneNode(true);
                const fileTabItem = fileFragment.querySelector('[data-role="file-tab-item"]');
                const fileTabButton = fileFragment.querySelector('[data-role="file-tab-button"]');
                const fileTabTitle = fileFragment.querySelector('[data-role="file-tab-title"]');
                const deleteButton = fileFragment.querySelector('[data-role="dataset-delete"]');
                const fileTabPane = fileFragment.querySelector('[data-role="file-tab-pane"]');
                if (!fileTabItem || !fileTabButton || !fileTabTitle || !deleteButton || !fileTabPane) {
                    return;
                }

                fileTabButton.className = `nav-link${isActiveFile ? ' active' : ''}`;
                fileTabButton.id = fileTabId;
                fileTabButton.setAttribute('data-bs-target', `#${filePaneId}`);
                fileTabButton.setAttribute('aria-controls', filePaneId);
                fileTabButton.setAttribute('aria-selected', String(isActiveFile));
                fileTabTitle.textContent = fileStem(item.name);
                fileTabPane.className = `tab-pane fade${isActiveFile ? ' show active' : ''}`;
                fileTabPane.id = filePaneId;
                fileTabPane.setAttribute('aria-labelledby', fileTabId);
                deleteButton.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    deleteYoloDataset(item, deleteButton);
                });
                const loadFrameViewer = initializeYoloFrameViewer(item, fileTabPane);
                fileTabButton.addEventListener('shown.bs.tab', loadFrameViewer);
                fileTabButton.addEventListener('click', loadFrameViewer);
                if (isActiveFile) {
                    activeFileViewerLoader = loadFrameViewer;
                }
                fileTabsElement.appendChild(fileTabItem);
                fileTabContentElement.appendChild(fileTabPane);
            });

            yoloClassTabsElement.appendChild(tabItem);
            yoloClassTabContentElement.appendChild(tabPane);
            tabButton.addEventListener('shown.bs.tab', () => activeFileViewerLoader?.());
            if (isActive) {
                activeFileViewerLoader?.();
            }
        });

        updateOutputDownloadState();
    }

    function renderUploadedHistory() {
        updateYoloClassTabs();
        if (!uploadedListElement) {
            return;
        }

        uploadedListElement.querySelectorAll('li[data-uploaded-history-item="true"]').forEach((item) => {
            item.remove();
        });
        uploadedListElement.querySelectorAll('#sam2-uploaded-empty').forEach((item) => {
            item.remove();
        });

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
            li.dataset.uploadedHistoryItem = 'true';
            li.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                showUploadedContextMenu(event, item);
            });

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

                debugSam2('업로드 동영상 클릭', {
                    name: item.name,
                    serverFileName: item.serverFileName,
                    inputUrl: item.inputUrl,
                    playableUrl: item.playableUrl,
                    outputUrl: item.outputUrl,
                });

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
                    await previewSelectedVideoFirstFrame(false, item.playableUrl || item.inputUrl);
                } catch (error) {
                    const message = error && error.message ? error.message : '원본 영상 로드 실패';
                    setStatus(`원본 영상 로드 실패: ${message}`, 'warning');
                }

                await loadVideoOptions(selectedServerFileName);
                const hasExistingOutput = await loadExistingOutputVideo(
                    item.outputUrl,
                    item.serverFileName,
                    item.yoloConversionAvailable
                );
                loadOutputTab();

                renderUploadedHistory();
                setStatus(
                    hasExistingOutput
                        ? `선택됨: ${item.name} (기존 검출 영상 표시)`
                        : `선택됨: ${item.name} (검출 버튼을 눌러 실행)`,
                    'secondary'
                );
            });

            row.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                showUploadedContextMenu(event, item);
            });

            uploadedListElement.appendChild(li);
        }
    }

    function hideUploadedContextMenu() {
        if (uploadedContextMenuElement) {
            uploadedContextMenuElement.remove();
            uploadedContextMenuElement = null;
        }
    }

    function showUploadedContextMenu(event, item) {
        hideUploadedContextMenu();
        const menu = document.createElement('div');
        menu.className = 'bg-white border rounded shadow-sm p-1';
        menu.style.position = 'fixed';
        menu.style.left = `${Math.min(event.clientX, window.innerWidth - 150)}px`;
        menu.style.top = `${Math.min(event.clientY, window.innerHeight - 90)}px`;
        menu.style.zIndex = '2000';

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'btn btn-danger btn-sm w-100 mb-1';
        deleteButton.textContent = '삭제';
        deleteButton.addEventListener('click', async () => {
            hideUploadedContextMenu();
            await deleteUploadedVideo(item);
        });
        menu.appendChild(deleteButton);

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'btn btn-outline-secondary btn-sm w-100';
        cancelButton.textContent = '취소';
        cancelButton.addEventListener('click', hideUploadedContextMenu);
        menu.appendChild(cancelButton);
        document.body.appendChild(menu);
        uploadedContextMenuElement = menu;
    }

    async function deleteUploadedVideo(item) {
        if (!item || !item.serverFileName) {
            return;
        }
        try {
            let response = await fetch(`/fast/sam2/uploaded_video?file_name=${encodeURIComponent(item.serverFileName)}`, {
                method: 'DELETE',
            });
            if (!response.ok) {
                const apiBase = await resolveApiBase();
                response = await fetch(`${apiBase}/fast/sam2/uploaded_video?file_name=${encodeURIComponent(item.serverFileName)}`, {
                    method: 'DELETE',
                });
            }
            if (!response.ok) {
                throw new Error(`삭제 실패 (${response.status})`);
            }
            uploadedHistory = uploadedHistory.filter(historyItem => historyItem.serverFileName !== item.serverFileName);
            if (selectedServerFileName === item.serverFileName) {
                selectedServerFileName = '';
                highlightedServerFileName = '';
                stopCurrentOutputPlayback();
                inputVideoElement?.removeAttribute('src');
                inputVideoElement?.load();
                saveSelectedVideo('');
                updateDetectionControlState();
            }
            renderUploadedHistory();
            setStatus(`삭제됨: ${item.name}`, 'success');
        } catch (error) {
            setStatus(error instanceof Error ? error.message : '삭제 중 오류가 발생했습니다.', 'danger');
        }
    }

    document.addEventListener('click', (event) => {
        if (uploadedContextMenuElement && !uploadedContextMenuElement.contains(event.target)) {
            hideUploadedContextMenu();
        }
    });

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

        sortUploadedHistoryByName(uploadedHistory);
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
                    const message = `업로드 목록 조회 실패 (${response.status})`;
                    setStatus(message, 'warning');
                    window.alert(message);
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
                inputUrl: String(item.input_url || ''),
                playableUrl: String(item.playable_url || ''),
                outputUrl: String(item.output_url || ''),
                yoloConversionAvailable: item.yolo_conversion_available === true,
                hasYoloDataset: item.has_yolo_dataset === true,
            }));

            if (requestSeq !== uploadedListLatestRequestSeq) {
                return;
            }

            uploadedHistory = sortUploadedHistoryByName(mapped);

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
                        await previewSelectedVideoFirstFrame(false, matchedSelected.playableUrl || matchedSelected.inputUrl);
                    } catch (error) {
                        const message = error && error.message ? error.message : '원본 영상 로드 실패';
                        setStatus(`원본 영상 로드 실패: ${message}`, 'warning');
                    }
                    await loadVideoOptions(selectedServerFileName);
                    const hasExistingOutput = await loadExistingOutputVideo(
                        matchedSelected.outputUrl,
                        matchedSelected.serverFileName,
                        matchedSelected.yoloConversionAvailable
                    );
                    loadOutputTab();
                    renderUploadedHistory();
                    setStatus(
                        hasExistingOutput
                            ? `이전 선택 복원: ${matchedSelected.name} (기존 검출 영상 표시)`
                            : `이전 선택 복원: ${matchedSelected.name}`,
                        'secondary'
                    );
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
                const message = '업로드 목록을 불러오지 못했습니다. API 연결 상태를 확인하세요.';
                setStatus(message, 'warning');
                window.alert(message);
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

        if (pathValue.toLowerCase().includes('.playable.mp4')) {
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

    async function loadExistingOutputVideo(outputUrl, inputFileName, conversionAvailable) {
        const value = String(outputUrl || '').trim();
        if (!value) {
            return false;
        }

        try {
            const apiBase = await resolveApiBase();
            const playableUrl = await resolvePlayableVideoUrl(apiBase, value, true);
            await assignVideoSource(outputVideoElement, playableUrl, 'output');
            applyLoopOption();
            yoloInputFileName = String(inputFileName || '').trim();
            yoloConversionAvailable = conversionAvailable === true;
            updateYoloClassTabs(extractYoloClassName(yoloInputFileName));
            updateOutputDownloadState();
            return true;
        } catch (_ignore) {
            return false;
        }
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

        if (objectUrlKey === 'output') {
            updateOutputDownloadState();
        }

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
            videoElement.src = newObjectUrl;
            videoElement.load();

            if (videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                onLoadedData();
            }
        });
    }

    async function assignInputVideoSource(videoElement, sourceUrl) {
        if (inputObjectUrl) {
            URL.revokeObjectURL(inputObjectUrl);
            inputObjectUrl = '';
        }

        await new Promise((resolve, reject) => {
            debugSam2('원본 video source 설정', { sourceUrl });
            const cleanup = () => {
                videoElement.removeEventListener('loadeddata', onLoadedData);
                videoElement.removeEventListener('error', onError);
            };

            const onLoadedData = () => {
                debugSam2('원본 video loadeddata', {
                    readyState: videoElement.readyState,
                    networkState: videoElement.networkState,
                    duration: videoElement.duration,
                });
                cleanup();
                resolve();
            };

            const onError = () => {
                const mediaError = videoElement.error;
                const code = mediaError && mediaError.code ? mediaError.code : 'unknown';
                console.error('[SAM2] 원본 video error', {
                    code,
                    message: mediaError && mediaError.message,
                    sourceUrl,
                    readyState: videoElement.readyState,
                    networkState: videoElement.networkState,
                });
                cleanup();
                reject(new Error(`원본 영상 디코딩 실패 (code: ${code})`));
            };

            videoElement.addEventListener('loadeddata', onLoadedData, { once: true });
            videoElement.addEventListener('error', onError, { once: true });
            videoElement.src = sourceUrl;
            videoElement.load();
            debugSam2('원본 video load 호출', {
                currentSrc: videoElement.currentSrc,
                readyState: videoElement.readyState,
                networkState: videoElement.networkState,
            });

            if (videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                onLoadedData();
            }
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
            setStatus(`파일 용량이 너무 큽니다. 최대 크기는 ${maxText} 입니다.`, 'warning');
            return;
        }

        applyUploadDefaultOptions();
        setSelectedFile(file);
        showInputSourceTab('sam2-uploaded-source-tab');
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
        setUploadProgress(0);
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
                await previewSelectedVideoFirstFrame(false, uploadResult.playable_url || uploadResult.input_url);
            } catch (_ignore) {
                // Keep successful upload flow even if preview fails.
            }
            await loadVideoOptions(selectedServerFileName);
            loadOutputTab();

            uploadCompleted = true;
            setStatus('동영상 업로드 완료. 검출 시작 버튼을 눌러주세요.', 'success');
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            // Fallback: keep selected file so segment_video_upload can still upload+segment.
            if (uploadProgressBarElement) {
                uploadProgressBarElement.style.width = '100%';
                uploadProgressBarElement.setAttribute('aria-valuenow', '100');
                uploadProgressBarElement.classList.remove('progress-bar-animated');
                uploadProgressBarElement.classList.remove('progress-bar-striped');
                uploadProgressBarElement.classList.add('bg-danger');
            }
            setUploadText(uploadProgressStatusElement, '실패');
            setStatus(`업로드 오류: ${message} (검출 시작 시 업로드 재시도)`, 'danger');
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
                setStatus('하이라이트된 동영상을 자동 선택하여 검출을 시작합니다.', 'secondary');
            }
        }

        if (!file && !selectedServerFileName) {
            setStatus('동영상 파일을 선택하세요.', 'warning');
            return;
        }

        detectButton.disabled = true;
        stopCurrentOutputPlayback();
        setStatus('SAM2 검출 진행중 ...', 'info');

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
                const url = `${apiBase}/fast/sam2/segment_video_upload?${bboxQuery.slice(1)}${pointsQuery}${pointLabelsQuery}${buildPromptFrameQuery()}${buildMultimaskOutputQuery()}${buildMaskInputQuery()}${buildClaheQuery()}${buildIouMaskFilterQuery()}`;
                response = await fetch(url, {
                    method: 'POST',
                    body: formData,
                });
            } else {
                const url = `${apiBase}/fast/sam2/segment_saved_video?file_name=${encodeURIComponent(selectedServerFileName)}${bboxQuery}${pointsQuery}${pointLabelsQuery}${buildPromptFrameQuery()}${buildMultimaskOutputQuery()}${buildMaskInputQuery()}${buildClaheQuery()}${buildIouMaskFilterQuery()}`;
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

            const result = await waitForSegmentResult(apiBase, response);

            if (file) {
                const relativeServerPath = extractFastImagePath(result.input_url) || String(result.input_file || '').trim();
                selectedServerFileName = String(relativeServerPath || selectedServerFileName);
                highlightedServerFileName = selectedServerFileName;
                saveSelectedVideo(selectedServerFileName);
                await loadUploadedHistoryFromServer();
            }

            const inputUrl = await resolvePlayableVideoUrl(apiBase, result.input_url, true);
            const outputUrl = await resolvePlayableVideoUrl(apiBase, result.output_url, true);
            yoloInputFileName = extractFastImagePath(result.input_url)
                || selectedServerFileName
                || '';
            yoloConversionAvailable = result.yolo_conversion_available === true;
            if (yoloDatasetSummaryElement) {
                yoloDatasetSummaryElement.textContent = yoloConversionAvailable
                    ? ''
                    : 'YOLO 학습 데이터로 변환할 수 없습니다.';
            }
            updateYoloClassTabs(extractYoloClassName(yoloInputFileName));
            updateOutputDownloadState();

            await assignVideoSource(inputVideoElement, inputUrl, 'input');
            await assignVideoSource(outputVideoElement, outputUrl, 'output');

            const outputTabButton = document.getElementById('sam2-output-tab');
            if (outputTabButton) {
                if (window.bootstrap && typeof window.bootstrap.Tab === 'function') {
                    window.bootstrap.Tab.getOrCreateInstance(outputTabButton).show();
                } else {
                    outputTabButton.click();
                }
            }

            applyLoopOption();

            setStatus('검출 완료', 'success');
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

    document.querySelectorAll('#sam2-video-tabs [data-bs-toggle="tab"]').forEach((tabButton) => {
        tabButton.addEventListener('click', (event) => {
            if (!event.isTrusted) {
                return;
            }
            const tabId = event.currentTarget && event.currentTarget.id;
            if (tabId) {
                try {
                    localStorage.setItem(STORAGE_OUTPUT_TAB_KEY, tabId);
                } catch (_ignore) {
                    // Keep the current tab when localStorage is unavailable.
                }
            }
        });
    });

    const outputTabButton = document.getElementById('sam2-output-tab');
    if (outputTabButton) {
        outputTabButton.addEventListener('shown.bs.tab', () => {
            if (outputObjectUrl || !selectedServerFileName) {
                return;
            }

            const selectedItem = uploadedHistory.find(
                (item) => item.serverFileName === selectedServerFileName
            );
            if (selectedItem && selectedItem.outputUrl) {
                void loadExistingOutputVideo(
                    selectedItem.outputUrl,
                    selectedItem.serverFileName,
                    selectedItem.yoloConversionAvailable
                );
            }
        });
    }

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
    if (outputDownloadButton) {
        outputDownloadButton.addEventListener('click', downloadDetectedVideo);
    }
    if (yoloConvertButton) {
        yoloConvertButton.addEventListener('click', convertYoloDataset);
    }
    function setPointMode(mode) {
        if (!hasSelectedVideo()) {
            setStatus('먼저 동영상을 선택하세요.', 'warning');
            return;
        }

        detectionMode = mode;
        const isForeground = mode === 'foreground';
        foregroundPointModeButton?.classList.toggle('btn-primary', isForeground);
        foregroundPointModeButton?.classList.toggle('btn-outline-primary', !isForeground);
        backgroundPointModeButton?.classList.toggle('btn-primary', !isForeground);
        backgroundPointModeButton?.classList.toggle('btn-outline-primary', isForeground);
        bboxModeButton?.classList.add('btn-outline-primary');
        bboxModeButton?.classList.remove('btn-primary');
        setStatus(`${isForeground ? '전경' : '배경'} Point 설정 모드입니다.`, 'secondary');
    }

    if (foregroundPointModeButton) {
        foregroundPointModeButton.addEventListener('click', () => {
            setPointMode('foreground');
        });
    }
    if (backgroundPointModeButton) {
        backgroundPointModeButton.addEventListener('click', () => {
            setPointMode('background');
        });
    }
    if (bboxModeButton) {
        bboxModeButton.addEventListener('click', () => {
            if (!hasSelectedVideo()) {
                setStatus('먼저 동영상을 선택하세요.', 'warning');
                return;
            }
            detectionMode = 'bbox';
            foregroundPointModeButton?.classList.add('btn-outline-primary');
            foregroundPointModeButton?.classList.remove('btn-primary');
            backgroundPointModeButton?.classList.add('btn-outline-primary');
            backgroundPointModeButton?.classList.remove('btn-primary');
            bboxModeButton?.classList.add('btn-outline-primary');
            bboxModeButton.classList.remove('btn-outline-primary');
            bboxModeButton.classList.add('btn-primary');
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
    if (optionsSaveButton) {
        optionsSaveButton.addEventListener('click', async () => {
            if (!selectedServerFileName) {
                setStatus('서버에 저장할 동영상을 먼저 선택하세요.', 'warning');
                return;
            }

            optionsSaveButton.disabled = true;
            try {
                const saved = await saveVideoOptions(selectedServerFileName);
                setStatus(
                    saved ? '검출 옵션을 서버에 저장했습니다.' : '검출 옵션 저장에 실패했습니다.',
                    saved ? 'secondary' : 'warning'
                );
            } catch (_ignore) {
                setStatus('검출 옵션 저장에 실패했습니다.', 'warning');
            } finally {
                updateDetectionControlState();
            }
        });
    }
    if (optionsResetButton) {
        optionsResetButton.addEventListener('click', async () => {
            if (!selectedServerFileName) {
                setStatus('서버에 저장된 검출 설정을 찾을 수 없습니다.', 'warning');
                return;
            }

            optionsResetButton.disabled = true;
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
            if (pointContextMenuElement) {
                if (pointContextMenuElement.contains(event.target)) {
                    return;
                }
                hidePointContextMenu();
            }
            if (detectionMode === 'foreground' || detectionMode === 'background') {
                if (suppressPointClick) {
                    suppressPointClick = false;
                    return;
                }
                addPointByClick(event);
            }
        });
        bboxCaptureLayerElement.addEventListener('contextmenu', selectPointByRightClick);
        bboxCaptureLayerElement.addEventListener('mousemove', updatePointInputCursor);
        bboxCaptureLayerElement.addEventListener('mouseleave', () => {
            bboxCaptureLayerElement.style.cursor = 'default';
        });
        bboxCaptureLayerElement.addEventListener('mousedown', (event) => {
            startPointDrag(event);
            if (pointDragIndex < 0 && detectionMode === 'bbox') {
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
    if (multimaskOutputCheckbox) {
        multimaskOutputCheckbox.addEventListener('change', updateMultimaskOutputText);
        updateMultimaskOutputText();
    }
    if (maskInputCheckbox) {
        maskInputCheckbox.addEventListener('change', updateMaskInputText);
        updateMaskInputText();
    }
    if (claheCheckbox) {
        claheCheckbox.addEventListener('change', updateClaheText);
        updateClaheText();
    }
    if (iouMaskFilterCheckbox) {
        iouMaskFilterCheckbox.addEventListener('change', updateIouMaskFilterText);
        updateIouMaskFilterText();
    }
    if (inputVideoElement) {
        ['loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'waiting', 'stalled', 'abort'].forEach((eventName) => {
            inputVideoElement.addEventListener(eventName, () => {
                const mediaError = inputVideoElement.error;
                debugSam2(`원본 video 이벤트: ${eventName}`, {
                    currentSrc: inputVideoElement.currentSrc || inputVideoElement.src,
                    readyState: inputVideoElement.readyState,
                    networkState: inputVideoElement.networkState,
                    paused: inputVideoElement.paused,
                    currentTime: inputVideoElement.currentTime,
                    duration: inputVideoElement.duration,
                    errorCode: mediaError && mediaError.code,
                    errorMessage: mediaError && mediaError.message,
                });
            });
        });
    }
    setUploadedListLoading(true, '동영상 목록을 불러오는 중...');
    setStatus('업로드 목록을 가져오는 중...', 'info');

    if (uploadedEmptyElement) {
        uploadedEmptyElement.remove();
    }
    updateUploadLimitLabel('default');

    applyLoopOption();
    initializeOutputVideoControls();
    initializeYoloOutputTab();
    loadInputSourceTab();
    loadOutputTab();
    updateDetectionControlState();
    renderPointUi();
    renderBoundingBoxUi();
    if (yoloDatasetSummaryElement) {
        yoloDatasetSummaryElement.textContent = '';
    }

    loadUploadLimitFromServer();
    loadUploadedHistoryFromServer();
    console.log('[SAM2] 페이지 초기화 완료');
})();
