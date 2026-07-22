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
    '    <div class="modal-dialog modal-lg modal-dialog-scrollable">',
    '        <div class="modal-content">',
    '            <div class="modal-header py-2">',
    '                <h5 class="modal-title" id="mqtt-topic-history-title">MQTT 토픽 이력</h5>',
    '            </div>',
    '            <div class="modal-body px-2 pb-2 pt-0">',
    '                <ul class="nav nav-tabs mb-2 align-items-center" id="mqtt-topic-history-tabs" role="tablist">',
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

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
        void ensureWcsMqttHeaderUi();
    });
} else {
    void ensureWcsMqttHeaderUi();
}
