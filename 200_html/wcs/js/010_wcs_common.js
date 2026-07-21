
// wcs common js for vehicle pages

function setHeaderMenuCss() {
    // 현재 페이지의 파일명 추출
    var currentPage = window.location.pathname.split('/').pop();
    
    // 모든 네비게이션 링크에 대해 처리
    $('header .nav a[href]').each(function() {
        var $link = $(this);
        var linkPage = $link.attr('href');
        
        // 기존 클래스 제거
        $link.removeClass('text-white text-secondary');
        
        // 현재 페이지와 일치하는지 확인하여 클래스 추가
        if (linkPage === currentPage) {
           $link.addClass('text-white'); 
        } else {
            $link.addClass('text-secondary');
        }
    });
}

function getVehicleDirectionButtonSelector() {
    return '#vehicle-forward, #vehicle-backward, #vehicle-turn-left, #vehicle-turn-right, #vehicle-stop';
}

function getVehicleCommandByButtonId(buttonId) {
    switch (String(buttonId || '')) {
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

function getVehicleDriveModeByCommand(commandValue) {
    switch (Number(commandValue)) {
        case 1:
            return 'forward';
        case 2:
            return 'backward';
        case 3:
            return 'left';
        case 4:
            return 'right';
        case 0:
        default:
            return 'stop';
    }
}

function getVehicleHighlightWheelKeysByCommand(commandValue) {
    switch (Number(commandValue)) {
        case 1:
            return ['fl', 'fr'];
        case 2:
            return ['rl', 'rr'];
        case 3:
            return ['fr', 'rr'];
        case 4:
            return ['fl', 'rl'];
        default:
            return [];
    }
}

function getCommandSignedWheelRpm(commandValue, wheelKey, rpmMagnitude) {
    const absRpm = Math.max(0, Math.abs(Number(rpmMagnitude) || 0));
    const normalizedWheelKey = String(wheelKey || '').trim().toLowerCase();

    switch (Number(commandValue)) {
        case 0:
            return 0;
        case 1:
            return absRpm;
        case 2:
            return -absRpm;
        case 3:
            return (normalizedWheelKey === 'fl' || normalizedWheelKey === 'rl') ? -absRpm : absRpm;
        case 4:
            return (normalizedWheelKey === 'fl' || normalizedWheelKey === 'rl') ? absRpm : -absRpm;
        default:
            return Number(rpmMagnitude) || 0;
    }
}

function syncVehicleDirectionButtons(commandValue, buttonSelector) {
    const selector = String(buttonSelector || getVehicleDirectionButtonSelector());

    $(selector)
        .removeClass('active text-white')
        .addClass('text-black');

    const activeButtonId = getVehicleButtonIdByCommand(commandValue);
    const $activeButton = $('#' + activeButtonId);
    if ($activeButton.length === 0) {
        return false;
    }

    $activeButton
        .addClass('active text-white')
        .removeClass('text-black');

    return true;
}

function wcsNormalizePath(pathValue) {
    return String(pathValue || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
}

function wcsEncodePathForRoute(pathValue) {
    return wcsNormalizePath(pathValue)
        .split('/')
        .filter(function (segment) {
            return segment.length > 0;
        })
        .map(function (segment) {
            return encodeURIComponent(segment);
        })
        .join('/');
}

function wcsNormalizeSampleFolderPath(folderPath, baseFolder) {
    const normalized = wcsNormalizePath(folderPath).replace(/^samples\//, '');
    if (!normalized) {
        return String(baseFolder || '');
    }
    return normalized;
}

function wcsResolveRoadDetectStreamPath(pathValue) {
    const normalizedPath = wcsNormalizePath(pathValue);
    if (!normalizedPath) {
        return '';
    }

    // Backward compatibility: a bare file name is treated as cobot sample.
    if (normalizedPath.indexOf('/') === -1) {
        return 'samples/video/cobot/' + normalizedPath;
    }

    return normalizedPath;
}

function wcsBuildVideoThumbnailUrl(fileName) {
    return '/fast/video_thumbnail/' + wcsEncodePathForRoute(fileName) + '?t=' + Date.now();
}

function wcsBuildSamplesUrl(folderName) {
    return '/fast/samples/' + wcsEncodePathForRoute(folderName);
}

function wcsBuildSampleBrowserUrl(folderName) {
    return '/fast/sample_browser/' + wcsEncodePathForRoute(folderName);
}

function wcsBuildRoadDetectStreamUrl(fileName, options) {
    const streamPath = wcsResolveRoadDetectStreamPath(fileName);
    const encodedPath = wcsEncodePathForRoute(streamPath);
    if (!encodedPath) {
        return '';
    }

    const config = Object.assign({
        detect_type: 'road',
        remove_noisy_masks: true,
        show_time_bar: false,
        include_pothole: false,
        pothole_conf: 0.5,
        mqtt_publish: false,
        t: Date.now(),
    }, options || {});

    return '/fast/road_detect_stream/' + encodedPath + '?' + $.param(config);
}

function wcsBuildRoadDetectStreamCleanupUrl(fileName, queryParams) {
    const streamPath = wcsResolveRoadDetectStreamPath(fileName);
    const encodedPath = wcsEncodePathForRoute(streamPath);
    if (!encodedPath) {
        return '';
    }

    const params = Object.assign({ t: Date.now() }, queryParams || {});
    return '/fast/road_detect_stream_cleanup/' + encodedPath + '?' + $.param(params);
}

function wcsBuildFolderLabel(baseFolder, folderPath, options) {
    const config = Object.assign({
        leafOnly: false,
        defaultLabel: '기본 폴더',
    }, options || {});

    const normalized = wcsNormalizeSampleFolderPath(folderPath, baseFolder);
    if (normalized === baseFolder) {
        return config.defaultLabel;
    }

    const relative = normalized.replace(new RegExp('^' + String(baseFolder || '') + '/?'), '');
    if (!relative) {
        return config.defaultLabel;
    }

    if (!config.leafOnly) {
        return relative;
    }

    const parts = relative.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : relative;
}

function wcsBuildSampleBrowserHeader(options) {
    const config = Object.assign({
        baseFolder: '',
        currentFolderPath: '',
        showAllFiles: false,
        includeClearSelectionButton: false,
        clearSelectionLabel: '동영상 미선택',
        showPathLabel: false,
        pathLabelPrefix: '현재: ',
        allFilesSuffix: ' (모든 파일)',
    }, options || {});

    const baseFolder = String(config.baseFolder || '');
    const normalizedCurrent = wcsNormalizeSampleFolderPath(config.currentFolderPath, baseFolder);
    const showAllFiles = Boolean(config.showAllFiles);

    const $header = $('<div class="d-flex flex-wrap align-items-center gap-2 mb-2"></div>');
    const $homeButton = $('<button type="button" class="btn btn-sm btn-outline-secondary sample-folder-home"><i class="bi bi-house-door me-1"></i>루트</button>')
        .attr('data-base-folder', baseFolder);
    const $allFilesToggleWrap = $('<div class="form-check form-check-inline mb-0"></div>');
    const toggleId = 'sample-folder-all-' + baseFolder;
    const $allFilesToggle = $('<input class="form-check-input sample-folder-all-toggle" type="checkbox">')
        .attr('id', toggleId)
        .attr('data-base-folder', baseFolder)
        .prop('checked', showAllFiles);
    const $allFilesToggleLabel = $('<label class="form-check-label small" style="cursor:pointer;"></label>')
        .attr('for', toggleId)
        .text('모든 파일');
    $allFilesToggleWrap.append($allFilesToggle).append($allFilesToggleLabel);

    const parentPath = normalizedCurrent.indexOf(baseFolder + '/') === 0
        ? normalizedCurrent.split('/').slice(0, -1).join('/')
        : '';
    const hasParent = Boolean(parentPath) && normalizedCurrent !== baseFolder;
    const $upButton = $('<button type="button" class="btn btn-sm btn-outline-secondary sample-folder-up"><i class="bi bi-arrow-up-circle me-1"></i>상위</button>')
        .attr('data-base-folder', baseFolder)
        .attr('data-parent-folder', hasParent ? parentPath : baseFolder)
        .prop('disabled', !hasParent);

    $header.append($homeButton).append($upButton).append($allFilesToggleWrap);

    if (config.includeClearSelectionButton) {
        const $clearSelectionButton = $('<button type="button" class="btn btn-sm btn-outline-danger sample-video-clear-selection"><i class="bi bi-x-circle me-1"></i></button>')
            .append(document.createTextNode(String(config.clearSelectionLabel || '동영상 미선택')));
        $header.append($clearSelectionButton);
    }

    if (config.showPathLabel) {
        const labelText = showAllFiles
            ? ('samples/' + baseFolder + config.allFilesSuffix)
            : (normalizedCurrent === baseFolder ? 'samples/' + baseFolder : 'samples/' + normalizedCurrent);
        const $pathLabel = $('<span class="small text-muted"></span>').text(String(config.pathLabelPrefix || '현재: ') + labelText);
        $header.append($pathLabel);
    }

    return $header;
}

function wcsRenderSampleFolderTiles(options) {
    const config = Object.assign({
        baseFolder: '',
        childFolders: [],
        paneSelector: '',
        leafOnlyLabel: false,
    }, options || {});

    const $wrapper = $('<div class="d-flex flex-wrap gap-2 mb-2"></div>');
    const folders = Array.isArray(config.childFolders) ? config.childFolders : [];

    if (folders.length === 0) {
        return $wrapper;
    }

    folders.forEach(function (folderPath) {
        const normalizedFolder = wcsNormalizeSampleFolderPath(folderPath, config.baseFolder);
        const label = wcsBuildFolderLabel(config.baseFolder, normalizedFolder, {
            leafOnly: Boolean(config.leafOnlyLabel),
            defaultLabel: '기본 폴더',
        });
        const $button = $('<button type="button" class="btn btn-light border sample-folder-item"></button>')
            .attr('data-pane', config.paneSelector)
            .attr('data-folder-path', normalizedFolder)
            .append('<i class="bi bi-folder-fill text-warning me-1"></i>')
            .append($('<span class="small"></span>').text(label || normalizedFolder));
        $wrapper.append($button);
    });

    return $wrapper;
}

window.getVehicleDirectionButtonSelector = getVehicleDirectionButtonSelector;
window.getVehicleCommandByButtonId = getVehicleCommandByButtonId;
window.getVehicleButtonIdByCommand = getVehicleButtonIdByCommand;
window.getVehicleDriveModeByCommand = getVehicleDriveModeByCommand;
window.getVehicleHighlightWheelKeysByCommand = getVehicleHighlightWheelKeysByCommand;
window.getCommandSignedWheelRpm = getCommandSignedWheelRpm;
window.syncVehicleDirectionButtons = syncVehicleDirectionButtons;
window.wcsNormalizePath = wcsNormalizePath;
window.wcsEncodePathForRoute = wcsEncodePathForRoute;
window.wcsNormalizeSampleFolderPath = wcsNormalizeSampleFolderPath;
window.wcsResolveRoadDetectStreamPath = wcsResolveRoadDetectStreamPath;
window.wcsBuildVideoThumbnailUrl = wcsBuildVideoThumbnailUrl;
window.wcsBuildSamplesUrl = wcsBuildSamplesUrl;
window.wcsBuildSampleBrowserUrl = wcsBuildSampleBrowserUrl;
window.wcsBuildRoadDetectStreamUrl = wcsBuildRoadDetectStreamUrl;
window.wcsBuildRoadDetectStreamCleanupUrl = wcsBuildRoadDetectStreamCleanupUrl;
window.wcsBuildFolderLabel = wcsBuildFolderLabel;
window.wcsBuildSampleBrowserHeader = wcsBuildSampleBrowserHeader;
window.wcsRenderSampleFolderTiles = wcsRenderSampleFolderTiles;

// 페이지 로드 시 실행 
$(document).ready(function() {
    setHeaderMenuCss();
});
