// MQTT 클라이언트 설정 및 연결 (Mosquitto 브로커용)
class MqttClientManager {
    static logOptionStorageKey = 'wcs.mqtt.console_log_enabled.v1';
    static instance = null;

    constructor(options = {}) {
        this.brokerUrl = options.brokerUrl || null;
        this.clientId = options.clientId || `vehicle_status_client_${Math.random().toString(16).substr(2, 8)}`;
        this.topicFormatter = options.topicFormatter || null;
        this.client = null;
        this.lastUIUpdate = 0;
        this.receivedTopicCount = 0;
        this.publishedTopicCount = 0;
        this.maxTopicHistorySize = 300;
        this.receivedTopicHistory = [];
        this.publishedTopicHistory = [];
        this.currentHistoryType = 'received';
        this.topicHistorySort = { key: 'time', direction: 'desc' };
        this.topicHistoryFilters = {
            received: '',
            published: '',
        };
        this.bindTopicHistoryHandlers();
    }

    static getConsoleLogEnabled() {
        try {
            const saved = window.localStorage.getItem(MqttClientManager.logOptionStorageKey);
            if (saved === null) {
                return false;
            }

            const normalized = String(saved).trim().toLowerCase();
            return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
        } catch (error) {
            return false;
        }
    }

    static setConsoleLogEnabled(enabled) {
        const flag = !!enabled;
        window.__WCS_MQTT_CONSOLE_LOG_ENABLED = flag;

        try {
            window.localStorage.setItem(MqttClientManager.logOptionStorageKey, flag ? 'true' : 'false');
        } catch (error) {
            // localStorage 사용 불가 환경에서는 메모리 값만 사용한다.
        }

        return flag;
    }

    static isConsoleLogEnabled() {
        if (typeof window.__WCS_MQTT_CONSOLE_LOG_ENABLED === 'boolean') {
            return window.__WCS_MQTT_CONSOLE_LOG_ENABLED;
        }

        const initialFlag = MqttClientManager.getConsoleLogEnabled();
        window.__WCS_MQTT_CONSOLE_LOG_ENABLED = initialFlag;
        return initialFlag;
    }

    static log() {
        if (!MqttClientManager.isConsoleLogEnabled()) {
            return;
        }

        console.log.apply(console, arguments);
    }

    static getInstance(options = {}) {
        if (!MqttClientManager.instance) {
            MqttClientManager.instance = new MqttClientManager(options);
        }

        return MqttClientManager.instance;
    }

    static init(options = {}) {
        return MqttClientManager.getInstance(options).connect();
    }

    static send(topic, message, qos) {
        const manager = MqttClientManager.getInstance();

        if (!manager.client || !manager.client.connected) {
            const timestamp = new Date().toLocaleTimeString();
            console.error(`[MQTT] ❌ [${timestamp}] 클라이언트가 연결되지 않음`);
            console.warn('[MQTT] - MQTT 클라이언트 연결 상태를 확인하세요.');
            alert('MQTT 클라이언트가 연결되지 않았습니다.\n브로커 연결 상태를 확인해주세요.');
            return false;
        }

        return manager.send(topic, message, qos);
    }

    buildBrokerUrl() {
        if (this.brokerUrl) {
            return this.brokerUrl;
        }

        const currentHost = window.location.hostname || 'localhost';
        this.brokerUrl = `ws://${currentHost}:9001`;
        return this.brokerUrl;
    }

    connect() {
        try {
            const brokerUrl = this.buildBrokerUrl();
            const currentHost = window.location.hostname || 'localhost';

            MqttClientManager.log('[MQTT] 🦟 브로커 연결 시도중...', brokerUrl);
            MqttClientManager.log('[MQTT] 🌐 현재 호스트:', currentHost);

            this.client = mqtt.connect(brokerUrl, {
                clientId: this.clientId,
                clean: true,
                connectTimeout: 5000,
                reconnectPeriod: 2000,
                keepalive: 60,
                protocolVersion: 4,
            });

            this.bindEvents();
            window.mqttClient = this.client;
            return this.client;
        } catch (error) {
            this.handleInitError(error);
            return null;
        }
    }

    bindEvents() {
        if (!this.client) {
            return;
        }

        this.client.on('connect', (connack) => this.handleConnect(connack));
        this.client.on('message', (topic, message) => this.handleMessage(topic, message));
        this.client.on('error', (err) => this.handleError(err));
        this.client.on('close', () => this.handleClose());
        this.client.on('reconnect', () => this.handleReconnect());
    }

    updateTopicCounters() {
        $('#mqtt-received-count').text(String(this.receivedTopicCount));
        $('#mqtt-published-count').text(String(this.publishedTopicCount));
    }

    bindTopicHistoryHandlers() {
        const selector = '.mqtt-topic-history-trigger';
        const sortSelector = '.mqtt-topic-sort-trigger';
        const tabSelector = '.mqtt-topic-history-tab';
        const filterSelector = '.mqtt-topic-filter-input';

        $(document)
            .off('click.mqttTopicHistory', selector)
            .on('click.mqttTopicHistory', selector, (event) => {
                const historyType = String($(event.currentTarget).attr('data-history-type') || '').toLowerCase();
                this.openTopicHistoryModal(historyType);
            });

        $(document)
            .off('keydown.mqttTopicHistory', selector)
            .on('keydown.mqttTopicHistory', selector, (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') {
                    return;
                }

                event.preventDefault();
                const historyType = String($(event.currentTarget).attr('data-history-type') || '').toLowerCase();
                this.openTopicHistoryModal(historyType);
            });

        $(document)
            .off('click.mqttTopicSort', sortSelector)
            .on('click.mqttTopicSort', sortSelector, (event) => {
                const sortKey = String($(event.currentTarget).attr('data-sort-key') || '').toLowerCase();
                this.toggleTopicHistorySort(sortKey);
            });

        $(document)
            .off('keydown.mqttTopicSort', sortSelector)
            .on('keydown.mqttTopicSort', sortSelector, (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') {
                    return;
                }

                event.preventDefault();
                const sortKey = String($(event.currentTarget).attr('data-sort-key') || '').toLowerCase();
                this.toggleTopicHistorySort(sortKey);
            });

        $(document)
            .off('click.mqttTopicTab', tabSelector)
            .on('click.mqttTopicTab', tabSelector, (event) => {
                const historyType = String($(event.currentTarget).attr('data-history-type') || '').toLowerCase();
                this.switchTopicHistoryTab(historyType);
            });

        $(document)
            .off('keydown.mqttTopicTab', tabSelector)
            .on('keydown.mqttTopicTab', tabSelector, (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') {
                    return;
                }

                event.preventDefault();
                const historyType = String($(event.currentTarget).attr('data-history-type') || '').toLowerCase();
                this.switchTopicHistoryTab(historyType);
            });

        $(document)
            .off('input.mqttTopicFilter', filterSelector)
            .on('input.mqttTopicFilter', filterSelector, (event) => {
                const $input = $(event.currentTarget);
                const historyType = this.normalizeHistoryType($input.attr('data-history-type'));
                this.topicHistoryFilters[historyType] = String($input.val() || '');

                if (historyType !== this.currentHistoryType) {
                    return;
                }

                const historyList = this.getTopicHistoryList(historyType);
                const title = this.getTopicHistoryTitle(historyType);
                this.renderTopicHistoryRows(historyList, title);
            });
    }

    normalizeHistoryType(historyType) {
        return historyType === 'published' ? 'published' : 'received';
    }

    getTopicHistoryList(historyType) {
        return historyType === 'published' ? this.publishedTopicHistory : this.receivedTopicHistory;
    }

    getTopicHistoryTitle(historyType) {
        return historyType === 'published' ? 'MQTT 전송 토픽 이력' : 'MQTT 수신 토픽 이력';
    }

    getTopicFilterText(historyType) {
        const normalizedType = this.normalizeHistoryType(historyType);
        return String(this.topicHistoryFilters[normalizedType] || '').trim();
    }

    getFilteredTopicHistory(historyList, historyType) {
        const filterText = this.getTopicFilterText(historyType);
        if (!filterText) {
            return Array.isArray(historyList) ? historyList.slice() : [];
        }

        const normalizedFilter = filterText.toLowerCase();
        const sourceList = Array.isArray(historyList) ? historyList : [];
        return sourceList.filter((entry) => {
            const topicText = String(entry.topic || '').toLowerCase();
            return topicText.includes(normalizedFilter);
        });
    }

    updateTopicFilterUi() {
        const currentType = this.normalizeHistoryType(this.currentHistoryType);
        const receivedFilter = this.getTopicFilterText('received');
        const publishedFilter = this.getTopicFilterText('published');

        $('#mqtt-topic-filter-input-received').val(receivedFilter);
        $('#mqtt-topic-filter-input-published').val(publishedFilter);

        $('#mqtt-topic-filter-received').toggleClass('d-none', currentType !== 'received');
        $('#mqtt-topic-filter-published').toggleClass('d-none', currentType !== 'published');
    }

    updateTopicHistoryTabs() {
        const currentType = this.normalizeHistoryType(this.currentHistoryType);

        $('.mqtt-topic-history-tab').each(function () {
            const $tab = $(this);
            const tabType = String($tab.attr('data-history-type') || '').toLowerCase();
            const isActive = tabType === currentType;
            $tab.toggleClass('active', isActive);
            $tab.attr('aria-selected', isActive ? 'true' : 'false');
        });
    }

    switchTopicHistoryTab(historyType) {
        const normalizedType = this.normalizeHistoryType(historyType);
        this.currentHistoryType = normalizedType;
        this.updateTopicHistoryTabs();
        this.updateTopicFilterUi();

        const historyList = this.getTopicHistoryList(normalizedType);
        const title = this.getTopicHistoryTitle(normalizedType);
        this.renderTopicHistoryRows(historyList, title);
    }

    toggleTopicHistorySort(sortKey) {
        if (sortKey !== 'time' && sortKey !== 'topic') {
            return;
        }

        if (this.topicHistorySort.key === sortKey) {
            this.topicHistorySort.direction = this.topicHistorySort.direction === 'asc' ? 'desc' : 'asc';
        } else {
            this.topicHistorySort.key = sortKey;
            this.topicHistorySort.direction = sortKey === 'time' ? 'desc' : 'asc';
        }

        const currentList = this.currentHistoryType === 'published'
            ? this.publishedTopicHistory
            : this.receivedTopicHistory;
        const title = this.currentHistoryType === 'published'
            ? 'MQTT 발행 토픽 이력'
            : 'MQTT 수신 토픽 이력';

        this.renderTopicHistoryRows(currentList, title);
    }

    getSortedTopicHistory(historyList) {
        const sortKey = this.topicHistorySort.key;
        const sortDirection = this.topicHistorySort.direction;
        const sortedHistory = Array.isArray(historyList) ? historyList.slice() : [];

        sortedHistory.sort((a, b) => {
            if (sortKey === 'topic') {
                const left = String(a.topic || '');
                const right = String(b.topic || '');
                return left.localeCompare(right, 'ko', { sensitivity: 'base', numeric: true });
            }

            const leftTime = a.time instanceof Date ? a.time.getTime() : Number.MIN_SAFE_INTEGER;
            const rightTime = b.time instanceof Date ? b.time.getTime() : Number.MIN_SAFE_INTEGER;
            return leftTime - rightTime;
        });

        if (sortDirection === 'desc') {
            sortedHistory.reverse();
        }

        return sortedHistory;
    }

    updateTopicHistorySortIndicators() {
        const currentKey = this.topicHistorySort.key;
        const currentDirection = this.topicHistorySort.direction;

        $('.mqtt-topic-sort-trigger').each(function () {
            const $header = $(this);
            const headerKey = String($header.attr('data-sort-key') || '').toLowerCase();
            const $indicator = $header.find('.mqtt-sort-indicator');

            $indicator.removeClass('active').text('');

            if (headerKey !== currentKey) {
                return;
            }

            $indicator
                .text(currentDirection === 'asc' ? '▲' : '▼')
                .addClass('active');
        });
    }

    registerTopicHistory(type, topic, payload, qos) {
        const historyType = String(type || '').toLowerCase();
        const normalizedTopic = String(topic || '');
        const normalizedPayload = String(payload || '');
        const normalizedQos = Number.isFinite(Number(qos)) ? Number(qos) : '-';

        const entry = {
            time: new Date(),
            topic: normalizedTopic,
            payload: normalizedPayload,
            qos: normalizedQos,
        };

        const targetHistory = historyType === 'published' ? this.publishedTopicHistory : this.receivedTopicHistory;
        targetHistory.unshift(entry);
        if (targetHistory.length > this.maxTopicHistorySize) {
            targetHistory.length = this.maxTopicHistorySize;
        }
    }

    openTopicHistoryModal(historyType) {
        const normalizedType = this.normalizeHistoryType(historyType);
        this.currentHistoryType = normalizedType;
        this.updateTopicHistoryTabs();
        this.updateTopicFilterUi();
        const historyList = this.getTopicHistoryList(normalizedType);
        const title = this.getTopicHistoryTitle(normalizedType);

        this.renderTopicHistoryRows(historyList, title);
        this.showTopicHistoryModal();
    }

    renderTopicHistoryRows(historyList, title) {
        $('#mqtt-topic-history-title').text(title);
        this.updateTopicHistorySortIndicators();

        const $tbody = $('#mqtt-topic-history-table-body');
        const $summary = $('#mqtt-topic-history-summary-count');
        $tbody.empty();

        if (!Array.isArray(historyList) || historyList.length === 0) {
            const emptyMessage = this.currentHistoryType === 'published'
                ? '전송 토픽이 없습니다.'
                : '수신 토픽이 없습니다.';
            $summary.text('총 0건');
            const $emptyRow = $('<tr class="mqtt-topic-history-empty-row"></tr>');
            $('<td class="small text-center text-muted py-3" colspan="4"></td>')
                .text(emptyMessage)
                .appendTo($emptyRow);
            $tbody.append($emptyRow);
            return;
        }

        const filteredHistoryList = this.getFilteredTopicHistory(historyList, this.currentHistoryType);
        const sortedHistoryList = this.getSortedTopicHistory(filteredHistoryList);
        $summary.text(`총 ${sortedHistoryList.length}건`);

        sortedHistoryList.forEach((entry, index) => {
            const formattedTime = entry.time instanceof Date
                ? `${String(entry.time.getHours()).padStart(2, '0')}:${String(entry.time.getMinutes()).padStart(2, '0')}:${String(entry.time.getSeconds()).padStart(2, '0')}.${String(entry.time.getMilliseconds()).padStart(3, '0')}`
                : String(entry.time || '');

            const $row = $('<tr></tr>');
            $('<td class="small text-end text-nowrap"></td>').text(String(index + 1)).appendTo($row);
            $('<td class="small text-nowrap text-center"></td>').text(formattedTime).appendTo($row);
            $('<td class="small"></td>').text(String(entry.topic || '')).appendTo($row);
            $('<td class="small text-end mqtt-topic-history-value-cell"></td>')
                .text(String(entry.payload || ''))
                .attr('title', String(entry.payload || ''))
                .appendTo($row);
            $tbody.append($row);
        });
    }

    showTopicHistoryModal() {
        const modalElement = document.getElementById('mqtt-topic-history-modal');
        if (!modalElement) {
            return;
        }

        if (window.bootstrap && typeof window.bootstrap.Modal === 'function') {
            const modal = window.bootstrap.Modal.getOrCreateInstance(modalElement);
            modal.show();
            return;
        }

        // Bootstrap JS가 없는 경우 최소 표시 fallback
        $(modalElement).addClass('show').css('display', 'block').attr('aria-hidden', 'false');
    }

    renderConnectionStatus(options = {}) {
        const config = Object.assign({
            iconColor: '#d1d5db',
            title: 'MQTT 상태',
            spin: false,
        }, options || {});

        const iconClass = this.getStatusIconClass('fas fa-wifi');
        const spinClass = config.spin ? ' fa-spin' : '';
        const statusHtml = `<div id="mqtt-status" class="badge fs-6 mqtt-status-icon-badge d-inline-flex align-items-center justify-content-center" title="${String(config.title)}" aria-label="${String(config.title)}" style="background:#1f2937; color:${String(config.iconColor)}; width:2rem; height:2rem; padding:0; border-radius:50%; box-shadow:0 2px 5px rgba(0,0,0,0.2);"><i class="${String(iconClass)}${spinClass}"></i></div>`;
        const $renderTarget = $('#mqtt-status-render-target');

        if ($renderTarget.length > 0) {
            $renderTarget.html(statusHtml);
            return;
        }

        $('#mqtt-status-container').html(statusHtml);
    }

    getStatusIconClass(fallbackClass) {
        const mapElement = document.getElementById('mqtt-status-icon-map');

        if (mapElement && mapElement.dataset) {
            const mappedClass = mapElement.dataset.iconStatus;
            if (mappedClass && mappedClass.trim().length > 0) {
                return mappedClass.trim();
            }
        }

        return fallbackClass;
    }

    handleConnect(connack) {
        MqttClientManager.log('[MQTT] ✅ Mosquitto 브로커 연결 성공');
        MqttClientManager.log('[MQTT] 🔗 연결 정보:', connack);

        if (!this.client) {
            return;
        }

        this.client.subscribe('#', { qos: 1 }, (err, granted) => {
            if (err) {
                console.error('[MQTT] ❌ 전체 토픽 구독 실패:', err);
                this.renderConnectionStatus({
                    iconColor: '#ff6b6b',
                    title: 'MQTT 구독 실패',
                });
                return;
            }

            MqttClientManager.log('[MQTT] 📡 모든 토픽 구독 성공');
            MqttClientManager.log('[MQTT] 🎯 QoS 설정:', granted);

            this.renderConnectionStatus({
                iconColor: '#4ade80',
                title: 'MQTT 연결됨',
            });
            this.updateTopicCounters();

            setTimeout(() => {
                this.publishClientConnectInfo();
            }, 1000);
        });
    }

    handleMessage(topic, message) {
        const messageStr = message.toString();
        const processedValue = this.parseValue(messageStr);
        const shouldCountAsReceived = topic !== 'client/connect';

        if (topic.startsWith('vehicle/') || topic.startsWith('wheel/')) {
            MqttClientManager.log(`[MQTT] 📩 ${topic}: ${messageStr}`);
        } else {
            MqttClientManager.log(`[MQTT] 📝 ${topic.split('/')[0]}/*: ${messageStr}`);
        }

        if (shouldCountAsReceived) {
            this.receivedTopicCount += 1;
            this.registerTopicHistory('received', topic, messageStr, '-');
        }

        if (!this.lastUIUpdate || Date.now() - this.lastUIUpdate > 100) {
            const badgeColor = this.getBadgeColor(topic);
            const receivedBadge = $('#mqtt-received-badge');
            receivedBadge.removeClass('bg-info bg-success bg-warning bg-primary bg-secondary').addClass(badgeColor);
            this.updateTopicCounters();
            this.lastUIUpdate = Date.now();
        }

        if (typeof prcessMqttMessage === 'function') {
            prcessMqttMessage(topic, processedValue);
        }
    }

    parseValue(messageStr) {
        const numValue = parseFloat(messageStr);
        return isNaN(numValue) ? messageStr : numValue;
    }

    formatTopicValue(topic, processedValue, rawValue) {
        if (typeof getFormattedTopicValue === 'function') {
            return getFormattedTopicValue(topic, processedValue);
        }

        return rawValue;
    }

    getBadgeColor(topic) {
        if (topic.startsWith('vehicle/')) {
            return 'bg-success';
        }

        if (topic.startsWith('sensor/')) {
            return 'bg-warning';
        }

        if (topic.startsWith('system/')) {
            return 'bg-primary';
        }

        if (topic.startsWith('test/')) {
            return 'bg-secondary';
        }

        return 'bg-info';
    }

    handleError(err) {
        console.error('[MQTT] ❌ Mosquitto 연결 오류:', err);
        this.renderConnectionStatus({
            iconColor: '#ff6b6b',
            title: 'Mosquitto 오류',
        });
        $('#mqtt-status').css('animation', 'blink 1s infinite');

        if (err && err.message) {
            console.error('[MQTT] 에러 상세:', err.message);
        }
    }

    handleClose() {
        MqttClientManager.log('[MQTT] 🦟 Mosquitto 연결이 끊어졌습니다.');
        this.renderConnectionStatus({
            iconColor: '#fbbf24',
            title: 'Mosquitto 끊어짐',
        });
    }

    handleReconnect() {
        MqttClientManager.log('[MQTT] 🔄 Mosquitto 재연결 시도중...');
        this.renderConnectionStatus({
            iconColor: '#60a5fa',
            title: 'Mosquitto 재연결 중',
            spin: true,
        });
    }

    handleInitError(error) {
        console.error('[MQTT] ❌ Mosquitto 클라이언트 초기화 오류:', error);
        this.renderConnectionStatus({
            iconColor: '#ff6b6b',
            title: 'Mosquitto 초기화 실패',
        });
    }

    publishClientConnectInfo() {
        if (!this.client) {
            return;
        }

        const now = new Date();
        const timestamp = now.toISOString();
        const connectTime = now.getTime();
        window.clientConnectTime = connectTime;

        const clientInfo = {
            type: 'client_connect',
            client_id: this.client.options.clientId,
            timestamp: timestamp,
            user_agent: navigator.userAgent,
            url: window.location.href,
            page: window.location.pathname.split('/').pop() || 'index.html',
            host: window.location.hostname,
            connection_time: connectTime
        };

        this.client.publish('client/connect', JSON.stringify(clientInfo), { qos: 1 });
        MqttClientManager.log('[MQTT] 🌐 클라이언트 접속 메시지 발송:', clientInfo);
    }

    publish(topic, message, qos) {
        if (!this.client || !this.client.connected) {
            return false;
        }

        const qosValue = qos || 1;
        let messageStr;
        if (typeof message === 'object') {
            messageStr = JSON.stringify(message);
        } else {
            messageStr = String(message);
        }

        this.client.publish(topic, messageStr, { qos: qosValue }, (err) => {
            const timestamp = new Date().toLocaleTimeString();

            if (!err) {
                this.publishedTopicCount += 1;
                this.registerTopicHistory('published', topic, messageStr, qosValue);
                $('#mqtt-published-badge')
                    .removeClass('bg-info bg-success bg-warning bg-primary bg-secondary')
                    .addClass('bg-primary');
                this.updateTopicCounters();
                MqttClientManager.log(`[MQTT] 📤 [${timestamp}] 메시지 전송성공 [QoS ${qosValue}]:`, topic, messageStr);
                return;
            }

            console.error(`[MQTT] ❌ [${timestamp}] 메시지 전송 실패:`, err);
            console.error(`[MQTT]    - 토픽: ${topic}`);
            console.error(`[MQTT]    - 메시지: ${messageStr}`);
            alert(`MQTT 메시지 전송 실패!\n토픽: ${topic}\n에러: ${err.message || err}`);
        });

        return true;
    }

    send(topic, message, qos) {
        return this.publish(topic, message, qos);
    }

    disconnect() {
        if (this.client) {
            this.client.end(true);
            this.client = null;
        }
    }

    publishDisconnectInfo() {
        if (!this.client || !this.client.connected) {
            return;
        }

        try {
            const now = new Date();
            const disconnectInfo = {
                type: 'client_disconnect',
                client_id: this.client.options.clientId,
                timestamp: now.toISOString(),
                page: window.location.pathname.split('/').pop() || 'index.html',
                disconnect_time: now.getTime(),
                session_duration: now.getTime() - (window.clientConnectTime || now.getTime())
            };

            this.client.publish('web/client/disconnect', JSON.stringify(disconnectInfo), { qos: 1 });
            this.client.publish('web/status', 'disconnected', { qos: 1 });
            MqttClientManager.log('[MQTT] 👋 클라이언트 종료 메시지 발송:', disconnectInfo);
        } catch (error) {
            console.error('[MQTT] ❌ 종료 메시지 발송 실패:', error);
        }
    }
}

// MQTT 초기화 함수 (페이지 로드 시 자동 실행)
$(document).ready(function() {
    MqttClientManager.log('[MQTT] 🦟 jQuery DOM 준비 완료 - 차량 대시보드 시작');
    
    // Mosquitto MQTT 클라이언트 초기화
    MqttClientManager.init();
});

// 페이지 종료 시 disconnect 메시지 발송
$(window).on('beforeunload', function() {
    const manager = MqttClientManager.instance;
    if (manager) {
        manager.publishDisconnectInfo();
    }
});

window.WcsMqtt = {
    initMQTTClient: () => MqttClientManager.init(),
    sendMQTTMessage: (topic, message, qos) => MqttClientManager.send(topic, message, qos),
    getConsoleLogEnabled: () => MqttClientManager.getConsoleLogEnabled(),
    setConsoleLogEnabled: (enabled) => MqttClientManager.setConsoleLogEnabled(enabled),
    isConsoleLogEnabled: () => MqttClientManager.isConsoleLogEnabled(),
    log: (...args) => MqttClientManager.log(...args),
};