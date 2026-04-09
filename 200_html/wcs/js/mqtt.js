// MQTT 클라이언트 설정 및 연결 (Mosquitto 브로커용)
function initMQTTClient() {
    try {
        // Mosquitto 브로커 WebSocket 설정 (동적 호스트명 사용)
        // 현재 페이지의 호스트명을 가져와서 MQTT 브로커 URL 구성
        const currentHost = window.location.hostname || 'localhost';
        const brokerUrl = `ws://${currentHost}:9001`; // Mosquitto WebSocket 포트
        
        console.log('[MQTT] 🦟 브로커 연결 시도중...', brokerUrl);
        console.log('[MQTT] 🌐 현재 호스트:', currentHost);
        
        const client = mqtt.connect(brokerUrl, {
            clientId: 'vehicle_status_client_' + Math.random().toString(16).substr(2, 8),
            clean: true,
            connectTimeout: 5000,        // Mosquitto에 맞게 타임아웃 조정
            reconnectPeriod: 2000,       // 재연결 간격 조정
            keepalive: 60,               // Mosquitto 기본 keepalive
            protocolVersion: 4,          // MQTT 3.1.1 (Mosquitto 호환)
            // 필요시 인증 정보 추가
            // username: 'your_username',
            // password: 'your_password'
        });
        
        // 연결 성공
        client.on('connect', function (connack) {
            console.log('[MQTT] ✅ Mosquitto 브로커 연결 성공');
            console.log('[MQTT] 🔗 연결 정보:', connack);
            
            // "test/topic" 구독
            client.subscribe('test/topic', { qos: 1 }, function (err, granted) {
                if (!err) {
                    console.log('[MQTT] 📡 "test/topic" 구독 성공');
                    console.log('[MQTT] 🎯 QoS 설정:', granted);
                    
                    // jQuery를 사용한 UI 업데이트
                    $('#mqtt-status-container').html('<div id="mqtt-status" class="badge fs-6" style="background:#28a745; color:white; padding:8px 12px; border-radius:5px; box-shadow:0 2px 5px rgba(0,0,0,0.2);"><i class="fas fa-wifi" style="margin-right:5px;"></i>MQTT 연결됨</div>');
                    
                    // 테스트 메시지 발송 (선택사항)
                    setTimeout(() => {
                        const testMessage = JSON.stringify({
                            timestamp: new Date().toISOString(),
                            client: 'vehicle_status',
                            message: 'Connection test from web client'
                        });
                        client.publish('test/topic', testMessage, { qos: 1 });
                        console.log('[MQTT] 📤 테스트 메시지 발송:', testMessage);
                    }, 1000);
                    
                } else {
                    console.error('[MQTT] ❌ "test/topic" 구독 실패:', err);
                    
                    // jQuery를 사용한 에러 표시
                    $('#mqtt-status-container').html('<div id="mqtt-status" class="badge fs-6" style="background:#dc3545; color:white; padding:8px 12px; border-radius:5px; box-shadow:0 2px 5px rgba(0,0,0,0.2);"><i class="fas fa-exclamation-triangle" style="margin-right:5px;"></i>MQTT 구독 실패</div>');
                }
            });
        });
        
        // 메시지 수신
        client.on('message', function (topic, message) {
            if (topic === 'test/topic') {
                const messageStr = message.toString();
                const timestamp = new Date().toLocaleTimeString();
                
                // Console 로그로만 출력
                console.log(`[MQTT] 📩 [${timestamp}] [${topic}] 메시지 수신:`, messageStr);
                
                // JSON 파싱 시도 (Mosquitto 메시지 처리)
                try {
                    const jsonData = JSON.parse(messageStr);
                    console.log('[MQTT] 📊 [test/topic] JSON 데이터:', jsonData);
                    
                    // 특정 데이터 타입별 로깅
                    if (jsonData.speed) {
                        console.log('[MQTT] 🚗 차량 속도 업데이트:', jsonData.speed);
                        // 실제 UI 업데이트 로직을 여기에 추가 가능
                    }
                    
                    if (jsonData.temperature) {
                        console.log('[MQTT] 🌡️ 온도 데이터:', jsonData.temperature);
                    }
                    
                    if (jsonData.status) {
                        console.log('[MQTT] 🟢 상태 업데이트:', jsonData.status);
                        
                        // 상태에 따른 UI 업데이트 (MQTT 상태 표시만 유지)
                        const statusColor = jsonData.status === 'online' ? '#28a745' : 
                                          jsonData.status === 'warning' ? '#ffc107' : '#dc3545';
                        $('#mqtt-status').css('background', statusColor);
                    }
                    
                } catch (e) {
                    // JSON이 아닌 경우 일반 텍스트로 처리
                    console.warn('[MQTT] 📝 [test/topic] 텍스트 데이터:', messageStr);
                }
            }
        });
        
        // 연결 오류 (Mosquitto 전용 에러 처리)
        client.on('error', function (err) {
            console.error('[MQTT] ❌ Mosquitto 연결 오류:', err);
            
            // jQuery를 사용한 에러 상태 표시
            $('#mqtt-status').css({
                'background': '#dc3545',
                'animation': 'blink 1s infinite'
            }).html('<i class="fas fa-exclamation-triangle" style="margin-right:5px;"></i>Mosquitto 오류');
            
            // 에러 상세 정보 표시
            if (err.message) {
                console.error('[MQTT] 에러 상세:', err.message);
            }
        });
        
        // 연결 끊김 (Mosquitto 연결 끊김 이벤트)
        client.on('close', function () {
            console.log('[MQTT] 🦟 Mosquitto 연결이 끊어졌습니다.');
            
            // jQuery를 사용한 연결 상태 업데이트
            $('#mqtt-status').css('background', '#fd7e14').html('<i class="fas fa-unlink" style="margin-right:5px;"></i>Mosquitto 끊어짐');
        });
        
        // 재연결 (Mosquitto 재연결 로직)
        client.on('reconnect', function () {
            console.log('[MQTT] 🔄 Mosquitto 재연결 시도중...');
            
            // jQuery를 사용한 재연결 상태 표시
            $('#mqtt-status').css('background', '#17a2b8').html('<i class="fas fa-sync fa-spin" style="margin-right:5px;"></i>Mosquitto 재연결 중...');
        });
        
        // 전역 변수로 저장 (필요시 다른 곳에서 사용 가능)
        window.mqttClient = client;
        
    } catch (error) {
        console.error('[MQTT] ❌ Mosquitto 클라이언트 초기화 오류:', error);
        
        // jQuery를 사용한 초기화 에러 표시
        $('#mqtt-status-container').html('<div class="badge fs-6" style="background:#dc3545; color:white; padding:8px 12px; border-radius:5px; box-shadow:0 2px 5px rgba(0,0,0,0.2);"><i class="fas fa-times-circle" style="margin-right:5px;"></i>Mosquitto 초기화 실패</div>');
    }
}

// Mosquitto 메시지 전송 함수 (Console 로그만 사용)
function sendMQTTMessage(topic, message, qos) {
    qos = qos || 1; // 기본 QoS 1 (Mosquitto 배송 보장)
    
    if (window.mqttClient && window.mqttClient.connected) {
        // JSON 객체는 문자열로 변환
        const messageStr = typeof message === 'object' ? JSON.stringify(message) : message;
        
        window.mqttClient.publish(topic, messageStr, { qos: qos }, function(err) {
            const timestamp = new Date().toLocaleTimeString();
            
            if (!err) {
                console.log(`[MQTT] 📤 [${timestamp}] 메시지 전송성공 [QoS ${qos}]:`, topic, messageStr);
            } else {
                console.error(`[MQTT] ❌ [${timestamp}] 메시지 전송 실패:`, err);
                console.error(`[MQTT]    - 토픽: ${topic}`);
                console.error(`[MQTT]    - 메시지: ${messageStr}`);
            }
        });
    } else {
        const timestamp = new Date().toLocaleTimeString();
        console.error(`[MQTT] ❌ [${timestamp}] 클라이언트가 연결되지 않음`);
        console.warn('[MQTT] - MQTT 클라이언트 연결 상태를 확인하세요.');
    }
}

// MQTT 초기화 함수 (페이지 로드 시 자동 실행)
$(document).ready(function() {
    console.log('[MQTT] 🦟 jQuery DOM 준비 완료 - 차량 대시보드 시작');
    
    // Mosquitto MQTT 클라이언트 초기화
    initMQTTClient();
});

// 전역 함수로 내보내기
window.sendMQTTMessage = sendMQTTMessage;
window.initMQTTClient = initMQTTClient;