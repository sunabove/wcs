$(document).ready(function () {
    const maxSpeedTopic = 'vehicle/linear/max_speed';
    const vehicleOperationCommandTopic = 'vehicle/operation/command';
    const $wcsSampleVideoPane = $('#wcs-input-sample-video-pane');
    const vehicleDirectionButtonSelector = (typeof window.getVehicleDirectionButtonSelector === 'function')
        ? window.getVehicleDirectionButtonSelector()
        : '#vehicle-forward, #vehicle-backward, #vehicle-turn-left, #vehicle-turn-right, #vehicle-stop';
    const wcsSampleVideoItemTemplate = document.getElementById('wcs-sample-video-item-template');
    const SAMPLE_VIDEO_BROWSER_STORAGE_KEY = 'wcs.setting.sample_video_browser.v1';
    const OBSTACLE_SENSOR_DEFINITIONS = [
        { id: 'ToF', count: 4, target: '거리,장애물', enabled: true },
        { id: 'IMU', count: 5, target: '가속도,각속도', enabled: true },
        { id: 'Current', count: 4, target: '전류', enabled: true },
        { id: 'Camera', count: 1, target: '장애물', enabled: true },
        { id: 'Lidar', count: 1, target: '거리,장애물', enabled: true },
    ];
    const obstacleSensorSettingById = {};
    const obstacleSensorRowValueByKey = {};
    const $obstacleSensorValueTbody = $('#obstacle-sensor-value-tbody');
    let isSampleVideosLoaded = false;
    let isSampleVideosLoading = false;
    let sampleVideoBrowserPath = 'video';
    let sampleVideoShowAllFiles = false;
    let currentVideoFileName = '';
    let isDirectionInitSyncWindow = true;
    let pendingDirectionCommandValue = null;
    let pendingDirectionCommandTimer = null;

    function updateVehicleMaxSpeedUi(speedKmh, shouldPublish = true) {
        const numericKmh = Number.parseFloat(speedKmh);
        const normalizedKmh = Number.isFinite(numericKmh) ? Math.max(0, Math.min(100, numericKmh)) : 0;
        const roundedKmh = Math.round(normalizedKmh);

        $('#vehicle-max-speed').val(roundedKmh);
        $('#vehicle-max-speed-value').text(`${roundedKmh} Km/h`);

        if (shouldPublish) {
            const speedMs = Number((roundedKmh / 3.6).toFixed(2));
            window.WcsMqtt.sendMQTTMessage(maxSpeedTopic, speedMs);
        }
    }

    function updateVehicleRollAngleUi(rollAngleDeg, shouldPublish = true) {
        const numericRoll = Number.parseInt(rollAngleDeg, 10);
        const normalizedRoll = Number.isFinite(numericRoll) ? Math.max(-30, Math.min(30, numericRoll)) : 0;

        $('#vehicle-roll-angle').val(normalizedRoll);
        $('#vehicle-roll-angle-value').text(`${normalizedRoll}°`);

        if (shouldPublish) {
            const rollAngleRad = (normalizedRoll * Math.PI) / 180;
            window.WcsMqtt.sendMQTTMessage('vehicle/road/roll_angle', rollAngleRad);
        }
    }

    function updateVehiclePitchAngleUi(pitchAngleDeg, shouldPublish = true) {
        const numericPitch = Number.parseInt(pitchAngleDeg, 10);
        const normalizedPitch = Number.isFinite(numericPitch) ? Math.max(-30, Math.min(30, numericPitch)) : 0;

        $('#vehicle-pitch-angle').val(normalizedPitch);
        $('#vehicle-pitch-angle-value').text(`${normalizedPitch}°`);

        if (shouldPublish) {
            const pitchAngleRad = (normalizedPitch * Math.PI) / 180;
            window.WcsMqtt.sendMQTTMessage('vehicle/road/pitch_angle', pitchAngleRad);
        }
    }

    function upsertObstacleSensorSetting(sensorId, partialValue) {
        const safeId = String(sensorId || '').trim();
        if (!safeId) {
            return;
        }

        if (!obstacleSensorSettingById[safeId]) {
            obstacleSensorSettingById[safeId] = {
                id: safeId,
                count: 1,
                target: '',
                enabled: true,
            };
        }

        obstacleSensorSettingById[safeId] = {
            ...obstacleSensorSettingById[safeId],
            ...partialValue,
        };
    }

    function getOrderedObstacleSensorSettings() {
        return OBSTACLE_SENSOR_DEFINITIONS
            .map((sensorDef) => obstacleSensorSettingById[sensorDef.id] || sensorDef)
            .map((sensorDef) => ({
                id: String(sensorDef.id),
                count: Math.max(1, Number.parseInt(sensorDef.count, 10) || 1),
                target: String(sensorDef.target || ''),
                enabled: Boolean(sensorDef.enabled),
            }));
    }

    function getSensorRowKey(sensorId, sensorIndex) {
        return `${String(sensorId)}#${Number.parseInt(sensorIndex, 10)}`;
    }

    function getDefaultSensorValue(sensorId) {
        return 0;
    }

    function getDefaultSensorConfidence(sensorId) {
        return 0;
    }

    function getSensorValueSliderSpec(sensorId) {
        switch (String(sensorId)) {
            case 'ToF':
            case 'Lidar':
                return { min: 0, max: 5, step: 0.01, decimals: 2 };
            case 'Current':
                return { min: 0, max: 20, step: 0.01, decimals: 2 };
            case 'IMU':
                return { min: -20, max: 20, step: 0.01, decimals: 2 };
            case 'Camera':
                return { min: 0, max: 3, step: 1, decimals: 0 };
            default:
                return { min: 0, max: 10, step: 0.01, decimals: 2 };
        }
    }

    function normalizeSensorValueById(sensorId, rawValue) {
        const spec = getSensorValueSliderSpec(sensorId);
        const numericValue = Number.parseFloat(rawValue);
        const fallback = getDefaultSensorValue(sensorId);
        const safeValue = Number.isFinite(numericValue) ? numericValue : fallback;
        const clamped = Math.max(spec.min, Math.min(spec.max, safeValue));

        if (spec.decimals === 0) {
            return Math.round(clamped);
        }

        return Number(clamped.toFixed(spec.decimals));
    }

    function normalizeSensorConfidence(rawValue) {
        const numericConfidence = Number.parseFloat(rawValue);
        const safeConfidence = Number.isFinite(numericConfidence) ? numericConfidence : 0;
        return Number(Math.max(0, Math.min(1, safeConfidence)).toFixed(3));
    }

    function upsertObstacleSensorRowValue(sensorId, sensorIndex, partialValue) {
        const safeId = String(sensorId || '').trim();
        const safeIndex = Number.parseInt(sensorIndex, 10);
        if (!safeId || !Number.isFinite(safeIndex) || safeIndex < 0) {
            return;
        }

        const rowKey = getSensorRowKey(safeId, safeIndex);
        if (!obstacleSensorRowValueByKey[rowKey]) {
            const sensorSetting = obstacleSensorSettingById[safeId] || {};
            obstacleSensorRowValueByKey[rowKey] = {
                id: safeId,
                index: safeIndex,
                value: getDefaultSensorValue(safeId),
                confidence: getDefaultSensorConfidence(safeId),
                enabled: Boolean(sensorSetting.enabled ?? true),
            };
        }

        obstacleSensorRowValueByKey[rowKey] = {
            ...obstacleSensorRowValueByKey[rowKey],
            ...partialValue,
        };
    }

    function getOrderedObstacleSensorRows() {
        const rows = [];
        getOrderedObstacleSensorSettings().forEach((sensorDef) => {
            for (let sensorIndex = 0; sensorIndex < sensorDef.count; sensorIndex += 1) {
                const rowKey = getSensorRowKey(sensorDef.id, sensorIndex);
                if (!obstacleSensorRowValueByKey[rowKey]) {
                    upsertObstacleSensorRowValue(sensorDef.id, sensorIndex, {});
                }

                rows.push({
                    ...obstacleSensorRowValueByKey[rowKey],
                    enabled: Boolean(obstacleSensorRowValueByKey[rowKey].enabled ?? sensorDef.enabled),
                });
            }
        });
        return rows;
    }

    function renderObstacleSensorSettings() {
        // Sensor list UI was removed; keep table rendering entrypoint intact.
        renderObstacleSensorValueTable();
    }

    function renderObstacleSensorValueTable() {
        if ($obstacleSensorValueTbody.length === 0) {
            return;
        }

        const rows = getOrderedObstacleSensorRows();
        const groupRowCountBySensorId = {};
        const groupRenderedBySensorId = {};
        const groupStyleClassBySensorId = {};
        let groupStyleIndex = 0;

        rows.forEach((row) => {
            const sensorId = String(row.id || '');
            groupRowCountBySensorId[sensorId] = (groupRowCountBySensorId[sensorId] || 0) + 1;

            if (!groupStyleClassBySensorId[sensorId]) {
                groupStyleClassBySensorId[sensorId] = groupStyleIndex % 2 === 0
                    ? 'obstacle-sensor-group-even'
                    : 'obstacle-sensor-group-odd';
                groupStyleIndex += 1;
            }
        });

        $obstacleSensorValueTbody.empty();

        if (rows.length === 0) {
            $obstacleSensorValueTbody.append('<tr><td colspan="7" class="text-center text-muted py-2">센서 항목이 없습니다.</td></tr>');
            return;
        }

        rows.forEach((row) => {
            const sensorLabel = String(row.id || '');
            const sensorNumber = Number.parseInt(row.index, 10) + 1;
            const isEnabled = Boolean(row.enabled);
            const valueNumber = normalizeSensorValueById(sensorLabel, row.value);
            const confidenceNumber = normalizeSensorConfidence(row.confidence);
            const valueSpec = getSensorValueSliderSpec(sensorLabel);

            const rowDisabledClass = isEnabled ? '' : ' obstacle-sensor-value-row-disabled';
            const disabledAttr = isEnabled ? '' : ' disabled';
            const buttonDisabledAttr = '';
            const shouldRenderGroupReset = !groupRenderedBySensorId[sensorLabel];
            const groupStyleClass = groupStyleClassBySensorId[sensorLabel] || '';
            const groupStartClass = shouldRenderGroupReset ? ' obstacle-sensor-group-start' : '';
            if (shouldRenderGroupReset) {
                groupRenderedBySensorId[sensorLabel] = true;
            }

            const groupResetCellHtml = shouldRenderGroupReset
                ? `<td class="text-center" rowspan="${groupRowCountBySensorId[sensorLabel]}">
                        <div class="obstacle-sensor-group-action-wrap">
                            <button type="button" class="btn btn-outline-secondary btn-sm obstacle-sensor-row-reset-group" ${buttonDisabledAttr}>초기화</button>
                            <button type="button" class="btn btn-primary btn-sm obstacle-sensor-row-apply-group" ${buttonDisabledAttr}>적용</button>
                        </div>
                    </td>`
                : '';

            const html = `
                <tr class="${groupStyleClass}${groupStartClass}${rowDisabledClass}" data-sensor-id="${sensorLabel}" data-sensor-index="${row.index}">
                    <td class="text-center fw-semibold" data-sensor-column="name"><span class="obstacle-sensor-publish-text">${sensorLabel}</span></td>
                    <td class="text-center" data-sensor-column="number" data-sensor-column-index="${row.index}"><span class="obstacle-sensor-publish-text">${sensorNumber}</span></td>
                    <td class="text-center">
                        <button
                            type="button"
                            class="btn btn-sm obstacle-sensor-row-state-toggle ${isEnabled ? 'btn-success' : 'btn-outline-secondary'}"
                            data-enabled="${isEnabled ? '1' : '0'}"
                            aria-pressed="${isEnabled ? 'true' : 'false'}"
                        >
                            ${isEnabled ? 'ON' : 'OFF'}
                        </button>
                    </td>
                    <td>
                        <div class="obstacle-sensor-row-control">
                            <input
                                type="range"
                                min="${valueSpec.min}"
                                max="${valueSpec.max}"
                                step="${valueSpec.step}"
                                class="form-range mb-0 obstacle-sensor-row-value"
                                value="${valueNumber}"
                                ${disabledAttr}
                            >
                            <span class="badge text-bg-secondary obstacle-sensor-row-value-text">${valueNumber}</span>
                            <button type="button" class="btn btn-outline-secondary btn-sm obstacle-sensor-row-reset-value" ${buttonDisabledAttr}>초기화</button>
                        </div>
                    </td>
                    <td>
                        <div class="obstacle-sensor-row-control">
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                class="form-range mb-0 obstacle-sensor-row-confidence"
                                value="${confidenceNumber}"
                                ${disabledAttr}
                            >
                            <span class="badge text-bg-secondary obstacle-sensor-row-confidence-text">${confidenceNumber}</span>
                            <button type="button" class="btn btn-outline-secondary btn-sm obstacle-sensor-row-reset-confidence" ${buttonDisabledAttr}>초기화</button>
                        </div>
                    </td>
                    <td class="text-center">
                        <button type="button" class="btn btn-outline-secondary btn-sm obstacle-sensor-row-reset-all" ${buttonDisabledAttr}>초기화</button>
                    </td>
                    ${groupResetCellHtml}
                </tr>
            `;
            $obstacleSensorValueTbody.append(html);
        });
    }

    function resetObstacleSensorSettings() {
        OBSTACLE_SENSOR_DEFINITIONS.forEach((sensorDef) => {
            upsertObstacleSensorSetting(sensorDef.id, {
                count: sensorDef.count,
                target: sensorDef.target,
                enabled: sensorDef.enabled,
            });

            for (let sensorIndex = 0; sensorIndex < sensorDef.count; sensorIndex += 1) {
                upsertObstacleSensorRowValue(sensorDef.id, sensorIndex, {
                    value: getDefaultSensorValue(sensorDef.id),
                    confidence: getDefaultSensorConfidence(sensorDef.id),
                });
            }
        });
        renderObstacleSensorSettings();
    }

    function initializeObstacleSensorSettingsDefaults() {
        OBSTACLE_SENSOR_DEFINITIONS.forEach((sensorDef) => {
            if (!obstacleSensorSettingById[sensorDef.id]) {
                upsertObstacleSensorSetting(sensorDef.id, {
                    count: sensorDef.count,
                    target: sensorDef.target,
                    enabled: sensorDef.enabled,
                });
            }

            for (let sensorIndex = 0; sensorIndex < sensorDef.count; sensorIndex += 1) {
                const rowKey = getSensorRowKey(sensorDef.id, sensorIndex);
                if (!obstacleSensorRowValueByKey[rowKey]) {
                    upsertObstacleSensorRowValue(sensorDef.id, sensorIndex, {
                        value: getDefaultSensorValue(sensorDef.id),
                        confidence: getDefaultSensorConfidence(sensorDef.id),
                    });
                }
            }
        });

        renderObstacleSensorSettings();
    }

    function publishObstacleSensorSettings() {
        const publishedRowKeys = [];
        const settings = getOrderedObstacleSensorSettings();
        settings.forEach((sensorDef) => {
            window.WcsMqtt.sendMQTTMessage(`sensor/${sensorDef.id}/count`, sensorDef.count);
            window.WcsMqtt.sendMQTTMessage(`sensor/${sensorDef.id}/target`, sensorDef.target);
            window.WcsMqtt.sendMQTTMessage(`sensor/${sensorDef.id}/enabled`, sensorDef.enabled ? 1 : 0);
        });

        getOrderedObstacleSensorRows().forEach((row) => {
            if (!row.enabled) {
                return;
            }

            publishedRowKeys.push(getSensorRowKey(row.id, row.index));

            const sensorValue = normalizeSensorValueById(row.id, row.value);
            const sensorConfidence = normalizeSensorConfidence(row.confidence);

            window.WcsMqtt.sendMQTTMessage(`sensor/${row.id}/${row.index}/value`, sensorValue);
            window.WcsMqtt.sendMQTTMessage(`sensor/${row.id}/${row.index}/obstacle/confidence`, sensorConfidence);
            window.WcsMqtt.sendMQTTMessage(`sensor/${row.id}/${row.index}/state`, row.enabled ? 1 : 0);
        });

        window.WcsMqtt.sendMQTTMessage('obstacle/sensor/settings', JSON.stringify(settings));
        triggerObstacleSensorPublishBlink(publishedRowKeys);
    }

    function publishSingleObstacleSensorRow(sensorId, sensorIndex) {
        const rowKey = getSensorRowKey(sensorId, sensorIndex);
        const row = obstacleSensorRowValueByKey[rowKey];
        if (!row) {
            return;
        }

        const sensorValue = normalizeSensorValueById(row.id, row.value);
        const sensorConfidence = normalizeSensorConfidence(row.confidence);
        const enabled = Boolean(row.enabled ?? true);

        window.WcsMqtt.sendMQTTMessage(`sensor/${row.id}/${row.index}/value`, sensorValue);
        window.WcsMqtt.sendMQTTMessage(`sensor/${row.id}/${row.index}/obstacle/confidence`, sensorConfidence);
        window.WcsMqtt.sendMQTTMessage(`sensor/${row.id}/${row.index}/state`, enabled ? 1 : 0);
    }

    function publishObstacleSensorGroup(sensorId) {
        const publishedRowKeys = [];
        getOrderedObstacleSensorRows().forEach((row) => {
            if (String(row.id) === String(sensorId)) {
                publishedRowKeys.push(getSensorRowKey(row.id, row.index));
                publishSingleObstacleSensorRow(row.id, row.index);
            }
        });

        triggerObstacleSensorPublishBlink(publishedRowKeys);
    }

    function triggerObstacleSensorPublishBlink(rowKeys) {
        const uniqueRowKeys = Array.from(new Set(Array.isArray(rowKeys) ? rowKeys : []));
        if (uniqueRowKeys.length === 0) {
            return;
        }

        uniqueRowKeys.forEach((rowKey) => {
            const [sensorId, sensorIndexText] = String(rowKey || '').split('#');
            if (!sensorId || sensorIndexText === undefined) {
                return;
            }

            const sensorIndex = Number.parseInt(sensorIndexText, 10);
            if (!Number.isFinite(sensorIndex)) {
                return;
            }

            const $row = $obstacleSensorValueTbody.find(`tr[data-sensor-id="${sensorId}"][data-sensor-index="${sensorIndex}"]`);
            if ($row.length === 0) {
                return;
            }

            $row.find('[data-sensor-column="name"], [data-sensor-column="number"]').each(function () {
                this.classList.remove('obstacle-sensor-publish-cell-blink');
                void this.offsetWidth;
                this.classList.add('obstacle-sensor-publish-cell-blink');
            });

            $row.find('.obstacle-sensor-publish-text').each(function () {
                this.classList.remove('obstacle-sensor-publish-blink');
                void this.offsetWidth;
                this.classList.add('obstacle-sensor-publish-blink');
            });
        });
    }

    function updateVehicleDirectionControlUi(command) {
        const activeButtonId = (typeof window.getVehicleButtonIdByCommand === 'function')
            ? window.getVehicleButtonIdByCommand(command)
            : 'vehicle-stop';

        $(vehicleDirectionButtonSelector)
            .removeClass('active btn-secondary text-white')
            .addClass('btn-outline-secondary text-black');

        $('#' + activeButtonId)
            .removeClass('btn-outline-secondary text-black')
            .addClass('active btn-secondary text-white');
    }

    function sendVehicleDirectionCommand(command) {
        const numericCommand = Number(command);

        isDirectionInitSyncWindow = false;
        if (pendingDirectionCommandTimer) {
            clearTimeout(pendingDirectionCommandTimer);
            pendingDirectionCommandTimer = null;
            pendingDirectionCommandValue = null;
        }

        window.vehicleDirectionCommandActive = numericCommand >= 1 && numericCommand <= 4;
        if (window.vehicleDirectionCommandActive) {
            window.suppressAutoStopUntil = Date.now() + 1500;
        }

        updateVehicleDirectionControlUi(command);
        sendMQTTMessage(vehicleOperationCommandTopic, numericCommand, 1);
    }

    function handleVehicleDirectionUpdate(value) {
        const numericValue = Number.parseInt(value, 10);
        if (!Number.isFinite(numericValue)) {
            return;
        }

        if (isDirectionInitSyncWindow) {
            pendingDirectionCommandValue = numericValue;

            if (pendingDirectionCommandTimer) {
                clearTimeout(pendingDirectionCommandTimer);
            }

            pendingDirectionCommandTimer = setTimeout(function () {
                if (Number.isFinite(pendingDirectionCommandValue)) {
                    updateVehicleDirectionControlUi(pendingDirectionCommandValue);
                }
                pendingDirectionCommandTimer = null;
                pendingDirectionCommandValue = null;
            }, 220);

            return;
        }

        updateVehicleDirectionControlUi(numericValue);
    }

    const normalizePath = typeof window.wcsNormalizePath === 'function'
        ? window.wcsNormalizePath
        : function (pathValue) {
            return String(pathValue || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
        };

    const encodePathForRoute = typeof window.wcsEncodePathForRoute === 'function'
        ? window.wcsEncodePathForRoute
        : function (pathValue) {
            return normalizePath(pathValue)
                .split('/')
                .filter(function (segment) { return segment.length > 0; })
                .map(function (segment) { return encodeURIComponent(segment); })
                .join('/');
        };

    const buildVideoThumbnailUrl = typeof window.wcsBuildVideoThumbnailUrl === 'function'
        ? window.wcsBuildVideoThumbnailUrl
        : function (fileName) {
            return '/fast/video_thumbnail/' + encodePathForRoute(fileName) + '?t=' + Date.now();
        };

    const buildSampleBrowserUrl = typeof window.wcsBuildSampleBrowserUrl === 'function'
        ? window.wcsBuildSampleBrowserUrl
        : function (folderName) {
            return '/fast/sample_browser/' + encodePathForRoute(folderName);
        };

    const buildSamplesUrl = typeof window.wcsBuildSamplesUrl === 'function'
        ? window.wcsBuildSamplesUrl
        : function (folderName) {
            return '/fast/samples/' + encodePathForRoute(folderName);
        };

    const normalizeSampleFolderPath = typeof window.wcsNormalizeSampleFolderPath === 'function'
        ? window.wcsNormalizeSampleFolderPath
        : function (folderPath, baseFolder) {
            const normalized = normalizePath(folderPath).replace(/^samples\//, '');
            if (!normalized) {
                return baseFolder;
            }
            return normalized;
        };

    function applyCurrentVideoHighlight() {
        if ($wcsSampleVideoPane.length === 0) {
            return;
        }

        const normalizedCurrent = normalizePath(currentVideoFileName);
        const $items = $wcsSampleVideoPane.find('.sample-video-item');
        $items.removeClass('selected-sample');

        if (!normalizedCurrent) {
            return;
        }

        $items.each(function () {
            const itemFileName = normalizePath($(this).attr('data-file-name'));
            if (itemFileName === normalizedCurrent) {
                $(this).addClass('selected-sample');
            }
        });
    }

    const buildFolderLabel = typeof window.wcsBuildFolderLabel === 'function'
        ? function (baseFolder, folderPath) {
            return window.wcsBuildFolderLabel(baseFolder, folderPath, {
                leafOnly: false,
                defaultLabel: '기본 폴더',
            });
        }
        : function (baseFolder, folderPath) {
            const normalized = normalizeSampleFolderPath(folderPath, baseFolder);
            if (normalized === baseFolder) {
                return '기본 폴더';
            }
            return normalized.replace(new RegExp('^' + baseFolder + '/?'), '');
        };

    const buildSampleBrowserHeader = typeof window.wcsBuildSampleBrowserHeader === 'function'
        ? function (baseFolder, currentFolderPath, showAllFiles) {
            return window.wcsBuildSampleBrowserHeader({
                baseFolder: baseFolder,
                currentFolderPath: currentFolderPath,
                showAllFiles: showAllFiles,
                includeClearSelectionButton: true,
                clearSelectionLabel: '동영상 미선택',
                showPathLabel: false,
            });
        }
        : function (baseFolder, currentFolderPath, showAllFiles) {
            const normalizedCurrent = normalizeSampleFolderPath(currentFolderPath, baseFolder);
            const $header = $('<div class="d-flex flex-wrap align-items-center gap-2 mb-2"></div>');
            const $homeButton = $('<button type="button" class="btn btn-sm btn-outline-secondary sample-folder-home"><i class="bi bi-house-door me-1"></i>루트</button>')
                .attr('data-base-folder', baseFolder);
            const $allFilesToggleWrap = $('<div class="form-check form-check-inline mb-0"></div>');
            const toggleId = 'sample-folder-all-' + baseFolder;
            const $allFilesToggle = $('<input class="form-check-input sample-folder-all-toggle" type="checkbox">')
                .attr('id', toggleId)
                .attr('data-base-folder', baseFolder)
                .prop('checked', Boolean(showAllFiles));
            const $allFilesToggleLabel = $('<label class="form-check-label small" style="cursor:pointer;"></label>')
                .attr('for', toggleId)
                .text('모든 파일');
            $allFilesToggleWrap.append($allFilesToggle).append($allFilesToggleLabel);
            const $clearSelectionButton = $('<button type="button" class="btn btn-sm btn-outline-danger sample-video-clear-selection"><i class="bi bi-x-circle me-1"></i>동영상 미선택</button>');

            const parentPath = normalizedCurrent.indexOf(baseFolder + '/') === 0
                ? normalizedCurrent.split('/').slice(0, -1).join('/')
                : '';
            const hasParent = Boolean(parentPath) && normalizedCurrent !== baseFolder;
            const $upButton = $('<button type="button" class="btn btn-sm btn-outline-secondary sample-folder-up"><i class="bi bi-arrow-up-circle me-1"></i>상위</button>')
                .attr('data-base-folder', baseFolder)
                .attr('data-parent-folder', hasParent ? parentPath : baseFolder)
                .prop('disabled', !hasParent);

            $header.append($homeButton).append($upButton).append($allFilesToggleWrap).append($clearSelectionButton);
            return $header;
        };

    const renderSampleFolderTiles = typeof window.wcsRenderSampleFolderTiles === 'function'
        ? function (baseFolder, childFolders) {
            return window.wcsRenderSampleFolderTiles({
                baseFolder: baseFolder,
                childFolders: childFolders,
                paneSelector: 'video',
                leafOnlyLabel: false,
            });
        }
        : function (baseFolder, childFolders) {
            const $wrapper = $('<div class="d-flex flex-wrap gap-2 mb-2"></div>');
            const folders = Array.isArray(childFolders) ? childFolders : [];

            if (folders.length === 0) {
                return $wrapper;
            }

            folders.forEach(function (folderPath) {
                const normalizedFolder = normalizeSampleFolderPath(folderPath, baseFolder);
                const label = buildFolderLabel(baseFolder, normalizedFolder);
                const $button = $('<button type="button" class="btn btn-light border sample-folder-item"></button>')
                    .attr('data-pane', 'video')
                    .attr('data-folder-path', normalizedFolder)
                    .append('<i class="bi bi-folder-fill text-warning me-1"></i>')
                    .append($('<span class="small"></span>').text(label || normalizedFolder));
                $wrapper.append($button);
            });

            return $wrapper;
        };

    function saveSampleVideoBrowserStateToStorage() {
        if (typeof window.localStorage === 'undefined') {
            return;
        }

        const payload = {
            folder: normalizeSampleFolderPath(sampleVideoBrowserPath, 'video'),
            showAll: Boolean(sampleVideoShowAllFiles),
        };

        try {
            window.localStorage.setItem(SAMPLE_VIDEO_BROWSER_STORAGE_KEY, JSON.stringify(payload));
        } catch (error) {
            // Ignore storage write errors.
        }
    }

    function restoreSampleVideoBrowserStateFromStorage() {
        if (typeof window.localStorage === 'undefined') {
            return;
        }

        let parsed = null;
        try {
            const raw = window.localStorage.getItem(SAMPLE_VIDEO_BROWSER_STORAGE_KEY);
            if (!raw) {
                return;
            }
            parsed = JSON.parse(raw);
        } catch (error) {
            return;
        }

        if (!parsed || typeof parsed !== 'object') {
            return;
        }

        sampleVideoBrowserPath = normalizeSampleFolderPath(parsed.folder, 'video');
        sampleVideoShowAllFiles = false;
    }

    function extractSampleVideoFiles(result) {
        if (Array.isArray(result)) {
            return result;
        }
        if (result && Array.isArray(result.files)) {
            return result.files;
        }
        if (result && Array.isArray(result.video_files)) {
            return result.video_files;
        }
        if (result && Array.isArray(result.image_files)) {
            return result.image_files;
        }
        return [];
    }

    const renderSampleVideoThumbnails = typeof window.wcsRenderSampleVideoThumbnails === 'function'
        ? function (browserData, showAllFiles) {
            return window.wcsRenderSampleVideoThumbnails({
                pane: $wcsSampleVideoPane,
                browserData: browserData,
                showAllFiles: showAllFiles,
                baseFolder: 'video',
                paneSelector: 'video',
                itemTemplate: wcsSampleVideoItemTemplate,
                emptyMessage: '',
                normalizePath: normalizePath,
                normalizeSampleFolderPath: normalizeSampleFolderPath,
                buildSampleBrowserHeader: buildSampleBrowserHeader,
                renderSampleFolderTiles: function (baseFolder, currentFolderPath, childFolders) {
                    return renderSampleFolderTiles(baseFolder, childFolders);
                },
                buildVideoThumbnailUrl: buildVideoThumbnailUrl,
                onAfterRender: applyCurrentVideoHighlight,
            });
        }
        : function (browserData, showAllFiles) {
            if ($wcsSampleVideoPane.length === 0) {
                return;
            }

            const currentFolder = normalizeSampleFolderPath(browserData && browserData.current_folder, 'video');
            const childFolders = browserData && Array.isArray(browserData.folders) ? browserData.folders : [];
            const fileNames = browserData && Array.isArray(browserData.files) ? browserData.files : [];

            $wcsSampleVideoPane.empty().append(buildSampleBrowserHeader('video', currentFolder, Boolean(showAllFiles)));
            if (!showAllFiles) {
                $wcsSampleVideoPane.append(renderSampleFolderTiles('video', childFolders));
            }

            if (!Array.isArray(fileNames) || fileNames.length === 0) {
                return;
            }

            const $scrollContainer = $('<div class="sample-thumbnail-scroll"></div>');
            const $track = $('<div class="sample-thumbnail-track"></div>');

            fileNames.forEach(function (fileName) {
                const safeFileName = normalizePath(fileName);
                const thumbnailUrl = buildVideoThumbnailUrl(safeFileName);
                const label = safeFileName.split('/').pop() || safeFileName;

                if (!wcsSampleVideoItemTemplate || !wcsSampleVideoItemTemplate.content) {
                    return;
                }

                const node = wcsSampleVideoItemTemplate.content.firstElementChild.cloneNode(true);
                const button = node.querySelector('.sample-video-item');
                const thumbnailImage = node.querySelector('.sample-video-thumbnail');
                const video = node.querySelector('video');
                const caption = node.querySelector('.small');

                if (button) {
                    button.setAttribute('data-file-name', safeFileName);
                }
                if (thumbnailImage) {
                    thumbnailImage.setAttribute('src', thumbnailUrl);
                    thumbnailImage.setAttribute('alt', label);
                } else if (video) {
                    video.removeAttribute('src');
                    video.setAttribute('poster', thumbnailUrl);
                    video.setAttribute('preload', 'none');
                    if (typeof video.load === 'function') {
                        video.load();
                    }
                }
                if (caption) {
                    caption.setAttribute('title', safeFileName);
                    caption.textContent = label;
                }

                $track.append(node);
            });

            $scrollContainer.append($track);
            $wcsSampleVideoPane.append($scrollContainer);
            applyCurrentVideoHighlight();
        };

    const loadSampleVideos = typeof window.wcsLoadSampleVideos === 'function'
        ? function (folderPath, showAllFiles) {
            return window.wcsLoadSampleVideos({
                pane: $wcsSampleVideoPane,
                folderPath: folderPath,
                currentFolderPath: sampleVideoBrowserPath,
                showAllFiles: showAllFiles,
                isLoading: isSampleVideosLoading,
                baseFolder: 'video',
                loadingMessage: '샘플 동영상을 불러오는 중...',
                allFilesErrorMessage: '샘플 동영상 목록을 불러오지 못했습니다.',
                browserErrorMessage: '샘플 폴더를 불러오지 못했습니다.',
                normalizeSampleFolderPath: normalizeSampleFolderPath,
                buildSamplesUrl: buildSamplesUrl,
                buildSampleBrowserUrl: buildSampleBrowserUrl,
                extractSampleVideoFiles: extractSampleVideoFiles,
                renderSampleVideoThumbnails: renderSampleVideoThumbnails,
                setLoading: function (next) {
                    isSampleVideosLoading = Boolean(next);
                },
                setCurrentFolderPath: function (nextPath) {
                    sampleVideoBrowserPath = nextPath;
                },
                setShowAllFiles: function (nextShowAll) {
                    sampleVideoShowAllFiles = Boolean(nextShowAll);
                },
                saveBrowserState: saveSampleVideoBrowserStateToStorage,
                onLoaded: function () {
                    isSampleVideosLoaded = true;
                },
            });
        }
        : function (folderPath, showAllFiles) {
            if ($wcsSampleVideoPane.length === 0) {
                return;
            }
            if (isSampleVideosLoading) {
                return;
            }

            isSampleVideosLoading = true;
            sampleVideoBrowserPath = normalizeSampleFolderPath(folderPath || sampleVideoBrowserPath, 'video');
            sampleVideoShowAllFiles = Boolean(showAllFiles);
            saveSampleVideoBrowserStateToStorage();

            $wcsSampleVideoPane.html('<div class="text-muted text-center py-3">샘플 동영상을 불러오는 중...</div>');

            if (sampleVideoShowAllFiles) {
                $.ajax({
                    url: buildSamplesUrl('video'),
                    method: 'GET'
                }).done(function (result) {
                    const allFileNames = extractSampleVideoFiles(result);
                    renderSampleVideoThumbnails({
                        current_folder: 'samples/video',
                        folders: [],
                        files: allFileNames,
                    }, true);
                    isSampleVideosLoaded = true;
                }).fail(function (jqXHR) {
                    console.error('Sample video all-files error:', jqXHR.status, jqXHR.responseText);
                    $wcsSampleVideoPane.html('<div class="text-danger text-center py-3">샘플 동영상 목록을 불러오지 못했습니다.</div>');
                }).always(function () {
                    isSampleVideosLoading = false;
                });
                return;
            }

            $.ajax({
                url: buildSampleBrowserUrl(sampleVideoBrowserPath),
                method: 'GET'
            }).done(function (result) {
                renderSampleVideoThumbnails(result || {}, false);
                isSampleVideosLoaded = true;
            }).fail(function (jqXHR) {
                console.error('Sample video browser error:', jqXHR.status, jqXHR.responseText);
                $wcsSampleVideoPane.html('<div class="text-danger text-center py-3">샘플 폴더를 불러오지 못했습니다.</div>');
            }).always(function () {
                isSampleVideosLoading = false;
            });
        };

    const ensureSampleVideosLoaded = typeof window.wcsEnsureSampleVideosLoaded === 'function'
        ? function () {
            return window.wcsEnsureSampleVideosLoaded({
                isLoaded: isSampleVideosLoaded,
                loadSampleVideos: loadSampleVideos,
                folderPath: sampleVideoBrowserPath,
                showAllFiles: sampleVideoShowAllFiles,
            });
        }
        : function () {
            if (!isSampleVideosLoaded) {
                loadSampleVideos(sampleVideoBrowserPath, sampleVideoShowAllFiles);
            }
        };

    $obstacleSensorValueTbody.on('change input', '.obstacle-sensor-row-value, .obstacle-sensor-row-confidence', function () {
        const $row = $(this).closest('tr[data-sensor-id][data-sensor-index]');
        const sensorId = String($row.attr('data-sensor-id') || '').trim();
        const sensorIndex = Number.parseInt($row.attr('data-sensor-index'), 10);
        if (!sensorId || !Number.isFinite(sensorIndex)) {
            return;
        }

        const normalizedValue = normalizeSensorValueById(sensorId, $row.find('.obstacle-sensor-row-value').val());
        $row.find('.obstacle-sensor-row-value').val(normalizedValue);
        $row.find('.obstacle-sensor-row-value-text').text(normalizedValue);

        const normalizedConfidence = normalizeSensorConfidence($row.find('.obstacle-sensor-row-confidence').val());
        $row.find('.obstacle-sensor-row-confidence').val(normalizedConfidence);
        $row.find('.obstacle-sensor-row-confidence-text').text(normalizedConfidence);

        upsertObstacleSensorRowValue(sensorId, sensorIndex, {
            value: normalizedValue,
            confidence: normalizedConfidence,
        });
    });

    $obstacleSensorValueTbody.on('click', '.obstacle-sensor-row-state-toggle', function () {
        const $row = $(this).closest('tr[data-sensor-id][data-sensor-index]');
        const sensorId = String($row.attr('data-sensor-id') || '').trim();
        const sensorIndex = Number.parseInt($row.attr('data-sensor-index'), 10);
        if (!sensorId || !Number.isFinite(sensorIndex)) {
            return;
        }

        const currentEnabled = String($(this).attr('data-enabled') || '0') === '1';
        const isEnabled = !currentEnabled;
        upsertObstacleSensorRowValue(sensorId, sensorIndex, {
            enabled: isEnabled,
        });

        renderObstacleSensorValueTable();
        publishSingleObstacleSensorRow(sensorId, sensorIndex);
    });

    $('#reset-obstacle-sensor-settings').on('click', function () {
        resetObstacleSensorSettings();
        publishObstacleSensorSettings();
    });

    $obstacleSensorValueTbody.on('click', '.obstacle-sensor-row-reset-value', function () {
        const $row = $(this).closest('tr[data-sensor-id][data-sensor-index]');
        const sensorId = String($row.attr('data-sensor-id') || '').trim();
        const sensorIndex = Number.parseInt($row.attr('data-sensor-index'), 10);
        if (!sensorId || !Number.isFinite(sensorIndex)) {
            return;
        }

        upsertObstacleSensorRowValue(sensorId, sensorIndex, {
            value: getDefaultSensorValue(sensorId),
        });

        renderObstacleSensorValueTable();
        publishSingleObstacleSensorRow(sensorId, sensorIndex);
    });

    $obstacleSensorValueTbody.on('click', '.obstacle-sensor-row-reset-confidence', function () {
        const $row = $(this).closest('tr[data-sensor-id][data-sensor-index]');
        const sensorId = String($row.attr('data-sensor-id') || '').trim();
        const sensorIndex = Number.parseInt($row.attr('data-sensor-index'), 10);
        if (!sensorId || !Number.isFinite(sensorIndex)) {
            return;
        }

        upsertObstacleSensorRowValue(sensorId, sensorIndex, {
            confidence: getDefaultSensorConfidence(sensorId),
        });

        renderObstacleSensorValueTable();
        publishSingleObstacleSensorRow(sensorId, sensorIndex);
    });

    $obstacleSensorValueTbody.on('click', '.obstacle-sensor-row-reset-all', function () {
        const $row = $(this).closest('tr[data-sensor-id][data-sensor-index]');
        const sensorId = String($row.attr('data-sensor-id') || '').trim();
        const sensorIndex = Number.parseInt($row.attr('data-sensor-index'), 10);
        if (!sensorId || !Number.isFinite(sensorIndex)) {
            return;
        }

        upsertObstacleSensorRowValue(sensorId, sensorIndex, {
            value: getDefaultSensorValue(sensorId),
            confidence: getDefaultSensorConfidence(sensorId),
        });

        renderObstacleSensorValueTable();
        publishSingleObstacleSensorRow(sensorId, sensorIndex);
    });

    $obstacleSensorValueTbody.on('click', '.obstacle-sensor-row-reset-group', function () {
        const $row = $(this).closest('tr[data-sensor-id][data-sensor-index]');
        const sensorId = String($row.attr('data-sensor-id') || '').trim();
        if (!sensorId) {
            return;
        }

        getOrderedObstacleSensorRows().forEach((row) => {
            if (String(row.id) === sensorId) {
                upsertObstacleSensorRowValue(row.id, row.index, {
                    value: getDefaultSensorValue(row.id),
                    confidence: getDefaultSensorConfidence(row.id),
                });
            }
        });

        renderObstacleSensorValueTable();
        publishObstacleSensorGroup(sensorId);
    });

    $obstacleSensorValueTbody.on('click', '.obstacle-sensor-row-apply-group', function () {
        const $row = $(this).closest('tr[data-sensor-id][data-sensor-index]');
        const sensorId = String($row.attr('data-sensor-id') || '').trim();
        if (!sensorId) {
            return;
        }

        publishObstacleSensorGroup(sensorId);
    });

    $('#apply-obstacle-sensor-settings').on('click', function () {
        publishObstacleSensorSettings();
    });

    $('#vehicle-max-speed').on('input', function () {
        updateVehicleMaxSpeedUi($(this).val(), false);
    });

    $('#vehicle-max-speed').on('change', function () {
        updateVehicleMaxSpeedUi($(this).val(), true);
    });

    $wcsSampleVideoPane.on('click', '.sample-video-item', function () {
        $wcsSampleVideoPane.find('.sample-video-item.selected-sample').removeClass('selected-sample');
        $(this).addClass('selected-sample');

        const selectedVideoFileName = String($(this).attr('data-file-name') || '').trim();
        if (selectedVideoFileName) {
            currentVideoFileName = normalizePath(selectedVideoFileName);
            sendMQTTMessage('vehicle/current_video/file_name', selectedVideoFileName);
        }
    });

    $wcsSampleVideoPane.on('click', '.sample-folder-item', function () {
        const folderPath = String($(this).attr('data-folder-path') || '').trim();
        loadSampleVideos(folderPath, sampleVideoShowAllFiles);
    });

    $wcsSampleVideoPane.on('click', '.sample-folder-home', function () {
        const baseFolder = String($(this).attr('data-base-folder') || 'video').trim() || 'video';
        loadSampleVideos(baseFolder, sampleVideoShowAllFiles);
    });

    $wcsSampleVideoPane.on('click', '.sample-folder-up', function () {
        const baseFolder = String($(this).attr('data-base-folder') || 'video').trim() || 'video';
        const parentFolder = String($(this).attr('data-parent-folder') || baseFolder).trim() || baseFolder;
        loadSampleVideos(parentFolder, sampleVideoShowAllFiles);
    });

    $wcsSampleVideoPane.on('change', '.sample-folder-all-toggle', function () {
        const shouldShowAll = $(this).is(':checked');
        loadSampleVideos(sampleVideoBrowserPath, shouldShowAll);
    });

    $wcsSampleVideoPane.on('click', '.sample-video-clear-selection', function () {
        currentVideoFileName = '';
        applyCurrentVideoHighlight();
        sendMQTTMessage('vehicle/current_video/file_name', '');
    });

    $('#reset-vehicle-max-speed').on('click', function () {
        updateVehicleMaxSpeedUi(50, true);
    });

    $(vehicleDirectionButtonSelector).on('click', function () {
        const command = (typeof window.getVehicleCommandByButtonId === 'function')
            ? window.getVehicleCommandByButtonId($(this).attr('id'))
            : 0;
        sendVehicleDirectionCommand(command);
    });

    window.addEventListener('wcs:vehicle-direction-update', function (event) {
        const detail = event && event.detail ? event.detail : null;
        if (!detail) {
            return;
        }

        handleVehicleDirectionUpdate(detail.value);
    });

    if (Number.isFinite(window.latestVehicleOperationCommand)) {
        updateVehicleDirectionControlUi(window.latestVehicleOperationCommand);
    } else if (window.latestVehicleOperationState === 0) {
        updateVehicleDirectionControlUi(0);
    } else {
        updateVehicleDirectionControlUi(0);
    }

    setTimeout(function () {
        isDirectionInitSyncWindow = false;

        if (pendingDirectionCommandTimer) {
            clearTimeout(pendingDirectionCommandTimer);
            pendingDirectionCommandTimer = null;
        }

        if (Number.isFinite(pendingDirectionCommandValue)) {
            updateVehicleDirectionControlUi(pendingDirectionCommandValue);
            pendingDirectionCommandValue = null;
        }
    }, 1200);

    if (typeof window.prcessMqttMessage === 'function' && !window.wcsSettingMaxSpeedHooked) {
        const originalProcessMqtt = window.prcessMqttMessage;
        window.prcessMqttMessage = function (topic, value) {
            originalProcessMqtt(topic, value);

            if (topic === 'vehicle/linear/max_speed') {
                const numericMs = Number.parseFloat(value);
                if (Number.isFinite(numericMs)) {
                    updateVehicleMaxSpeedUi(numericMs * 3.6, false);
                }
            }

            if (topic === 'vehicle/surface/state') {
                const normalized = String(value).trim();
                if ($(`#surface-state option[value="${normalized}"]`).length > 0) {
                    $('#surface-state').val(normalized);
                }
            }

            if (topic === 'vehicle/surface/obstacle') {
                const normalized = String(value).trim();
                if ($(`#surface-obstacle option[value="${normalized}"]`).length > 0) {
                    $('#surface-obstacle').val(normalized);
                }
            }

            if (topic === 'vehicle/current_video/file_name') {
                currentVideoFileName = normalizePath(value);
                applyCurrentVideoHighlight();
            }

            const sensorCountMatch = String(topic || '').match(/^sensor\/([^/]+)\/count$/);
            if (sensorCountMatch) {
                const sensorId = sensorCountMatch[1];
                const sensorCount = Math.max(1, Math.min(16, Number.parseInt(value, 10) || 1));
                upsertObstacleSensorSetting(sensorId, { count: sensorCount });
                renderObstacleSensorSettings();
            }

            const sensorTargetMatch = String(topic || '').match(/^sensor\/([^/]+)\/target$/);
            if (sensorTargetMatch) {
                const sensorId = sensorTargetMatch[1];
                upsertObstacleSensorSetting(sensorId, { target: String(value || '') });
                renderObstacleSensorSettings();
            }

            const sensorEnabledMatch = String(topic || '').match(/^sensor\/([^/]+)\/enabled$/);
            if (sensorEnabledMatch) {
                const sensorId = sensorEnabledMatch[1];
                const enabledText = String(value || '').trim().toLowerCase();
                const enabled = enabledText === '1' || enabledText === 'true' || enabledText === 'on' || enabledText === 'yes';
                upsertObstacleSensorSetting(sensorId, { enabled: enabled });
                renderObstacleSensorSettings();
            }

            const sensorValueMatch = String(topic || '').match(/^sensor\/([^/]+)\/(\d+)\/value$/);
            if (sensorValueMatch) {
                const sensorId = sensorValueMatch[1];
                const sensorIndex = Number.parseInt(sensorValueMatch[2], 10);
                const normalizedValue = normalizeSensorValueById(sensorId, value);
                upsertObstacleSensorRowValue(sensorId, sensorIndex, { value: normalizedValue });
                renderObstacleSensorValueTable();
            }

            const sensorConfidenceMatch = String(topic || '').match(/^sensor\/([^/]+)\/(\d+)\/obstacle\/confidence$/);
            if (sensorConfidenceMatch) {
                const sensorId = sensorConfidenceMatch[1];
                const sensorIndex = Number.parseInt(sensorConfidenceMatch[2], 10);
                const normalizedConfidence = normalizeSensorConfidence(value);
                upsertObstacleSensorRowValue(sensorId, sensorIndex, { confidence: normalizedConfidence });
                renderObstacleSensorValueTable();
            }

            const sensorStateMatch = String(topic || '').match(/^sensor\/([^/]+)\/(\d+)\/state$/);
            if (sensorStateMatch) {
                const sensorId = sensorStateMatch[1];
                const sensorIndex = Number.parseInt(sensorStateMatch[2], 10);
                const stateText = String(value || '').trim().toLowerCase();
                const enabled = stateText === '1' || stateText === 'true' || stateText === 'on' || stateText === 'yes';
                upsertObstacleSensorRowValue(sensorId, sensorIndex, { enabled: enabled });
                renderObstacleSensorValueTable();
            }

            if (topic === vehicleOperationCommandTopic) {
                handleVehicleDirectionUpdate(value);
            }

        };
        window.wcsSettingMaxSpeedHooked = true;
    }

    $('#surface-state').on('change', function () {
        const surfaceValue = $('#surface-state').val();
        sendMQTTMessage('vehicle/surface/state', surfaceValue);
    });

    $('#surface-obstacle').on('change', function () {
        const obstacleValue = $('#surface-obstacle').val();
        sendMQTTMessage('vehicle/surface/obstacle', obstacleValue);
    });

    $('#vehicle-roll-angle').on('input', function () {
        updateVehicleRollAngleUi($(this).val(), false);
    });

    $('#vehicle-roll-angle').on('change', function () {
        updateVehicleRollAngleUi($(this).val(), true);
    });

    $('#reset-vehicle-roll-angle').on('click', function () {
        updateVehicleRollAngleUi(0, true);
    });

    $('#vehicle-pitch-angle').on('input', function () {
        updateVehiclePitchAngleUi($(this).val(), false);
    });

    $('#vehicle-pitch-angle').on('change', function () {
        updateVehiclePitchAngleUi($(this).val(), true);
    });

    $('#reset-vehicle-pitch-angle').on('click', function () {
        updateVehiclePitchAngleUi(0, true);
    });

    restoreSampleVideoBrowserStateFromStorage();
    initializeObstacleSensorSettingsDefaults();
    ensureSampleVideosLoaded();
});
