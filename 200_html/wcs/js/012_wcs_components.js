// shared UI components for WCS pages

const WCS_MQTT_HEADER_COMPONENT_PATH = './020_component.html';
const WCS_MQTT_HEADER_FALLBACK_HTML = [
    '<div id="mqtt-status-container" class="d-flex flex-nowrap align-items-center me-3">',
    '    <!-- MQTT 상태가 여기에 동적으로 추가됩니다 -->',
    '</div>',
    '<div id="mqtt-message-display" class="d-flex flex-nowrap align-items-center mqtt-message-display-fixed">',
    '    <div class="badge bg-info text-dark fs-6 px-3 py-2 w-100 d-flex align-items-center mqtt-message-badge-wrap">',
    '        <i class="fas fa-envelope me-2 flex-shrink-0"></i>',
    '        <div class="mqtt-message-row d-flex justify-content-between align-items-center w-100 text-truncate">',
    '            <span id="mqtt-topic" class="fw-bold text-white text-nowrap">대기중</span>',
    '            <span id="mqtt-value" class="text-white-50 flex-shrink-0">-</span>',
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

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
        void ensureWcsMqttHeaderUi();
    });
} else {
    void ensureWcsMqttHeaderUi();
}
