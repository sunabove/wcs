(function () {
    const $overlay = $("#road-detect-overlay");
    const $closeButton = $("#road-detect-overlay-close");
    const $playToggleButton = $("#road-detect-overlay-play-toggle");
    const $loopToggleButton = $("#road-detect-overlay-loop-toggle");
    const $status = $("#road-detect-overlay-status");
    const $image = $("#road-detect-overlay-image");
    const $video = $("#road-detect-overlay-video");
    const $viewer = $("#vehicle-urdf-viewer");
    const VEHICLE_AUDIO_STORAGE_KEY = "wcs.vehicle.showAudio";
    const OVERLAY_MEDIA_HIDDEN_STORAGE_KEY = "wcs.status.overlay.media_hidden";
    const OVERLAY_AUTO_REPLAY_STORAGE_KEY = "wcs.status.overlay.auto_replay";
    const CURRENT_VIDEO_SELECTION_STORAGE_KEY = "wcs.vehicle.current_video_file_name.v1";

    if ($overlay.length === 0 || $image.length === 0 || $video.length === 0) {
        return;
    }

    function requestAudioUnlockFromHud() {
        try {
            if (typeof window.activateVehicleAudioByGesture === "function") {
                window.activateVehicleAudioByGesture();
            } else {
                if (typeof window.setVehicleAudioEnabled === "function") {
                    window.setVehicleAudioEnabled(true);
                }
                if (typeof window.speechSynthesis !== "undefined" && window.speechSynthesis) {
                    window.speechSynthesis.resume();
                }
            }
        } catch (error) {
            // Ignore audio unlock failures; HUD state will continue to show current status.
        }
        updateOverlayAudioHud();
    }

    function toBoolean(value) {
        if (typeof value === "boolean") {
            return value;
        }
        const text = String(value || "").trim().toLowerCase();
        return text === "1" || text === "true" || text === "on" || text === "yes";
    }

    const showVideoOverlayEnabled = $viewer.length > 0 && toBoolean($viewer.attr("showVideo"));
    const showWheelInfoOverlayEnabled = $viewer.length > 0 && toBoolean($viewer.attr("showWheelInfo"));
    let overlayLayoutMode = "default";
    let latestCurrentVideoFileName = "";
    let mediaHiddenByUser = false;
    let mediaPlaybackPaused = false;
    let autoReplayEnabled = false;
    let lastMediaType = "";
    let lastMediaSource = "";
    let lastMediaAspectRatio = 16 / 9;
    let cleanupRequest = null;
    let cameraOverlaySessionId = "";
    let cameraOverlaySelectionKey = "";
    let cameraOverlayPollTimerId = null;
    let cameraOverlayNextRequest = null;
    let cameraOverlayCleanupRequest = null;
    let cameraOverlayInitRequest = null;
    let firstFrameTimeoutId = null;
    let firstFrameRequestToken = 0;
    let lastImageFrameAt = 0;
    let lastImageReplayAttemptAt = 0;
    let imageStreamNeedsReplay = false;
    let pageExitCleanupRequested = false;
    let audioHudBlinkPhase = false;
    let temporaryStatusHideTimerId = null;
    let hasStoredOverlayMediaHiddenState = false;
    const FIRST_FRAME_TIMEOUT_MS = 10000;
    const LOADING_MESSAGE = "로딩중입니다.";
    const FIRST_FRAME_TIMEOUT_MESSAGE = "동영상이 로딩되지 않았습니다.";
    const NO_SELECTED_VIDEO_MESSAGE = "현재 선택된 동영상이 없습니다.";
    const TEMPORARY_STATUS_MESSAGE_MS = 1800;
    const VIEWER_DRAG_PIXELS_RATIO = 0.47;
    const VIEWER_ZOOM_OUT_RATIO = 0.07;
    const IMAGE_STREAM_STALE_MS = 3500;
    const IMAGE_STREAM_REPLAY_COOLDOWN_MS = 2500;

    let $audioHud = $("#vehicle-audio-hud");
    if ($audioHud.length === 0) {
        $audioHud = $('<div id="vehicle-audio-hud"></div>');
        $audioHud.css({
            position: "absolute",
            left: "50%",
            bottom: "10px",
            transform: "translateX(-50%)",
            zIndex: "24",
            maxWidth: "92%",
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            pointerEvents: "auto",
        });
        $viewer.parent().append($audioHud);
    }

    let $audioHudState = $("#vehicle-audio-hud-state");
    let $audioHudText = $("#vehicle-audio-hud-text");

    if ($audioHudState.length === 0 || $audioHudText.length === 0) {
        $audioHud.empty();

        $audioHudState = $('<div id="vehicle-audio-hud-state"></div>');
        $audioHudText = $('<div id="vehicle-audio-hud-text"></div>');

        $audioHudState.css({
            padding: "4px 10px",
            borderRadius: "999px",
            background: "rgba(108, 117, 125, 0.72)",
            color: "#fff",
            fontSize: "12px",
            whiteSpace: "nowrap",
        });

        $audioHudText.css({
            maxWidth: "min(62vw, 540px)",
            padding: "4px 10px",
            borderRadius: "999px",
            background: "rgba(33, 37, 41, 0.62)",
            color: "#fff",
            fontSize: "12px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
        });

        $audioHud.append($audioHudState, $audioHudText);
    }

    $audioHudState.add($audioHudText)
        .css("cursor", "pointer")
        .attr("title", "클릭하여 음성 활성화")
        .off("click.wcsAudioUnlock")
        .on("click.wcsAudioUnlock", function (event) {
            event.preventDefault();
            event.stopPropagation();
            requestAudioUnlockFromHud();
        });

    function setCloseButtonToShowMode(_isShowMode) {
        $closeButton
            .attr("title", "동영상 닫기")
            .attr("aria-label", "동영상 닫기")
            .html('<i class="bi bi-x-lg overlay-toggle-icon overlay-toggle-icon-close" aria-hidden="true"></i>');
    }

    function updateLoopToggleButton(isControlEnabled = false) {
        if ($loopToggleButton.length === 0) {
            return;
        }

        if (mediaHiddenByUser) {
            $loopToggleButton.addClass("d-none");
            return;
        }

        $loopToggleButton.removeClass("d-none");

        if (autoReplayEnabled) {
            $loopToggleButton
                .addClass("road-detect-overlay-control-btn-active")
                .attr("title", "자동 반복 ON")
                .attr("aria-label", "자동 반복 ON");
        } else {
            $loopToggleButton
                .removeClass("road-detect-overlay-control-btn-active")
                .attr("title", "자동 반복 OFF")
                .attr("aria-label", "자동 반복 OFF");
        }

        $loopToggleButton.prop("disabled", !isControlEnabled);

        if ($video.length > 0 && !$video.hasClass("d-none")) {
            $video.prop("loop", autoReplayEnabled && lastMediaType === "video");
        }
    }

    function updateVideoControlButtons() {
        const hasCloseButton = $closeButton.length > 0;
        const isImageVisible = $image.length > 0 && !$image.hasClass("d-none");
        const hasImageSource = !!String($image.attr("src") || "").trim();
        if ($playToggleButton.length === 0 || $video.length === 0) {
            if (hasCloseButton) {
                $closeButton.prop("disabled", true);
            }
            return;
        }

        if (mediaHiddenByUser) {
            if (hasCloseButton) {
                $closeButton.prop("disabled", true);
            }
            $playToggleButton
                .removeClass("d-none")
                .prop("disabled", false)
                .attr("title", "동영상 출력")
                .attr("aria-label", "동영상 출력")
                .html('<i class="bi bi-play-btn-fill" aria-hidden="true"></i>');
            updateLoopToggleButton(false);
            return;
        }

        $playToggleButton.removeClass("d-none");

        if (lastMediaType === "image") {
            if (hasCloseButton) {
                $closeButton.prop("disabled", !(isImageVisible && hasImageSource));
            }
            const hasImageMediaSource = !!String(lastMediaSource || $image.attr("src") || "").trim();
            updateLoopToggleButton(hasImageMediaSource);
            if (mediaPlaybackPaused) {
                $playToggleButton
                    .prop("disabled", false)
                    .attr("title", "동영상 재생")
                    .attr("aria-label", "동영상 재생")
                    .html('<i class="bi bi-play-fill" aria-hidden="true"></i>');
                return;
            }

            $playToggleButton
                .prop("disabled", false)
                .attr("title", "동영상 일시 정지")
                .attr("aria-label", "동영상 일시 정지")
                .html('<i class="bi bi-pause-fill" aria-hidden="true"></i>');
            return;
        }

        const videoElement = $video[0];
        const isVideoVisible = !$video.hasClass("d-none");
        const hasVideoSource = !!String($video.attr("src") || "").trim();
        const isVideoOutputAreaActive = !mediaHiddenByUser && isVideoVisible;
        if (hasCloseButton) {
            $closeButton.prop("disabled", !isVideoOutputAreaActive);
        }
        const isVideoReady = isVideoVisible && hasVideoSource;
        const isPaused = !isVideoReady || mediaPlaybackPaused || videoElement.paused || videoElement.ended;

        updateLoopToggleButton(isVideoReady);

        if (!isVideoReady) {
            $playToggleButton
                .prop("disabled", true)
                .attr("title", "동영상 재생")
                .attr("aria-label", "동영상 재생")
                .html('<i class="bi bi-play-fill" aria-hidden="true"></i>');
            return;
        }

        if (isPaused) {
            $playToggleButton
                .prop("disabled", false)
                .attr("title", "동영상 재생")
                .attr("aria-label", "동영상 재생")
                .html('<i class="bi bi-play-fill" aria-hidden="true"></i>');
            return;
        }

        $playToggleButton
            .prop("disabled", false)
            .attr("title", "동영상 일시 정지")
            .attr("aria-label", "동영상 일시 정지")
            .html('<i class="bi bi-pause-fill" aria-hidden="true"></i>');
    }

    function readOverlayMediaHiddenState() {
        try {
            const rawValue = window.localStorage.getItem(OVERLAY_MEDIA_HIDDEN_STORAGE_KEY);
            hasStoredOverlayMediaHiddenState = rawValue !== null;
            if (rawValue === null) {
                return true;
            }
            const normalized = String(rawValue || "").trim().toLowerCase();
            return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
        } catch (error) {
            hasStoredOverlayMediaHiddenState = false;
            return true;
        }
    }

    function writeOverlayMediaHiddenState(hidden) {
        try {
            window.localStorage.setItem(OVERLAY_MEDIA_HIDDEN_STORAGE_KEY, hidden ? "true" : "false");
        } catch (error) {
            // Ignore storage write failures.
        }
    }

    function readOverlayAutoReplayState() {
        try {
            const rawValue = window.localStorage.getItem(OVERLAY_AUTO_REPLAY_STORAGE_KEY);
            const normalized = String(rawValue || "").trim().toLowerCase();
            return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
        } catch (error) {
            return false;
        }
    }

    function writeOverlayAutoReplayState(enabled) {
        try {
            window.localStorage.setItem(OVERLAY_AUTO_REPLAY_STORAGE_KEY, enabled ? "true" : "false");
        } catch (error) {
            // Ignore storage write failures.
        }
    }

    function readCurrentVideoSelectionState() {
        try {
            return String(window.localStorage.getItem(CURRENT_VIDEO_SELECTION_STORAGE_KEY) || "").trim();
        } catch (error) {
            return "";
        }
    }

    function writeCurrentVideoSelectionState(value) {
        try {
            window.localStorage.setItem(CURRENT_VIDEO_SELECTION_STORAGE_KEY, String(value || "").trim());
        } catch (error) {
            // Ignore storage write failures.
        }
    }

    function markOverlayMediaVisibleState() {
        mediaHiddenByUser = false;
        writeOverlayMediaHiddenState(false);
        setCloseButtonToShowMode(false);
    }

    function isAudioEnabledForOverlay() {
        if (typeof window.isVehicleAudioEnabled === "function") {
            try {
                const enabled = !!window.isVehicleAudioEnabled();
                window.__wcsAudioEnabled = enabled;
                return enabled;
            } catch (error) {
                // fallback to storage check.
            }
        }

        if (typeof window.__wcsAudioEnabled === "boolean") {
            return window.__wcsAudioEnabled;
        }

        try {
            const rawValue = window.localStorage.getItem(VEHICLE_AUDIO_STORAGE_KEY);
            const normalized = String(rawValue || "").trim().toLowerCase();
            return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
        } catch (error) {
            return false;
        }
    }

    function updateOverlayAudioHud() {
        const audioEnabled = isAudioEnabledForOverlay();
        const rawText = String(window.__wcsLastSpeechText || "").trim();
        const speechText = rawText || "대기중";
        const titleText = audioEnabled ? "음성 ON" : "음성 OFF (클릭 활성화)";
        const lastSpeechAt = Number(window.__wcsLastSpeechAt || 0);
        const isRecentSpeech = Number.isFinite(lastSpeechAt) && (Date.now() - lastSpeechAt) < 900;
        const isSpeakingNow = audioEnabled && (
            window.__wcsAudioSpeaking === true
            || (
                typeof window.speechSynthesis !== "undefined"
                && !!window.speechSynthesis
                && window.speechSynthesis.speaking === true
            )
            || isRecentSpeech
        );

        $audioHudState.text(titleText);
        $audioHudText.text(audioEnabled ? speechText : "새로고침 후 이곳을 한번 클릭하세요");
        $audioHudState.css("background", audioEnabled ? "rgba(25, 135, 84, 0.70)" : "rgba(108, 117, 125, 0.72)");

        if (isSpeakingNow) {
            audioHudBlinkPhase = !audioHudBlinkPhase;
            $audioHudState.css({
                opacity: audioHudBlinkPhase ? "1" : "0.42",
                boxShadow: audioHudBlinkPhase ? "0 0 0 2px rgba(255,255,255,0.18)" : "none",
            });
            return;
        }

        audioHudBlinkPhase = false;
        $audioHudState.css({
            opacity: "1",
            boxShadow: "none",
        });
    }

    function setOverlayStatus(message, visible) {
        if ($status.length === 0) {
            return;
        }

        if (mediaHiddenByUser && visible) {
            $status.addClass("d-none");
            return;
        }

        const text = String(message || "").trim();
        if (text) {
            $status.text(text);
        }
        $status.toggleClass("d-none", !visible);
    }

    function clearTemporaryStatusMessage() {
        if (temporaryStatusHideTimerId !== null) {
            clearTimeout(temporaryStatusHideTimerId);
            temporaryStatusHideTimerId = null;
        }
    }

    function showTemporaryStatusMessage(message, durationMs = TEMPORARY_STATUS_MESSAGE_MS) {
        clearTemporaryStatusMessage();
        setOverlayStatus(message, true);
        temporaryStatusHideTimerId = setTimeout(function () {
            temporaryStatusHideTimerId = null;
            setOverlayStatus("", false);
        }, durationMs);
    }

    function getOrCreateOverlayToastContainer() {
        let container = document.getElementById("road-detect-overlay-toast-container");
        if (container) {
            return container;
        }

        container = document.createElement("div");
        container.id = "road-detect-overlay-toast-container";
        container.className = "toast-container position-fixed p-2";
        container.style.top = "14px";
        container.style.left = "14px";
        container.style.transform = "none";
        container.style.zIndex = "1100";
        document.body.appendChild(container);
        return container;
    }

    function positionOverlayToastContainerNearAnchor(container, anchorElement) {
        if (!container) {
            return;
        }

        const margin = 12;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

        if (!anchorElement || typeof anchorElement.getBoundingClientRect !== "function") {
            container.style.top = `${margin}px`;
            container.style.left = `${margin}px`;
            container.style.transform = "none";
            return;
        }

        const rect = anchorElement.getBoundingClientRect();
        const estimatedWidth = 300;
        const estimatedHeight = 64;

        let left = rect.left;
        let top = rect.bottom + margin;

        if (left + estimatedWidth > viewportWidth - margin) {
            left = Math.max(margin, viewportWidth - estimatedWidth - margin);
        }
        if (top + estimatedHeight > viewportHeight - margin) {
            top = rect.top - estimatedHeight - margin;
        }
        if (top < margin) {
            top = margin;
        }

        container.style.top = `${Math.round(top)}px`;
        container.style.left = `${Math.round(left)}px`;
        container.style.transform = "none";
    }

    function showOverlayToast(message, styleType = "warning", anchorElement = null) {
        const text = String(message || "").trim();
        if (!text) {
            return;
        }

        const type = String(styleType || "warning").toLowerCase();
        const toastClass = type === "danger" ? "text-bg-danger" : (type === "success" ? "text-bg-success" : "text-bg-warning");
        const container = getOrCreateOverlayToastContainer();
        positionOverlayToastContainerNearAnchor(container, anchorElement);
        const toastElement = document.createElement("div");
        toastElement.className = `toast align-items-center border-0 ${toastClass}`;
        toastElement.setAttribute("role", "alert");
        toastElement.setAttribute("aria-live", "assertive");
        toastElement.setAttribute("aria-atomic", "true");

        toastElement.innerHTML = `
            <div class="d-flex">
                <div class="toast-body">${text}</div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
            </div>
        `;

        container.appendChild(toastElement);

        if (window.bootstrap && window.bootstrap.Toast) {
            const toast = new window.bootstrap.Toast(toastElement, { delay: 2200 });
            toastElement.addEventListener("hidden.bs.toast", function () {
                toastElement.remove();
            }, { once: true });
            toast.show();
            return;
        }

        setTimeout(function () {
            toastElement.remove();
        }, 2200);
    }

    function clearFirstFrameTimeout() {
        if (firstFrameTimeoutId !== null) {
            clearTimeout(firstFrameTimeoutId);
            firstFrameTimeoutId = null;
        }
    }

    function startFirstFrameWait() {
        firstFrameRequestToken += 1;
        const currentToken = firstFrameRequestToken;

        clearFirstFrameTimeout();
        setOverlayStatus(LOADING_MESSAGE, true);

        firstFrameTimeoutId = setTimeout(function () {
            if (currentToken !== firstFrameRequestToken) {
                return;
            }
            setOverlayStatus(FIRST_FRAME_TIMEOUT_MESSAGE, true);
        }, FIRST_FRAME_TIMEOUT_MS);
    }

    function markFirstFrameReady() {
        firstFrameRequestToken += 1;
        clearFirstFrameTimeout();
        clearTemporaryStatusMessage();
        setOverlayStatus("", false);
    }

    const normalizePath = typeof window.wcsNormalizePath === "function"
        ? window.wcsNormalizePath
        : function (pathValue) {
            return String(pathValue || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
        };

    const encodePathForRoute = typeof window.wcsEncodePathForRoute === "function"
        ? window.wcsEncodePathForRoute
        : function (pathValue) {
            return normalizePath(pathValue)
                .split("/")
                .filter(function (segment) {
                    return segment.length > 0;
                })
                .map(function (segment) {
                    return encodeURIComponent(segment);
                })
                .join("/");
        };

    const resolveRoadDetectStreamPath = typeof window.wcsResolveRoadDetectStreamPath === "function"
        ? window.wcsResolveRoadDetectStreamPath
        : function (pathValue) {
            const normalizedPath = normalizePath(pathValue);
            if (!normalizedPath) {
                return "";
            }

            // Backward compatibility: a bare file name is treated as cobot sample.
            if (normalizedPath.indexOf("/") === -1) {
                return "samples/video/cobot/" + normalizedPath;
            }

            return normalizedPath;
        };

    const buildRoadDetectStreamUrl = typeof window.wcsBuildRoadDetectStreamUrl === "function"
        ? function (fileName) {
            return window.wcsBuildRoadDetectStreamUrl(fileName, {
                detect_type: "road_type",
                remove_noisy_masks: true,
                show_time_bar: true,
                include_pothole: true,
                pothole_conf: 0.45,
                mqtt_publish: true,
                t: Date.now(),
            });
        }
        : function (fileName) {
            const streamPath = resolveRoadDetectStreamPath(fileName);
            const encodedPath = encodePathForRoute(streamPath);
            if (!encodedPath) {
                return "";
            }

            return "/fast/road_detect_stream/" + encodedPath + "?" + $.param({
                detect_type: "road_type",
                remove_noisy_masks: true,
                show_time_bar: true,
                include_pothole: true,
                pothole_conf: 0.45,
                mqtt_publish: true,
                t: Date.now(),
            });
        };

    const buildRoadDetectStreamCleanupUrl = typeof window.wcsBuildRoadDetectStreamCleanupUrl === "function"
        ? function (fileName) {
            return window.wcsBuildRoadDetectStreamCleanupUrl(fileName, { t: Date.now() });
        }
        : function (fileName) {
            const streamPath = resolveRoadDetectStreamPath(fileName);
            const encodedPath = encodePathForRoute(streamPath);
            if (!encodedPath) {
                return "";
            }

            return "/fast/road_detect_stream_cleanup/" + encodedPath + "?" + $.param({
                t: Date.now(),
            });
        };

    function buildCameraDetectStreamInitUrl(cameraIndex) {
        return "/fast/camera_detect_stream_init?" + $.param({
            camera_index: Number(cameraIndex),
            detect_type: "road_type",
            remove_noisy_masks: true,
            show_detect_stats: true,
            include_pothole: true,
            pothole_conf: 0.45,
            mqtt_publish: true,
            t: Date.now(),
        });
    }

    function buildCameraDetectStreamNextUrl(sessionId) {
        return "/fast/camera_detect_stream_next/" + encodeURIComponent(String(sessionId || "")) + "?" + $.param({ t: Date.now() });
    }

    function buildCameraDetectStreamCleanupUrl(sessionId) {
        return "/fast/camera_detect_stream_cleanup/" + encodeURIComponent(String(sessionId || ""));
    }

    function parseCameraSelection(value) {
        const text = normalizePath(value).toLowerCase();
        const matched = text.match(/^camera_(\d+)$/);
        if (!matched) {
            return null;
        }

        const cameraIndex = Number(matched[1]);
        if (!Number.isFinite(cameraIndex) || cameraIndex < 0) {
            return null;
        }

        return {
            key: text,
            index: cameraIndex,
        };
    }

    function clearCameraOverlayPoll() {
        if (cameraOverlayPollTimerId !== null) {
            clearTimeout(cameraOverlayPollTimerId);
            cameraOverlayPollTimerId = null;
        }
    }

    function stopCameraOverlayStream(sendCleanup = true) {
        clearCameraOverlayPoll();

        if (cameraOverlayNextRequest && typeof cameraOverlayNextRequest.abort === "function") {
            cameraOverlayNextRequest.abort();
        }
        cameraOverlayNextRequest = null;

        if (cameraOverlayInitRequest && typeof cameraOverlayInitRequest.abort === "function") {
            cameraOverlayInitRequest.abort();
        }
        cameraOverlayInitRequest = null;

        const sessionToCleanup = String(cameraOverlaySessionId || "");
        cameraOverlaySessionId = "";
        cameraOverlaySelectionKey = "";

        if (!sendCleanup || !sessionToCleanup) {
            return;
        }

        if (cameraOverlayCleanupRequest && typeof cameraOverlayCleanupRequest.abort === "function") {
            cameraOverlayCleanupRequest.abort();
        }

        cameraOverlayCleanupRequest = $.ajax({
            url: buildCameraDetectStreamCleanupUrl(sessionToCleanup),
            method: "POST",
            timeout: 3000,
        }).always(function () {
            cameraOverlayCleanupRequest = null;
        });
    }

    function scheduleCameraOverlayNextPoll(delayMs) {
        clearCameraOverlayPoll();
        cameraOverlayPollTimerId = setTimeout(function () {
            requestCameraOverlayNextFrame();
        }, Math.max(30, Number(delayMs) || 80));
    }

    function requestCameraOverlayNextFrame() {
        const sessionId = String(cameraOverlaySessionId || "");
        if (!sessionId || mediaHiddenByUser) {
            return;
        }

        if (cameraOverlayNextRequest && typeof cameraOverlayNextRequest.abort === "function") {
            cameraOverlayNextRequest.abort();
        }

        cameraOverlayNextRequest = $.ajax({
            url: buildCameraDetectStreamNextUrl(sessionId),
            method: "GET",
            timeout: 5000,
        }).done(function (result) {
            if (sessionId !== String(cameraOverlaySessionId || "")) {
                return;
            }

            if (!result || result.has_next === false) {
                scheduleCameraOverlayNextPoll(180);
                return;
            }

            const frameB64 = String(result.frame_detected || result.frame_original || "").trim();
            if (!frameB64) {
                scheduleCameraOverlayNextPoll(90);
                return;
            }

            applyCompactOverlayLayout();
            showOverlay();
            showImageSource("data:image/jpeg;base64," + frameB64);

            // Avoid appending cache-busting query to data URLs in image auto-replay path.
            if (cameraOverlaySessionId) {
                lastMediaSource = "";
            }

            const fps = Number(result.fps || 0);
            const intervalMs = fps > 0 ? Math.round(1000 / fps) : 80;
            scheduleCameraOverlayNextPoll(intervalMs);
        }).fail(function () {
            if (sessionId !== String(cameraOverlaySessionId || "")) {
                return;
            }
            scheduleCameraOverlayNextPoll(250);
        }).always(function () {
            cameraOverlayNextRequest = null;
        });
    }

    function startCameraOverlayStream(cameraSelection) {
        const selection = cameraSelection || null;
        if (!selection || !Number.isFinite(selection.index)) {
            return;
        }

        const selectionKey = String(selection.key || "");
        if (selectionKey && selectionKey === cameraOverlaySelectionKey && cameraOverlaySessionId) {
            markOverlayMediaVisibleState();
            applyCompactOverlayLayout();
            showOverlay();
            return;
        }

        stopCameraOverlayStream(true);
        cameraOverlaySelectionKey = selectionKey;

        cameraOverlayInitRequest = $.ajax({
            url: buildCameraDetectStreamInitUrl(selection.index),
            method: "POST",
            timeout: 5000,
        }).done(function (result) {
            const sessionId = String(result && result.session_id ? result.session_id : "").trim();
            if (!sessionId) {
                setOverlayStatus(FIRST_FRAME_TIMEOUT_MESSAGE, true);
                return;
            }

            if (cameraOverlaySelectionKey !== selectionKey) {
                return;
            }

            cameraOverlaySessionId = sessionId;
            markOverlayMediaVisibleState();
            applyCompactOverlayLayout();
            showOverlay();
            requestCameraOverlayNextFrame();
        }).fail(function () {
            setOverlayStatus(FIRST_FRAME_TIMEOUT_MESSAGE, true);
        }).always(function () {
            cameraOverlayInitRequest = null;
        });
    }

    function buildRoadDetectStreamCleanupUrlByPath(filePath) {
        const normalizedPath = normalizePath(filePath);
        if (!normalizedPath) {
            return "";
        }

        return "/fast/road_detect_stream_cleanup/" + encodePathForRoute(normalizedPath) + "?" + $.param({
            t: Date.now(),
        });
    }

    function extractRoadDetectStreamFilePathFromUrl(url) {
        const text = String(url || "").trim();
        if (!text) {
            return "";
        }

        const marker = "/fast/road_detect_stream/";
        const markerIndex = text.indexOf(marker);
        if (markerIndex < 0) {
            return "";
        }

        const startIndex = markerIndex + marker.length;
        const queryIndex = text.indexOf("?", startIndex);
        const rawPath = queryIndex >= 0 ? text.slice(startIndex, queryIndex) : text.slice(startIndex);
        if (!rawPath) {
            return "";
        }

        try {
            return normalizePath(decodeURIComponent(rawPath));
        } catch (error) {
            return normalizePath(rawPath);
        }
    }

    function toComparableVideoPath(pathValue) {
        const normalized = normalizePath(pathValue);
        if (!normalized) {
            return "";
        }

        return normalized.replace(/^samples\//, "");
    }

    function requestRoadDetectSessionCleanup(fileName) {
        stopCameraOverlayStream(true);

        const cleanupUrlCandidates = [];

        const byFileNameUrl = buildRoadDetectStreamCleanupUrl(fileName || latestCurrentVideoFileName);
        if (byFileNameUrl) {
            cleanupUrlCandidates.push(byFileNameUrl);
        }

        const streamedFilePath = extractRoadDetectStreamFilePathFromUrl(lastMediaSource);
        const byStreamPathUrl = buildRoadDetectStreamCleanupUrlByPath(streamedFilePath);
        if (byStreamPathUrl) {
            cleanupUrlCandidates.push(byStreamPathUrl);
        }

        const uniqueCleanupUrls = Array.from(new Set(cleanupUrlCandidates));
        if (uniqueCleanupUrls.length === 0) {
            return;
        }

        if (cleanupRequest && typeof cleanupRequest.abort === "function") {
            cleanupRequest.abort();
        }

        const cleanupRequests = uniqueCleanupUrls.map(function (cleanupUrl) {
            return $.ajax({
                url: cleanupUrl,
                method: "POST",
                timeout: 3000,
            });
        });

        cleanupRequest = cleanupRequests[cleanupRequests.length - 1] || null;
        $.when.apply($, cleanupRequests).always(function () {
            cleanupRequest = null;
        });
    }

    function requestRoadDetectSessionCleanupAllOnLoad() {
        $.ajax({
            url: "/fast/road_detect_stream_cleanup_all?" + $.param({ t: Date.now() }),
            method: "POST",
            timeout: 3000,
        }).fail(function () {
            // Ignore startup cleanup failures; overlay can still work without this.
        });

        $.ajax({
            url: "/fast/camera_detect_stream_cleanup_all",
            method: "POST",
            timeout: 3000,
        }).fail(function () {
            // Ignore startup cleanup failures; overlay can still work without this.
        });
    }

    function requestRoadDetectSessionCleanupAll() {
        stopCameraOverlayStream(true);
        requestRoadDetectSessionCleanupAllOnLoad();
    }

    function sendCleanupBeacon(url) {
        if (!url) {
            return false;
        }

        try {
            if (navigator && typeof navigator.sendBeacon === "function") {
                const payload = new Blob([""], { type: "text/plain" });
                return navigator.sendBeacon(url, payload);
            }
        } catch (error) {
            // Ignore beacon failures.
        }

        return false;
    }

    function requestCleanupOnPageExit() {
        if (pageExitCleanupRequested) {
            return;
        }
        pageExitCleanupRequested = true;

        // Stop local polling/timers immediately.
        stopCameraOverlayStream(false);
        clearFirstFrameTimeout();
        clearTemporaryStatusMessage();

        const roadCleanupUrl = "/fast/road_detect_stream_cleanup_all?" + $.param({ t: Date.now() });
        const cameraCleanupUrl = "/fast/camera_detect_stream_cleanup_all";

        const roadBeaconSent = sendCleanupBeacon(roadCleanupUrl);
        const cameraBeaconSent = sendCleanupBeacon(cameraCleanupUrl);

        // Fallback when beacon is unavailable or rejected.
        if (!roadBeaconSent) {
            try {
                fetch(roadCleanupUrl, {
                    method: "POST",
                    keepalive: true,
                    credentials: "same-origin",
                }).catch(function () {
                    // Ignore unload-time cleanup failures.
                });
            } catch (error) {
                // Ignore unload-time cleanup failures.
            }
        }

        if (!cameraBeaconSent) {
            try {
                fetch(cameraCleanupUrl, {
                    method: "POST",
                    keepalive: true,
                    credentials: "same-origin",
                }).catch(function () {
                    // Ignore unload-time cleanup failures.
                });
            } catch (error) {
                // Ignore unload-time cleanup failures.
            }
        }
    }

    function attemptImageStreamAutoReplay() {
        if (!autoReplayEnabled || mediaHiddenByUser || mediaPlaybackPaused) {
            return;
        }

        if (lastMediaType !== "image") {
            return;
        }

        if (!latestCurrentVideoFileName) {
            return;
        }

        if (parseCameraSelection(latestCurrentVideoFileName)) {
            const nowForCamera = Date.now();
            if ((nowForCamera - lastImageReplayAttemptAt) < IMAGE_STREAM_REPLAY_COOLDOWN_MS) {
                return;
            }
            lastImageReplayAttemptAt = nowForCamera;
            resolveAndShowCurrentVideo(latestCurrentVideoFileName);
            return;
        }

        const now = Date.now();
        if (!$status.hasClass("d-none")) {
            return;
        }

        if (lastImageFrameAt <= 0 || (now - lastImageFrameAt) < IMAGE_STREAM_STALE_MS) {
            return;
        }

        const statusText = String($status.text() || "").trim();
        const isTimeoutState = imageStreamNeedsReplay
            || (!$status.hasClass("d-none") && statusText === FIRST_FRAME_TIMEOUT_MESSAGE);
        if (!isTimeoutState) {
            return;
        }

        if ((now - lastImageReplayAttemptAt) < IMAGE_STREAM_REPLAY_COOLDOWN_MS) {
            return;
        }

        imageStreamNeedsReplay = false;
        lastImageFrameAt = now;
        lastImageReplayAttemptAt = now;
        if (lastMediaSource) {
            const cacheBustSeparator = lastMediaSource.includes("?") ? "&" : "?";
            showImageSource(`${lastMediaSource}${cacheBustSeparator}t=${Date.now()}`);
            return;
        }

        resolveAndShowCurrentVideo(latestCurrentVideoFileName);
    }

    function replayActiveOverlayMedia() {
        if (!autoReplayEnabled || mediaHiddenByUser) {
            return;
        }

        mediaPlaybackPaused = false;

        if (parseCameraSelection(latestCurrentVideoFileName)) {
            resolveAndShowCurrentVideo(latestCurrentVideoFileName);
            return;
        }

        if (lastMediaType === "image" && lastMediaSource) {
            const cacheBustSeparator = lastMediaSource.includes("?") ? "&" : "?";
            showImageSource(`${lastMediaSource}${cacheBustSeparator}t=${Date.now()}`);
            return;
        }

        if (lastMediaSource) {
            showVideoSource(lastMediaSource);
            return;
        }

        if (latestCurrentVideoFileName) {
            resolveAndShowCurrentVideo(latestCurrentVideoFileName);
        }
    }

    function shouldRenderAsImageStream(url) {
        const normalizedUrl = String(url || "").toLowerCase();
        return normalizedUrl.indexOf("/fast/road_detect_stream/") !== -1;
    }

    function applyDefaultOverlayLayout() {
        if (overlayLayoutMode === "default") {
            return;
        }

        $overlay.attr("style", "");
        overlayLayoutMode = "default";

        if (typeof window.setVehicleViewerOverlayDragPixels === "function") {
            window.setVehicleViewerOverlayDragPixels(0);
        } else if (typeof window.setVehicleViewerVerticalOffset === "function") {
            window.setVehicleViewerVerticalOffset(0);
        }

        if (typeof window.setVehicleViewerOverlayZoomOutRatio === "function") {
            window.setVehicleViewerOverlayZoomOutRatio(0);
        }
    }

    function applyCompactOverlayLayout() {
        if (overlayLayoutMode === "compact") {
            return;
        }

        const initialWidth = getCompactOverlayInitialWidth(lastMediaAspectRatio);

        // Top-center compact overlay, constrained to less than half of viewer size.
        $overlay.attr(
            "style",
            "inset:auto;top:10px;left:50%;transform:translateX(-50%);width:" + initialWidth + "px;height:min(46%, 420px);z-index:60;display:flex;flex-direction:column;background:rgba(0,0,0,0.82);border-radius:1rem;overflow:hidden;"
        );
        overlayLayoutMode = "compact";

        applyCompactOverlayWidthByAspect(lastMediaAspectRatio);
        applyVehicleViewerDragByOverlayHeight();
        applyVehicleViewerZoomByOverlayMode();
    }

    function getCompactOverlayTargetHeightPx() {
        const overlayElement = $overlay[0];
        const liveHeight = Number(overlayElement?.clientHeight || 0);
        if (Number.isFinite(liveHeight) && liveHeight > 0) {
            return liveHeight;
        }

        const viewerHeight = Number($viewer.outerHeight() || 0);
        if (!Number.isFinite(viewerHeight) || viewerHeight <= 0) {
            return 220;
        }

        return Math.min(420, Math.max(180, viewerHeight * 0.46));
    }

    function applyVehicleViewerDragByOverlayHeight() {
        if (typeof window.setVehicleViewerOverlayDragPixels !== "function") {
            return;
        }

        if (overlayLayoutMode !== "compact") {
            window.setVehicleViewerOverlayDragPixels(0);
            return;
        }

        const overlayHeightPx = getCompactOverlayTargetHeightPx();
        window.setVehicleViewerOverlayDragPixels(overlayHeightPx * VIEWER_DRAG_PIXELS_RATIO);
    }

    function applyVehicleViewerZoomByOverlayMode() {
        if (typeof window.setVehicleViewerOverlayZoomOutRatio !== "function") {
            return;
        }

        if (overlayLayoutMode !== "compact") {
            window.setVehicleViewerOverlayZoomOutRatio(0);
            return;
        }

        window.setVehicleViewerOverlayZoomOutRatio(VIEWER_ZOOM_OUT_RATIO);
    }

    function getCompactOverlayMaxWidth() {
        const viewerWidth = Number($viewer.outerWidth() || 0);
        if (!Number.isFinite(viewerWidth) || viewerWidth <= 0) {
            return 760;
        }

        const sideMargin = 12;
        const centerGap = 16;
        const estimatedWheelPanelWidth = showWheelInfoOverlayEnabled
            ? Math.min(230, Math.round(viewerWidth * 0.34))
            : 0;

        const reservedWidth = (estimatedWheelPanelWidth * 2) + (sideMargin * 2) + centerGap;
        const availableCenterWidth = Math.round(viewerWidth - reservedWidth);

        if (availableCenterWidth > 0) {
            return Math.max(220, Math.min(760, availableCenterWidth));
        }

        return Math.max(220, Math.min(760, Math.round(viewerWidth * 0.5)));
    }

    function getCompactOverlayInitialWidth(aspectRatio) {
        const ratio = Number(aspectRatio);
        const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : (16 / 9);

        const viewerHeight = Number($viewer.outerHeight() || 0);
        if (!Number.isFinite(viewerHeight) || viewerHeight <= 0) {
            return getCompactOverlayMaxWidth();
        }

        const overlayHeight = Math.min(420, Math.max(180, viewerHeight * 0.46));
        const mediaHeight = Math.max(0, overlayHeight - 16);
        const estimatedWidth = Math.round((mediaHeight * safeRatio) + 16);

        return Math.min(getCompactOverlayMaxWidth(), Math.max(220, estimatedWidth));
    }

    function applyCompactOverlayWidthByAspect(aspectRatio) {
        const ratio = Number(aspectRatio);
        if (!Number.isFinite(ratio) || ratio <= 0 || overlayLayoutMode !== "compact") {
            return;
        }

        const overlayElement = $overlay[0];
        if (!overlayElement) {
            return;
        }

        const overlayHeight = Number(overlayElement.clientHeight || 0);
        if (!Number.isFinite(overlayHeight) || overlayHeight <= 0) {
            return;
        }

        // Body padding is 8px * 2 in CSS.
        const mediaHeight = Math.max(0, overlayHeight - 16);
        const mediaWidth = mediaHeight * ratio;
        const targetWidth = Math.round(mediaWidth + 16);
        const clampedWidth = Math.min(getCompactOverlayMaxWidth(), Math.max(220, targetWidth));

        $overlay.css("width", clampedWidth + "px");
    }

    function applyCollapsedOverlayLayout() {
        if (overlayLayoutMode === "collapsed") {
            return;
        }

        const currentWidth = Number($overlay.outerWidth() || 0);
        const collapsedWidth = Number.isFinite(currentWidth) && currentWidth > 0
            ? Math.round(currentWidth) + "px"
            : "min(50%, 760px)";

        // Media hidden mode: keep only a small top-center area for the toggle button.
        $overlay.attr(
            "style",
            "inset:auto;top:10px;left:50%;transform:translateX(-50%);width:" + collapsedWidth + ";height:52px;z-index:60;display:block;background:transparent;border-radius:0;overflow:visible;"
        );
        overlayLayoutMode = "collapsed";

        if (typeof window.setVehicleViewerOverlayDragPixels === "function") {
            window.setVehicleViewerOverlayDragPixels(0);
        } else if (typeof window.setVehicleViewerVerticalOffset === "function") {
            window.setVehicleViewerVerticalOffset(0);
        }

        if (typeof window.setVehicleViewerOverlayZoomOutRatio === "function") {
            window.setVehicleViewerOverlayZoomOutRatio(0);
        }
    }

    function resolveAndShowCurrentVideo(fileName) {
        if (!showVideoOverlayEnabled) {
            return;
        }

        const normalizedFile = normalizePath(fileName);
        latestCurrentVideoFileName = normalizedFile;
        const cameraSelection = parseCameraSelection(normalizedFile);

        // 사용자가 미디어 영역을 숨긴 상태에서는 자동으로 다시 열지 않는다.
        if (mediaHiddenByUser) {
            applyCollapsedOverlayLayout();
            setCloseButtonToShowMode(true);
            showOverlay();
            return;
        }

        if (!normalizedFile) {
            stopCameraOverlayStream(true);
            requestRoadDetectSessionCleanupAll();
            clearFirstFrameTimeout();
            clearTemporaryStatusMessage();
            hideAllMedia(true);
            applyCollapsedOverlayLayout();
            setCloseButtonToShowMode(true);
            showOverlay();
            updateVideoControlButtons();
            return;
        }

        markOverlayMediaVisibleState();

        if (cameraSelection) {
            startCameraOverlayStream(cameraSelection);
            return;
        }

        stopCameraOverlayStream(true);

        const requestedStreamPath = resolveRoadDetectStreamPath(normalizedFile);
        const currentStreamPath = extractRoadDetectStreamFilePathFromUrl(lastMediaSource);
        const requestedComparablePath = toComparableVideoPath(requestedStreamPath);
        const currentComparablePath = toComparableVideoPath(currentStreamPath);
        const hasCurrentVideoSource = !!String($video.attr("src") || "").trim();
        const isCurrentVideoVisible = $video.length > 0 && !$video.hasClass("d-none");
        const isSameVideoSelection = lastMediaType === "video"
            && requestedComparablePath
            && currentComparablePath
            && requestedComparablePath === currentComparablePath;

        // Skip redundant stream URL refresh for the same file to preserve paused position.
        if (isSameVideoSelection && hasCurrentVideoSource && isCurrentVideoVisible) {
            applyCompactOverlayLayout();
            showOverlay();
            updateVideoControlButtons();
            return;
        }

        const streamUrl = buildRoadDetectStreamUrl(normalizedFile);
        if (!streamUrl) {
            return;
        }

        applyCompactOverlayLayout();
        showOverlay();
        showVideoSource(streamUrl);
    }

    function hideAllMedia(resetMemory = true) {
        if (resetMemory) {
            lastMediaType = "";
            lastMediaSource = "";
            mediaPlaybackPaused = false;
            markFirstFrameReady();
        }
        $image.attr("src", "").addClass("d-none");

        if ($video[0]) {
            if (typeof $video[0].pause === "function") {
                $video[0].pause();
            }
            if (typeof $video[0].removeAttribute === "function") {
                $video[0].removeAttribute("src");
            }
            if (typeof $video[0].load === "function") {
                $video[0].load();
            }
        }
        $video.attr("src", "").addClass("d-none");
        updateVideoControlButtons();
        if (resetMemory) {
            setOverlayStatus("", false);
        }
    }

    function showOverlay() {
        $overlay.removeClass("d-none");
    }

    function hideOverlay() {
        stopCameraOverlayStream(true);
        requestRoadDetectSessionCleanup(latestCurrentVideoFileName);
        setCloseButtonToShowMode(mediaHiddenByUser);
        hideAllMedia(true);
        setOverlayStatus("", false);
        $overlay.addClass("d-none");
    }

    function hideMediaAreaOnly() {
        stopCameraOverlayStream(true);
        requestRoadDetectSessionCleanup(latestCurrentVideoFileName);
        clearFirstFrameTimeout();
        clearTemporaryStatusMessage();
        mediaHiddenByUser = true;
        mediaPlaybackPaused = false;
        writeOverlayMediaHiddenState(true);
        hideAllMedia(false);
        setOverlayStatus("", false);
        applyCollapsedOverlayLayout();
        setCloseButtonToShowMode(true);
    }

    function restoreMediaAreaOnly() {
        clearFirstFrameTimeout();
        clearTemporaryStatusMessage();
        setOverlayStatus("", false);
        mediaHiddenByUser = false;
        mediaPlaybackPaused = false;
        writeOverlayMediaHiddenState(false);
        setCloseButtonToShowMode(false);
        applyCompactOverlayLayout();

        if (lastMediaType === "video" && lastMediaSource) {
            showVideoSource(lastMediaSource);
            return;
        }
        if (lastMediaType === "image" && lastMediaSource) {
            showImageSource(lastMediaSource);
            return;
        }
        if (latestCurrentVideoFileName) {
            resolveAndShowCurrentVideo(latestCurrentVideoFileName);
        }
    }

    function showImageSource(src) {
        if (!src) {
            return;
        }
        const normalizedSrc = String(src);
        markOverlayMediaVisibleState();
        hideAllMedia();
        startFirstFrameWait();
        $image.attr("src", normalizedSrc).removeClass("d-none");
        imageStreamNeedsReplay = false;
        lastImageReplayAttemptAt = 0;
        lastMediaType = "image";
        lastMediaSource = normalizedSrc;
        mediaPlaybackPaused = false;
        mediaHiddenByUser = false;
        setCloseButtonToShowMode(false);
        showOverlay();

        const imageElement = $image[0];
        if (imageElement && imageElement.naturalWidth > 0 && imageElement.naturalHeight > 0) {
            lastMediaAspectRatio = imageElement.naturalWidth / imageElement.naturalHeight;
            applyCompactOverlayWidthByAspect(lastMediaAspectRatio);
        }

        updateVideoControlButtons();
    }

    function freezeCurrentImageFrameForPause() {
        const imageElement = $image[0];
        if (!imageElement || !imageElement.naturalWidth || !imageElement.naturalHeight) {
            return false;
        }

        try {
            const canvas = document.createElement("canvas");
            canvas.width = imageElement.naturalWidth;
            canvas.height = imageElement.naturalHeight;

            const context = canvas.getContext("2d");
            if (!context) {
                return false;
            }

            context.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
            const snapshotDataUrl = canvas.toDataURL("image/jpeg", 0.92);
            if (!snapshotDataUrl) {
                return false;
            }

            $image.attr("src", snapshotDataUrl).removeClass("d-none");
            return true;
        } catch (error) {
            return false;
        }
    }

    function showVideoSource(src) {
        if (!src) {
            return;
        }
        const normalizedSrc = String(src);

        // road_detect_stream returns stream frames that are better rendered by img.
        if (shouldRenderAsImageStream(normalizedSrc)) {
            showImageSource(normalizedSrc);
            return;
        }

        markOverlayMediaVisibleState();
        hideAllMedia();
        startFirstFrameWait();
        $video.prop("loop", autoReplayEnabled);
        $video.attr("src", normalizedSrc).removeClass("d-none");
        lastMediaType = "video";
        lastMediaSource = normalizedSrc;
        mediaPlaybackPaused = false;
        mediaHiddenByUser = false;
        setCloseButtonToShowMode(false);

        if ($video[0] && typeof $video[0].load === "function") {
            $video[0].load();
        }
        if ($video[0] && typeof $video[0].play === "function") {
            const playPromise = $video[0].play();
            if (playPromise && typeof playPromise.catch === "function") {
                playPromise.catch(function () {
                    // Ignore autoplay policy rejections.
                });
            }
        }

        updateVideoControlButtons();

        showOverlay();

        const videoElement = $video[0];
        if (videoElement && videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
            lastMediaAspectRatio = videoElement.videoWidth / videoElement.videoHeight;
            applyCompactOverlayWidthByAspect(lastMediaAspectRatio);
        }
    }

    function handleOverlayMqttTopic(topic, value) {
        const topicText = String(topic || "").trim();

        if (topicText === "vehicle/current_video/file_name") {
            writeCurrentVideoSelectionState(value);
            resolveAndShowCurrentVideo(value);
            return;
        }

        if (topicText === "ai/road/overlay/show") {
            applyDefaultOverlayLayout();
            if (toBoolean(value)) {
                showOverlay();
            } else {
                hideOverlay();
            }
            return;
        }

        if (topicText === "ai/road/overlay/image_url") {
            applyDefaultOverlayLayout();
            showImageSource(String(value || ""));
            return;
        }

        if (topicText === "ai/road/overlay/video_url") {
            applyDefaultOverlayLayout();
            showVideoSource(String(value || ""));
            return;
        }

        if (topicText === "ai/road/overlay/frame_b64") {
            applyDefaultOverlayLayout();
            const base64 = String(value || "").trim();
            if (!base64) {
                return;
            }
            showImageSource("data:image/jpeg;base64," + base64);
            return;
        }
    }

    const originalProcessMqtt = window.prcessMqttMessage;
    window.prcessMqttMessage = function (topic, value) {
        if (typeof originalProcessMqtt === "function") {
            originalProcessMqtt(topic, value);
        }
        handleOverlayMqttTopic(topic, value);
    };

    window.setRoadDetectOverlayImage = function (src) {
        showImageSource(src);
    };

    window.setRoadDetectOverlayVideo = function (src) {
        showVideoSource(src);
    };

    window.hideRoadDetectOverlay = function () {
        hideOverlay();
    };

    window.showRoadDetectOverlay = function () {
        showOverlay();
    };

    $closeButton.on("click", function () {
        hideMediaAreaOnly();
    });

    $playToggleButton.on("click", function () {
        const hasSelectedVideoFile = !!String(latestCurrentVideoFileName || "").trim();
        const hasKnownMediaSource = !!String(lastMediaSource || "").trim();
        const hasVideoSource = !!String($video.attr("src") || "").trim();
        const hasImageSource = !!String($image.attr("src") || "").trim();
        if (!hasSelectedVideoFile && !hasKnownMediaSource && !hasVideoSource && !hasImageSource) {
            showOverlayToast(NO_SELECTED_VIDEO_MESSAGE, "warning", this);
            return;
        }

        if (mediaHiddenByUser) {
            restoreMediaAreaOnly();
            return;
        }

        const videoElement = $video[0];
        const hasImageMediaSource = !!String(lastMediaSource || "").trim();

        if (lastMediaType === "image" && hasImageMediaSource) {
            if (mediaPlaybackPaused) {
                mediaPlaybackPaused = false;
                setOverlayStatus("", false);

                if (latestCurrentVideoFileName) {
                    resolveAndShowCurrentVideo(latestCurrentVideoFileName);
                } else {
                    const cacheBustSeparator = lastMediaSource.includes("?") ? "&" : "?";
                    showImageSource(`${lastMediaSource}${cacheBustSeparator}t=${Date.now()}`);
                }
            } else {
                mediaPlaybackPaused = true;
                freezeCurrentImageFrameForPause();
                requestRoadDetectSessionCleanup(latestCurrentVideoFileName);
                setOverlayStatus("일시 정지", true);
            }
            updateVideoControlButtons();
            return;
        }

        if (!videoElement || $video.hasClass("d-none")) {
            showTemporaryStatusMessage(FIRST_FRAME_TIMEOUT_MESSAGE);
            return;
        }

        if (!String($video.attr("src") || "").trim()) {
            showTemporaryStatusMessage(FIRST_FRAME_TIMEOUT_MESSAGE);
            return;
        }

        if (videoElement.paused || videoElement.ended) {
            mediaPlaybackPaused = false;
            clearTemporaryStatusMessage();
            setOverlayStatus("", false);
            if (typeof videoElement.play === "function") {
                const playPromise = videoElement.play();
                if (playPromise && typeof playPromise.catch === "function") {
                    playPromise.catch(function () {
                        // Ignore autoplay policy rejections for manual resume.
                    });
                }
            }
        } else if (typeof videoElement.pause === "function") {
            mediaPlaybackPaused = true;
            videoElement.pause();
            setOverlayStatus("일시 정지", true);
        }

        updateVideoControlButtons();
    });

    $loopToggleButton.on("click", function () {
        autoReplayEnabled = !autoReplayEnabled;
        writeOverlayAutoReplayState(autoReplayEnabled);
        if (autoReplayEnabled && lastMediaType === "image") {
            imageStreamNeedsReplay = false;
            lastImageFrameAt = Date.now();
        }
        updateVideoControlButtons();
    });

    $image.on("load", function () {
        if (!this.naturalWidth || !this.naturalHeight) {
            return;
        }
        imageStreamNeedsReplay = false;
        lastImageFrameAt = Date.now();
        markFirstFrameReady();
        lastMediaAspectRatio = this.naturalWidth / this.naturalHeight;
        applyCompactOverlayWidthByAspect(lastMediaAspectRatio);
    });

    $image.on("error", function () {
        const hasImageSource = !!String($image.attr("src") || "").trim();
        if (mediaHiddenByUser || $image.hasClass("d-none") || !hasImageSource) {
            return;
        }
        imageStreamNeedsReplay = true;
        setOverlayStatus(FIRST_FRAME_TIMEOUT_MESSAGE, true);
    });

    $video.on("loadeddata", function () {
        if (!this.videoWidth || !this.videoHeight) {
            return;
        }
        markFirstFrameReady();
        lastMediaAspectRatio = this.videoWidth / this.videoHeight;
        applyCompactOverlayWidthByAspect(lastMediaAspectRatio);
        updateVideoControlButtons();
    });

    $video.on("play pause", function () {
        mediaPlaybackPaused = this.paused;
        const hasVideoSource = !!String($video.attr("src") || "").trim();
        if (mediaPlaybackPaused && !mediaHiddenByUser && !$video.hasClass("d-none") && hasVideoSource) {
            setOverlayStatus("일시 정지", true);
        } else if (!mediaPlaybackPaused) {
            clearTemporaryStatusMessage();
            setOverlayStatus("", false);
        }
        updateVideoControlButtons();
    });

    $video.on("ended", function () {
        if (autoReplayEnabled && !$video.hasClass("d-none")) {
            replayActiveOverlayMedia();
            updateVideoControlButtons();
            return;
        }

        mediaPlaybackPaused = true;
        try {
            this.loop = false;
        } catch (error) {
            // Ignore loop property issues.
        }
        if (typeof this.pause === "function") {
            try {
                this.pause();
            } catch (error) {
                // Ignore pause issues.
            }
        }
        setOverlayStatus("일시 정지", true);
        updateVideoControlButtons();
    });

    $video.on("error", function () {
        const hasVideoSource = !!String($video.attr("src") || "").trim();
        if (mediaHiddenByUser || $video.hasClass("d-none") || !hasVideoSource) {
            return;
        }
        // Keep loading message until first-frame timeout decides failure.
        showTemporaryStatusMessage(FIRST_FRAME_TIMEOUT_MESSAGE);
    });

    $(window).on("resize", function () {
        if (overlayLayoutMode === "compact") {
            applyCompactOverlayWidthByAspect(lastMediaAspectRatio);
            applyVehicleViewerDragByOverlayHeight();
            applyVehicleViewerZoomByOverlayMode();
        }
    });

    window.addEventListener("pagehide", requestCleanupOnPageExit, { capture: true });
    window.addEventListener("beforeunload", requestCleanupOnPageExit, { capture: true });

    mediaHiddenByUser = readOverlayMediaHiddenState();
    autoReplayEnabled = readOverlayAutoReplayState();
    setCloseButtonToShowMode(mediaHiddenByUser);
    updateVideoControlButtons();
    if (mediaHiddenByUser) {
        applyCollapsedOverlayLayout();
        showOverlay();
    }
    if (showVideoOverlayEnabled && $overlay.hasClass("d-none") && !hasStoredOverlayMediaHiddenState) {
        mediaHiddenByUser = true;
        writeOverlayMediaHiddenState(true);
        setCloseButtonToShowMode(true);
        updateVideoControlButtons();
        applyCollapsedOverlayLayout();
        showOverlay();
    }
    updateOverlayAudioHud();
    requestRoadDetectSessionCleanupAllOnLoad();
    const savedCurrentVideoSelection = readCurrentVideoSelectionState();
    if (savedCurrentVideoSelection) {
        resolveAndShowCurrentVideo(savedCurrentVideoSelection);
    }
    setInterval(updateOverlayAudioHud, 400);
    setInterval(attemptImageStreamAutoReplay, 500);
})();
