
function prcessMqttMessage(topic, numValue) {

    console.log(`[MQTT] 🧩 prcessMqttMessage 호출 - topic: ${topic}, value: ${numValue}`);

    // 토픽별 분류 및 상세 로깅
    if (topic.startsWith('vehicle/')) {
        console.log('[MQTT] 🚗 차량 데이터:', topic, numValue);
    } else if (topic.startsWith('sensor/')) {
        console.log('[MQTT] 📡 센서 데이터:', topic, numValue);
    } else if (topic.startsWith('system/')) {
        console.log('[MQTT] ⚙️ 시스템 데이터:', topic, numValue);
    } else if (topic.startsWith('test/')) {
        console.log('[MQTT] 🧪 테스트 데이터:', topic, numValue);
    } else if (topic.startsWith('web/')) {
        console.log('[MQTT] 🌐 웹 클라이언트 데이터:', topic, numValue);
    } else {
        console.log('[MQTT] 📝 일반 데이터:', topic, numValue);
    } 

}