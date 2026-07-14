(function () {
    'use strict';

    const fileInput = document.getElementById('yolo-video-file');
    const detectButton = document.getElementById('yolo-detect-btn');
    const confInput = document.getElementById('yolo-conf');
    const iouInput = document.getElementById('yolo-iou');

    const statusElement = document.getElementById('yolo-status');
    const inputVideoElement = document.getElementById('yolo-input-video');
    const outputVideoElement = document.getElementById('yolo-output-video');
    const resultJsonElement = document.getElementById('yolo-result-json');

    function setStatus(message, type) {
        const alertType = type || 'secondary';
        statusElement.className = `alert alert-${alertType} mt-3 mb-0`;
        statusElement.textContent = message;
    }

    function toNumber(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    async function runYoloDetect() {
        const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        if (!file) {
            setStatus('동영상 파일을 선택하세요.', 'warning');
            return;
        }

        const conf = toNumber(confInput.value, 0.25);
        const iou = toNumber(iouInput.value, 0.45);

        detectButton.disabled = true;
        setStatus('YOLO 검출 진행 중...', 'info');

        try {
            const formData = new FormData();
            formData.append('file', file);

            const url = `/fast/yolo/detect_video_upload?conf=${encodeURIComponent(conf)}&iou=${encodeURIComponent(iou)}`;
            const response = await fetch(url, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                let errorMessage = `요청 실패 (${response.status})`;
                try {
                    const errorBody = await response.json();
                    if (errorBody && errorBody.detail) {
                        errorMessage = String(errorBody.detail);
                    }
                } catch (_ignore) {
                    // Keep default message.
                }
                throw new Error(errorMessage);
            }

            const result = await response.json();

            inputVideoElement.src = result.input_url || '';
            outputVideoElement.src = result.output_url || '';
            inputVideoElement.load();
            outputVideoElement.load();

            resultJsonElement.textContent = JSON.stringify(result, null, 2);
            setStatus('검출 완료', 'success');
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            setStatus(`오류: ${message}`, 'danger');
        } finally {
            detectButton.disabled = false;
        }
    }

    detectButton.addEventListener('click', runYoloDetect);
})();
