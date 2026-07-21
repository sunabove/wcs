// mqtt_process_01_status.js

let vehicleSpeedZeroClickLatched = false;
window.latestVehicleLinearSpeedMs = window.latestVehicleLinearSpeedMs || 0;
window.latestVehicleOperationCommand = window.latestVehicleOperationCommand ?? null;
window.latestVehicleOperationState = window.latestVehicleOperationState ?? null;
window.wheelRadiusById = window.wheelRadiusById || {};
const VEHICLE_AUDIO_STORAGE_KEY = 'wcs.vehicle.showAudio';

function ensureGlobalUserGestureTrackerFallback() {
    if (window.__wcsUserGestureTrackerAttached === true) {
        return;
    }

    const markGesture = function () {
        window.__wcsAnyUserGestureDetected = true;
    };

    document.addEventListener('pointerdown', markGesture, true);
    document.addEventListener('keydown', markGesture, true);
    document.addEventListener('touchstart', markGesture, true);

    window.__wcsUserGestureTrackerAttached = true;
}

ensureGlobalUserGestureTrackerFallback();

try {
    window.localStorage.removeItem('wcs.vehicle.operation.command.v1');
    window.localStorage.removeItem('wcs.vehicle.operation.state.v1');
} catch (error) {
    // Ignore storage cleanup failures.
}

const fallbackVehicleAudioState = {
    isActivated: false,
    listenerAttached: false,
    pendingMessage: null,
    speakTimerId: null,
    speechQueue: [],
    isSpeaking: false,
    lastSurfaceState: null,
    lastRollAngleDeg: null,
    baselineSeen: {
        surface: false,
        obstacle: false,
        roll: false,
    },
    lastRollAnnouncedAt: 0,
    minRollDeltaDeg: 2,
    minRollAnnounceIntervalMs: 1200,
    lastSpokenMessage: '',
    lastSpokenAt: 0,
    duplicateMessageBlockMs: 350
};

function mqttLog() {
    const args = Array.from(arguments);
    if (args.length === 0) {
        return;
    }

    const topicLogPattern = /(wheel\/(fl|fr|rl|rr)\/(angle\/speed|linear\/speed|operation\/command|radius|angle)|vehicle\/operation\/command|vehicle\/linear\/speed)/i;
    const joinedStringArgs = args
        .filter((arg) => typeof arg === 'string')
        .join(' ');

    if (!topicLogPattern.test(joinedStringArgs)) {
        return;
    }

    if (typeof window.mqttConsoleLog === 'function') {
        window.mqttConsoleLog.apply(window, args);
    }
}

const SENSOR_DISPLAY_ORDER = ['ToF', 'IMU', 'Current', 'Camera', 'Lidar'];
const OBSTACLE_FUSION_SENSOR_RECEIVE_WINDOW_MS = 2500;
const sensorCountById = {};
const receivedSensorIds = new Set();
const obstacleActiveSensorIds = new Set();
const receivedSensorIndexById = new Map();
const obstacleFusionState = {
    obstacle: null,
    confidence: null,
    sensorIds: new Set(),
    sensorLastSeenAtById: new Map(),
};

function renderObstacleFusionStatus() {
    const $enabled = $('#obstacle-fusion-enabled');
    const $confidence = $('#obstacle-fusion-confidence');
    const $confidenceText = $('#obstacle-fusion-confidence-text');
    const $confidenceSlider = $('#obstacle-fusion-confidence-slider');

    if ($enabled.length === 0) {
        return;
    }

    const now = Date.now();
    const activeSensorIds = Array.from(obstacleFusionState.sensorLastSeenAtById.entries())
        .filter(([, lastSeenAt]) => Number.isFinite(lastSeenAt) && (now - lastSeenAt) <= OBSTACLE_FUSION_SENSOR_RECEIVE_WINDOW_MS)
        .map(([sensorId]) => sensorId);

    obstacleFusionState.sensorIds = new Set(activeSensorIds);
    const confidenceValue = Number(obstacleFusionState.confidence);
    const confidencePercent = Number.isFinite(confidenceValue)
        ? Math.round(confidenceValue * 100)
        : null;

    const fusionEnabled = activeSensorIds.length >= 2;

    $enabled
        .removeClass('text-bg-secondary text-bg-success text-bg-warning')
        .addClass(fusionEnabled ? 'text-bg-success' : 'text-bg-warning')
        .text(fusionEnabled ? '융합 ON' : '융합 OFF');

    if ($confidence.length > 0) {
        $confidence.text(Number.isFinite(confidencePercent) ? `${confidencePercent}%` : '-%');
    }

    if ($confidenceText.length > 0) {
        $confidenceText.text(Number.isFinite(confidencePercent) ? `${confidencePercent}%` : '-%');
    }

    if ($confidenceSlider.length > 0) {
        const sliderValue = Number.isFinite(confidencePercent) ? confidencePercent : 0;
        $confidenceSlider
            .val(sliderValue)
            .css('background', '');
    }
}

function getSensorDisplayOrder(sensorId) {
    const orderIndex = SENSOR_DISPLAY_ORDER.indexOf(sensorId);
    return orderIndex >= 0 ? orderIndex : SENSOR_DISPLAY_ORDER.length + 1;
}

function getSensorRowLabel(sensorId, sensorIndex) {
    return String(sensorId);
}

function getSensorNumberLabel(sensorIndex) {
    if (!Number.isFinite(sensorIndex)) {
        return '-';
    }
    return String(sensorIndex + 1);
}

function hasReceivedSensorIndex(sensorId, sensorIndex) {
    const receivedIndexes = receivedSensorIndexById.get(String(sensorId));
    return receivedIndexes instanceof Set && receivedIndexes.has(sensorIndex);
}

function getReceivedSensorIndexCount(sensorId) {
    const receivedIndexes = receivedSensorIndexById.get(String(sensorId));
    return receivedIndexes instanceof Set ? receivedIndexes.size : 0;
}

function getConfiguredSensorCount(sensorId) {
    const configuredCount = Number.parseInt(sensorCountById[String(sensorId)], 10);
    if (Number.isFinite(configuredCount) && configuredCount > 0) {
        return configuredCount;
    }

    const $chip = $(`#obstacle-sensor-types .obstacle-sensor-chip[data-sensor-id="${String(sensorId)}"]`);
    if ($chip.length > 0) {
        const domCount = $chip.find('[data-sensor-chip-number] .obstacle-sensor-chip-number-cell').length;
        if (domCount > 0) {
            return domCount;
        }
    }

    return 0;
}

function getSensorCountRangeLabel(sensorId) {
    const sensorCount = Number.parseInt(sensorCountById[sensorId], 10);
    if (!Number.isFinite(sensorCount) || sensorCount <= 0) {
        return '';
    }

    return Array.from({ length: sensorCount }, (_, sensorIndex) => {
        const isActive = hasReceivedSensorIndex(sensorId, sensorIndex);
        const activeClassName = isActive ? ' active' : '';
        return `<span class="obstacle-sensor-chip-number-cell${activeClassName}" data-sensor-index="${sensorIndex}" aria-hidden="true"></span>`;
    }).join('');
}

function refreshObstacleSensorChipNumbers(sensorId) {
    const selector = sensorId
        ? `#obstacle-sensor-types .obstacle-sensor-chip[data-sensor-id="${sensorId}"]`
        : '#obstacle-sensor-types .obstacle-sensor-chip[data-sensor-id]';

    $(selector).each(function () {
        const rowSensorId = String($(this).attr('data-sensor-id') || '');
        $(this).find('[data-sensor-chip-number]').html(getSensorCountRangeLabel(rowSensorId));
    });
}

function refreshSensorRowLabels(sensorId) {
    const selector = sensorId
        ? `#sensor-info-tbody tr[data-sensor-row-key][data-sensor-id="${sensorId}"]`
        : '#sensor-info-tbody tr[data-sensor-row-key]';

    $(selector).each(function () {
        const rowSensorId = String($(this).attr('data-sensor-id') || '');
        const rowSensorIndex = Number.parseInt($(this).attr('data-sensor-index'), 10);
        $(this).find('[data-sensor-label]').text(getSensorRowLabel(rowSensorId, rowSensorIndex));
        $(this).find('[data-sensor-number]').text(getSensorNumberLabel(rowSensorIndex));
    });
}

function applyObstacleSensorChipNumberState(sensorId) {
    const selector = sensorId
        ? `#obstacle-sensor-types .obstacle-sensor-chip[data-sensor-id="${sensorId}"]`
        : '#obstacle-sensor-types .obstacle-sensor-chip[data-sensor-id]';

    $(selector).each(function () {
        const rowSensorId = String($(this).attr('data-sensor-id') || '').trim();
        if (!rowSensorId) {
            return;
        }

        $(this).find('[data-sensor-chip-number] .obstacle-sensor-chip-number-cell').each(function (cellIndex) {
            const dataIndex = Number.parseInt($(this).attr('data-sensor-index'), 10);
            const normalizedCellIndex = Number.isFinite(dataIndex) ? dataIndex : cellIndex;
            const isActive = hasReceivedSensorIndex(rowSensorId, normalizedCellIndex);
            $(this).toggleClass('active', isActive);
        });
    });
}

function applyObstacleSensorChipState() {
    const $chips = $('#obstacle-sensor-types .obstacle-sensor-chip');
    if ($chips.length === 0) {
        return;
    }

    $chips.each(function () {
        const sensorId = String($(this).attr('data-sensor-id') || '').trim();
        if (!sensorId) {
            return;
        }

        const configuredCount = getConfiguredSensorCount(sensorId);
        const activeCount = getReceivedSensorIndexCount(sensorId);
        const isFullyActive = configuredCount > 0 && activeCount >= configuredCount;
        const isPartiallyActive = activeCount > 0 && (!isFullyActive);
        const isDisabled = activeCount <= 0;

        $(this)
            .toggleClass('active', isFullyActive)
            .toggleClass('partial', isPartiallyActive)
            .toggleClass('disabled', isDisabled)
            .toggleClass('sensor-received', activeCount > 0);
    });
}

function updateReceivedSensorTypes(topic) {
    const sensorTopicMatch = String(topic || '').match(/^sensor\/([^/]+)\//);
    if (!sensorTopicMatch) {
        return;
    }

    const sensorId = String(sensorTopicMatch[1] || '').trim();
    if (!sensorId) {
        return;
    }

    if (!receivedSensorIds.has(sensorId)) {
        receivedSensorIds.add(sensorId);
    }

    applyObstacleSensorChipState();
}

function updateReceivedSensorNumberCells(topic, value) {
    const sensorTopicMatch = String(topic || '').match(/^sensor\/([^/]+)\/(\d+)\/(state|value|obstacle|obstacle\/confidence)$/);
    if (!sensorTopicMatch) {
        return;
    }

    const metricType = String(sensorTopicMatch[3] || '').trim();
    if (metricType !== 'state') {
        return;
    }

    const sensorId = String(sensorTopicMatch[1] || '').trim();
    const sensorIndex = Number.parseInt(sensorTopicMatch[2], 10);
    if (!sensorId || !Number.isFinite(sensorIndex)) {
        return;
    }

    if (!receivedSensorIndexById.has(sensorId)) {
        receivedSensorIndexById.set(sensorId, new Set());
    }

    const receivedIndexes = receivedSensorIndexById.get(sensorId);
    if (!(receivedIndexes instanceof Set)) {
        return;
    }

    const sensorState = Number.parseInt(value, 10);
    if (sensorState === 1) {
        receivedIndexes.add(sensorIndex);
        obstacleFusionState.sensorLastSeenAtById.set(sensorId, Date.now());
    } else {
        receivedIndexes.delete(sensorIndex);
        if (receivedIndexes.size === 0) {
            obstacleFusionState.sensorLastSeenAtById.delete(sensorId);
        }
    }

    applyObstacleSensorChipNumberState(sensorId);
    applyObstacleSensorChipState();
    renderObstacleFusionStatus();
}

function updateObstacleSensorTypes(topic, value) {
    if (topic !== 'obstacle/sensors') {
        return;
    }

    obstacleActiveSensorIds.clear();

    let parsedSources = [];
    try {
        parsedSources = JSON.parse(String(value || '[]'));
    } catch (error) {
        applyObstacleSensorChipState();
        return;
    }

    if (!Array.isArray(parsedSources) || parsedSources.length === 0) {
        applyObstacleSensorChipState();
        return;
    }

    const activeSensorIds = new Set(
        parsedSources
            .map((source) => String(source && source.id ? source.id : '').trim())
            .filter(Boolean)
    );

    activeSensorIds.forEach((sensorId) => {
        obstacleActiveSensorIds.add(sensorId);
    });

    applyObstacleSensorChipState();
}

function updateObstacleFusionValues(topic, value) {
    if (topic === 'obstacle') {
        obstacleFusionState.obstacle = Number.parseInt(value, 10);
        renderObstacleFusionStatus();
        return;
    }

    if (topic === 'obstacle/confidence') {
        const confidence = Number(value);
        obstacleFusionState.confidence = Number.isFinite(confidence) ? confidence : null;
        renderObstacleFusionStatus();
    }
}

function ensureDynamicSensorRow(topic) {
    const topicMatch = String(topic || '').match(/^sensor\/([^/]+)\/(\d+)\/(state|value|obstacle|obstacle\/confidence)$/);
    if (!topicMatch) {
        return;
    }

    const sensorId = topicMatch[1];
    const sensorIndex = Number.parseInt(topicMatch[2], 10);
    if (!Number.isFinite(sensorIndex)) {
        return;
    }

    const $tbody = $('#sensor-info-tbody');
    if ($tbody.length === 0) {
        return;
    }

    const $rowTemplate = $('#sensor-info-row-template');
    if ($rowTemplate.length === 0) {
        return;
    }

    // Keep template hidden at all times even after dynamic DOM operations.
    $rowTemplate.addClass('d-none');

    const rowKey = `${sensorId}#${sensorIndex}`;
    const rowSelector = `[data-sensor-row-key="${rowKey}"]`;
    if ($tbody.find(rowSelector).length > 0) {
        return;
    }

    $('#sensor-info-empty-row').remove();

    const safeSensorId = String(sensorId);
    const $newRow = $rowTemplate.clone(false)
        .removeAttr('id')
        .removeClass('d-none')
        .attr('data-sensor-row-key', rowKey)
        .attr('data-sensor-id', safeSensorId)
        .attr('data-sensor-index', sensorIndex);

    $newRow.find('[data-sensor-label]').text(getSensorRowLabel(safeSensorId, sensorIndex));
    $newRow.find('[data-sensor-number]').text(getSensorNumberLabel(sensorIndex));
    $newRow.find('[data-topic-suffix]').each(function () {
        const topicSuffix = String($(this).attr('data-topic-suffix') || '').trim();
        if (!topicSuffix) {
            return;
        }
        $(this).attr('id', `sensor/${safeSensorId}/${sensorIndex}/${topicSuffix}`);
    });

    $rowTemplate.before($newRow);

    const rows = $tbody.find('tr[data-sensor-row-key]').get();
    rows.sort((a, b) => {
        const aSensorId = String($(a).attr('data-sensor-id') || '');
        const bSensorId = String($(b).attr('data-sensor-id') || '');
        const aSensorIndex = Number.parseInt($(a).attr('data-sensor-index'), 10);
        const bSensorIndex = Number.parseInt($(b).attr('data-sensor-index'), 10);

        const orderDelta = getSensorDisplayOrder(aSensorId) - getSensorDisplayOrder(bSensorId);
        if (orderDelta !== 0) {
            return orderDelta;
        }

        if (aSensorId !== bSensorId) {
            return aSensorId.localeCompare(bSensorId);
        }

        return aSensorIndex - bSensorIndex;
    });

    rows.forEach((row) => {
        $rowTemplate.before(row);
    });
}

function triggerSensorInfoRowBlink(topic) {
    const topicMatch = String(topic || '').match(/^sensor\/([^/]+)\/(\d+)\/(state|value|obstacle|obstacle\/confidence)$/);
    if (!topicMatch) {
        return;
    }

    const sensorId = String(topicMatch[1] || '').trim();
    const sensorIndex = Number.parseInt(topicMatch[2], 10);
    if (!sensorId || !Number.isFinite(sensorIndex)) {
        return;
    }

    const rowKey = `${sensorId}#${sensorIndex}`;
    const $row = $(`#sensor-info-tbody tr[data-sensor-row-key="${rowKey}"]`);
    if ($row.length === 0) {
        return;
    }

    const existingTimer = $row.data('blinkTimerId');
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    $row.removeClass('sensor-info-row-blink');
    void $row.get(0).offsetWidth;
    $row.addClass('sensor-info-row-blink');

    const timerId = setTimeout(() => {
        $row.removeClass('sensor-info-row-blink');
        $row.removeData('blinkTimerId');
    }, 800);

    $row.data('blinkTimerId', timerId);
}

function triggerObstacleSensorChipBlink(topic) {
    const topicMatch = String(topic || '').match(/^sensor\/([^/]+)\/(\d+)\/(state|value|obstacle|obstacle\/confidence)$/);
    if (!topicMatch) {
        return;
    }

    const sensorId = String(topicMatch[1] || '').trim();
    const sensorIndex = Number.parseInt(topicMatch[2], 10);
    if (!sensorId || !Number.isFinite(sensorIndex)) {
        return;
    }

    const $chip = $(`#obstacle-sensor-types .obstacle-sensor-chip[data-sensor-id="${sensorId}"]`);
    if ($chip.length === 0) {
        return;
    }

    const $numberCell = $chip.find(`[data-sensor-chip-number] .obstacle-sensor-chip-number-cell[data-sensor-index="${sensorIndex}"]`);

    if ($numberCell.length > 0) {
        const cellTimerId = $numberCell.data('blinkTimerId');
        if (cellTimerId) {
            clearTimeout(cellTimerId);
        }

        $numberCell.removeClass('obstacle-sensor-chip-number-cell-blink');
        void $numberCell.get(0).offsetWidth;
        $numberCell.addClass('obstacle-sensor-chip-number-cell-blink');

        const nextCellTimerId = setTimeout(() => {
            $numberCell.removeClass('obstacle-sensor-chip-number-cell-blink');
            $numberCell.removeData('blinkTimerId');
        }, 800);
        $numberCell.data('blinkTimerId', nextCellTimerId);
    }
}

function syncSensorRowLabelNumberColor(topic) {
    const topicMatch = String(topic || '').match(/^sensor\/([^/]+)\/(\d+)\/(state|value|obstacle|obstacle\/confidence)$/);
    if (!topicMatch) {
        return;
    }

    const sensorId = String(topicMatch[1] || '').trim();
    const sensorIndex = Number.parseInt(topicMatch[2], 10);
    if (!sensorId || !Number.isFinite(sensorIndex)) {
        return;
    }

    const rowKey = `${sensorId}#${sensorIndex}`;
    const $row = $(`#sensor-info-tbody tr[data-sensor-row-key="${rowKey}"]`);
    if ($row.length === 0) {
        return;
    }

    if ($row.hasClass('sensor-info-row-inactive')) {
        return;
    }

    const $sensorLabelCell = $row.find('[data-sensor-label]');
    const $sensorNumberCell = $row.find('[data-sensor-number]');

    if ($sensorLabelCell.length > 0) {
        updateTargetElementCss($sensorLabelCell);
    }

    if ($sensorNumberCell.length > 0) {
        updateTargetElementCss($sensorNumberCell);
    }
}

function setSensorInfoRowInactiveState(sensorId, sensorIndex, isInactive) {
    const rowKey = `${sensorId}#${sensorIndex}`;
    const $row = $(`#sensor-info-tbody tr[data-sensor-row-key="${rowKey}"]`);
    if ($row.length === 0) {
        return;
    }

    $row.toggleClass('sensor-info-row-inactive', Boolean(isInactive));
}

function dispatchVehicleDirectionEvent(sourceTopic, value) {
    if (!Number.isFinite(value)) {
        return;
    }

    try {
        window.dispatchEvent(new CustomEvent('wcs:vehicle-direction-update', {
            detail: {
                topic: String(sourceTopic || ''),
                value: value,
            },
        }));
    } catch (error) {
        // Ignore event dispatch failures.
    }
}

function syncViewerDriveAnimationByCommand(commandValue) {
    const numericCommand = Number.parseInt(commandValue, 10);
    if (!Number.isFinite(numericCommand)) {
        return;
    }

    const speedMs = Number(window.latestVehicleLinearSpeedMs);
    const speedKmh = Number.isFinite(speedMs) ? Math.max(0, speedMs * 3.6) : 0;

    if (typeof window.setDriveSpeedKmh === 'function') {
        window.setDriveSpeedKmh(speedKmh);
    }

    if (typeof window.setDriveMode === 'function') {
        const driveMode = (typeof window.getVehicleDriveModeByCommand === 'function')
            ? window.getVehicleDriveModeByCommand(numericCommand)
            : 'stop';
        window.setDriveMode(driveMode);
    }
}

function canUseSpeechSynthesisFallback() {
    return typeof window !== 'undefined'
        && typeof window.SpeechSynthesisUtterance === 'function'
        && window.speechSynthesis
        && typeof window.speechSynthesis.speak === 'function';
}

function getPreferredSpeechVoiceFallback() {
    if (!canUseSpeechSynthesisFallback()) {
        return null;
    }

    let voices = [];
    try {
        voices = window.speechSynthesis.getVoices() || [];
    } catch (error) {
        voices = [];
    }

    if (!Array.isArray(voices) || voices.length === 0) {
        return null;
    }

    const koVoice = voices.find(function (voice) {
        return String(voice && voice.lang || '').toLowerCase().startsWith('ko');
    });
    return koVoice || voices[0] || null;
}

function hasUserActivatedDocumentFallback() {
    if (window.__wcsAnyUserGestureDetected === true) {
        return true;
    }

    try {
        return !!(navigator.userActivation && navigator.userActivation.hasBeenActive === true);
    } catch (error) {
        return false;
    }
}

function readVehicleAudioEnabledFallback() {
    if (typeof window.isVehicleAudioEnabled === 'function') {
        return !!window.isVehicleAudioEnabled();
    }

    try {
        const rawValue = window.localStorage.getItem(VEHICLE_AUDIO_STORAGE_KEY);
        if (rawValue == null) {
            return false;
        }

        const normalized = String(rawValue).trim().toLowerCase();
        return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
    } catch (error) {
        console.warn('[MQTT][Audio] localStorage read failed:', error);
    }

    return false;
}

function tryActivateFallbackAudioFromGesture() {
    if (!canUseSpeechSynthesisFallback()) {
        return;
    }

    try {
        window.speechSynthesis.resume();
        window.speechSynthesis.getVoices();
    } catch (error) {
        console.warn('[MQTT][Audio] resume failed:', error);
    }

    fallbackVehicleAudioState.isActivated = true;
    const pendingMessage = fallbackVehicleAudioState.pendingMessage;
    if (pendingMessage) {
        fallbackVehicleAudioState.pendingMessage = null;
        speakVehicleStatusFallback(pendingMessage, { interrupt: true });
    }
}

function tryActivateFallbackAudioAuto() {
    if (!canUseSpeechSynthesisFallback() || !hasUserActivatedDocumentFallback()) {
        return false;
    }

    try {
        window.speechSynthesis.resume();
        window.speechSynthesis.getVoices();
    } catch (error) {
        console.warn('[MQTT][Audio] auto resume failed:', error);
    }

    fallbackVehicleAudioState.isActivated = true;
    return true;
}

function ensureFallbackAudioActivationListener() {
    if (fallbackVehicleAudioState.listenerAttached || !readVehicleAudioEnabledFallback()) {
        return;
    }

    if (hasUserActivatedDocumentFallback()) {
        tryActivateFallbackAudioAuto();
        return;
    }

    fallbackVehicleAudioState.listenerAttached = true;

    const onFirstUserGesture = () => {
        tryActivateFallbackAudioFromGesture();
        document.removeEventListener('pointerdown', onFirstUserGesture, true);
        document.removeEventListener('keydown', onFirstUserGesture, true);
        document.removeEventListener('touchstart', onFirstUserGesture, true);
    };

    document.addEventListener('pointerdown', onFirstUserGesture, true);
    document.addEventListener('keydown', onFirstUserGesture, true);
    document.addEventListener('touchstart', onFirstUserGesture, true);
}

function processFallbackSpeechQueue() {
    if (!readVehicleAudioEnabledFallback() || !canUseSpeechSynthesisFallback()) {
        return;
    }

    if (!fallbackVehicleAudioState.isActivated || fallbackVehicleAudioState.isSpeaking) {
        return;
    }

    if (!Array.isArray(fallbackVehicleAudioState.speechQueue) || fallbackVehicleAudioState.speechQueue.length === 0) {
        return;
    }

    const nextMessage = String(fallbackVehicleAudioState.speechQueue.shift() || '').trim();
    if (!nextMessage) {
        processFallbackSpeechQueue();
        return;
    }

    fallbackVehicleAudioState.isSpeaking = true;
    window.__wcsAudioSpeaking = true;

    try {
        window.speechSynthesis.resume();
        window.speechSynthesis.getVoices();
    } catch (error) {
        console.warn('[MQTT][Audio] resume before queue speak failed:', error);
    }

    const utterance = new window.SpeechSynthesisUtterance(nextMessage);
    const preferredVoice = getPreferredSpeechVoiceFallback();
    if (preferredVoice) {
        utterance.voice = preferredVoice;
        if (preferredVoice.lang) {
            utterance.lang = preferredVoice.lang;
        }
    } else {
        utterance.lang = 'ko-KR';
    }
    utterance.rate = 1.05;
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.onend = () => {
        fallbackVehicleAudioState.isSpeaking = false;
        window.__wcsAudioSpeaking = false;
        processFallbackSpeechQueue();
    };
    utterance.onerror = () => {
        fallbackVehicleAudioState.isSpeaking = false;
        window.__wcsAudioSpeaking = false;
        processFallbackSpeechQueue();
    };
    try {
        window.speechSynthesis.speak(utterance);
    } catch (error) {
        console.warn('[MQTT][Audio] speechSynthesis.speak failed:', error);
        fallbackVehicleAudioState.isSpeaking = false;
        window.__wcsAudioSpeaking = false;
        processFallbackSpeechQueue();
    }
}

function speakVehicleStatusFallback(text, options = {}) {
    if (!readVehicleAudioEnabledFallback() || !canUseSpeechSynthesisFallback()) {
        return;
    }

    const message = String(text || '').trim();
    if (!message) {
        return;
    }

    const shouldInterrupt = !!(options && options.interrupt === true);

    const now = Date.now();
    window.__wcsAudioEnabled = true;
    window.__wcsLastSpeechText = message;
    window.__wcsLastSpeechAt = now;
    if (
        fallbackVehicleAudioState.lastSpokenMessage === message
        && (now - fallbackVehicleAudioState.lastSpokenAt) < fallbackVehicleAudioState.duplicateMessageBlockMs
    ) {
        return;
    }

    if (!fallbackVehicleAudioState.isActivated) {
        if (hasUserActivatedDocumentFallback()) {
            tryActivateFallbackAudioAuto();
        }

        if (fallbackVehicleAudioState.isActivated) {
            // continue to enqueue/speak below.
        } else {
            fallbackVehicleAudioState.pendingMessage = message;
            ensureFallbackAudioActivationListener();
            return;
        }
    }

    const globalSpeechState = window.__wcsGlobalSpeechState || { message: '', at: 0 };
    if (globalSpeechState.message === message && (now - globalSpeechState.at) < 1200) {
        return;
    }
    window.__wcsGlobalSpeechState = { message: message, at: now };

    if (shouldInterrupt && canUseSpeechSynthesisFallback()) {
        try {
            window.speechSynthesis.cancel();
        } catch (error) {
            // Ignore cancel failures and continue queue handling.
        }
        fallbackVehicleAudioState.speechQueue = [];
        fallbackVehicleAudioState.isSpeaking = false;
        window.__wcsAudioSpeaking = false;
    } else if (fallbackVehicleAudioState.speechQueue.length >= 6) {
        // Keep queue bounded to prevent stale delayed speech.
        fallbackVehicleAudioState.speechQueue = fallbackVehicleAudioState.speechQueue.slice(-3);
    }

    fallbackVehicleAudioState.speechQueue.push(message);
    processFallbackSpeechQueue();

    fallbackVehicleAudioState.lastSpokenMessage = message;
    fallbackVehicleAudioState.lastSpokenAt = now;
}

function announceVehicleObstacleAudio(obstacle) {
    if (typeof window.announceVehicleObstacle === 'function') {
        window.announceVehicleObstacle(obstacle);
        return;
    }

    const obstacleValue = Number.parseInt(obstacle, 10);
    const obstacleText = {
        1: '장애물 단차 검출',
        2: '장애물 포트홀 검출',
        3: '장애물 빙판길 검출'
    };

    // 첫 수신 장애물 상태는 기준만 설정하고 음성은 생략한다.
    if (!fallbackVehicleAudioState.baselineSeen.obstacle) {
        fallbackVehicleAudioState.baselineSeen.obstacle = true;
        return;
    }

    if (obstacleValue === 0) {
        return;
    }

    const message = obstacleText[obstacleValue];
    if (!message) {
        return;
    }

    speakVehicleStatusFallback(message, { interrupt: true });
}

function announceVehicleSurfaceStateAudio(surfaceState) {
    if (typeof window.announceVehicleSurfaceState === 'function') {
        window.announceVehicleSurfaceState(surfaceState);
        return;
    }

    const surfaceStateValue = Number.parseInt(surfaceState, 10);
    const surfaceText = {
        0: '노면 아스팔트',
        1: '노면 보도블록',
        2: '노면 흙길',
        3: '노면 자갈길'
    };

    const message = surfaceText[surfaceStateValue];
    if (!message) {
        return;
    }

    // 첫 수신 노면 상태는 기준만 설정하고 음성은 생략한다.
    if (!fallbackVehicleAudioState.baselineSeen.surface) {
        fallbackVehicleAudioState.baselineSeen.surface = true;
        fallbackVehicleAudioState.lastSurfaceState = surfaceStateValue;
        return;
    }

    if (fallbackVehicleAudioState.lastSurfaceState === surfaceStateValue) {
        return;
    }

    fallbackVehicleAudioState.lastSurfaceState = surfaceStateValue;
    speakVehicleStatusFallback(message, { interrupt: true });
}

function announceVehicleRollAngleAudio(angleDeg) {
    if (typeof window.announceVehicleRollAngleDeg === 'function') {
        window.announceVehicleRollAngleDeg(angleDeg);
    }

    const numericAngleDeg = Number(angleDeg);
    if (!Number.isFinite(numericAngleDeg)) {
        return;
    }

    const roundedAngleDeg = Math.round(numericAngleDeg);
    const now = Date.now();

    // 첫 수신값(초기값)은 기준만 설정하고 음성은 생략한다.
    if (!fallbackVehicleAudioState.baselineSeen.roll) {
        fallbackVehicleAudioState.baselineSeen.roll = true;
        fallbackVehicleAudioState.lastRollAngleDeg = roundedAngleDeg;
        fallbackVehicleAudioState.lastRollAnnouncedAt = now;
        return;
    }

    if (fallbackVehicleAudioState.lastRollAngleDeg != null) {
        const angleDelta = Math.abs(roundedAngleDeg - fallbackVehicleAudioState.lastRollAngleDeg);
        const elapsedMs = now - fallbackVehicleAudioState.lastRollAnnouncedAt;
        if (angleDelta < fallbackVehicleAudioState.minRollDeltaDeg || elapsedMs < fallbackVehicleAudioState.minRollAnnounceIntervalMs) {
            return;
        }
    }

    fallbackVehicleAudioState.lastRollAngleDeg = roundedAngleDeg;
    fallbackVehicleAudioState.lastRollAnnouncedAt = now;
    speakVehicleStatusFallback(`롤 각도 ${roundedAngleDeg}도`, { interrupt: true });
}

function prcessMqttMessage(topic, value) {

    mqttLog(`[MQTT] 🧩 prcessMqttMessage 호출 - topic: ${topic}, value: ${value}`);

    // 토픽별 분류 및 상세 로깅
    if (topic.startsWith('vehicle/')) {
        mqttLog('[MQTT] 🚗 차량 데이터:', topic, value);
    } else if (topic.startsWith('wheel/')) {
        mqttLog('[MQTT] 🛞 바퀴 데이터:', topic, value);

        cacheWheelRadius(topic, value);

        // wheel 각속도 토픽이 오면 URDF 휠 애니메이션에 즉시 반영
        applyWheelAngularVelocityToViewer(topic, value);
        applyDerivedWheelLinearSpeed(topic, value);
        
        // wheel/{id}/id 토픽 특별 처리 - Vehicle Setting 페이지의 바퀴 ID 라디오 버튼 업데이트
        const wheelIdPattern = /^wheel\/([a-z]+)\/id$/;
        const match = topic.match(wheelIdPattern);
        
        if (match) {
            const wheelPosition = match[1]; // fl, fr, rl, rr
            const wheelId = parseInt(value);
            
            mqttLog(`[MQTT] 🏷️ Wheel ID 토픽 수신: ${topic} -> ${wheelId}`);
            
            // Vehicle Setting 페이지에만 적용
            if (window.location.pathname.includes('110_vehicle_setting.html')) {
                // 현재 선택된 바퀴와 일치하는지 확인
                const currentSelectedWheel = $('input[name="wheelPosition"]:checked').val();
                
                if (currentSelectedWheel && currentSelectedWheel.toLowerCase() === wheelPosition.toLowerCase()) {
                    // 해당하는 wheelId 라디오 버튼 선택
                    if (wheelId >= 1 && wheelId <= 4) {
                        $(`input[name="wheelId"][value="${wheelId}"]`).prop('checked', true);
                        mqttLog(`[MQTT] ✅ 바퀴 ID 자동 선택: ${wheelPosition.toUpperCase()} -> ID ${wheelId}`);
                        
                        // 시각적 피드백 (버튼 하이라이트)
                        const $selectedBtn = $(`label[for="wheel-id-${wheelId}"]`);
                        $selectedBtn.addClass('btn-primary').removeClass('btn-outline-secondary');
                        
                        // 다른 버튼들은 원래 상태로
                        $('label[for^="wheel-id-"]').not($selectedBtn).removeClass('btn-primary').addClass('btn-outline-secondary');
                        
                        setTimeout(() => {
                            $selectedBtn.removeClass('btn-primary').addClass('btn-outline-secondary');
                        }, 1500);
                    }
                }
            }
        }
    } else if (topic.startsWith('sensor/')) {
        mqttLog('[MQTT] 📡 센서 데이터:', topic, value);
    } else if (topic.startsWith('system/')) {
        mqttLog('[MQTT] ⚙️ 시스템 데이터:', topic, value);
    } else if (topic.startsWith('test/')) {
        mqttLog('[MQTT] 🧪 테스트 데이터:', topic, value);
    } else if (topic.startsWith('web/')) {
        mqttLog('[MQTT] 🌐 웹 클라이언트 데이터:', topic, value);
    } else {
        mqttLog('[MQTT] 📝 일반 데이터:', topic, value);
    }

    // 시뮬레이션 상태 토픽 특별 처리
    if (topic === 'simulation/start' && value === 'start') {
        $('#sim-status').removeClass('bg-secondary bg-danger').addClass('bg-success').text('상태: 실행 중');
    } else if (topic === 'simulation/stop' && value === 'stop') {
        $('#sim-status').removeClass('bg-secondary bg-success').addClass('bg-danger').text('상태: 중지됨');
    } else if (topic === 'simulation/state') {
        if (value === 'start') {
            $('#sim-status').removeClass('bg-secondary bg-danger').addClass('bg-success').text('상태: 실행 중');
        } else if (value === 'stop') {
            $('#sim-status').removeClass('bg-secondary bg-success').addClass('bg-danger').text('상태: 중지됨');
        }
    }

    // 센서 토픽은 tbody 행을 동적으로 만든 후 값을 반영한다.
    const sensorCountTopicMatch = String(topic || '').match(/^sensor\/([^/]+)\/count$/);
    if (sensorCountTopicMatch) {
        const sensorId = sensorCountTopicMatch[1];
        const sensorCount = Number.parseInt(value, 10);
        if (Number.isFinite(sensorCount) && sensorCount > 0) {
            sensorCountById[sensorId] = sensorCount;
            refreshSensorRowLabels(sensorId);
            refreshObstacleSensorChipNumbers(sensorId);
            applyObstacleSensorChipNumberState(sensorId);
        }
    }

    ensureDynamicSensorRow(topic);
    triggerSensorInfoRowBlink(topic);
    triggerObstacleSensorChipBlink(topic);
    updateReceivedSensorTypes(topic);
    updateReceivedSensorNumberCells(topic, value);
    updateObstacleSensorTypes(topic, value);
    updateObstacleFusionValues(topic, value);
    updateRunInfoHistoryMetric(topic, value);
    updateVehicleSpeedHistoryMetric(topic, value);

    // jQuery를 사용한 DOM 업데이트: topic을 id로 사용해서 해당 요소 찾기 (속성 선택자 사용)
    const $targetElement = $(`[id="${topic}"]`);

    // vehicle/run/state 특별 처리 (상태별 버튼 enable/disable)
    if (topic === 'vehicle/run/state') {

        const state = parseInt(value);
        
        // 모든 상태 버튼 비활성화 (속성 선택자 사용)
        $('[id="vehicle/run/state/0"], [id="vehicle/run/state/1"]')
            .prop('disabled', true)
            .removeClass('btn-success btn-primary')
            .addClass('btn-secondary');
        
        // 해당 상태 버튼만 활성화
        if (state === 0) {
            $('[id="vehicle/run/state/0"]')
                .prop('disabled', false)
                .removeClass('btn-secondary')
                .addClass('btn-success');
            mqttLog('[MQTT] 🔴 차량 상태: IDLE (정지)');
        } else {
            $('[id="vehicle/run/state/1"]')
                .prop('disabled', false)
                .removeClass('btn-secondary')
                .addClass('btn-success');
            mqttLog('[MQTT] 🟢 차량 상태: RUNNING (동작중)');
        }
    }

    // vehicle/surface/state 특별 처리 (노면 상태별 테두리 강조 및 disabled 효과)
    if (topic === 'vehicle/surface/state') {
        const state = parseInt(value);

        announceVehicleSurfaceStateAudio(state);
        
        // 모든 노면 상태 요소의 테두리 제거 및 disabled 효과 적용
        $('[id^="vehicle/surface/state/"]')
            .removeClass('border-primary border-3')
            .addClass('disabled')
            .css({ 
                'opacity': '0.6', 
                'color': '#666',
                'background-color': '#ccc'  // Light gray 배경색
            });
        
        // 해당 노면 상태 요소에 테두리 추가 및 활성화
        const $currentStateElement = $(`[id="vehicle/surface/state/${state}"]`);
        if ($currentStateElement.length > 0) {
            $currentStateElement
                .addClass('border-primary border-3')
                .removeClass('disabled')
                .css({ 
                    'opacity': '1', 
                    'color': '', 
                    'font-weight': 'bold',
                    'background-color': ''  // 원본 배경색 복원
                });
            
            const stateNames = ['ASPHALT', 'PAVING_BLOCK', 'DIRT_ROAD', 'GRAVEL_ROAD'];
            const stateName = stateNames[state] || 'UNKNOWN';
            mqttLog(`[MQTT] 🛣️ 노면 상태: ${stateName} (${state})`);
        }
    }

    // vehicle/surface/obstacle 특별 처리 (장애물 상태별 테두리 강조 및 disabled 효과)
    if (topic === 'vehicle/surface/obstacle') {
        const obstacle = parseInt(value);

        announceVehicleObstacleAudio(obstacle);

        // 모든 장애물 상태 요소의 테두리 제거 및 disabled 효과 적용
        $('[id^="vehicle/surface/obstacle/"]')
            .removeClass('border-primary border-3')
            .addClass('disabled')
            .css({
                'opacity': '0.6',
                'color': '#666',
                'background-color': '#ccc'
            });

        // 해당 장애물 요소에 테두리 추가 및 활성화
        const $currentObstacleElement = $(`[id="vehicle/surface/obstacle/${obstacle}"]`);
        if ($currentObstacleElement.length > 0) {
            $currentObstacleElement
                .addClass('border-primary border-3')
                .removeClass('disabled')
                .css({
                    'opacity': '1',
                    'color': '',
                    'font-weight': 'bold',
                    'background-color': ''
                });

            const obstacleNames = ['NONE', 'STEP', 'POT_HOLE', 'ICE_ROAD'];
            const obstacleName = obstacleNames[obstacle] || 'UNKNOWN';
            mqttLog(`[MQTT] ⚠️ 장애물 상태: ${obstacleName} (${obstacle})`);
        }
    }

    // road roll/pitch 각도 토픽 특별 처리 (rad -> deg, WCS Setting 슬라이더 초기화)
    if (topic === 'vehicle/road/roll_angle' || topic === 'vehicle/road/pitch_angle') {
        const numericRad = Number(value);
        if (Number.isFinite(numericRad)) {
            const angleDeg = Math.round((numericRad * 180) / Math.PI);

            if (topic === 'vehicle/road/roll_angle') {
                if (typeof window.setRoadRollAngleDeg === 'function') {
                    window.setRoadRollAngleDeg(angleDeg);
                }

                announceVehicleRollAngleAudio(angleDeg);

                const $rollSlider = $('#vehicle-roll-angle');
                const $rollValue = $('#vehicle-roll-angle-value');
                if ($rollSlider.length > 0) {
                    $rollSlider.val(String(angleDeg));
                }
                if ($rollValue.length > 0) {
                    $rollValue.text(`${angleDeg}°`);
                }
            } else {
                if (typeof window.setRoadPitchAngleDeg === 'function') {
                    window.setRoadPitchAngleDeg(angleDeg);
                }

                const $pitchSlider = $('#vehicle-pitch-angle');
                const $pitchValue = $('#vehicle-pitch-angle-value');
                if ($pitchSlider.length > 0) {
                    $pitchSlider.val(String(angleDeg));
                }
                if ($pitchValue.length > 0) {
                    $pitchValue.text(`${angleDeg}°`);
                }
            }
        }
    }
    
    // vehicle/operation/command 특별 처리 (차량 이동 제어 버튼 자동 선택)
    if (topic === 'vehicle/operation/command') {
        const commandValue = parseInt(value);
        if (Number.isFinite(commandValue)) {
            window.latestVehicleOperationCommand = commandValue;
            dispatchVehicleDirectionEvent(topic, commandValue);
        }
        window.vehicleDirectionCommandActive = commandValue >= 1 && commandValue <= 4;

        // 상태 페이지 동작 아이콘 동기화
        const $operationIcon = $('[id="vehicle/operation/command/icon"]');
        if ($operationIcon.length > 0) {
            const iconClassByCommand = {
                0: 'bi-stop-circle text-secondary',
                1: 'bi-arrow-up-circle text-info',
                2: 'bi-arrow-down-circle text-warning',
                3: 'bi-arrow-counterclockwise text-primary',
                4: 'bi-arrow-clockwise text-primary',
            };

            const mappedIconClass = iconClassByCommand[commandValue];
            if (mappedIconClass) {
                $operationIcon.attr('class', `bi fs-1 ${mappedIconClass}`);
            }
        }
        
        // 명령값에 따라 해당 버튼 활성화
        let commandName = '';
        
        switch(commandValue) {
            case 0: // 정지
                commandName = '정지';
                break;
            case 1: // 전진
                commandName = '전진';
                break;
            case 2: // 후진
                commandName = '후진';
                break;
            case 3: // 좌회전
                commandName = '좌회전';
                break;
            case 4: // 우회전
                commandName = '우회전';
                break;
            default:
                mqttLog(`[MQTT] ⚠️ 알 수 없는 차량 명령값: ${commandValue}`);
                return;
        }
        
        if (typeof window.announceVehicleDriveCommand === 'function') {
            window.announceVehicleDriveCommand(commandValue);
        }

        if (commandValue === 0 && typeof window.clearVehicleWheelHighlights === 'function') {
            window.clearVehicleWheelHighlights();
        } else if (commandValue === 1 && typeof window.setVehicleWheelHighlightByKeys === 'function') {
            window.setVehicleWheelHighlightByKeys(['fl', 'fr']);
        } else if (commandValue === 2 && typeof window.setVehicleWheelHighlightByKeys === 'function') {
            window.setVehicleWheelHighlightByKeys(['rl', 'rr']);
        } else if (commandValue === 3 && typeof window.setVehicleWheelHighlightByKeys === 'function') {
            window.setVehicleWheelHighlightByKeys(['fr', 'rr']);
        } else if (commandValue === 4 && typeof window.setVehicleWheelHighlightByKeys === 'function') {
            window.setVehicleWheelHighlightByKeys(['fl', 'rl']);
        }

        // 해당 버튼 활성화
        const syncedDirectionUi = (typeof window.syncVehicleDirectionButtons === 'function')
            ? window.syncVehicleDirectionButtons(commandValue)
            : false;
        if (syncedDirectionUi) {
            mqttLog(`[MQTT] 🚗 차량 명령 버튼 선택: ${commandName} (${commandValue})`);
        }
    }

    // operation/state는 주행 상태 보조 정보로만 사용하고, 방향 버튼 강제 동기화에는 사용하지 않는다.
    if (topic === 'vehicle/operation/state') {
        const operationState = parseInt(value, 10);
        if (Number.isFinite(operationState)) {
            window.latestVehicleOperationState = operationState;
        }

        if (operationState === 1) {
            vehicleSpeedZeroClickLatched = false;
        }
    }

    // 차량 실제 속도(vehicle/linear/speed) 기준으로 정지 버튼 자동 활성화
    if (topic === 'vehicle/linear/speed') {
        const numericSpeed = parseFloat(value);
        if (Number.isFinite(numericSpeed)) {
            window.latestVehicleLinearSpeedMs = numericSpeed;
        }

        const shouldSkipAutoStopSync =
            window.vehicleDirectionCommandActive === true ||
            window.manualWheelTestActive === true ||
            (window.suppressAutoStopUntil || 0) > Date.now();

        if (!shouldSkipAutoStopSync) {
            const speedZeroEpsilon = 0.05;
            const speedReleaseEpsilon = 0.15;

            if (Number.isFinite(numericSpeed) && Math.abs(numericSpeed) <= speedZeroEpsilon) {
                const $stopButton = $('#vehicle-stop');

                // 속도 0 구간에 진입할 때 1회 정지 버튼 UI만 동기화한다.
                if (!vehicleSpeedZeroClickLatched && $stopButton.length > 0) {
                    $('#vehicle-forward, #vehicle-backward, #vehicle-turn-left, #vehicle-turn-right, #vehicle-stop')
                        .removeClass('active text-white')
                        .addClass('text-black');

                    $stopButton
                        .addClass('active text-white')
                        .removeClass('text-black');

                    if (typeof window.clearVehicleWheelHighlights === 'function') {
                        window.clearVehicleWheelHighlights();
                    }

                    window.vehicleDirectionCommandActive = false;
                    vehicleSpeedZeroClickLatched = true;
                }

                mqttLog(`[MQTT] ⏹️ 차량 속도 0 근접 감지(${numericSpeed.toFixed(3)}): 정지 버튼 UI 자동 동기화`);
            } else if (Number.isFinite(numericSpeed) && Math.abs(numericSpeed) >= speedReleaseEpsilon) {
                // 다시 움직이기 시작하면 다음 정지 진입 시 자동 클릭이 재동작하도록 latch 해제
                vehicleSpeedZeroClickLatched = false;
            }
        }
    }
    
    // 속도 UI(슬라이더/텍스트)는 수동 조작 시에만 갱신한다.
    // MQTT 수신 토픽(vehicle/linear/max_speed, vehicle/linear/speed)으로는 속도 UI를 갱신하지 않는다.
    
    if ($targetElement.length > 0) {
        // 숫자 값 포맷팅
        let formattedValue = getFormattedTopicValue(topic, value);
        const isSensorStateTopic = /^sensor\/[^/]+\/\d+\/state$/.test(String(topic || ''));
        const numericSensorState = Number.parseInt(value, 10);
        const isSensorInactive = isSensorStateTopic && numericSensorState !== 1;

        if (isSensorStateTopic) {
            const sensorTopicMatch = String(topic || '').match(/^sensor\/([^/]+)\/(\d+)\/state$/);
            if (sensorTopicMatch) {
                const sensorId = String(sensorTopicMatch[1] || '').trim();
                const sensorIndex = Number.parseInt(sensorTopicMatch[2], 10);
                if (sensorId && Number.isFinite(sensorIndex)) {
                    setSensorInfoRowInactiveState(sensorId, sensorIndex, isSensorInactive);
                }
            }
        }
        
        // jQuery를 사용한 DOM 요소 업데이트
        $targetElement.text(formattedValue);

        if (isSensorStateTopic) {
            $targetElement
                .toggleClass('sensor-state-inactive', isSensorInactive)
                .toggleClass('sensor-state-active', !isSensorInactive);
        }

        if (!isSensorStateTopic && !isSensorInactive) {
            updateTargetElementCss($targetElement);
        }
        syncSensorRowLabelNumberColor(topic);
        
        mqttLog(`[MQTT] ✅ DOM 업데이트 성공: ${topic} -> ${formattedValue}`);
    } else {
        // console.log(`[MQTT] ❌ DOM 요소를 찾을 수 없음: ${topic}`);
    }
} // prcessMqttMessage

function cacheWheelRadius(topic, value) {
    const radiusTopicMatch = topic.match(/^wheel\/(fl|fr|rl|rr)\/radius$/i);
    if (!radiusTopicMatch) {
        return;
    }

    const wheelKey = radiusTopicMatch[1].toLowerCase();
    const radius = Number(value);
    if (!Number.isFinite(radius) || radius <= 0) {
        return;
    }

    window.wheelRadiusById[wheelKey] = radius;
    mqttLog(`[MQTT] 📏 바퀴 반경 캐시: ${wheelKey} -> ${radius} m`);
}

$(document).ready(function() {
    ensureFallbackAudioActivationListener();
    createRunInfoHistoryChart();
    createVehicleSpeedHistoryChart();
});

function applyDerivedWheelLinearSpeed(topic, value) {
    const topicMatch = topic.match(/^wheel\/(fl|fr|rl|rr)\/(.+)$/i);
    if (!topicMatch) {
        return;
    }

    const wheelKey = topicMatch[1].toLowerCase();
    const metricPath = topicMatch[2].toLowerCase();
    if (metricPath !== 'angle/speed') {
        return;
    }

    const angularSpeedRadPerSec = Number(value);
    if (!Number.isFinite(angularSpeedRadPerSec)) {
        return;
    }

    const wheelRadius = Number(window.wheelRadiusById[wheelKey]);
    if (!Number.isFinite(wheelRadius) || wheelRadius <= 0) {
        return;
    }

    const linearSpeedMps = angularSpeedRadPerSec * wheelRadius;
    const linearSpeedTopic = `wheel/${wheelKey}/linear/speed`;
    const $linearSpeedElement = $(`[id="${linearSpeedTopic}"]`);
    if ($linearSpeedElement.length === 0) {
        return;
    }
    const formattedLinearSpeed = getFormattedTopicValue(linearSpeedTopic, linearSpeedMps);
    $linearSpeedElement.text(formattedLinearSpeed);
    updateTargetElementCss($linearSpeedElement);
}

function applyWheelAngularVelocityToViewer(topic, value) {
    if (typeof setWheelAnimationByKey !== 'function') {
        return;
    }

    const topicMatch = topic.match(/^wheel\/(fl|fr|rl|rr)\/(.+)$/i);
    if (!topicMatch) {
        return;
    }

    const wheelKey = topicMatch[1].toLowerCase();
    const metricPath = topicMatch[2].toLowerCase();
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return;
    }

    const isAngularTopic = metricPath === 'angle/speed';

    if (!isAngularTopic) {
        return;
    }

    // 수동 휠 테스트 중에는 해당 휠의 MQTT 각속도 값(지연 0값 등)으로 로컬 회전이 덮어써지지 않게 보호
    if (
        window.manualWheelTestActive === true
        && String(window.manualWheelTestWheel || '').toLowerCase() === wheelKey
    ) {
        return;
    }

    const rpmValue = convertAngularMetricToRpm(metricPath, numericValue);
    if (!Number.isFinite(rpmValue)) {
        return;
    }

    console.log(`[WHEEL_SPEED] ${wheelKey.toUpperCase()} ${rpmValue.toFixed(1)} rpm`);

    setWheelAnimationByKey(wheelKey, rpmValue);
}

function convertAngularMetricToRpm(metricPath, value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return NaN;
    }

    if (metricPath === 'angle/speed') {
        // 프로젝트 표준 토픽: wheel/{id}/angle/speed 는 rad/s 로 해석
        return (numericValue * 60) / (2 * Math.PI);
    }

    return NaN;
}

function getFormattedTopicValue(topic, value) {
    const numValue = Number(value);

    let formattedValue = value;
    const surfaceObstacleLabels = ['없음', '단차', '포트홀', '빙판길'];
            
    if (topic.startsWith('sensor/') && topic.endsWith('/state')) {
        formattedValue = numValue === 1 ? '정상' : '비활성';
    } else if (topic.startsWith('sensor/') && topic.endsWith('/obstacle')) {
        const obstacleIndex = Number.parseInt(value, 10);
        formattedValue = surfaceObstacleLabels[obstacleIndex] || '알수없음';
    } else if (topic === 'obstacle') {
        const stateIndex = parseInt(value, 10);
        formattedValue = surfaceObstacleLabels[stateIndex] || '알수없음';
    } else if (topic === 'obstacle/confidence') {
        const confidencePercent = Number.isFinite(numValue) ? Math.round(numValue * 100) : 0;
        formattedValue = `${confidencePercent}%`;
    } else if (topic === 'obstacle/sensors') {
        try {
            const parsed = JSON.parse(String(value));
            if (Array.isArray(parsed) && parsed.length > 0) {
                formattedValue = parsed
                    .map((sensor) => `${sensor.id || '?'}#${sensor.index ?? '?'}`)
                    .join(', ');
            } else {
                formattedValue = '-';
            }
        } catch (error) {
            formattedValue = String(value || '-');
        }
    } else if (topic === 'vehicle/drive/available_time') {
        // 주행 가능 시간
        // 시분 변환 표시 (초 → 시:분)
        const hours = Math.floor(numValue / 3600);
        const minutes = Math.floor((numValue % 3600) / 60); 
        if (hours === 0) {
            formattedValue = `${minutes}분`;  // 시간이 0이면 분만 표시
        } else {
            formattedValue = `${hours}시 ${minutes.toString().padStart(2, '0')}분`;
        }
    } else if (topic === 'vehicle/battery/remain_time') {
        // 배터리 잔여 시간도 시:분으로 표시
        const hours = Math.floor(numValue / 3600);
        const minutes = Math.floor((numValue % 3600) / 60);
        if (hours === 0) {
            formattedValue = `${minutes}분`;  // 시간이 0이면 분만 표시
        } else {
            formattedValue = `${hours}시 ${minutes.toString().padStart(2, '0')}분`;
        }
    } else if (topic === 'vehicle/drive/elapsed_time') {
        // 총 주행 시간: 1분 이하면 초, 60분 이하면 분초, 이상이면 시간 단위로 표시
        if (isNaN(numValue) || numValue === null || numValue === undefined) {
            formattedValue = value;
        } else if (numValue >= 0 && numValue < 60) {
            // 0초 이상 60초 미만 - 초로 표시
            const seconds = Math.floor(numValue);
            formattedValue = `${seconds}초`;
        } else if (numValue < 3600) {
            // 60초 이상 3600초(60분) 미만 - 분초로 표시
            const totalSeconds = Math.floor(numValue);
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            formattedValue = `${minutes}분 ${seconds}초`;
        } else {
            // 3600초(60분) 이상 - 시간 단위로 표시
            const hours = Math.floor(numValue / 3600);
            const minutes = Math.floor((numValue % 3600) / 60);
            formattedValue = `${hours}시 ${minutes.toString().padStart(2, '0')}분`;
        }
    } else if (topic === 'vehicle/drive/total_distance') {
        // 총 이동거리: 1km 미만은 m 단위, 1km 이상은 km 단위로 표시
        if (numValue < 1000) {
            formattedValue = `${Math.round(numValue)}m`;  // 1km 미만은 미터 단위
        } else {
            const kilometers = numValue / 1000;
            formattedValue = `${kilometers.toFixed(0)}km`;  // 1km 이상은 킬로미터 단위
        }
    } else if (topic === 'vehicle/battery/remain_amount') {
        formattedValue = `${numValue.toFixed(0)}%`;  // 배터리 잔량 퍼센트
    } else if (topic === 'vehicle/linear/max_speed') {
        // 최고 속도: m/s를 km/h로 변환 (1 m/s = 3.6 km/h)
        const kmPerHour = numValue * 3.6;
        const roundedKmPerHour = Math.round(kmPerHour);  // 반올림하여 정수로 만듦
        formattedValue = `${roundedKmPerHour} Km/h`;  // 소수점 없이 정수로 표시
    } else if (topic === 'vehicle/operation/command') {
        // 동작 상태: 0~4 숫자를 문자로 변환
        const operationStates = ['정지', '전진', '후진', '좌회전', '우회전'];
        const stateIndex = parseInt(value);
        if (stateIndex >= 0 && stateIndex < operationStates.length) {
            formattedValue = operationStates[stateIndex];
        } else {
            formattedValue = '알수없음';  // 범위를 벗어난 값
        }
    } else if (topic.includes('/linear/speed')) {
        // m/s를 km/h로 변환 (1 m/s = 3.6 km/h)
        const kmPerHour = numValue * 3.6;
        const roundedKmPerHour = Math.round(kmPerHour);  // 반올림하여 정수로 만듦
        formattedValue = `${roundedKmPerHour} km/h`;  // 소수점 없이 정수로 표시
    } else if (topic.includes('/power')) {
        formattedValue = `${Math.round(numValue)} W`;  // SI: 와트
    } else if (topic.includes('/pid/')) {
        formattedValue = numValue.toFixed(2);  // 무차원
    } else if (topic.includes('/tof/distance')) {
        formattedValue = `${numValue.toFixed(3)} m`;  // SI: 미터 (ToF 센서)
    } else if (topic.includes('/angle/speed')) {
        // rad/s -> rpm
        const rpm = (numValue * 60) / (2 * Math.PI);
        formattedValue = `${rpm.toFixed(1)} rpm`;
    } else if (topic.includes('/angle')) {
        // radian을 도(degree)로 변환 표시
        const degrees = (numValue * 180 / Math.PI);
        formattedValue = `${degrees.toFixed(1)}°`;
    } else if (topic.includes('/axis/angle')) {
        // 축 각도도 radian에서 도로 변환 표시
        const degrees = (numValue * 180 / Math.PI);
        formattedValue = `${degrees.toFixed(1)}°`;
    } else if (topic.includes('/voltage')) {
        formattedValue = `${numValue.toFixed(2)} V`;  // SI: 볼트
    } else if (topic.includes('/distance') || topic.includes('/total_distance')) {
        formattedValue = `${numValue.toFixed(3)} m`;  // SI: 미터 (기타 거리)
    } else if (topic.includes('/acceleration')) {
        const accelerationKmPerHourPerSec = numValue * 3.6;
        formattedValue = `${accelerationKmPerHourPerSec.toFixed(1)} km/hs`;
    } else if (topic.includes('/torque')) {
        formattedValue = `${numValue.toFixed(2)} Nm`;  // SI: 뉴턴미터
    } else if (topic.includes('_time')) {
        formattedValue = `${Math.round(numValue)} s`;  // SI: 초 (기타 시간 값들)
    } else if (topic.includes('/position/')) {
        formattedValue = `${numValue.toFixed(0)} m`;  // SI: 미터 (위치)
    } else if (topic.includes('/remain_amount')) {
        formattedValue = `${numValue.toFixed(1)} %`;  // 기타 퍼센트 값
    } else {
        // 기본 숫자 포맷
        formattedValue = numValue.toFixed(2);
    }

    return formattedValue;
} // getFormattedValue

function updateTargetElementCss( $targetElement ) {
    // tr의 index를 구해서 색상 결정
    const $parentRow = $targetElement.closest('tr');

    if ($parentRow.length > 0 && $parentRow.hasClass('sensor-info-row-inactive')) {
        return;
    }

    let rowIndex = $parentRow.length > 0 ? $parentRow.index() : 0;
    
    // rowIndex가 유효하지 않은 경우 기본값 0으로 설정
    if (rowIndex < 0 || isNaN(rowIndex)) {
        rowIndex = 0;
    }
    
    // tr index에 따른 색상 배열 (첫 번째와 두 번째 색상)
    const colorPairs = [
        { first: '#e91e63', second: '#9c27b0' },  // index 0: 핑크 → 보라
        { first: '#2196f3', second: '#03a9f4' },  // index 1: 파란색 → 하늘색
        { first: '#4caf50', second: '#8bc34a' },  // index 2: 초록색 → 연초록
        { first: '#ff9800', second: '#ffc107' },  // index 3: 주황색 → 노란색
        { first: '#f44336', second: '#ff5722' },  // index 4: 빨간색 → 주황빨강
        { first: '#673ab7', second: '#3f51b5' },  // index 5: 보라 → 인디고
    ];
    
    // 색상 선택 (index가 배열 길이보다 크면 순환)
    const colorPair = colorPairs[rowIndex % colorPairs.length];
    
    // colorPair가 유효한지 확인
    if (!colorPair) {
        console.warn('[CSS] 색상 배열에서 유효한 colorPair를 찾을 수 없음. rowIndex:', rowIndex);
        return; // 에러 방지를 위해 함수 종료
    }
    
    // tr index에 따른 2단계 전경색 변경 효과
    $targetElement.css({
        'transition': 'color 0.15s ease',
        'color': colorPair.first,  // 첫 번째 색상
        'font-weight': 'bold'
    });
    
    // 150ms 후 두 번째 색상으로 변경
    setTimeout(() => {
        $targetElement.css('color', colorPair.second);  // 두 번째 색상
    }, 150);
    
    // 500ms 후 원래 색상으로 복원
    setTimeout(() => {
        $targetElement.css({ 
            'font-weight': 'bold'
        });
    }, 500);

} // updateTargetElementCss