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
    const modelTabsElement = document.getElementById('yolo-model-tabs');
    const modelTabContentElement = document.getElementById('yolo-model-tab-content');

    function createModelPaneTemplate() {
        const sourceElement = document.getElementById('yolo-model-pane-template');
        if (!sourceElement) {
            return null;
        }

        const templateElement = document.createElement('template');
        templateElement.innerHTML = sourceElement.innerHTML;
        sourceElement.remove();
        return templateElement;
    }

    const modelPaneTemplate = createModelPaneTemplate();

    const statusElement = document.getElementById('yolo-status');
    const statusTextElement = document.getElementById('yolo-status-text');
    const uploadProgressWrapElement = document.getElementById('yolo-upload-progress-wrap');
    const uploadProgressLabelElement = document.getElementById('yolo-upload-progress-label');
    const uploadProgressBarElement = document.getElementById('yolo-upload-progress-bar');
    const inputVideoElement = document.getElementById('yolo-input-video');
    const outputVideoElement = document.getElementById('yolo-output-video');

    let selectedFile = null;
    let resolvedApiBase = null;
    let inputObjectUrl = '';
    let outputObjectUrl = '';
    let realtimeDetectTimer = null;
    let detectProgressTimer = null;
    let detectProgressValue = 0;
    let pendingRealtimeDetect = false;
    let uploadedHistory = [];
    let modelHistory = [];
    let selectedServerFileName = '';
    let selectedModelPath = '';
    let selectedModelFileName = '';
    const selectedClassNamesByModelKey = {};

    const REALTIME_DETECT_DEBOUNCE_MS = 300;
    const INPUT_SOURCE_TAB_STORAGE_KEY = 'wcs.yolo.input_source_tab.v1';
    const MODEL_SELECTION_STORAGE_KEY = 'wcs.yolo.model_selection.v1';
    const VIDEO_DETECT_OPTION_STORAGE_KEY = 'wcs.yolo.video_detect_option.v1';
    const STATUS_ALERT_VARIANTS = ['alert-secondary', 'alert-info', 'alert-warning', 'alert-danger', 'alert-success', 'alert-primary'];

    function normalizeThresholdValue(value, fallbackValue) {
        const numeric = toNumber(value, fallbackValue);
        return Math.max(0, Math.min(1, numeric));
    }

    function readVideoDetectOptionMap() {
        try {
            const raw = window.localStorage.getItem(VIDEO_DETECT_OPTION_STORAGE_KEY);
            if (!raw) {
                return {};
            }

            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_ignore) {
            return {};
        }
    }

    function writeVideoDetectOptionMap(optionMap) {
        try {
            window.localStorage.setItem(VIDEO_DETECT_OPTION_STORAGE_KEY, JSON.stringify(optionMap || {}));
        } catch (_ignore) {
            // Ignore storage failures.
        }
    }

    function saveDetectOptionsForSelectedVideo() {
        const selectedVideoKey = String(selectedServerFileName || '').trim();
        if (!selectedVideoKey) {
            return;
        }

        const optionMap = readVideoDetectOptionMap();
        optionMap[selectedVideoKey] = {
            conf: normalizeThresholdValue(confInput.value, 0.25),
            iou: normalizeThresholdValue(iouInput.value, 0.45),
            savedAt: new Date().toISOString(),
        };
        writeVideoDetectOptionMap(optionMap);
    }

    function applyDetectOptionsForSelectedVideo() {
        const selectedVideoKey = String(selectedServerFileName || '').trim();
        if (!selectedVideoKey) {
            return;
        }

        const optionMap = readVideoDetectOptionMap();
        const savedOption = optionMap[selectedVideoKey];
        if (!savedOption || typeof savedOption !== 'object') {
            return;
        }

        confInput.value = String(normalizeThresholdValue(savedOption.conf, 0.25));
        iouInput.value = String(normalizeThresholdValue(savedOption.iou, 0.45));
        updateSliderValueLabels();
    }

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

    function setUploadProgress(percent, show, labelText) {
        if (!uploadProgressWrapElement || !uploadProgressBarElement) {
            return;
        }

        const hasNumericProgress = Number.isFinite(Number(percent));
        const numeric = hasNumericProgress ? Number(percent) : 100;
        const bounded = Math.max(0, Math.min(100, Math.round(numeric)));
        const isComplete = bounded >= 100;

        uploadProgressBarElement.style.width = `${bounded}%`;
        uploadProgressBarElement.setAttribute('aria-valuenow', String(bounded));
        uploadProgressBarElement.classList.toggle('progress-bar-animated', !isComplete);
        uploadProgressBarElement.setAttribute('aria-valuetext', `${bounded}%`);
        if (uploadProgressLabelElement) {
            uploadProgressLabelElement.textContent = `${bounded}%`;
        }

        uploadProgressWrapElement.classList.remove('d-none');
    }

    function stopDetectProgressTicker(finalPercent) {
        if (detectProgressTimer) {
            clearInterval(detectProgressTimer);
            detectProgressTimer = null;
        }

        if (Number.isFinite(Number(finalPercent))) {
            detectProgressValue = Math.max(0, Math.min(100, Number(finalPercent)));
            setUploadProgress(detectProgressValue, true, `${Math.round(detectProgressValue)}%`);
        }
    }

    function startDetectProgressTicker() {
        stopDetectProgressTicker();
        detectProgressValue = 3;
        setUploadProgress(detectProgressValue, true, `${Math.round(detectProgressValue)}%`);

        detectProgressTimer = setInterval(() => {
            if (detectProgressValue >= 95) {
                return;
            }

            // Gradually slow down as it approaches completion to look natural.
            if (detectProgressValue < 40) {
                detectProgressValue += 3;
            } else if (detectProgressValue < 70) {
                detectProgressValue += 2;
            } else {
                detectProgressValue += 1;
            }

            if (detectProgressValue > 95) {
                detectProgressValue = 95;
            }

            setUploadProgress(detectProgressValue, true, `${Math.round(detectProgressValue)}%`);
        }, 700);
    }

    function formatBytes(bytes) {
        const value = Number(bytes);
        if (!Number.isFinite(value) || value < 0) {
            return '0 B';
        }

        const units = ['B', 'KB', 'MB', 'GB'];
        let number = value;
        let unitIndex = 0;
        while (number >= 1024 && unitIndex < units.length - 1) {
            number /= 1024;
            unitIndex += 1;
        }

        const decimals = unitIndex === 0 ? 0 : 1;
        return `${number.toFixed(decimals)} ${units[unitIndex]}`;
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
                    setStatus('동영상 업로드 중...', 'info');
                    return;
                }

                const percent = (event.loaded / event.total) * 100;
                const label = `${Math.round(percent)}% (${formatBytes(event.loaded)} / ${formatBytes(event.total)})`;
                setUploadProgress(percent, true, label);
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

                setUploadProgress(100, true, '100%');

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

    function formatDateTime(value) {
        const text = String(value || '').trim();
        if (!text) {
            return '-';
        }

        return text.replace('T', ' ');
    }

    function getSelectedModelItem() {
        if (!selectedModelPath && !selectedModelFileName) {
            return null;
        }

        return modelHistory.find((item) => {
            return (selectedModelPath && item.modelPath === selectedModelPath)
                || (selectedModelFileName && item.fileName === selectedModelFileName);
        }) || null;
    }

    function setSelectedModelSelection(modelPath, fileName) {
        const normalizedPath = String(modelPath || '').trim();
        const normalizedFileName = String(fileName || '').trim();
        selectedModelPath = normalizedPath;
        selectedModelFileName = normalizedFileName;

        try {
            if (normalizedPath || normalizedFileName) {
                window.localStorage.setItem(MODEL_SELECTION_STORAGE_KEY, normalizedPath);
                window.localStorage.setItem(`${MODEL_SELECTION_STORAGE_KEY}.file`, normalizedFileName);
            } else {
                window.localStorage.removeItem(MODEL_SELECTION_STORAGE_KEY);
                window.localStorage.removeItem(`${MODEL_SELECTION_STORAGE_KEY}.file`);
            }
        } catch (_ignore) {
            // Ignore storage failures.
        }
    }

    function restoreSelectedModelPath() {
        try {
            selectedModelPath = String(window.localStorage.getItem(MODEL_SELECTION_STORAGE_KEY) || '').trim();
            selectedModelFileName = String(window.localStorage.getItem(`${MODEL_SELECTION_STORAGE_KEY}.file`) || '').trim();
        } catch (_ignore) {
            selectedModelPath = '';
            selectedModelFileName = '';
        }
    }

    function getModelSelectionKey(modelItem) {
        if (!modelItem) {
            return '';
        }

        const byPath = String(modelItem.modelPath || '').trim();
        if (byPath) {
            return byPath;
        }

        return String(modelItem.fileName || '').trim();
    }

    function normalizeClassNameList(classNames) {
        if (!Array.isArray(classNames)) {
            return [];
        }

        return classNames
            .map((name) => String(name || '').trim())
            .filter((name) => name.length > 0);
    }

    function ensureModelClassSelection(modelItem) {
        const modelKey = getModelSelectionKey(modelItem);
        const classNames = normalizeClassNameList(modelItem && modelItem.classNames);

        if (!modelKey || classNames.length === 0) {
            return [];
        }

        const existingSelection = Array.isArray(selectedClassNamesByModelKey[modelKey])
            ? selectedClassNamesByModelKey[modelKey]
            : [];

        const cleanedSelection = existingSelection.filter((name) => classNames.includes(name));
        const nextSelection = cleanedSelection.length > 0 ? cleanedSelection : classNames.slice();
        selectedClassNamesByModelKey[modelKey] = nextSelection;
        return nextSelection;
    }

    function getSelectedClassNamesForModel(modelItem) {
        const modelKey = getModelSelectionKey(modelItem);
        if (!modelKey) {
            return [];
        }

        const selectedList = ensureModelClassSelection(modelItem);
        return selectedList.slice();
    }

    function applyClassToggleButtonState(buttonElement, isSelected) {
        if (!buttonElement) {
            return;
        }

        buttonElement.classList.toggle('btn-primary', isSelected);
        buttonElement.classList.toggle('btn-outline-secondary', !isSelected);
        buttonElement.setAttribute('aria-pressed', String(isSelected));
    }

    function renderClassToggleButtons(classListElement, modelItem, selectedClassNames) {
        if (!classListElement) {
            return;
        }

        const classNames = normalizeClassNameList(modelItem && modelItem.classNames);
        if (classNames.length === 0) {
            classListElement.innerHTML = '<span class="badge text-bg-light border text-dark flex-shrink-0" style="font-family: inherit; font-size: inherit;">-</span>';
            return;
        }

        const selectedSet = new Set(selectedClassNames);
        classListElement.innerHTML = '';

        classNames.forEach((className) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-sm yolo-class-toggle-btn px-2 py-0';
            button.style.fontSize = 'inherit';
            button.setAttribute('data-role', 'class-toggle');
            button.setAttribute('data-model-key', getModelSelectionKey(modelItem));
            button.setAttribute('data-class-name', className);
            button.textContent = className;
            applyClassToggleButtonState(button, selectedSet.has(className));
            classListElement.appendChild(button);
        });
    }

    function renderClassSelectionToggleButton(modelBadgesElement, modelItem, selectedClassNames) {
        if (!modelBadgesElement) {
            return;
        }

        const classNames = normalizeClassNameList(modelItem && modelItem.classNames);
        if (classNames.length === 0) {
            return;
        }

        const selectedCount = Array.isArray(selectedClassNames) ? selectedClassNames.length : 0;
        const isAllSelected = selectedCount >= classNames.length;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-sm btn-outline-primary ms-auto px-2 py-0 flex-shrink-0';
        button.setAttribute('data-role', 'class-toggle-all');
        button.setAttribute('data-model-key', getModelSelectionKey(modelItem));
        button.textContent = isAllSelected ? '전체 해제' : '전체 선택';
        modelBadgesElement.appendChild(button);
    }

    function updateClassSelectionToggleButton(paneElement, modelItem, selectedClassNames) {
        if (!paneElement) {
            return;
        }

        const totalCount = normalizeClassNameList(modelItem && modelItem.classNames).length;
        const toggleAllButton = paneElement.querySelector('[data-role="class-toggle-all"]');
        if (toggleAllButton) {
            toggleAllButton.textContent = selectedClassNames.length >= totalCount ? '전체 해제' : '전체 선택';
        }
    }

    function toggleClassNameSelection(modelKey, className) {
        const normalizedModelKey = String(modelKey || '').trim();
        const normalizedClassName = String(className || '').trim();
        if (!normalizedModelKey || !normalizedClassName) {
            return;
        }

        const modelItem = modelHistory.find((item) => getModelSelectionKey(item) === normalizedModelKey);
        if (!modelItem) {
            return;
        }

        const classNames = normalizeClassNameList(modelItem.classNames);
        const selectedList = ensureModelClassSelection(modelItem);
        const selectedSet = new Set(selectedList);

        if (selectedSet.has(normalizedClassName)) {
            selectedSet.delete(normalizedClassName);
        } else {
            selectedSet.add(normalizedClassName);
        }

        const nextSelection = classNames.filter((name) => selectedSet.has(name));
        selectedClassNamesByModelKey[normalizedModelKey] = nextSelection;

        const activePane = modelTabContentElement
            ? modelTabContentElement.querySelector('.tab-pane.active, .tab-pane.show.active')
            : null;

        if (activePane) {
            const selectedNow = new Set(nextSelection);
            const toggleButtons = Array.from(activePane.querySelectorAll('[data-role="class-toggle"]'));
            toggleButtons.forEach((button) => {
                const buttonClassName = String(button.getAttribute('data-class-name') || '').trim();
                applyClassToggleButtonState(button, selectedNow.has(buttonClassName));
            });
            updateClassSelectionToggleButton(activePane, modelItem, nextSelection);
        }
    }

    function toggleAllClassNameSelection(modelKey) {
        const normalizedModelKey = String(modelKey || '').trim();
        if (!normalizedModelKey) {
            return;
        }

        const modelItem = modelHistory.find((item) => getModelSelectionKey(item) === normalizedModelKey);
        if (!modelItem) {
            return;
        }

        const classNames = normalizeClassNameList(modelItem.classNames);
        if (classNames.length === 0) {
            return;
        }

        const currentSelection = ensureModelClassSelection(modelItem);
        const shouldSelectAll = currentSelection.length < classNames.length;
        const nextSelection = shouldSelectAll ? classNames.slice() : [];
        selectedClassNamesByModelKey[normalizedModelKey] = nextSelection;

        const activePane = modelTabContentElement
            ? modelTabContentElement.querySelector('.tab-pane.active, .tab-pane.show.active')
            : null;

        if (activePane) {
            const selectedNow = new Set(nextSelection);
            const toggleButtons = Array.from(activePane.querySelectorAll('[data-role="class-toggle"]'));
            toggleButtons.forEach((button) => {
                const buttonClassName = String(button.getAttribute('data-class-name') || '').trim();
                applyClassToggleButtonState(button, selectedNow.has(buttonClassName));
            });
            updateClassSelectionToggleButton(activePane, modelItem, nextSelection);
        }
    }

    function renderModelMetadataTabs() {
        if (!modelTabsElement || !modelTabContentElement) {
            return;
        }

        modelTabsElement.innerHTML = '';
        modelTabContentElement.innerHTML = '';

        if (modelHistory.length === 0) {
            modelTabContentElement.innerHTML = '<div class="text-muted small">등록된 모델이 없습니다.</div>';
            return;
        }

        const activeModel = getSelectedModelItem() || modelHistory.find((item) => item.isDefault) || modelHistory[0];
        if (activeModel) {
            setSelectedModelSelection(activeModel.modelPath, activeModel.fileName);
        }

        modelHistory.forEach((modelItem, index) => {
            const tabId = `yolo-model-tab-${index}`;
            const paneId = `yolo-model-pane-${index}`;
            const isActive = activeModel && activeModel.fileName === modelItem.fileName;

            const li = document.createElement('li');
            li.className = 'nav-item';
            li.setAttribute('role', 'presentation');

            const button = document.createElement('button');
            button.className = `nav-link ${isActive ? 'active text-primary' : 'text-secondary'}`;
            button.id = tabId;
            button.type = 'button';
            button.setAttribute('data-bs-toggle', 'tab');
            button.setAttribute('data-bs-target', `#${paneId}`);
            button.setAttribute('data-model-path', modelItem.modelPath);
            button.setAttribute('data-model-file-name', modelItem.fileName);
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-controls', paneId);
            button.setAttribute('aria-selected', String(isActive));
            button.innerHTML = `
                <span class="d-inline-flex align-items-center gap-1">
                    <i class="bi bi-box-seam text-secondary" aria-hidden="true"></i>
                    <span>${modelItem.displayName}</span>
                </span>
            `;

            li.appendChild(button);
            modelTabsElement.appendChild(li);

            const pane = document.createElement('div');
            pane.className = `tab-pane fade ${isActive ? 'show active' : ''}`;
            pane.id = paneId;
            pane.setAttribute('role', 'tabpanel');
            pane.setAttribute('aria-labelledby', tabId);
            pane.tabIndex = 0;

            if (modelPaneTemplate && modelPaneTemplate.content) {
                const templateClone = modelPaneTemplate.content.cloneNode(true);
                const modelBadgesElement = templateClone.querySelector('[data-role="model-badges"]');
                const modelTypeElement = templateClone.querySelector('[data-role="model-type"]');
                const classListElement = templateClone.querySelector('[data-role="class-list"]');

                if (modelBadgesElement) {
                    modelBadgesElement.classList.add('align-items-center');
                }
                if (modelTypeElement) {
                    modelTypeElement.textContent = modelItem.modelType || 'YOLO 모델';
                }
                const selectedClassNames = getSelectedClassNamesForModel(modelItem);
                renderClassToggleButtons(classListElement, modelItem, selectedClassNames);
                if (modelTypeElement && classListElement) {
                    classListElement.prepend(modelTypeElement);
                }
                renderClassSelectionToggleButton(modelBadgesElement, modelItem, selectedClassNames);

                pane.appendChild(templateClone);
            } else {
                pane.innerHTML = '<div class="text-muted small">모델 템플릿을 찾을 수 없습니다.</div>';
            }

            modelTabContentElement.appendChild(pane);
        });

        syncModelTabColor();
    }

    function syncModelTabColor() {
        if (!modelTabsElement) {
            return;
        }

        const modelTabButtons = Array.from(modelTabsElement.querySelectorAll('[data-bs-toggle="tab"]'));
        modelTabButtons.forEach((button) => {
            const isActive = button.classList.contains('active');
            button.classList.toggle('text-primary', isActive);
            button.classList.toggle('text-secondary', !isActive);
        });
    }

    function syncInputSourceTabColor() {
        if (inputSourceTabButtons.length === 0) {
            return;
        }

        inputSourceTabButtons.forEach((button) => {
            const isActive = button.classList.contains('active');
            button.classList.toggle('text-primary', isActive);
            button.classList.toggle('text-secondary', !isActive);
        });
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
        saveDetectOptionsForSelectedVideo();
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
                applyDetectOptionsForSelectedVideo();
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

    async function loadModelMetadataFromServer() {
        if (!modelTabsElement || !modelTabContentElement) {
            return;
        }

        try {
            const apiBase = await resolveApiBase();
            const response = await fetch(`${apiBase}/fast/yolo/models`, {
                method: 'GET',
                cache: 'no-store',
            });

            if (!response.ok) {
                modelHistory = [];
                renderModelMetadataTabs();
                return;
            }

            const body = await response.json();
            const models = body && Array.isArray(body.models) ? body.models : [];

            modelHistory = models.map((item) => ({
                fileName: String(item.file_name || ''),
                displayName: String(item.display_name || item.file_name || 'model'),
                modelPath: String(item.model_path || ''),
                size: Number(item.size || 0),
                modifiedAt: String(item.modified_at || ''),
                isDefault: Boolean(item.is_default),
                description: String(item.description || ''),
                task: String(item.task || 'unknown'),
                modelType: String(item.model_type || 'YOLO 모델'),
                classCount: Number(item.class_count || 0),
                classNames: Array.isArray(item.class_names) ? item.class_names.map((value) => String(value)) : [],
            }));

            renderModelMetadataTabs();
        } catch (_ignore) {
            modelHistory = [];
            renderModelMetadataTabs();
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
        setUploadProgress(0, true, '0%');
        setStatus('동영상 업로드 중...', 'info');

        try {
            const apiBase = await resolveApiBase();
            const result = await uploadVideoWithProgress(apiBase, file);
            setUploadProgress(100, true, '100%');
            addUploadedHistoryItem(
                result.display_name || file.name,
                result.file_name,
                buildAbsoluteUrl(apiBase, result.thumbnail_url)
            );
            selectedServerFileName = String(result.file_name || '');
            applyDetectOptionsForSelectedVideo();
            setSelectedFile(null);
            syncInputWithFile(null);
            renderUploadedHistory();
            showInputSourceTab('#yolo-uploaded-source-pane');
            setStatus('동영상 업로드 완료. 업로드 동영상 탭에서 선택되었습니다.', 'success');
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            setStatus(`오류: ${message}`, 'danger');
            setUploadProgress(0, false, '0%');
        } finally {
            if (uploadButton) {
                uploadButton.disabled = !selectedFile;
            }
        }
    }

    async function runYoloDetect() {
        if (detectButton.disabled) {
            return;
        }

        if (outputVideoElement) {
            outputVideoElement.pause();
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
        const selectedModelItem = getSelectedModelItem();
        const modelName = selectedModelItem ? selectedModelItem.modelPath : '';
        const selectedClassNames = selectedModelItem ? getSelectedClassNamesForModel(selectedModelItem) : [];

        if (selectedModelItem && normalizeClassNameList(selectedModelItem.classNames).length > 0 && selectedClassNames.length === 0) {
            setStatus('검출할 클래스를 1개 이상 선택하세요.', 'warning');
            return;
        }

        detectButton.disabled = true;
        startDetectProgressTicker();
        setStatus('YOLO 검출 진행 중...', 'info');

        try {
            const apiBase = await resolveApiBase();
            const classNamesParam = selectedClassNames.join(',');
            const url = `${apiBase}/fast/yolo/detect_saved_video?file_name=${encodeURIComponent(selectedServerFileName)}&conf=${encodeURIComponent(conf)}&iou=${encodeURIComponent(iou)}&model_name=${encodeURIComponent(modelName)}&class_names=${encodeURIComponent(classNamesParam)}`;
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

            stopDetectProgressTicker(100);
            setStatus('검출 완료', 'success');
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            stopDetectProgressTicker(0);
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
            syncInputSourceTabColor();
        });
    });

    if (modelTabsElement) {
        modelTabsElement.addEventListener('shown.bs.tab', (event) => {
            const shownButton = event?.target || null;
            const modelPath = shownButton ? shownButton.getAttribute('data-model-path') : '';
            const modelFileName = shownButton ? shownButton.getAttribute('data-model-file-name') : '';
            setSelectedModelSelection(modelPath, modelFileName);
            syncModelTabColor();
        });
    }

    if (modelTabContentElement) {
        modelTabContentElement.addEventListener('click', (event) => {
            const toggleAllButton = event.target && typeof event.target.closest === 'function'
                ? event.target.closest('[data-role="class-toggle-all"]')
                : null;
            if (toggleAllButton) {
                event.preventDefault();
                const modelKey = toggleAllButton.getAttribute('data-model-key');
                toggleAllClassNameSelection(modelKey);
                return;
            }

            const targetButton = event.target && typeof event.target.closest === 'function'
                ? event.target.closest('[data-role="class-toggle"]')
                : null;
            if (!targetButton) {
                return;
            }

            event.preventDefault();
            const modelKey = targetButton.getAttribute('data-model-key');
            const className = targetButton.getAttribute('data-class-name');
            toggleClassNameSelection(modelKey, className);
        });
    }

    updateSliderValueLabels();
    if (uploadedEmptyElement) {
        renderUploadedHistory();
    }

    restoreSelectedModelPath();

    if (modelTabsElement && modelTabContentElement) {
        renderModelMetadataTabs();
    }

    applyLoopOption();
    restoreInputSourceTab();
    syncInputSourceTabColor();

    loadUploadedHistoryFromServer();
    loadModelMetadataFromServer();
})();
