$(document).ready(function() {
    function applySelectedWheelHighlightOnLoad() {
        const selectedWheel = $('input[name="wheelPosition"]:checked').val();
        if (!selectedWheel) {
            return;
        }

        if (typeof window.setVehicleWheelHighlightByKey === 'function') {
            window.setVehicleWheelHighlightByKey(selectedWheel.toLowerCase());
        }
    }

    function updateWheelDataIds() {
        const selectedWheel = $('input[name="wheelPosition"]:checked').val().toLowerCase();
        const dataElements = [];
        $('#wheelDataTable tbody td[id]').each(function() {
            const currentId = $(this).attr('id');
            const idParts = currentId.split('/');
            if (idParts.length >= 3) {
                const suffix = '/' + idParts.slice(2).join('/');
                const selector = `#wheelDataTable td[id*="${suffix}"]`;

                dataElements.push({
                    selector: selector,
                    suffix: suffix,
                    element: $(this)
                });
            }
        });

        console.log('[Vehicle Setting] 🔍 동적으로 추출된 데이터 요소들:', dataElements);

        dataElements.forEach(element => {
            const newId = `wheel/${selectedWheel}${element.suffix}`;
            element.element.attr('id', newId);
            console.log(`[Vehicle Setting] 🛞 바퀴 데이터 ID 업데이트: ${newId}`);
        });

        $('#wheelDataTable thead th[colspan="2"]').text(`${selectedWheel.toUpperCase()} Wheel`);

        console.log(`[Vehicle Setting] 📋 선택된 바퀴: ${selectedWheel.toUpperCase()}, wheelDataTable ID 업데이트 완료`);
    }

    $('input[name="wheelPosition"]').change(function() {
        const selectedWheel = $(this).val();
        console.log(`[Vehicle Setting] 🎯 바퀴 선택 변경: ${selectedWheel}`);

        updateWheelDataIds();

        if (typeof window.setWheelViewerKey === 'function') {
            window.setWheelViewerKey(selectedWheel.toLowerCase());
        }

        if (typeof window.flashWheelViewer === 'function') {
            window.flashWheelViewer();
        }

        if (typeof window.setVehicleWheelHighlightByKey === 'function') {
            window.setVehicleWheelHighlightByKey(selectedWheel.toLowerCase());
        }

        const wheelId = selectedWheel.toLowerCase();
        const topic = `wheel/${wheelId}/id_request`;
        const message = '';

        console.log('[Vehicle Setting] 📤 ID 요청 MQTT 전송 준비 - 토픽:', topic);

        try {
            window.WcsMqtt.sendMQTTMessage(topic, message, 1);
            console.log(`[Vehicle Setting] 🔍 바퀴 ID 요청 발행 - 바퀴: ${selectedWheel}, 토픽: ${topic}`);
        } catch (error) {
            console.error('[Vehicle Setting] ❌ ID 요청 sendMQTTMessage 호출 에러:', error);
        }

        const $dataTable = $('#wheelDataTable');
        $dataTable.css('transform', 'scale(0.95)')
            .css('transition', 'transform 0.2s ease-in-out, opacity 0.2s ease-in-out')
            .css('opacity', '0.8');

        setTimeout(() => {
            $dataTable.css('transform', 'scale(1)')
                .css('opacity', '1');
        }, 200);
    });

    updateWheelDataIds();

    const initialWheel = $('input[name="wheelPosition"]:checked').val().toLowerCase();
    if (typeof window.setVehicleWheelHighlightByKey === 'function') {
        window.setVehicleWheelHighlightByKey(initialWheel);
    }

    setTimeout(applySelectedWheelHighlightOnLoad, 800);

    if (typeof window.setWheelViewerKey === 'function') {
        window.setWheelViewerKey(initialWheel);
    }

    $('#max_speed_set_btn').click(function() {
        const maxSpeed = $('#maxSpeed').val();

        if (maxSpeed !== '' && !isNaN(maxSpeed)) {
            const speed = parseFloat(maxSpeed);
            const selectedWheel = $('input[name="wheelPosition"]:checked').val();

            if (speed >= 0 && speed <= 10) {
                const topic = 'vehicle/linear/max_speed';
                const message = speed;

                window.WcsMqtt.sendMQTTMessage(topic, message, 1);

                console.log(`[Vehicle Setting] 🚗 최고 속도 설정 - 바퀴: ${selectedWheel}, 속도: ${speed} km/s`);

                $(this).removeClass('input-group-text').addClass('btn btn-success');
                $(this).text('설정완료');

                setTimeout(() => {
                    $(this).removeClass('btn btn-success').addClass('input-group-text');
                    $(this).text('설정');
                }, 2000);
            } else {
                alert('속도는 0~10 km/s 범위로 입력해주세요.');
            }
        } else {
            alert('유효한 속도 값을 입력해주세요.');
        }
    });

    $('#tof_calibration_btn').click(function() {
        console.log('[Vehicle Setting] 🔍 ToF 캘리브레이션 버튼 클릭됨');

        const tofValue = $('#tofCalibration').val();
        console.log('[Vehicle Setting] 📊 입력된 ToF 값:', tofValue);

        if (tofValue !== '' && !isNaN(tofValue)) {
            const calibration = parseFloat(tofValue);
            console.log('[Vehicle Setting] 🔢 파싱된 캘리브레이션 값:', calibration);

            const selectedWheel = $('input[name="wheelPosition"]:checked').val();
            console.log('[Vehicle Setting] 🎯 선택된 바퀴:', selectedWheel);

            const topic = `wheel/${selectedWheel}/tof/calibration`;
            const message = calibration;

            console.log('[Vehicle Setting] 📤 MQTT 전송 준비 - 토픽:', topic, '메시지:', message, '타입:', typeof message);

            try {
                window.WcsMqtt.sendMQTTMessage(topic, message, 1);
            } catch (error) {
                console.error('[Vehicle Setting] ❌ sendMQTTMessage 호출 에러:', error);
                alert(`ToF 캘리브레이션 전송 중 오류 발생: ${error.message}`);
                return;
            }

            console.log(`[Vehicle Setting] 📡 ToF 캘리브레이션 - 바퀴: ${selectedWheel}, 값: ${calibration} cm`);

            $(this).removeClass('input-group-text').addClass('btn btn-primary');
            $(this).text('실행완료');

            setTimeout(() => {
                $(this).removeClass('btn btn-primary').addClass('input-group-text');
                $(this).text('실행');
            }, 2000);
        } else {
            console.warn('[Vehicle Setting] ⚠️ 유효하지 않은 ToF 값:', tofValue);
            alert('유효한 캘리브레이션 값을 입력해주세요.');
        }
    });

    $('input[name="wheelId"]').change(function() {
        const wheelIdValue = $(this).val();
        const wheelId = parseInt(wheelIdValue);
        const selectedWheel = $('input[name="wheelPosition"]:checked').val();

        console.log(`[Vehicle Setting] 🏷️ 바퀴 ID 변경: ${wheelId}, 선택된 바퀴: ${selectedWheel}`);

        const topic = `wheel/${selectedWheel}/id`;
        const message = wheelId;

        console.log('[Vehicle Setting] 📤 MQTT 전송 준비 - 토픽:', topic, '메시지:', message, '타입:', typeof message);

        try {
            sendMQTTMessage(topic, message, 1);
            console.log(`[Vehicle Setting] 🏷️ 바퀴 ID 자동 설정 - 바퀴: ${selectedWheel}, ID: ${wheelId}`);
        } catch (error) {
            console.error('[Vehicle Setting] ❌ sendMQTTMessage 호출 에러:', error);
            alert(`바퀴 ID 설정 전송 중 오류 발생: ${error.message}`);
        }
    });

    $('#wheel_id_set_btn').click(function() {
        const wheelIdValue = $('input[name="wheelId"]:checked').val();
        const wheelId = parseInt(wheelIdValue);
        const selectedWheel = $('input[name="wheelPosition"]:checked').val();

        console.log(`[Vehicle Setting] 🏷️ 바퀴 ID 수동 설정: ${wheelId}, 선택된 바퀴: ${selectedWheel}`);

        if (wheelId >= 1 && wheelId <= 4) {
            const topic = `wheel/${selectedWheel}/id`;
            const message = wheelId;

            console.log('[Vehicle Setting] 📤 MQTT 전송 준비 - 토픽:', topic, '메시지:', message, '타입:', typeof message);

            try {
                sendMQTTMessage(topic, message, 1);
                console.log(`[Vehicle Setting] 🏷️ 바퀴 ID 수동 설정 - 바퀴: ${selectedWheel}, ID: ${wheelId}`);

                $(this).removeClass('btn-outline-primary').addClass('btn btn-success');
                $(this).html('<i class="bi bi-check-lg me-1"></i>설정완료');

                setTimeout(() => {
                    $(this).removeClass('btn btn-success').addClass('btn-outline-primary');
                    $(this).html('<i class="bi bi-gear-fill me-1"></i>ID 설정');
                }, 2000);
            } catch (error) {
                console.error('[Vehicle Setting] ❌ sendMQTTMessage 호출 에러:', error);
                alert(`바퀴 ID 설정 전송 중 오류 발생: ${error.message}`);
            }
        } else {
            alert('올바른 바퀴 ID를 선택해주세요.');
        }
    });
});
