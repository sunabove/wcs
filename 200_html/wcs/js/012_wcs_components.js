// shared UI components for WCS pages

const WCS_MQTT_HEADER_COMPONENT_PATH = './020_component.html';
const WCS_MQTT_HEADER_FALLBACK_HTML = [
    '<div class="mqtt-status-message-inline d-flex flex-nowrap align-items-center border rounded-3 px-2 py-1">',
    '    <div id="mqtt-status-container" class="d-flex flex-nowrap align-items-center me-3">',
    '        <div id="mqtt-status-icon-map" class="d-none" data-icon-status="fas fa-wifi"></div>',
    '        <div id="mqtt-status-render-target" class="d-flex align-items-center"></div>',
    '    </div>',
    '    <div id="mqtt-message-display" class="d-flex flex-nowrap align-items-center mqtt-message-display-fixed">',
    '        <div class="mqtt-message-row d-flex align-items-center w-100 text-truncate">',
    '            <div id="mqtt-received-badge" class="badge bg-info text-dark fs-6 px-2 py-2 d-flex align-items-center mqtt-counter-badge">',
    '                <i class="fas fa-arrow-down text-white-50 flex-shrink-0" title="수신" aria-label="수신"></i>',
    '                <span id="mqtt-received-count" class="fw-bold text-white flex-shrink-0 text-nowrap ms-2 d-inline-block text-end" style="min-width: 2.5rem;">0</span>',
    '            </div>',
    '            <div id="mqtt-published-badge" class="badge bg-secondary text-dark fs-6 px-2 py-2 d-flex align-items-center mqtt-counter-badge ms-2">',
    '                <i class="fas fa-arrow-up text-white-50 flex-shrink-0" title="발행" aria-label="발행"></i>',
    '                <span id="mqtt-published-count" class="fw-bold text-white flex-shrink-0 text-nowrap ms-2 d-inline-block text-end" style="min-width: 2.5rem;">0</span>',
    '            </div>',
    '        </div>',
    '    </div>',
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

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
        void ensureWcsMqttHeaderUi();
    });
} else {
    void ensureWcsMqttHeaderUi();
}
