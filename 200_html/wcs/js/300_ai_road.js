$(function () {
    const $dropZone = $("#image-drop-zone");
    const $fileInput = $("#road-image-input");
    const $selectedFileLabel = $("#selected-image-name");
    const $uploadedImagePreview = $("#original-image-preview");
    const $uploadedVideoPreview = $("#original-video-preview");
    const $detectedImagePreview = $("#detected-image-preview");
    const $detectedVideoPreview = $("#detected-video-preview");
    const $detectedStreamControls = $("#detected-stream-controls");
    const $detectedStreamPauseButton = $("#detected-stream-pause");
    const $detectedStreamResumeButton = $("#detected-stream-resume");
    const $detectedStreamFrameInput = $("#detected-stream-frame-input");
    const $detectedStreamFrameValue = $("#detected-stream-frame-value");
    const $detectedStreamFrameLabel = $("#detected-stream-frame-label");
    const $roiOverlay = $("#roi-overlay");
    const $roiSelection = $("#roi-selection");
    const $roiResetButton = $("#roi-reset-button");
    const $roiEditorStatus = $("#roi-editor-status");
    const $originalImageTab = $("#original-image-tab");
    const $detectedImageTab = $("#detected-image-tab");
    const $originalLiveBadge = $("#original-live-badge");
    const $detectedLiveBadge = $("#detected-live-badge");
    const $uploadingIndicator = $("#working-indicator");
    const $uploadStatusMessage = $("#work-status-message");
    const $detectingIndicator = $("#detecting-indicator");
    const $detectTypeInputs = $("input[name='detect-type']");
    const $cameraPane = $("#input-camera-pane");
    const $cameraTab = $("#input-camera-tab");
    const $cameraDeviceList = $("#camera-device-list");
    const $sampleImagePane = $("#input-sample-image-pane");
    const $sampleImageTab = $("#input-sample-image-tab");
    const $sampleVideoPane = $("#input-sample-video-pane");
    const $sampleVideoTab = $("#input-sample-video-tab");
    const sampleImageItemTemplate = document.getElementById("sample-image-item-template");
    const sampleVideoItemTemplate = document.getElementById("sample-video-item-template");
    const DETECT_AFTER_UPLOAD_DELAY_MS = 800;
    let uploadedFileName = "";
    let previousFileName = "";  // 이전 파일명 추적
    let detectDebounceTimer = null;
    let sampleDetectTimer = null;
    let isUploading = false;
    let isDetecting = false;
    let isCameraDevicesLoaded = false;
    let isCameraDevicesLoading = false;
    let isSampleImagesLoaded = false;
    let isSampleImagesLoading = false;
    let isSampleVideosLoaded = false;
    let isSampleVideosLoading = false;
    let frameStreamState = {};  // 프레임 스트리밍 상태
    let frameTimerMap = {};     // 프레임 타이머 맵
    let cameraStreamState = null;
    let cameraStreamTimer = null;
    let currentRoiInfo = null;
    let draftRoiInfo = null;
    let roiInteraction = null;
    let roiRequestToken = 0;
    const MIN_ROI_SIZE = 20;

    if ($dropZone.length === 0 || $fileInput.length === 0 || $uploadedImagePreview.length === 0) {
        return;
    }

    function isVideoPath(pathValue) {
        const lower = normalizePath(pathValue).toLowerCase();
        return [".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".wmv"].some(function (ext) {
            return lower.endsWith(ext);
        });
    }

    function hideImageAndVideo($img, $video) {
        if ($img && $img.length > 0) {
            $img.attr("src", "").addClass("d-none");
        }
        if ($video && $video.length > 0) {
            $video.attr("src", "").addClass("d-none");
            if ($video[0] && typeof $video[0].pause === "function") {
                $video[0].pause();
            }
        }
    }

    function showMediaPreview(url, isVideo, $img, $video) {
        if (isVideo) {
            if ($img && $img.length > 0) {
                $img.attr("src", "").addClass("d-none");
            }
            if ($video && $video.length > 0) {
                $video.attr("src", url).removeClass("d-none");
                if ($video[0] && typeof $video[0].load === "function") {
                    $video[0].load();
                }
            }
            return;
        }

        if ($video && $video.length > 0) {
            $video.attr("src", "").addClass("d-none");
            if ($video[0] && typeof $video[0].pause === "function") {
                $video[0].pause();
            }
        }
        if ($img && $img.length > 0) {
            $img.attr("src", url).removeClass("d-none");
        }

        requestAnimationFrame(syncRoiOverlay);
    }

    function cloneRoi(roi) {
        if (!roi) {
            return null;
        }

        return {
            x1: Number(roi.x1) || 0,
            y1: Number(roi.y1) || 0,
            x2: Number(roi.x2) || 0,
            y2: Number(roi.y2) || 0,
        };
    }

    function sameRoi(left, right) {
        if (!left || !right) {
            return false;
        }

        return left.x1 === right.x1
            && left.y1 === right.y1
            && left.x2 === right.x2
            && left.y2 === right.y2;
    }

    function setRoiStatus(message, tone) {
        if ($roiEditorStatus.length === 0) {
            return;
        }

        $roiEditorStatus
            .removeClass("text-muted text-success text-danger")
            .addClass(tone === "danger" ? "text-danger" : (tone === "success" ? "text-success" : "text-muted"))
            .text(message || "");
    }

    function updateRoiEditorButtons() {
        const hasRoi = Boolean(currentRoiInfo && draftRoiInfo);
        $roiResetButton.prop("disabled", !hasRoi);
    }

    function clearRoiEditor() {
        roiRequestToken += 1;
        currentRoiInfo = null;
        draftRoiInfo = null;
        roiInteraction = null;
        $roiOverlay.addClass("d-none");
        $roiSelection.css({ left: "", top: "", width: "", height: "" });
        updateRoiEditorButtons();
        setRoiStatus("원본 영상에서 ROI를 수정할 수 있습니다.", "muted");
    }

    function updateSelectedFile(file) {
        if ($selectedFileLabel.length > 0) {
            $selectedFileLabel.text(file ? "선택 파일: " + file.name : "선택된 파일 없음");
        }
    }

    function clearSampleSelection() {
        $sampleImagePane.find(".sample-image-item.selected-sample").removeClass("selected-sample");
        $sampleVideoPane.find(".sample-video-item.selected-sample").removeClass("selected-sample");
    }

    function markSampleSelection($item) {
        clearSampleSelection();
        if ($item && $item.length > 0) {
            $item.addClass("selected-sample");
        }
    }

    function setUploadingState(uploading) {
        isUploading = Boolean(uploading);
        if (isUploading) {
            showUploadStatusMessage("업로드 중...", true);
        }
        updateWorkingIndicatorState();
    }

    function setDetectingState(detecting) {
        isDetecting = Boolean(detecting);
        updateWorkingIndicatorState();
    }

    function updateWorkingIndicatorState() {
        if ($uploadingIndicator.length === 0) {
            return;
        }

        $uploadingIndicator.toggleClass("d-none", !(isUploading || isDetecting));
    }

    function updateCameraLiveBadges() {
        const isLive = Boolean(cameraStreamState && cameraStreamState.isPlaying);
        if ($originalLiveBadge.length > 0) {
            $originalLiveBadge.toggleClass("d-none", !isLive);
        }
        if ($detectedLiveBadge.length > 0) {
            $detectedLiveBadge.toggleClass("d-none", !isLive);
        }
    }

    function showUploadStatusMessage(message, isSuccess) {
        if ($uploadStatusMessage.length === 0) {
            return;
        }

        $uploadStatusMessage
            .removeClass("d-none text-success text-danger")
            .addClass(isSuccess ? "text-success" : "text-danger")
            .text(message);
    }

    function updateDetectedStreamControls() {
        const isVideo = Boolean(uploadedFileName) && isVideoPath(uploadedFileName);
        if (!isVideo) {
            $detectedStreamControls.addClass("d-none");
            $detectedStreamFrameValue.text("");
            $detectedStreamFrameLabel.text("");
            return;
        }

        $detectedStreamControls.removeClass("d-none");

        const state = frameStreamState[uploadedFileName] || null;
        const totalFrames = state ? Number(state.totalFrames || 0) : 0;
        const currentFrame = state ? Number(state.frameIndex || 0) : 0;
        const isPlaying = Boolean(state && state.isPlaying);
        const isPaused = Boolean(state && state.isPaused);
        const hasSession = Boolean(state);
        const canPause = hasSession && isPlaying && !isPaused;
        const canResume = hasSession && isPaused && !isPlaying;

        if (totalFrames > 0) {
            const normalizedFrame = Math.max(1, currentFrame || 1);
            $detectedStreamFrameInput.attr("min", 1);
            $detectedStreamFrameInput.attr("max", totalFrames);
            $detectedStreamFrameInput.val(String(normalizedFrame));
            $detectedStreamFrameValue.text(String(normalizedFrame));
            $detectedStreamFrameLabel.text(currentFrame > 0 ? (currentFrame + " / " + totalFrames) : ("0 / " + totalFrames));
        } else {
            $detectedStreamFrameInput.attr("min", 1);
            $detectedStreamFrameInput.removeAttr("max");
            $detectedStreamFrameInput.val("1");
            $detectedStreamFrameValue.text("1");
            $detectedStreamFrameLabel.text("");
        }

        $detectedStreamPauseButton.prop("disabled", !canPause);
        $detectedStreamResumeButton.prop("disabled", !canResume);
        $detectedStreamFrameInput.prop("disabled", !hasSession);

        $detectedStreamPauseButton
            .toggleClass("btn-outline-primary", canPause)
            .toggleClass("btn-outline-secondary", !canPause);
        $detectedStreamResumeButton
            .toggleClass("btn-outline-primary", canResume)
            .toggleClass("btn-outline-secondary", !canResume);

        $detectedStreamPauseButton.find("i")
            .toggleClass("text-primary", canPause)
            .toggleClass("text-muted", !canPause);
        $detectedStreamResumeButton.find("i")
            .toggleClass("text-primary", canResume)
            .toggleClass("text-muted", !canResume);
    }

    function resetPreviewImages() {
        uploadedFileName = "";
        previousFileName = "";
        clearRoiEditor();
        updateDetectedStreamControls();
        // 이미지 초기화
        hideImageAndVideo($uploadedImagePreview, $uploadedVideoPreview);
        hideImageAndVideo($detectedImagePreview, $detectedVideoPreview);
        // src 속성 완전 제거
        $uploadedImagePreview.removeAttr("src");
        $uploadedVideoPreview.removeAttr("src");
        $detectedImagePreview.removeAttr("src");
        $detectedVideoPreview.removeAttr("src");
        // 비디오 정지 및 리소스 해제
        [$uploadedVideoPreview, $detectedVideoPreview].forEach(function ($v) {
            if ($v.length > 0 && $v[0]) {
                try { $v[0].pause(); } catch (e) {}
                try { $v[0].removeAttribute("src"); } catch (e) {}
                try { $v[0].load(); } catch (e) {}
            }
        });
        // 검출 인디케이터 초기화
        $detectingIndicator.addClass("d-none");
        setDetectingState(false);
    }

    function getSelectedDetectType() {
        const selected = $("input[name='detect-type']:checked").val();
        return selected || "road";
    }

    function getValidPercent($input, fallbackValue) {
        if (!$input || $input.length === 0) {
            return fallbackValue;
        }

        const parsed = parseFloat($input.val());
        const normalized = Number.isNaN(parsed) ? fallbackValue : parsed;
        const clamped = Math.min(95, Math.max(5, normalized));
        if (String(clamped) !== String($input.val())) {
            $input.val(clamped);
        }
        return clamped;
    }

    function getConfidenceValue() {
        const detectType = getSelectedDetectType();
        return detectType === "pothole"
            ? getValidPercent($defaultConfidencePothole, FALLBACK_POTHOLE_CONFIDENCE_PERCENT) / 100
            : getValidPercent($defaultConfidenceOthers, FALLBACK_DEFAULT_CONFIDENCE_PERCENT) / 100;
    }

    function normalizePath(pathValue) {
        return String(pathValue || "")
            .trim()
            .replace(/\\/g, "/")
            .replace(/^\/+/, "");
    }

    function encodePathForRoute(pathValue) {
        return normalizePath(pathValue)
            .split("/")
            .filter(function (segment) {
                return segment.length > 0;
            })
            .map(function (segment) {
                return encodeURIComponent(segment);
            })
            .join("/");
    }

    function buildImageUrl(fileName) {
        return "/fast/image/" + encodePathForRoute(fileName) + "?t=" + Date.now();
    }

    function buildRoadDetectUrl(fileName) {
        return "/fast/road_detect/" + encodePathForRoute(fileName);
    }

    function buildRoadRoiUrl(fileName) {
        return "/fast/road_roi/" + encodePathForRoute(fileName);
    }

    function buildRoadDetectStreamUrl(fileName, detectType) {
        const base = "/fast/road_detect_stream/" + encodePathForRoute(fileName);
        const query = $.param({ detect_type: detectType || "road", t: Date.now() });
        return base + "?" + query;
    }

    function buildRoadDetectStreamInitUrl(fileName, detectType) {
        const base = "/fast/road_detect_stream_init/" + encodePathForRoute(fileName);
        const query = $.param({ detect_type: detectType || "road" });
        return base + "?" + query;
    }

    function buildRoadDetectStreamNextUrl(fileName) {
        return "/fast/road_detect_stream_next/" + encodePathForRoute(fileName);
    }

    function buildRoadDetectStreamSeekUrl(fileName, frameNumber) {
        const base = "/fast/road_detect_stream_seek/" + encodePathForRoute(fileName);
        return base + "?" + $.param({ frame_number: frameNumber });
    }

    function buildRoadDetectStreamCleanupUrl(fileName) {
        return "/fast/road_detect_stream_cleanup/" + encodePathForRoute(fileName);
    }

    function buildCameraDevicesUrl() {
        return "/fast/camera/devices";
    }

    function buildCameraDetectStreamInitUrl(cameraIndex, detectType) {
        return "/fast/camera_detect_stream_init?" + $.param({
            camera_index: cameraIndex,
            detect_type: detectType || "road",
        });
    }

    function buildCameraDetectStreamNextUrl(sessionId) {
        return "/fast/camera_detect_stream_next/" + encodeURIComponent(sessionId);
    }

    function buildCameraDetectStreamCleanupUrl(sessionId) {
        return "/fast/camera_detect_stream_cleanup/" + encodeURIComponent(sessionId);
    }

    function getActiveOriginalMediaElement() {
        if ($uploadedVideoPreview.length > 0 && !$uploadedVideoPreview.hasClass("d-none") && $uploadedVideoPreview[0].src) {
            return $uploadedVideoPreview[0];
        }

        if ($uploadedImagePreview.length > 0 && !$uploadedImagePreview.hasClass("d-none") && $uploadedImagePreview[0].src) {
            return $uploadedImagePreview[0];
        }

        return null;
    }

    function getActiveOriginalMediaGeometry() {
        const mediaElement = getActiveOriginalMediaElement();
        if (!mediaElement || !currentRoiInfo || currentRoiInfo.width <= 0 || currentRoiInfo.height <= 0) {
            return null;
        }

        const displayWidth = mediaElement.clientWidth;
        const displayHeight = mediaElement.clientHeight;
        if (displayWidth <= 0 || displayHeight <= 0) {
            return null;
        }

        return {
            ratioX: displayWidth / currentRoiInfo.width,
            ratioY: displayHeight / currentRoiInfo.height,
            scaleX: currentRoiInfo.width / displayWidth,
            scaleY: currentRoiInfo.height / displayHeight,
        };
    }

    function clampDraftRoi(roi) {
        if (!currentRoiInfo) {
            return cloneRoi(roi);
        }

        const width = currentRoiInfo.width;
        const height = currentRoiInfo.height;
        const minWidth = Math.min(MIN_ROI_SIZE, width);
        const minHeight = Math.min(MIN_ROI_SIZE, height);

        let x1 = Math.round(roi.x1);
        let y1 = Math.round(roi.y1);
        let x2 = Math.round(roi.x2);
        let y2 = Math.round(roi.y2);

        x1 = Math.max(0, Math.min(x1, width - 1));
        y1 = Math.max(0, Math.min(y1, height - 1));
        x2 = Math.max(x1 + minWidth, Math.min(x2, width));
        y2 = Math.max(y1 + minHeight, Math.min(y2, height));

        if (x2 > width) {
            x2 = width;
            x1 = Math.max(0, x2 - minWidth);
        }
        if (y2 > height) {
            y2 = height;
            y1 = Math.max(0, y2 - minHeight);
        }

        return { x1: x1, y1: y1, x2: x2, y2: y2 };
    }

    function syncRoiOverlay() {
        if (!currentRoiInfo || !draftRoiInfo) {
            $roiOverlay.addClass("d-none");
            updateRoiEditorButtons();
            return;
        }

        const geometry = getActiveOriginalMediaGeometry();
        if (!geometry) {
            $roiOverlay.addClass("d-none");
            return;
        }

        $roiSelection.css({
            left: (draftRoiInfo.x1 * geometry.ratioX) + "px",
            top: (draftRoiInfo.y1 * geometry.ratioY) + "px",
            width: (Math.max(1, draftRoiInfo.x2 - draftRoiInfo.x1) * geometry.ratioX) + "px",
            height: (Math.max(1, draftRoiInfo.y2 - draftRoiInfo.y1) * geometry.ratioY) + "px",
        });

        $roiOverlay.removeClass("d-none");
        updateRoiEditorButtons();
    }

    function loadRoiInfo(fileName) {
        if (!fileName) {
            clearRoiEditor();
            return;
        }

        const requestToken = ++roiRequestToken;
        setRoiStatus("ROI 정보를 불러오는 중...", "muted");

        $.ajax({
            url: buildRoadRoiUrl(fileName),
            method: "GET"
        }).done(function (result) {
            if (requestToken !== roiRequestToken) {
                return;
            }

            currentRoiInfo = {
                width: Number(result.width) || 0,
                height: Number(result.height) || 0,
                roiFile: result.roi_file || "",
                roi: cloneRoi(result.roi),
            };
            draftRoiInfo = cloneRoi(result.roi);
            syncRoiOverlay();
            setRoiStatus("ROI를 수정할 수 있습니다.", "muted");
        }).fail(function (jqXHR) {
            if (requestToken !== roiRequestToken) {
                return;
            }

            console.error("ROI load error:", jqXHR.status, jqXHR.responseText);
            clearRoiEditor();
            setRoiStatus("ROI 정보를 불러오지 못했습니다.", "danger");
        });
    }

    function displayOriginalMedia(fileName) {
        const normalizedFileName = normalizePath(fileName);
        const mediaUrl = buildImageUrl(normalizedFileName);
        showMediaPreview(mediaUrl, isVideoPath(normalizedFileName), $uploadedImagePreview, $uploadedVideoPreview);
        updateDetectedStreamControls();
        loadRoiInfo(normalizedFileName);
    }

    function showDetectedTabAndRunDetect(delayMs) {
        if (sampleDetectTimer) {
            clearTimeout(sampleDetectTimer);
        }

        sampleDetectTimer = setTimeout(function () {
            if ($detectedImageTab.length > 0 && typeof bootstrap !== "undefined" && bootstrap.Tab) {
                bootstrap.Tab.getOrCreateInstance($detectedImageTab[0]).show();
            }
            runDetect();
            sampleDetectTimer = null;
        }, delayMs);
    }

    function cleanupAllFrameStreams() {
        // 모든 활성 스트리밍 세션 타이머 즉시 정리
        Object.keys(frameTimerMap).forEach(function (fileName) {
            clearTimeout(frameTimerMap[fileName]);
            delete frameTimerMap[fileName];
        });

        // 모든 세션 isPlaying 중단 (진행 중인 루프 차단)
        Object.keys(frameStreamState).forEach(function (fileName) {
            if (frameStreamState[fileName]) {
                frameStreamState[fileName].isPlaying = false;
            }
        });

        // 서버 세션 정리 (비동기, UI와 무관)
        Object.keys(frameStreamState).forEach(function (fileName) {
            $.ajax({
                url: buildRoadDetectStreamCleanupUrl(fileName),
                method: "POST",
                timeout: 3000
            }).fail(function () {
                console.warn("Failed to cleanup stream session:", fileName);
            });
        });

        frameStreamState = {};  // 로컬 상태 완전 초기화
        updateDetectedStreamControls();
    }

    function stopCameraLiveStream() {
        if (cameraStreamTimer) {
            clearTimeout(cameraStreamTimer);
            cameraStreamTimer = null;
        }

        const previousSessionId = cameraStreamState && cameraStreamState.sessionId
            ? cameraStreamState.sessionId
            : null;

        cameraStreamState = null;
        updateCameraLiveBadges();

        if (!previousSessionId) {
            return;
        }

        $.ajax({
            url: buildCameraDetectStreamCleanupUrl(previousSessionId),
            method: "POST",
            timeout: 3000,
        }).fail(function () {
            console.warn("Failed to cleanup camera stream session:", previousSessionId);
        });
    }

    function playCameraLiveStream() {
        if (!cameraStreamState || !cameraStreamState.sessionId || !cameraStreamState.isPlaying) {
            return;
        }

        const sessionId = cameraStreamState.sessionId;
        $.ajax({
            url: buildCameraDetectStreamNextUrl(sessionId),
            method: "GET",
        }).done(function (result) {
            if (!cameraStreamState || cameraStreamState.sessionId !== sessionId || !cameraStreamState.isPlaying) {
                return;
            }

            if (!result || !result.frame_original || !result.frame_detected) {
                showUploadStatusMessage("카메라 프레임을 가져오지 못했습니다.", false);
                setDetectingState(false);
                $detectingIndicator.addClass("d-none");
                stopCameraLiveStream();
                return;
            }

            $uploadedVideoPreview.addClass("d-none");
            $uploadedImagePreview
                .attr("src", "data:image/jpeg;base64," + result.frame_original)
                .removeClass("d-none");

            $detectedVideoPreview.addClass("d-none");
            $detectedImagePreview
                .attr("src", "data:image/jpeg;base64," + result.frame_detected)
                .removeClass("d-none");

            showUploadStatusMessage("카메라 실시간 검출 중... (" + String(result.frame_number || 0) + ")", true);

            const fps = Number(result.fps || cameraStreamState.fps || 20);
            const frameDelay = fps > 0 ? (1000 / fps) : 50;
            cameraStreamTimer = setTimeout(function () {
                playCameraLiveStream();
            }, frameDelay);
        }).fail(function (jqXHR) {
            console.error("Camera stream next error:", jqXHR.status, jqXHR.responseText);
            showUploadStatusMessage("카메라 프레임 수신에 실패했습니다.", false);
            setDetectingState(false);
            $detectingIndicator.addClass("d-none");
            stopCameraLiveStream();
        });
    }

    function startCameraLiveStream(cameraIndex, cameraName) {
        stopCameraLiveStream();
        cleanupAllFrameStreams();

        uploadedFileName = "";
        previousFileName = "";
        clearRoiEditor();
        updateDetectedStreamControls();

        hideImageAndVideo($uploadedImagePreview, $uploadedVideoPreview);
        hideImageAndVideo($detectedImagePreview, $detectedVideoPreview);

        setDetectingState(true);
        $detectingIndicator.removeClass("d-none");
        showUploadStatusMessage("카메라 장치를 여는 중...", true);

        const detectType = getSelectedDetectType();
        $.ajax({
            url: buildCameraDetectStreamInitUrl(cameraIndex, detectType),
            method: "POST",
        }).done(function (result) {
            cameraStreamState = {
                sessionId: String(result.session_id || ""),
                cameraIndex: Number(result.camera_index || cameraIndex),
                cameraName: String(cameraName || ("Camera " + cameraIndex)),
                detectType: detectType,
                fps: Number(result.fps || 20),
                isPlaying: true,
            };
            updateCameraLiveBadges();

            if ($detectedImageTab.length > 0 && typeof bootstrap !== "undefined" && bootstrap.Tab) {
                bootstrap.Tab.getOrCreateInstance($detectedImageTab[0]).show();
            }

            showUploadStatusMessage(cameraStreamState.cameraName + " 실시간 검출을 시작합니다.", true);
            playCameraLiveStream();
        }).fail(function (jqXHR) {
            console.error("Camera stream init error:", jqXHR.status, jqXHR.responseText);
            showUploadStatusMessage("카메라 스트림 초기화에 실패했습니다.", false);
            setDetectingState(false);
            $detectingIndicator.addClass("d-none");
            stopCameraLiveStream();
        });
    }

    function stopActiveFrameProcessing() {
        const activeStreamFileNames = Object.keys(frameStreamState).filter(function (fileName) {
            return frameStreamState[fileName] && frameStreamState[fileName].isPlaying;
        });

        if (activeStreamFileNames.length === 0) {
            return false;
        }

        cleanupAllFrameStreams();
        setDetectingState(false);
        $detectingIndicator.addClass("d-none");
        showUploadStatusMessage("프레임 처리를 중지했습니다.", true);
        return true;
    }

    function pauseFrameStream(fileName) {
        const state = frameStreamState[fileName];
        if (!state) {
            return;
        }

        state.isPlaying = false;
        state.isPaused = true;
        if (frameTimerMap[fileName]) {
            clearTimeout(frameTimerMap[fileName]);
            delete frameTimerMap[fileName];
        }
        setDetectingState(false);
        $detectingIndicator.addClass("d-none");
        updateDetectedStreamControls();
        showUploadStatusMessage("프레임 출력을 멈췄습니다.", true);
    }

    function resumeFrameStream(fileName) {
        const state = frameStreamState[fileName];
        if (!state) {
            return;
        }

        state.isPlaying = true;
        state.isPaused = false;
        setDetectingState(true);
        $detectingIndicator.removeClass("d-none");
        updateDetectedStreamControls();
        playFrameStream(fileName);
    }

    function seekFrameStream(fileName, frameNumber) {
        const state = frameStreamState[fileName];
        if (!state) {
            return;
        }

        const targetFrame = Math.max(1, Math.min(parseInt(frameNumber, 10) || 1, Number(state.totalFrames || 1)));
        if (frameTimerMap[fileName]) {
            clearTimeout(frameTimerMap[fileName]);
            delete frameTimerMap[fileName];
        }

        state.isPlaying = false;
        state.isPaused = true;
        updateDetectedStreamControls();
        setDetectingState(true);
        $detectingIndicator.removeClass("d-none");

        $.ajax({
            url: buildRoadDetectStreamSeekUrl(fileName, targetFrame),
            method: "POST"
        }).done(function (result) {
            const currentState = frameStreamState[fileName];
            if (!currentState) {
                return;
            }

            currentState.frameIndex = Number(result.frame_number || targetFrame) - 1;
            currentState.totalFrames = Number(result.total_frames || currentState.totalFrames || 0);
            currentState.isPlaying = false;
            currentState.isPaused = true;
            showUploadStatusMessage(String(result.frame_number || targetFrame) + " 번째 프레임으로 이동하였습니다.", true);
            updateDetectedStreamControls();
            playFrameStream(fileName, { singleStep: true });
        }).fail(function (jqXHR) {
            console.error("Stream seek error:", jqXHR.status, jqXHR.responseText);
            showUploadStatusMessage("프레임 이동에 실패했습니다.", false);
            setDetectingState(false);
            $detectingIndicator.addClass("d-none");
            updateDetectedStreamControls();
        });
    }

    function saveRoiInfo() {
        if (!uploadedFileName || !draftRoiInfo) {
            return;
        }

        if (currentRoiInfo && sameRoi(currentRoiInfo.roi, draftRoiInfo)) {
            return;
        }

        setRoiStatus("ROI 저장 중...", "muted");

        $.ajax({
            url: buildRoadRoiUrl(uploadedFileName),
            method: "POST",
            data: JSON.stringify({ roi: draftRoiInfo }),
            contentType: "application/json"
        }).done(function (result) {
            currentRoiInfo = {
                width: Number(result.width) || 0,
                height: Number(result.height) || 0,
                roiFile: result.roi_file || "",
                roi: cloneRoi(result.roi),
            };
            draftRoiInfo = cloneRoi(result.roi);
            syncRoiOverlay();
            setRoiStatus("ROI가 저장되었습니다. 검출 탭을 클릭하면 반영됩니다.", "success");
        }).fail(function (jqXHR) {
            console.error("ROI save error:", jqXHR.status, jqXHR.responseText);
            setRoiStatus("ROI 저장에 실패했습니다.", "danger");
        });
    }

    function startRoiInteraction(event) {
        if (!draftRoiInfo || !currentRoiInfo) {
            return;
        }

        const handle = $(event.target).data("handle") || "move";
        const isSelectionTarget = event.target === $roiSelection[0] || $.contains($roiSelection[0], event.target);
        if (!isSelectionTarget) {
            return;
        }

        roiInteraction = {
            handle: handle,
            startX: event.clientX,
            startY: event.clientY,
            startRoi: cloneRoi(draftRoiInfo),
        };

        event.preventDefault();
    }

    function updateRoiInteraction(event) {
        if (!roiInteraction || !currentRoiInfo) {
            return;
        }

        const geometry = getActiveOriginalMediaGeometry();
        if (!geometry) {
            return;
        }

        const deltaX = Math.round((event.clientX - roiInteraction.startX) * geometry.scaleX);
        const deltaY = Math.round((event.clientY - roiInteraction.startY) * geometry.scaleY);
        const startRoi = roiInteraction.startRoi;
        const roiWidth = startRoi.x2 - startRoi.x1;
        const roiHeight = startRoi.y2 - startRoi.y1;
        let nextRoi = cloneRoi(startRoi);

        if (roiInteraction.handle === "move") {
            const maxX = Math.max(0, currentRoiInfo.width - roiWidth);
            const maxY = Math.max(0, currentRoiInfo.height - roiHeight);
            nextRoi.x1 = Math.max(0, Math.min(startRoi.x1 + deltaX, maxX));
            nextRoi.y1 = Math.max(0, Math.min(startRoi.y1 + deltaY, maxY));
            nextRoi.x2 = nextRoi.x1 + roiWidth;
            nextRoi.y2 = nextRoi.y1 + roiHeight;
        } else if (roiInteraction.handle === "nw") {
            nextRoi.x1 = startRoi.x1 + deltaX;
            nextRoi.y1 = startRoi.y1 + deltaY;
        } else if (roiInteraction.handle === "ne") {
            nextRoi.x2 = startRoi.x2 + deltaX;
            nextRoi.y1 = startRoi.y1 + deltaY;
        } else if (roiInteraction.handle === "sw") {
            nextRoi.x1 = startRoi.x1 + deltaX;
            nextRoi.y2 = startRoi.y2 + deltaY;
        } else if (roiInteraction.handle === "se") {
            nextRoi.x2 = startRoi.x2 + deltaX;
            nextRoi.y2 = startRoi.y2 + deltaY;
        }

        draftRoiInfo = clampDraftRoi(nextRoi);
        syncRoiOverlay();
        setRoiStatus("ROI를 수정했습니다. 저장하면 검출에 반영됩니다.", "muted");
    }

    function endRoiInteraction() {
        if (!roiInteraction) {
            return;
        }

        const changed = currentRoiInfo && !sameRoi(currentRoiInfo.roi, draftRoiInfo);
        roiInteraction = null;
        updateRoiEditorButtons();

        if (changed) {
            saveRoiInfo();
        }
    }

    function uploadSelectedImage(file) {
        if (!file) {
            return;
        }

        // 파일 업로드를 시작하면 샘플 선택 하이라이트는 해제
        clearSampleSelection();

        // 1단계: UI 즉시 초기화
        resetPreviewImages();
        showUploadStatusMessage("", false);
        $uploadStatusMessage.addClass("d-none");

        // 2단계: 모든 이전 스트리밍 세션 정리 (서버 포함)
        cleanupAllFrameStreams();

        // 3단계: 업로드 진행
        prepareUploadFile(file).then(function (uploadFile) {
            const formData = new FormData();
            formData.append("file", uploadFile, uploadFile.name || file.name);

            showUploadStatusMessage("", true);
            $uploadStatusMessage.addClass("d-none");
            setUploadingState(true);

            $.ajax({
                url: "/fast/upload_image",
                method: "POST",
                data: formData,
                processData: false,
                contentType: false
            }).done(function (result) {
                console.log(result.filename);
                if (result && result.filename) {
                    previousFileName = uploadedFileName;  // 이전 파일명 저장
                    uploadedFileName = result.filename;    // 새 파일명 설정
                    displayOriginalMedia(result.filename);

                    if ($detectedImageTab.length > 0 && typeof bootstrap !== "undefined" && bootstrap.Tab) {
                        bootstrap.Tab.getOrCreateInstance($detectedImageTab[0]).show();
                    }
                }
                showUploadStatusMessage("업로드가 완료되었습니다.", true);
                setTimeout(function () {
                    runDetect();
                }, DETECT_AFTER_UPLOAD_DELAY_MS);
            }).fail(function (jqXHR) {
                console.error("Image upload error:", jqXHR.status, jqXHR.responseText);
                showUploadStatusMessage("업로드에 실패했습니다.", false);
            }).always(function () {
                setUploadingState(false);
            });
        }).catch(function (error) {
            console.error("Image preprocess error:", error);
            showUploadStatusMessage("업로드 준비 중 오류가 발생했습니다.", false);
            setUploadingState(false);
        });
    }

    function prepareUploadFile(file) {
        const maxUploadBytes = 900 * 1024;
        const compressibleTypes = ["image/jpeg", "image/png", "image/webp"];

        if (file.size <= maxUploadBytes || compressibleTypes.indexOf(file.type) === -1) {
            return Promise.resolve(file);
        }

        return resizeAndCompressImage(file, maxUploadBytes);
    }

    function resizeAndCompressImage(file, targetBytes) {
        return new Promise(function (resolve, reject) {
            const reader = new FileReader();

            reader.onload = function (loadEvent) {
                const img = new Image();

                img.onload = function () {
                    const canvas = document.createElement("canvas");
                    let width = img.width;
                    let height = img.height;
                    const maxDimension = 1920;

                    if (Math.max(width, height) > maxDimension) {
                        const ratio = maxDimension / Math.max(width, height);
                        width = Math.floor(width * ratio);
                        height = Math.floor(height * ratio);
                    }

                    canvas.width = width;
                    canvas.height = height;

                    const ctx = canvas.getContext("2d");
                    if (!ctx) {
                        reject(new Error("Canvas context is unavailable"));
                        return;
                    }

                    ctx.drawImage(img, 0, 0, width, height);

                    let quality = 0.9;

                    function exportBlob() {
                        canvas.toBlob(function (blob) {
                            if (!blob) {
                                reject(new Error("Image compression failed"));
                                return;
                            }

                            if (blob.size <= targetBytes || quality <= 0.5) {
                                const optimizedFile = new File([blob], file.name, { type: "image/jpeg" });
                                resolve(optimizedFile);
                                return;
                            }

                            quality -= 0.1;
                            exportBlob();
                        }, "image/jpeg", quality);
                    }

                    exportBlob();
                };

                img.onerror = function () {
                    reject(new Error("Image load failed"));
                };

                img.src = loadEvent.target ? loadEvent.target.result : "";
            };

            reader.onerror = function () {
                reject(new Error("File read failed"));
            };

            reader.readAsDataURL(file);
        });
    }

    // 네이티브 이벤트 핸들러로 드래그 앤 드롭 처리
    const dropZoneElement = document.getElementById("image-drop-zone");
    const fileInputElement = document.getElementById("road-image-input");

    if (dropZoneElement && fileInputElement) {
        // 1. Document 레벨: 브라우저 기본 동작 방지
        document.addEventListener("dragenter", function (e) {
            e.preventDefault();
            e.stopPropagation();
        }, false);

        document.addEventListener("dragover", function (e) {
            e.preventDefault();
            e.stopPropagation();
        }, false);

        document.addEventListener("dragleave", function (e) {
            e.preventDefault();
            e.stopPropagation();
        }, false);

        document.addEventListener("drop", function (e) {
            e.preventDefault();
            e.stopPropagation();
        }, false);

        // 2. DropZone: 시각적 효과
        dropZoneElement.addEventListener("dragenter", function (e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.add("drag-over");
        }, false);

        dropZoneElement.addEventListener("dragover", function (e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.add("drag-over");
        }, false);

        dropZoneElement.addEventListener("dragleave", function (e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.remove("drag-over");
        }, false);

        dropZoneElement.addEventListener("drop", function (e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.remove("drag-over");

            const files = e.dataTransfer.files;
            if (!files || files.length === 0) {
                return;
            }

            const file = files[0];
            const fileName = file.name.toLowerCase();
            const isImage = file.type.startsWith("image/") || /\.(jpg|jpeg|png|bmp|webp)$/i.test(fileName);
            const isVideo = file.type.startsWith("video/") || /\.(mp4|m4v|mov|avi|mkv|webm|wmv)$/i.test(fileName);

            if (!isImage && !isVideo) {
                if ($selectedFileLabel.length > 0) {
                    $selectedFileLabel.text("이미지/동영상 파일만 업로드할 수 있습니다.");
                }
                return;
            }

            updateSelectedFile(file);
            uploadSelectedImage(file);
        }, false);

        // 3. DropZone: 클릭으로 파일 선택
        dropZoneElement.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            fileInputElement.click();
        }, false);

        // 4. File Input: 변경 감지
        fileInputElement.addEventListener("change", function (e) {
            const files = this.files;
            const file = files && files[0] ? files[0] : null;
            updateSelectedFile(file);
            uploadSelectedImage(file);
        }, false);
    }

    function initFrameStream(fileName, detectType) {
        // 이미 활성인 세션이 있으면 정리
        if (frameStreamState[fileName]) {
            if (frameTimerMap[fileName]) {
                clearTimeout(frameTimerMap[fileName]);
                delete frameTimerMap[fileName];
            }
            delete frameStreamState[fileName];
        }

        $.ajax({
            url: buildRoadDetectStreamInitUrl(fileName, detectType),
            method: "POST"
        }).done(function (result) {
            console.log("Stream initialized:", result);
            frameStreamState[fileName] = {
                sessionId: result.session_id,
                totalFrames: result.total_frames,
                fps: result.fps,
                detectType: detectType,
                frameIndex: 0,
                isPlaying: true,
                isPaused: false
            };
            updateDetectedStreamControls();
            playFrameStream(fileName);
        }).fail(function (jqXHR) {
            console.error("Stream init error:", jqXHR.status, jqXHR.responseText);
            showUploadStatusMessage("프레임 스트림 초기화에 실패했습니다.", false);
            setDetectingState(false);
            $detectingIndicator.addClass("d-none");
            updateDetectedStreamControls();
        });
    }

    function playFrameStream(fileName, options) {
        const playbackOptions = options || {};
        const state = frameStreamState[fileName];
        if (!state) {
            return;
        }

        if (!state.isPlaying && !playbackOptions.singleStep) {
            return;
        }

        $.ajax({
            url: buildRoadDetectStreamNextUrl(fileName),
            method: "GET"
        }).done(function (result) {
            // 응답 도착 시점에 세션이 이미 정리되었으면 중단
            const currentState = frameStreamState[fileName];
            if (!currentState) {
                return;
            }

            if (!currentState.isPlaying && !playbackOptions.singleStep) {
                return;
            }

            if (!result.frame) {
                // 마지막 프레임
                showUploadStatusMessage(
                    "프레임 스트리밍 완료 (" + currentState.frameIndex + "/" + currentState.totalFrames + ")",
                    true
                );
                cleanupFrameStream(fileName);
                return;
            }

            // 이미지 태그에 프레임 표시
            $detectedVideoPreview.addClass("d-none");
            $detectedImagePreview
                .attr("src", "data:image/jpeg;base64," + result.frame)
                .removeClass("d-none");

            currentState.frameIndex = result.frame_number;
            currentState.totalFrames = result.total_frames;
            showUploadStatusMessage(
                "프레임 처리 중... (" + result.frame_number + "/" + currentState.totalFrames + ")",
                true
            );
            updateDetectedStreamControls();

            // 다음 프레임을 위한 타이머 설정
            if (playbackOptions.singleStep) {
                currentState.isPlaying = false;
                currentState.isPaused = true;
                updateDetectedStreamControls();
                setDetectingState(false);
                $detectingIndicator.addClass("d-none");
                if (playbackOptions.autoResume) {
                    resumeFrameStream(fileName);
                }
                return;
            }

            if (result.has_next && currentState.isPlaying) {
                const frameDelay = currentState.fps > 0 ? 1000 / currentState.fps : 33;
                if (frameTimerMap[fileName]) {
                    clearTimeout(frameTimerMap[fileName]);
                }
                frameTimerMap[fileName] = setTimeout(function () {
                    playFrameStream(fileName);
                }, frameDelay);
            } else {
                // 마지막 프레임
                showUploadStatusMessage(
                    "프레임 스트리밍 완료 (" + currentState.frameIndex + "/" + currentState.totalFrames + ")",
                    true
                );
                cleanupFrameStream(fileName);
            }
        }).fail(function (jqXHR) {
            console.error("Stream next error:", jqXHR.status, jqXHR.responseText);
            showUploadStatusMessage("프레임 수신에 실패했습니다.", false);
            cleanupFrameStream(fileName);
        });
    }

    function cleanupFrameStream(fileName) {
        // 로컬 정리 먼저 (AJAX 실패시도 정리)
        if (frameTimerMap[fileName]) {
            clearTimeout(frameTimerMap[fileName]);
            delete frameTimerMap[fileName];
        }
        delete frameStreamState[fileName];
        updateDetectedStreamControls();
        
        // UI 상태 업데이트
        setDetectingState(false);
        $detectingIndicator.addClass("d-none");
        
        // 서버에 정리 신호
        $.ajax({
            url: buildRoadDetectStreamCleanupUrl(fileName),
            method: "POST",
            timeout: 3000
        }).done(function (result) {
            console.log("Stream cleaned up:", result);
        }).fail(function (jqXHR) {
            console.error("Stream cleanup error:", jqXHR.status, jqXHR.responseText);
        });
    }

    function runDetect() {
        if (!uploadedFileName) {
            return;
        }

        const detectType = getSelectedDetectType();
        showUploadStatusMessage("도로 검출 중...", true);
        hideImageAndVideo($detectedImagePreview, $detectedVideoPreview);
        setDetectingState(true);
        $detectingIndicator.removeClass("d-none");

        if (isVideoPath(uploadedFileName)) {
            // 모든 이전 스트리밍 세션 정리
            cleanupAllFrameStreams();
            // 비디오: 프레임별 스트리밍 시작
            initFrameStream(uploadedFileName, detectType);
            return;
        }

        // 이미지: 기존 로직
        $.ajax({
            url: buildRoadDetectUrl(uploadedFileName),
            data: { detect_type: detectType },
            method: "GET"
        }).done(function (result) {
            if (result && result.image_url) {
                const detectedMediaUrl = result.image_url + "?t=" + Date.now();
                showMediaPreview(detectedMediaUrl, isVideoPath(result.image_url), $detectedImagePreview, $detectedVideoPreview);
                showUploadStatusMessage("검출 이미지가 생성되었습니다.", true);
            } else {
                showUploadStatusMessage("검출 결과를 받지 못했습니다.", false);
            }
        }).fail(function (jqXHR) {
            console.error("Detect road error:", jqXHR.status, jqXHR.responseText);
            showUploadStatusMessage("도로 검출에 실패했습니다.", false);
        }).always(function () {
            setDetectingState(false);
            $detectingIndicator.addClass("d-none");
        });
    }

    function renderSampleImageThumbnails(fileNames) {
        if ($sampleImagePane.length === 0) {
            return;
        }

        if (!Array.isArray(fileNames) || fileNames.length === 0) {
            $sampleImagePane.html('<div class="text-muted text-center py-3">샘플 영상이 없습니다.</div>');
            return;
        }

        const $scrollContainer = $('<div class="sample-thumbnail-scroll"></div>');
        const $track = $('<div class="sample-thumbnail-track"></div>');

        fileNames.forEach(function (fileName) {
            const safeFileName = normalizePath(fileName);
            const imageUrl = buildImageUrl(safeFileName);
            const label = safeFileName.split("/").pop() || safeFileName;

            if (!sampleImageItemTemplate || !sampleImageItemTemplate.content) {
                return;
            }

            const node = sampleImageItemTemplate.content.firstElementChild.cloneNode(true);
            const button = node.querySelector(".sample-image-item");
            const image = node.querySelector("img");
            const caption = node.querySelector(".small");

            if (button) {
                button.setAttribute("data-file-name", safeFileName);
            }
            if (image) {
                image.setAttribute("src", imageUrl);
                image.setAttribute("alt", label);
            }
            if (caption) {
                caption.setAttribute("title", safeFileName);
                caption.textContent = label;
            }

            $track.append(node);
        });

        $scrollContainer.append($track);
        $sampleImagePane.empty().append($scrollContainer);
    }

    function loadSampleImages() {
        if ($sampleImagePane.length === 0) {
            return;
        }

        if (isSampleImagesLoading || isSampleImagesLoaded) {
            return;
        }

        isSampleImagesLoading = true;

        $sampleImagePane.html('<div class="text-muted text-center py-3">샘플 영상을 불러오는 중...</div>');

        $.ajax({
            url: "/fast/samples/image",
            method: "GET"
        }).done(function (result) {
            const fileNames = Array.isArray(result)
                ? result
                : (result && Array.isArray(result.image_files) ? result.image_files : []);
            renderSampleImageThumbnails(fileNames);
            isSampleImagesLoaded = true;
        }).fail(function (jqXHR) {
            console.error("Sample image list error:", jqXHR.status, jqXHR.responseText);
            $sampleImagePane.html('<div class="text-danger text-center py-3">샘플 영상을 불러오지 못했습니다.</div>');
        }).always(function () {
            isSampleImagesLoading = false;
        });
    }

    function ensureSampleImagesLoaded() {
        if (!isSampleImagesLoaded) {
            loadSampleImages();
        }
    }

    function renderSampleVideoThumbnails(fileNames) {
        if ($sampleVideoPane.length === 0) {
            return;
        }

        if (!Array.isArray(fileNames) || fileNames.length === 0) {
            $sampleVideoPane.html('<div class="text-muted text-center py-3">샘플 동영상이 없습니다.</div>');
            return;
        }

        const $scrollContainer = $('<div class="sample-thumbnail-scroll"></div>');
        const $track = $('<div class="sample-thumbnail-track"></div>');

        fileNames.forEach(function (fileName) {
            const safeFileName = normalizePath(fileName);
            const videoUrl = buildImageUrl(safeFileName);
            const label = safeFileName.split("/").pop() || safeFileName;

            if (!sampleVideoItemTemplate || !sampleVideoItemTemplate.content) {
                return;
            }

            const node = sampleVideoItemTemplate.content.firstElementChild.cloneNode(true);
            const button = node.querySelector(".sample-video-item");
            const video = node.querySelector("video");
            const caption = node.querySelector(".small");

            if (button) {
                button.setAttribute("data-file-name", safeFileName);
            }
            if (video) {
                video.setAttribute("src", videoUrl);
            }
            if (caption) {
                caption.setAttribute("title", safeFileName);
                caption.textContent = label;
            }

            $track.append(node);
        });

        $scrollContainer.append($track);
        $sampleVideoPane.empty().append($scrollContainer);
    }

    function loadSampleVideos() {
        if ($sampleVideoPane.length === 0) {
            return;
        }

        if (isSampleVideosLoading || isSampleVideosLoaded) {
            return;
        }

        isSampleVideosLoading = true;

        $sampleVideoPane.html('<div class="text-muted text-center py-3">샘플 동영상을 불러오는 중...</div>');

        $.ajax({
            url: "/fast/samples/video",
            method: "GET"
        }).done(function (result) {
            const fileNames = Array.isArray(result)
                ? result
                : (result && Array.isArray(result.image_files) ? result.image_files : []);
            renderSampleVideoThumbnails(fileNames);
            isSampleVideosLoaded = true;
        }).fail(function (jqXHR) {
            console.error("Sample video list error:", jqXHR.status, jqXHR.responseText);
            $sampleVideoPane.html('<div class="text-danger text-center py-3">샘플 동영상을 불러오지 못했습니다.</div>');
        }).always(function () {
            isSampleVideosLoading = false;
        });
    }

    function ensureSampleVideosLoaded() {
        if (!isSampleVideosLoaded) {
            loadSampleVideos();
        }
    }

    function renderCameraDevices(devices) {
        if ($cameraDeviceList.length === 0) {
            return;
        }

        if (!Array.isArray(devices) || devices.length === 0) {
            $cameraDeviceList.html('<div class="text-muted text-center py-3">열 수 있는 카메라 장치가 없습니다.</div>');
            return;
        }

        const itemHtml = devices.map(function (device) {
            const index = Number(device.index);
            const name = String(device.name || ("Camera " + index));
            const width = Number(device.width || 0);
            const height = Number(device.height || 0);
            const fps = Number(device.fps || 0);
            const detailParts = [];
            if (width > 0 && height > 0) {
                detailParts.push(width + "x" + height);
            }
            if (fps > 0) {
                detailParts.push(fps.toFixed(1) + " fps");
            }

            const detail = detailParts.join(" / ") || "열림 확인";
            return '<button type="button" class="btn btn-light border rounded px-3 py-2 flex-shrink-0 camera-device-item" data-camera-index="' + index + '" data-camera-name="' + $("<div>").text(name).html() + '">'
                + '<div class="d-flex align-items-center gap-2">'
                + '<span class="badge text-bg-secondary rounded-pill">#' + index + '</span>'
                + '<span class="fw-semibold">' + $("<div>").text(name).html() + '</span>'
                + '<span class="small text-muted">' + detail + '</span>'
                + '</div>'
                + '</button>';
        }).join("");

        const html = '<div class="d-flex flex-nowrap gap-2 overflow-auto py-1">' + itemHtml + '</div>';
        $cameraDeviceList.html(html);
    }

    function loadCameraDevices(forceReload) {
        if ($cameraDeviceList.length === 0) {
            return;
        }

        if (isCameraDevicesLoading) {
            return;
        }

        if (!forceReload && isCameraDevicesLoaded) {
            return;
        }

        isCameraDevicesLoading = true;
        $cameraDeviceList.html('<div class="text-muted text-center py-3">카메라 장치를 확인하는 중...</div>');

        $.ajax({
            url: buildCameraDevicesUrl(),
            method: "GET"
        }).done(function (result) {
            const devices = Array.isArray(result)
                ? result
                : (result && Array.isArray(result.devices) ? result.devices : []);
            renderCameraDevices(devices);
            isCameraDevicesLoaded = true;
        }).fail(function (jqXHR) {
            console.error("Camera device list error:", jqXHR.status, jqXHR.responseText);
            $cameraDeviceList.html('<div class="text-danger text-center py-3">카메라 장치 목록을 불러오지 못했습니다.</div>');
        }).always(function () {
            isCameraDevicesLoading = false;
        });
    }

    function ensureCameraDevicesLoaded() {
        if (!isCameraDevicesLoaded) {
            loadCameraDevices(false);
        }
    }

    function scheduleDetectUpdate() {
        if (!uploadedFileName) {
            return;
        }
        if (detectDebounceTimer) {
            clearTimeout(detectDebounceTimer);
        }
        detectDebounceTimer = setTimeout(function () {
            runDetect();
        }, 250);
    }

    $detectedImageTab.on("click", function () {
        if (cameraStreamState && cameraStreamState.isPlaying) {
            return;
        }

        if (!uploadedFileName) {
            showUploadStatusMessage("먼저 이미지를 업로드해 주세요.", false);
            return;
        }

        runDetect();
    });

    $detectedImageTab.on("shown.bs.tab", function () {
        updateDetectedStreamControls();
    });

    $detectTypeInputs.on("change", function () {
        scheduleDetectUpdate();
    });

    $sampleImagePane.on("click", ".sample-image-item", function () {
        const $selectedItem = $(this);
        const selectedFileName = $(this).data("file-name");
        if (!selectedFileName) {
            return;
        }

        markSampleSelection($selectedItem);

        if (sampleDetectTimer) {
            clearTimeout(sampleDetectTimer);
            sampleDetectTimer = null;
        }
        if (detectDebounceTimer) {
            clearTimeout(detectDebounceTimer);
            detectDebounceTimer = null;
        }

        stopCameraLiveStream();

        // 샘플 선택 전 현재 검출 출력/세션을 완전히 초기화
        cleanupAllFrameStreams();
        hideImageAndVideo($detectedImagePreview, $detectedVideoPreview);
        $detectedImagePreview.removeAttr("src");
        $detectedVideoPreview.removeAttr("src");
        if ($detectedVideoPreview.length > 0 && $detectedVideoPreview[0]) {
            try { $detectedVideoPreview[0].pause(); } catch (e) {}
            try { $detectedVideoPreview[0].removeAttribute("src"); } catch (e) {}
            try { $detectedVideoPreview[0].load(); } catch (e) {}
        }
        setDetectingState(false);
        $detectingIndicator.addClass("d-none");

        previousFileName = uploadedFileName;
        uploadedFileName = normalizePath(selectedFileName);
        displayOriginalMedia(uploadedFileName);
        showUploadStatusMessage("샘플 영상을 선택하였습니다. 잠시 후 검출합니다.", true);
        showDetectedTabAndRunDetect(DETECT_AFTER_UPLOAD_DELAY_MS);
    });

    $sampleVideoPane.on("click", ".sample-video-item", function () {
        const $selectedItem = $(this);
        const selectedFileName = $(this).data("file-name");
        if (!selectedFileName) {
            return;
        }

        markSampleSelection($selectedItem);

        if (sampleDetectTimer) {
            clearTimeout(sampleDetectTimer);
            sampleDetectTimer = null;
        }
        if (detectDebounceTimer) {
            clearTimeout(detectDebounceTimer);
            detectDebounceTimer = null;
        }

        stopCameraLiveStream();

        cleanupAllFrameStreams();
        hideImageAndVideo($detectedImagePreview, $detectedVideoPreview);
        $detectedImagePreview.removeAttr("src");
        $detectedVideoPreview.removeAttr("src");
        if ($detectedVideoPreview.length > 0 && $detectedVideoPreview[0]) {
            try { $detectedVideoPreview[0].pause(); } catch (e) {}
            try { $detectedVideoPreview[0].removeAttribute("src"); } catch (e) {}
            try { $detectedVideoPreview[0].load(); } catch (e) {}
        }
        setDetectingState(false);
        $detectingIndicator.addClass("d-none");

        previousFileName = uploadedFileName;
        uploadedFileName = normalizePath(selectedFileName);
        displayOriginalMedia(uploadedFileName);
        showUploadStatusMessage("샘플 동영상을 선택하였습니다. 잠시 후 검출합니다.", true);
        showDetectedTabAndRunDetect(DETECT_AFTER_UPLOAD_DELAY_MS);
    });

    $uploadedImagePreview.on("load", function () {
        syncRoiOverlay();
    });

    $uploadedVideoPreview.on("loadedmetadata loadeddata", function () {
        syncRoiOverlay();
    });

    $("#original-media-stage").on("click", function () {
        if (!uploadedFileName || !isVideoPath(uploadedFileName)) {
            return;
        }

        stopActiveFrameProcessing();
    });

    $(window).on("resize", function () {
        syncRoiOverlay();
    });

    $originalImageTab.on("click", function () {
        if (!cameraStreamState || !cameraStreamState.isPlaying) {
            return;
        }

        stopCameraLiveStream();
        setDetectingState(false);
        $detectingIndicator.addClass("d-none");
        showUploadStatusMessage("카메라 실시간 검출을 중지했습니다.", true);
    });

    $originalImageTab.on("shown.bs.tab", function () {
        if (uploadedFileName && isVideoPath(uploadedFileName)) {
            stopActiveFrameProcessing();
        }
        syncRoiOverlay();
        updateDetectedStreamControls();
    });

    $detectedStreamPauseButton.on("click", function () {
        if (!uploadedFileName) {
            return;
        }

        pauseFrameStream(uploadedFileName);
    });

    $detectedStreamResumeButton.on("click", function () {
        if (!uploadedFileName) {
            return;
        }

        resumeFrameStream(uploadedFileName);
    });

    $detectedStreamFrameInput.on("input", function () {
        $detectedStreamFrameValue.text(String($(this).val() || "1"));
    });

    $detectedStreamFrameInput.on("pointerdown mousedown touchstart", function () {
        if (!uploadedFileName) {
            return;
        }

        const state = frameStreamState[uploadedFileName];
        if (state && state.isPlaying && !state.isPaused) {
            pauseFrameStream(uploadedFileName);
        }
    });

    $detectedStreamFrameInput.on("change", function () {
        if (!uploadedFileName) {
            return;
        }

        seekFrameStream(uploadedFileName, $(this).val());
    });

    $roiOverlay.on("pointerdown", function (event) {
        startRoiInteraction(event);
    });

    $(document).on("pointermove.roiEditor", function (event) {
        updateRoiInteraction(event);
    });

    $(document).on("pointerup.roiEditor pointercancel.roiEditor", function () {
        endRoiInteraction();
    });

    $roiResetButton.on("click", function () {
        if (!currentRoiInfo || !currentRoiInfo.roi) {
            return;
        }

        draftRoiInfo = cloneRoi(currentRoiInfo.roi);
        syncRoiOverlay();
        setRoiStatus("저장된 ROI로 되돌렸습니다.", "muted");
    });

    $sampleImageTab.on("click", function () {
        ensureSampleImagesLoaded();
    });

    $sampleImageTab.on("shown.bs.tab", function () {
        ensureSampleImagesLoaded();
    });

    $sampleVideoTab.on("click", function () {
        ensureSampleVideosLoaded();
    });

    $sampleVideoTab.on("shown.bs.tab", function () {
        ensureSampleVideosLoaded();
    });

    $cameraPane.on("click", ".camera-device-item", function () {
        const $selectedItem = $(this);
        const cameraIndex = Number($selectedItem.data("camera-index"));
        const cameraName = String($selectedItem.data("camera-name") || ("Camera " + cameraIndex));
        if (!Number.isFinite(cameraIndex) || cameraIndex < 0) {
            showUploadStatusMessage("카메라 장치 정보가 올바르지 않습니다.", false);
            return;
        }

        $cameraPane.find(".camera-device-item.active").removeClass("active");
        $selectedItem.addClass("active");
        startCameraLiveStream(cameraIndex, cameraName);
    });

    $cameraTab.on("click", function () {
        loadCameraDevices(true);
    });

    $detectTypeInputs.on("change.cameraLive", function () {
        if (!cameraStreamState || !cameraStreamState.isPlaying) {
            return;
        }

        startCameraLiveStream(cameraStreamState.cameraIndex, cameraStreamState.cameraName);
    });

    updateCameraLiveBadges();
});
