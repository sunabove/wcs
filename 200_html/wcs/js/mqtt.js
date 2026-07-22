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

    renderConnectionStatus(options = {}) {
        const config = Object.assign({
            background: '#6c757d',
            iconClass: 'fas fa-question-circle',
            title: 'MQTT 상태',
            spin: false,
        }, options || {});

        const spinClass = config.spin ? ' fa-spin' : '';
        $('#mqtt-status-container').html(
            `<div id="mqtt-status" class="badge fs-6 mqtt-status-icon-badge" title="${String(config.title)}" aria-label="${String(config.title)}" style="background:${String(config.background)}; color:white; padding:8px 10px; border-radius:999px; box-shadow:0 2px 5px rgba(0,0,0,0.2);"><i class="${String(config.iconClass)}${spinClass}"></i></div>`
        );
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
                    background: '#dc3545',
                    iconClass: 'fas fa-exclamation-triangle',
                    title: 'MQTT 구독 실패',
                });
                return;
            }

            MqttClientManager.log('[MQTT] 📡 모든 토픽 구독 성공');
            MqttClientManager.log('[MQTT] 🎯 QoS 설정:', granted);

            this.renderConnectionStatus({
                background: '#28a745',
                iconClass: 'fas fa-wifi',
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
        }

        if (!this.lastUIUpdate || Date.now() - this.lastUIUpdate > 100) {
            const badgeColor = this.getBadgeColor(topic);
            const badge = $('#mqtt-message-display .badge');
            badge.removeClass('bg-info bg-success bg-warning bg-primary bg-secondary').addClass(badgeColor);
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
            background: '#dc3545',
            iconClass: 'fas fa-exclamation-triangle',
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
            background: '#fd7e14',
            iconClass: 'fas fa-unlink',
            title: 'Mosquitto 끊어짐',
        });
    }

    handleReconnect() {
        MqttClientManager.log('[MQTT] 🔄 Mosquitto 재연결 시도중...');
        this.renderConnectionStatus({
            background: '#17a2b8',
            iconClass: 'fas fa-sync',
            title: 'Mosquitto 재연결 중',
            spin: true,
        });
    }

    handleInitError(error) {
        console.error('[MQTT] ❌ Mosquitto 클라이언트 초기화 오류:', error);
        this.renderConnectionStatus({
            background: '#dc3545',
            iconClass: 'fas fa-times-circle',
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