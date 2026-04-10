// mqtt_process_01_status.js

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

    // jQuery를 사용한 DOM 업데이트: topic을 id로 사용해서 해당 요소 찾기 (속성 선택자 사용)
    const $targetElement = $(`[id="${topic}"]`);

    // vehicle/run/state 특별 처리 (상태별 버튼 enable/disable)
    if (topic === 'vehicle/run/state') {
        const state = parseInt(value);
        
        // 모든 상태 버튼 비활성화 (속성 선택자 사용)
        $('[id="vehicle/run/state/0"], [id="vehicle/run/state/1"]')
            .prop('disabled', true)
            .removeClass('btn-success btn-primary')
            .addClass('btn-secondary');
        
        // 해당 상태 버튼만 활성화
        if (state === 0) {
            $('[id="vehicle/run/state/0"]')
                .prop('disabled', false)
                .removeClass('btn-secondary')
                .addClass('btn-success');
            console.log('[MQTT] 🔴 차량 상태: IDLE (정지)');
        } else {
            $('[id="vehicle/run/state/1"]')
                .prop('disabled', false)
                .removeClass('btn-secondary')
                .addClass('btn-success');
            console.log('[MQTT] 🟢 차량 상태: RUNNING (동작중)');
        }
    }

    // vehicle/surface/state 특별 처리 (노면 상태별 테두리 강조 및 disabled 효과)
    if (topic === 'vehicle/surface/state') {
        const state = parseInt(value);
        
        // 모든 노면 상태 요소의 테두리 제거 및 disabled 효과 적용
        $('[id^="vehicle/surface/state/"]')
            .removeClass('border-primary border-3')
            .addClass('disabled')
            .css({ 
                'opacity': '0.6', 
                'color': '#666',
                'background-color': '#ccc'  // Light gray 배경색
            });
        
        // 해당 노면 상태 요소에 테두리 추가 및 활성화
        const $currentStateElement = $(`[id="vehicle/surface/state/${state}"]`);
        if ($currentStateElement.length > 0) {
            $currentStateElement
                .addClass('border-primary border-3')
                .removeClass('disabled')
                .css({ 
                    'opacity': '1', 
                    'color': '', 
                    'font-weight': 'bold',
                    'background-color': ''  // 원본 배경색 복원
                });
            
            const stateNames = ['ROAD', 'GRAVEL', 'ICE', 'POTHOLE'];
            const stateName = stateNames[state] || 'UNKNOWN';
            console.log(`[MQTT] 🛣️ 노면 상태: ${stateName} (${state})`);
        }
    }
    
    if ($targetElement.length > 0) {
        // 숫자 값 포맷팅
        let formattedValue = getFormattedTopicValue(topic, value);
        
        // jQuery를 사용한 DOM 요소 업데이트
        $targetElement.text(formattedValue);
        
        updateTargetElementCss($targetElement);
        
        console.log(`[MQTT] ✅ DOM 업데이트 성공: ${topic} -> ${formattedValue}`);
    } else {
        console.log(`[MQTT] ❌ DOM 요소를 찾을 수 없음: ${topic}`);
    }
} // prcessMqttMessage

function getFormattedTopicValue(topic, value) {
    const numValue = parseFloat(value);

    let formattedValue = value;
            
    // SI 단위계 토픽별 단위 및 포맷팅
    if (topic === 'vehicle/drive/available_time') {
        // 시분 변환 표시 (초 → 시:분)
        const hours = Math.floor(numValue / 3600);
        const minutes = Math.floor((numValue % 3600) / 60); 
        if (hours === 0) {
            formattedValue = `${minutes}분`;  // 시간이 0이면 분만 표시
        } else {
            formattedValue = `${hours}시 ${minutes.toString().padStart(2, '0')}분`;
        }
    } else if (topic === 'vehicle/battery/remain_time') {
        // 배터리 잔여 시간도 시:분으로 표시
        const hours = Math.floor(numValue / 3600);
        const minutes = Math.floor((numValue % 3600) / 60);
        if (hours === 0) {
            formattedValue = `${minutes}분`;  // 시간이 0이면 분만 표시
        } else {
            formattedValue = `${hours}시 ${minutes.toString().padStart(2, '0')}분`;
        }
    } else if (topic === 'vehicle/drive/elapsed_time') {
        // 경과 시간도 시:분으로 표시
        const hours = Math.floor(numValue / 3600);
        const minutes = Math.floor((numValue % 3600) / 60);
        if (hours === 0) {
            formattedValue = `${minutes}분`;  // 시간이 0이면 분만 표시
        } else {
            formattedValue = `${hours}시 ${minutes.toString().padStart(2, '0')}분`;
        }
    } else if (topic === 'vehicle/drive/total_distance') {
        // 총 이동거리: 1km 미만은 m 단위, 1km 이상은 km 단위로 표시
        if (numValue < 1000) {
            formattedValue = `${Math.round(numValue)} m`;  // 1km 미만은 미터 단위
        } else {
            const kilometers = numValue / 1000;
            formattedValue = `${kilometers.toFixed(0)} km`;  // 1km 이상은 킬로미터 단위
        }
    } else if (topic === 'vehicle/battery/remain_amount') {
        formattedValue = `${numValue.toFixed(0)}%`;  // 배터리 잔량 퍼센트
    } else if (topic.includes('/linear/speed')) {
        formattedValue = `${numValue.toFixed(3)} m/s`;  // SI: 미터/초
    } else if (topic.includes('/power')) {
        formattedValue = `${Math.round(numValue)} W`;  // SI: 와트
    } else if (topic.includes('/pid/')) {
        formattedValue = numValue.toFixed(3);  // 무차원
    } else if (topic.includes('/tof/distance')) {
        formattedValue = `${numValue.toFixed(3)} m`;  // SI: 미터 (ToF 센서)
    } else if (topic.includes('/angle')) {
        // radian을 도(degree)로 변환 표시
        const degrees = (numValue * 180 / Math.PI);
        formattedValue = `${degrees.toFixed(1)}°`;
    } else if (topic.includes('/axis/angle')) {
        // 축 각도도 radian에서 도로 변환 표시
        const degrees = (numValue * 180 / Math.PI);
        formattedValue = `${degrees.toFixed(1)}°`;
    } else if (topic.includes('/voltage')) {
        formattedValue = `${numValue.toFixed(2)} V`;  // SI: 볼트
    } else if (topic.includes('/distance') || topic.includes('/total_distance')) {
        formattedValue = `${numValue.toFixed(3)} m`;  // SI: 미터 (기타 거리)
    } else if (topic.includes('/acceleration')) {
        formattedValue = `${numValue.toFixed(3)} m/s²`;  // SI: 미터/초²
    } else if (topic.includes('/torque')) {
        formattedValue = `${numValue.toFixed(2)} Nm`;  // SI: 뉴턴미터
    } else if (topic.includes('_time')) {
        formattedValue = `${Math.round(numValue)} s`;  // SI: 초 (기타 시간 값들)
    } else if (topic.includes('/position/')) {
        formattedValue = `${numValue.toFixed(3)} m`;  // SI: 미터 (위치)
    } else if (topic.includes('/remain_amount')) {
        formattedValue = `${numValue.toFixed(1)} %`;  // 기타 퍼센트 값
    } else {
        // 기본 숫자 포맷
        formattedValue = numValue.toFixed(2);
    }

    return formattedValue;
} // getFormattedValue

function updateTargetElementCss( $targetElement ) {
    // tr의 index를 구해서 색상 결정
    const $parentRow = $targetElement.closest('tr');
    let rowIndex = $parentRow.length > 0 ? $parentRow.index() : 0;
    
    // rowIndex가 유효하지 않은 경우 기본값 0으로 설정
    if (rowIndex < 0 || isNaN(rowIndex)) {
        rowIndex = 0;
    }
    
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
    
    // colorPair가 유효한지 확인
    if (!colorPair) {
        console.warn('[CSS] 색상 배열에서 유효한 colorPair를 찾을 수 없음. rowIndex:', rowIndex);
        return; // 에러 방지를 위해 함수 종료
    }
    
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
            'font-weight': 'bold'
        });
    }, 500);

} // updateTargetElementCss