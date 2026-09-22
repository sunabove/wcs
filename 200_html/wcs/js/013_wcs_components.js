// shared UI components for WCS pages

// Root-relative, not "./020_component_mqtt.html": this script is shared across pages in
// several different top-level directories (200_html/wcs/, 200_html/simulation/, etc.),
// and a relative fetch() resolves against the *including page's* URL, not this script's
// own location - it only happened to work for pages that live in 200_html/wcs/ itself,
// 404ing (with the fallback header UI below silently covering for it) everywhere else.
const WCS_MQTT_HEADER_COMPONENT_PATH = '/wcs/020_component_mqtt.html';
const WCS_MQTT_HEADER_FALLBACK_HTML = [
    '<div class="mqtt-status-message-inline d-flex flex-nowrap align-items-center border rounded-3 px-2 py-1">',
    '    <div id="mqtt-status-container" class="d-flex flex-nowrap align-items-center me-3">',
    '        <div id="mqtt-status-icon-map" class="d-none" data-icon-status="fas fa-wifi"></div>',
    '        <div id="mqtt-status-render-target" class="d-flex align-items-center"></div>',
    '    </div>',
    '    <div id="mqtt-message-display" class="d-flex flex-nowrap align-items-center mqtt-message-display-fixed">',
    '        <div class="mqtt-message-row d-flex align-items-center w-100 text-truncate">',
    '            <div id="mqtt-received-badge" class="badge bg-info text-dark fs-6 px-2 py-2 d-flex align-items-center mqtt-counter-badge mqtt-topic-history-trigger" data-history-type="received" role="button" tabindex="0" title="수신 토픽 목록 조회">',
    '                <i class="fas fa-arrow-down text-white-50 flex-shrink-0" title="수신" aria-label="수신"></i>',
    '                <span id="mqtt-received-count" class="fw-bold text-white flex-shrink-0 text-nowrap ms-2 d-inline-block text-end" style="min-width: 2.5rem;">0</span>',
    '            </div>',
    '            <div id="mqtt-published-badge" class="badge bg-secondary text-dark fs-6 px-2 py-2 d-flex align-items-center mqtt-counter-badge ms-2 mqtt-topic-history-trigger" data-history-type="published" role="button" tabindex="0" title="발행 토픽 목록 조회">',
    '                <i class="fas fa-arrow-up text-white-50 flex-shrink-0" title="발행" aria-label="발행"></i>',
    '                <span id="mqtt-published-count" class="fw-bold text-white flex-shrink-0 text-nowrap ms-2 d-inline-block text-end" style="min-width: 2.5rem;">0</span>',
    '            </div>',
    '        </div>',
    '    </div>',
    '    </div>',
    '</div>',
    '<div class="modal fade" id="mqtt-topic-history-modal" tabindex="-1" aria-labelledby="mqtt-topic-history-title" aria-hidden="true">',
    '    <div class="modal-dialog modal-lg mqtt-topic-history-dialog">',
    '        <div class="modal-content mqtt-topic-history-content">',
    '            <div class="modal-header py-2">',
    '                <h5 class="modal-title" id="mqtt-topic-history-title">MQTT 토픽 이력</h5>',
    '            </div>',
    '            <div class="modal-body px-2 pb-2 pt-0">',
    '                <ul class="nav nav-tabs mb-2 align-items-center mqtt-topic-history-drag-handle" id="mqtt-topic-history-tabs" role="tablist">',
    '                    <li class="nav-item" role="presentation">',
    '                        <button type="button" class="nav-link active mqtt-topic-history-tab" data-history-type="received" role="tab" aria-selected="true">수신 토픽</button>',
    '                    </li>',
    '                    <li class="nav-item" role="presentation">',
    '                        <button type="button" class="nav-link mqtt-topic-history-tab" data-history-type="published" role="tab" aria-selected="false">전송 토픽</button>',
    '                    </li>',
    '                    <li class="nav-item ms-auto d-flex align-items-center" role="presentation">',
    '                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="닫기"></button>',
    '                    </li>',
    '                </ul>',
    '                <div id="mqtt-topic-filter-received" class="mqtt-topic-filter-wrap mb-2" data-history-type="received">',
    '                    <div class="input-group input-group-sm">',
    '                        <span class="input-group-text">수신 필터</span>',
    '                        <input id="mqtt-topic-filter-input-received" type="text" class="form-control mqtt-topic-filter-input" data-history-type="received" placeholder="토픽 입력">',
    '                    </div>',
    '                </div>',
    '                <div id="mqtt-topic-filter-published" class="mqtt-topic-filter-wrap mb-2 d-none" data-history-type="published">',
    '                    <div class="input-group input-group-sm">',
    '                        <span class="input-group-text">전송 필터</span>',
    '                        <input id="mqtt-topic-filter-input-published" type="text" class="form-control mqtt-topic-filter-input" data-history-type="published" placeholder="토픽 입력">',
    '                    </div>',
    '                </div>',
    '                <div class="table-responsive mqtt-topic-history-table-wrap">',
    '                    <table class="table table-sm table-striped align-middle mb-0" id="mqtt-topic-history-table">',
    '                        <colgroup>',
    '                            <col style="width: 3.5rem;">',
    '                            <col style="width: 9rem;">',
    '                            <col style="width: 34%;">',
    '                            <col>',
    '                        </colgroup>',
    '                        <thead>',
    '                            <tr>',
    '                                <th class="text-center">No</th>',
    '                                <th class="text-center mqtt-topic-sort-trigger" data-sort-key="time" role="button" tabindex="0" title="시간 정렬">시간 <span class="mqtt-sort-indicator"></span></th>',
    '                                <th class="text-center mqtt-topic-sort-trigger" data-sort-key="topic" role="button" tabindex="0" title="토픽 정렬">토픽 <span class="mqtt-sort-indicator"></span></th>',
    '                                <th class="text-center">값</th>',
    '                            </tr>',
    '                        </thead>',
    '                        <tbody id="mqtt-topic-history-table-body"></tbody>',
    '                        <tfoot>',
    '                            <tr>',
    '                                <th class="text-center" colspan="3">전체 요약</th>',
    '                                <th id="mqtt-topic-history-summary-count" class="text-end">총 0건</th>',
    '                            </tr>',
    '                        </tfoot>',
    '                    </table>',
    '                </div>',
    '            </div>',
    '        </div>',
    '    </div>',
    '</div>',
].join('');

function ensureWcsMqttHeaderMountPoint() {
    let $mountPoint = $('#mqtt-header-ui');
    if ($mountPoint.length > 0) {
        return $mountPoint;
    }

    const $headerRow = $('header .top-header-row').first();
    if ($headerRow.length === 0) {
        return $();
    }

    $mountPoint = $('<div id="mqtt-header-ui" class="mqtt-header-ui"></div>');
    $headerRow.append($mountPoint);
    return $mountPoint;
}

async function ensureWcsMqttHeaderUi() {
    const $existingStatus = $('#mqtt-status-container');
    const $existingMessage = $('#mqtt-message-display');
    if ($existingStatus.length > 0 && $existingMessage.length > 0) {
        return;
    }

    const $mountPoint = ensureWcsMqttHeaderMountPoint();
    if ($mountPoint.length === 0) {
        return;
    }

    try {
        const response = await fetch(WCS_MQTT_HEADER_COMPONENT_PATH, { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const componentHtml = await response.text();
        $mountPoint.html(componentHtml);
    } catch (error) {
        console.error('[WCS] MQTT header component load failed:', error);
        $mountPoint.html(WCS_MQTT_HEADER_FALLBACK_HTML);
    }
}

// Same root-relative-path reasoning as WCS_MQTT_HEADER_COMPONENT_PATH above: this file
// is shared across pages in several different top-level directories.
const WCS_PAGE_ZOOM_COMPONENT_PATH = '/wcs/020_component_page_zoom.html';
const WCS_PAGE_ZOOM_FALLBACK_HTML = [
    '<div class="page-zoom-control-inline d-flex flex-nowrap align-items-center border rounded-3 px-2 py-1">',
    '    <button type="button" id="page-zoom-decrease" class="btn btn-sm btn-outline-light" aria-label="화면 축소" title="화면 축소">',
    '        <i class="bi bi-dash-lg"></i>',
    '    </button>',
    '    <span id="page-zoom-value" class="text-white small text-center mx-1" style="min-width: 3.2em;">100%</span>',
    '    <button type="button" id="page-zoom-increase" class="btn btn-sm btn-outline-light" aria-label="화면 확대" title="화면 확대">',
    '        <i class="bi bi-plus-lg"></i>',
    '    </button>',
    '</div>',
].join('');

const WCS_PAGE_ZOOM_STORAGE_KEY = 'wcs.pageZoomPercent';
const WCS_PAGE_ZOOM_STEP_PERCENT = 5;
const WCS_PAGE_ZOOM_MIN_PERCENT = 40;
const WCS_PAGE_ZOOM_MAX_PERCENT = 150;
const WCS_PAGE_ZOOM_TABLET_DEFAULT_PERCENT = 67;
const WCS_PAGE_ZOOM_DESKTOP_DEFAULT_PERCENT = 100;
// Android's own resource-qualifier breakpoint (sw600dp) for "this is a tablet, not a
// phone" - screen.width/height are physical CSS px and don't change with this page's own
// zoom or any portrait-forcing rotation, so the shorter of the two is a stable stand-in
// for the device's short edge regardless of current orientation/zoom.
const WCS_PAGE_ZOOM_TABLET_MIN_SHORT_SIDE_PX = 600;

function isWcsLargeAndroidTablet() {
    const isAndroid = /Android/i.test(navigator.userAgent || '');
    if (!isAndroid) {
        return false;
    }

    const shortSidePx = Math.min(
        Number(window.screen && window.screen.width) || 0,
        Number(window.screen && window.screen.height) || 0,
    );
    return shortSidePx >= WCS_PAGE_ZOOM_TABLET_MIN_SHORT_SIDE_PX;
}

function clampWcsPageZoomPercent(percent) {
    return Math.min(WCS_PAGE_ZOOM_MAX_PERCENT, Math.max(WCS_PAGE_ZOOM_MIN_PERCENT, percent));
}

function getDefaultWcsPageZoomPercent() {
    return isWcsLargeAndroidTablet()
        ? WCS_PAGE_ZOOM_TABLET_DEFAULT_PERCENT
        : WCS_PAGE_ZOOM_DESKTOP_DEFAULT_PERCENT;
}

function loadWcsPageZoomPercent() {
    try {
        if (typeof window.localStorage === 'undefined') {
            return getDefaultWcsPageZoomPercent();
        }

        const savedValue = window.localStorage.getItem(WCS_PAGE_ZOOM_STORAGE_KEY);
        if (savedValue == null) {
            return getDefaultWcsPageZoomPercent();
        }

        const parsedValue = Number.parseInt(savedValue, 10);
        return Number.isFinite(parsedValue)
            ? clampWcsPageZoomPercent(parsedValue)
            : getDefaultWcsPageZoomPercent();
    } catch (error) {
        return getDefaultWcsPageZoomPercent();
    }
}

function saveWcsPageZoomPercent(percent) {
    try {
        if (typeof window.localStorage === 'undefined') {
            return;
        }
        window.localStorage.setItem(WCS_PAGE_ZOOM_STORAGE_KEY, String(percent));
    } catch (error) {
        // Ignore storage write errors in restricted browser modes.
    }
}

function ensureWcsPageZoomMountPoint() {
    let $mountPoint = $('#page-zoom-control');
    if ($mountPoint.length > 0) {
        return $mountPoint;
    }

    const $headerRow = $('header .top-header-row').first();
    if ($headerRow.length === 0) {
        return $();
    }

    $mountPoint = $('<div id="page-zoom-control" class="ms-2"></div>');
    $headerRow.append($mountPoint);
    return $mountPoint;
}

function wireUpWcsPageZoomControls($mountPoint) {
    const decreaseButton = $mountPoint.find('#page-zoom-decrease').get(0);
    const increaseButton = $mountPoint.find('#page-zoom-increase').get(0);
    const valueLabel = $mountPoint.find('#page-zoom-value').get(0);
    if (!decreaseButton || !increaseButton || !valueLabel) {
        return;
    }

    let currentZoomPercent = clampWcsPageZoomPercent(loadWcsPageZoomPercent());

    function applyZoomPercent(percent) {
        // <html> (not <body>/an inner wrapper) is what makes Chrome treat this as a real
        // page zoom - vh/vw/100% layout throughout the page recompute against the
        // rescaled effective viewport, same as the browser's own Ctrl+-/pinch zoom, so
        // content actually gains/loses screen real estate instead of rendering smaller
        // inside an unchanged-size box.
        document.documentElement.style.zoom = `${percent}%`;
        valueLabel.textContent = `${percent}%`;
        decreaseButton.disabled = percent <= WCS_PAGE_ZOOM_MIN_PERCENT;
        increaseButton.disabled = percent >= WCS_PAGE_ZOOM_MAX_PERCENT;
    }

    function setZoomPercent(nextPercent) {
        currentZoomPercent = clampWcsPageZoomPercent(nextPercent);
        saveWcsPageZoomPercent(currentZoomPercent);
        applyZoomPercent(currentZoomPercent);
    }

    applyZoomPercent(currentZoomPercent);

    decreaseButton.addEventListener('click', () => {
        setZoomPercent(currentZoomPercent - WCS_PAGE_ZOOM_STEP_PERCENT);
    });
    increaseButton.addEventListener('click', () => {
        setZoomPercent(currentZoomPercent + WCS_PAGE_ZOOM_STEP_PERCENT);
    });
}

async function ensureWcsPageZoomUi() {
    const $existingButtons = $('#page-zoom-decrease, #page-zoom-increase');
    if ($existingButtons.length > 0) {
        return;
    }

    const $mountPoint = ensureWcsPageZoomMountPoint();
    if ($mountPoint.length === 0) {
        return;
    }

    try {
        const response = await fetch(WCS_PAGE_ZOOM_COMPONENT_PATH, { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const componentHtml = await response.text();
        $mountPoint.html(componentHtml);
    } catch (error) {
        console.error('[WCS] Page zoom component load failed:', error);
        $mountPoint.html(WCS_PAGE_ZOOM_FALLBACK_HTML);
    }

    wireUpWcsPageZoomControls($mountPoint);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
        void ensureWcsMqttHeaderUi();
        void ensureWcsPageZoomUi();
    });
} else {
    void ensureWcsMqttHeaderUi();
    void ensureWcsPageZoomUi();
}
