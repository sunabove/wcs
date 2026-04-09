
function prcessMqttMessage(topic, value) {

    console.log(`[MQTT] 🧩 prcessMqttMessage 호출 - topic: ${topic}, value: ${value}`);

    // 토픽별 분류 및 상세 로깅
    if (topic.startsWith('vehicle/')) {
        console.log('[MQTT] 🚗 차량 데이터:', topic, value);
    } else if (topic.startsWith('wheel/')) {
        console.log('[MQTT] 🛞 바퀴 데이터:', topic, value);
    } else if (topic.startsWith('sensor/')) {
        console.log('[MQTT] 📡 센서 데이터:', topic, value);
    } else if (topic.startsWith('system/')) {
        console.log('[MQTT] ⚙️ 시스템 데이터:', topic, value);
    } else if (topic.startsWith('test/')) {
        console.log('[MQTT] 🧪 테스트 데이터:', topic, value);
    } else if (topic.startsWith('web/')) {
        console.log('[MQTT] 🌐 웹 클라이언트 데이터:', topic, value);
    } else {
        console.log('[MQTT] 📝 일반 데이터:', topic, value);
    }

    // jQuery를 사용한 DOM 업데이트: topic을 id로 사용해서 해당 요소 찾기
    const $targetElement = $(`#${CSS.escape(topic)}`);
    
    if ($targetElement.length > 0) {
        // 숫자 값 포맷팅
        let formattedValue = value;
        
        // 숫자인 경우 적절한 포맷 적용
        if (!isNaN(value)) {
            const numValue = parseFloat(value);
            
            // 토픽별 단위 및 포맷팅
            if (topic.includes('/linear/speed')) {
                formattedValue = `${numValue.toFixed(1)} m/s`;
            } else if (topic.includes('/power')) {
                formattedValue = `${Math.round(numValue)} W`;
            } else if (topic.includes('/pid/')) {
                formattedValue = numValue.toFixed(3);
            } else if (topic.includes('/tof/distance')) {
                formattedValue = `${numValue.toFixed(1)} cm`;
            } else if (topic.includes('/angle')) {
                // radian을 도(degree)로 변환
                const degrees = (numValue * 180 / Math.PI);
                formattedValue = `${degrees.toFixed(1)}°`;
            } else if (topic.includes('/axis/angle')) {
                // 축 각도도 radian에서 도로 변환
                const degrees = (numValue * 180 / Math.PI);
                formattedValue = `${degrees.toFixed(1)}°`;
            } else if (topic.includes('/voltage')) {
                formattedValue = `${numValue.toFixed(1)} V`;
            } else if (topic.includes('/distance')) {
                formattedValue = `${numValue.toFixed(2)} m`;
            } else if (topic.includes('/acceleration')) {
                formattedValue = `${numValue.toFixed(2)} m/s²`;
            } else if (topic.includes('/torque')) {
                formattedValue = `${numValue.toFixed(1)} Nm`;
            } else {
                // 기본 숫자 포맷
                formattedValue = numValue.toFixed(2);
            }
        }
        
        // jQuery를 사용한 DOM 요소 업데이트
        $targetElement.text(formattedValue);
        
        // tr의 index를 구해서 색상 결정
        const $parentRow = $targetElement.closest('tr');
        const rowIndex = $parentRow.index();
        
        // tr index에 따른 색상 배열 (첫 번째와 두 번째 색상)
        const colorPairs = [
            { first: '#e91e63', second: '#9c27b0' },  // index 0: 핑크 → 보라
            { first: '#2196f3', second: '#03a9f4' },  // index 1: 파란색 → 하늘색
            { first: '#4caf50', second: '#8bc34a' },  // index 2: 초록색 → 연초록
            { first: '#ff9800', second: '#ffc107' },  // index 3: 주황색 → 노란색
            { first: '#f44336', second: '#ff5722' },  // index 4: 빨간색 → 주황빨강
            { first: '#673ab7', second: '#3f51b5' },  // index 5: 보라 → 인디고
        ];
        
        // 색상 선택 (index가 배열 길이보다 크면 순환)
        const colorPair = colorPairs[rowIndex % colorPairs.length];
        
        // tr index에 따른 2단계 전경색 변경 효과
        $targetElement.css({
            'transition': 'color 0.15s ease',
            'color': colorPair.first,  // 첫 번째 색상
            'font-weight': 'bold'
        });
        
        // 150ms 후 두 번째 색상으로 변경
        setTimeout(() => {
            $targetElement.css('color', colorPair.second);  // 두 번째 색상
        }, 150);
        
        // 500ms 후 원래 색상으로 복원
        setTimeout(() => {
            $targetElement.css({
                'color': '',
                'font-weight': ''
            });
        }, 500);
        
        console.log(`[MQTT] ✅ DOM 업데이트 성공: ${topic} -> ${formattedValue} (행 인덱스: ${rowIndex}, 색상: ${colorPair.first} → ${colorPair.second})`);
    } else {
        console.log(`[MQTT] ❌ DOM 요소를 찾을 수 없음: ${topic}`);
    }
}