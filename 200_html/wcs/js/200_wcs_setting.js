$(document).ready(function () {
    const maxSpeedTopic = 'vehicle/linear/max_speed';
    const vehicleOperationCommandTopic = 'vehicle/operation/command';
    const $wcsSampleVideoPane = $('#wcs-input-sample-video-pane');
    const vehicleDirectionButtonSelector = '#vehicle-forward, #vehicle-backward, #vehicle-turn-left, #vehicle-turn-right, #vehicle-stop';
    const wcsSampleVideoItemTemplate = document.getElementById('wcs-sample-video-item-template');
    const SAMPLE_VIDEO_BROWSER_STORAGE_KEY = 'wcs.setting.sample_video_browser.v1';
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
            sendMQTTMessage(maxSpeedTopic, speedMs);
        }
    }

    function updateVehicleRollAngleUi(rollAngleDeg, shouldPublish = true) {
        const numericRoll = Number.parseInt(rollAngleDeg, 10);
        const normalizedRoll = Number.isFinite(numericRoll) ? Math.max(-30, Math.min(30, numericRoll)) : 0;

        $('#vehicle-roll-angle').val(normalizedRoll);
        $('#vehicle-roll-angle-value').text(`${normalizedRoll}°`);

        if (shouldPublish) {
            const rollAngleRad = (normalizedRoll * Math.PI) / 180;
            sendMQTTMessage('vehicle/road/roll_angle', rollAngleRad);
        }
    }

    function updateVehiclePitchAngleUi(pitchAngleDeg, shouldPublish = true) {
        const numericPitch = Number.parseInt(pitchAngleDeg, 10);
        const normalizedPitch = Number.isFinite(numericPitch) ? Math.max(-30, Math.min(30, numericPitch)) : 0;

        $('#vehicle-pitch-angle').val(normalizedPitch);
        $('#vehicle-pitch-angle-value').text(`${normalizedPitch}°`);

        if (shouldPublish) {
            const pitchAngleRad = (normalizedPitch * Math.PI) / 180;
            sendMQTTMessage('vehicle/road/pitch_angle', pitchAngleRad);
        }
    }

    function getVehicleCommandByButtonId(buttonId) {
        switch (buttonId) {
            case 'vehicle-forward':
                return 1;
            case 'vehicle-backward':
                return 2;
            case 'vehicle-turn-left':
                return 3;
            case 'vehicle-turn-right':
                return 4;
            case 'vehicle-stop':
            default:
                return 0;
        }
    }

    function getVehicleButtonIdByCommand(command) {
        switch (Number(command)) {
            case 1:
                return 'vehicle-forward';
            case 2:
                return 'vehicle-backward';
            case 3:
                return 'vehicle-turn-left';
            case 4:
                return 'vehicle-turn-right';
            case 0:
            default:
                return 'vehicle-stop';
        }
    }

    function updateVehicleDirectionControlUi(command) {
        const activeButtonId = getVehicleButtonIdByCommand(command);

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

    function normalizePath(pathValue) {
        return String(pathValue || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    }

    function encodePathForRoute(pathValue) {
        return normalizePath(pathValue)
            .split('/')
            .filter(function (segment) { return segment.length > 0; })
            .map(function (segment) { return encodeURIComponent(segment); })
            .join('/');
    }

    function buildVideoThumbnailUrl(fileName) {
        return '/fast/video_thumbnail/' + encodePathForRoute(fileName) + '?t=' + Date.now();
    }

    function buildSampleBrowserUrl(folderName) {
        return '/fast/sample_browser/' + encodePathForRoute(folderName);
    }

    function buildSamplesUrl(folderName) {
        return '/fast/samples/' + encodePathForRoute(folderName);
    }

    function normalizeSampleFolderPath(folderPath, baseFolder) {
        const normalized = normalizePath(folderPath).replace(/^samples\//, '');
        if (!normalized) {
            return baseFolder;
        }
        return normalized;
    }

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

    function buildFolderLabel(baseFolder, folderPath) {
        const normalized = normalizeSampleFolderPath(folderPath, baseFolder);
        if (normalized === baseFolder) {
            return '기본 폴더';
        }
        return normalized.replace(new RegExp('^' + baseFolder + '/?'), '');
    }

    function buildSampleBrowserHeader(baseFolder, currentFolderPath, showAllFiles) {
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
    }

    function renderSampleFolderTiles(baseFolder, childFolders) {
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
    }

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

    function renderSampleVideoThumbnails(browserData, showAllFiles) {
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
    }

    function loadSampleVideos(folderPath, showAllFiles) {
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
    }

    function ensureSampleVideosLoaded() {
        if (!isSampleVideosLoaded) {
            loadSampleVideos(sampleVideoBrowserPath, sampleVideoShowAllFiles);
        }
    }

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
        const command = getVehicleCommandByButtonId($(this).attr('id'));
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
    ensureSampleVideosLoaded();
});
