(function () {
    const $overlay = $("#road-detect-overlay");
    const $closeButton = $("#road-detect-overlay-close");
    const $status = $("#road-detect-overlay-status");
    const $image = $("#road-detect-overlay-image");
    const $video = $("#road-detect-overlay-video");
    const $viewer = $("#vehicle-urdf-viewer");
    const VEHICLE_AUDIO_STORAGE_KEY = "wcs.vehicle.showAudio";
    const OVERLAY_MEDIA_HIDDEN_STORAGE_KEY = "wcs.status.overlay.media_hidden";

    if ($overlay.length === 0 || $image.length === 0 || $video.length === 0) {
        return;
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
    let lastMediaType = "";
    let lastMediaSource = "";
    let lastMediaAspectRatio = 16 / 9;
    let cleanupRequest = null;
    let firstFrameTimeoutId = null;
    let firstFrameRequestToken = 0;
    const FIRST_FRAME_TIMEOUT_MS = 10000;
    const LOADING_MESSAGE = "로딩중입니다.";
    const FIRST_FRAME_TIMEOUT_MESSAGE = "동영상 로딩이 되지 않았습니다.";

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
            padding: "4px 10px",
            borderRadius: "999px",
            background: "rgba(108, 117, 125, 0.72)",
            color: "#fff",
            fontSize: "12px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            pointerEvents: "none",
        });
        $viewer.parent().append($audioHud);
    }

    function setCloseButtonToShowMode(isShowMode) {
        $closeButton.text(isShowMode ? "동영상" : "닫기");
    }

    function readOverlayMediaHiddenState() {
        try {
            const rawValue = window.localStorage.getItem(OVERLAY_MEDIA_HIDDEN_STORAGE_KEY);
            const normalized = String(rawValue || "").trim().toLowerCase();
            return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
        } catch (error) {
            return false;
        }
    }

    function writeOverlayMediaHiddenState(hidden) {
        try {
            window.localStorage.setItem(OVERLAY_MEDIA_HIDDEN_STORAGE_KEY, hidden ? "true" : "false");
        } catch (error) {
            // Ignore storage write failures.
        }
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
        const titleText = audioEnabled ? "음성 ON" : "음성 OFF";
        $audioHud.text(titleText + " | " + speechText);
        $audioHud.css("background", audioEnabled ? "rgba(25, 135, 84, 0.70)" : "rgba(108, 117, 125, 0.72)");
    }

    function setOverlayStatus(message, visible) {
        if ($status.length === 0) {
            return;
        }
        const text = String(message || "").trim();
        if (text) {
            $status.text(text);
        }
        $status.toggleClass("d-none", !visible);
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
        setOverlayStatus("", false);
    }

    function normalizePath(pathValue) {
        return String(pathValue || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    }

    function extractVideoFileName(pathValue) {
        const normalizedPath = normalizePath(pathValue);
        if (!normalizedPath) {
            return "";
        }

        const segments = normalizedPath.split("/").filter(function (segment) {
            return segment.length > 0;
        });
        return segments.length > 0 ? segments[segments.length - 1] : "";
    }

    function buildRoadDetectStreamUrl(fileName) {
        const safeFileName = extractVideoFileName(fileName);
        if (!safeFileName) {
            return "";
        }

        return "http://ai/fast/road_detect_stream/samples/video/cobot/" + encodeURIComponent(safeFileName) + "?" + $.param({
            detect_type: "road_type",
            remove_noisy_masks: true,
            show_time_bar: true,
            include_pothole: true,
            pothole_conf: 0.45,
            mqtt_publish: true,
            t: Date.now(),
        });
    }

    function buildRoadDetectStreamCleanupUrl(fileName) {
        const safeFileName = extractVideoFileName(fileName);
        if (!safeFileName) {
            return "";
        }

        return "http://ai/fast/road_detect_stream_cleanup/samples/video/cobot/" + encodeURIComponent(safeFileName) + "?" + $.param({
            t: Date.now(),
        });
    }

    function buildRoadDetectStreamCleanupUrlByPath(filePath) {
        const normalizedPath = normalizePath(filePath);
        if (!normalizedPath) {
            return "";
        }

        return "http://ai/fast/road_detect_stream_cleanup/" + normalizedPath.split("/").map(function (segment) {
            return encodeURIComponent(segment);
        }).join("/") + "?" + $.param({
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

    function requestRoadDetectSessionCleanup(fileName) {
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
            url: "http://ai/fast/road_detect_stream_cleanup_all?" + $.param({ t: Date.now() }),
            method: "POST",
            timeout: 3000,
        }).fail(function () {
            // Ignore startup cleanup failures; overlay can still work without this.
        });
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
    }

    function applyCompactOverlayLayout() {
        if (overlayLayoutMode === "compact") {
            return;
        }

        const initialWidth = getCompactOverlayInitialWidth(lastMediaAspectRatio);

        // Top-center compact overlay, constrained to less than half of viewer size.
        $overlay.attr(
            "style",
            "inset:auto;top:10px;left:50%;transform:translateX(-50%);width:" + initialWidth + "px;height:min(46%, 420px);z-index:20;display:flex;flex-direction:column;background:rgba(0,0,0,0.82);border-radius:1rem;overflow:hidden;"
        );
        overlayLayoutMode = "compact";
        applyCompactOverlayWidthByAspect(lastMediaAspectRatio);
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
            "inset:auto;top:10px;left:50%;transform:translateX(-50%);width:" + collapsedWidth + ";height:52px;z-index:20;display:block;background:transparent;border-radius:0;overflow:visible;"
        );
        overlayLayoutMode = "collapsed";
    }

    function resolveAndShowCurrentVideo(fileName) {
        if (!showVideoOverlayEnabled) {
            return;
        }

        const normalizedFile = normalizePath(fileName);
        latestCurrentVideoFileName = normalizedFile;

        // 사용자가 미디어 영역을 숨긴 상태에서는 자동으로 다시 열지 않는다.
        if (mediaHiddenByUser) {
            applyCollapsedOverlayLayout();
            setCloseButtonToShowMode(true);
            showOverlay();
            return;
        }

        if (!normalizedFile) {
            hideOverlay();
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
            markFirstFrameReady();
        }
        $image.attr("src", "").addClass("d-none");

        if ($video[0] && typeof $video[0].pause === "function") {
            $video[0].pause();
        }
        $video.attr("src", "").addClass("d-none");
        if (resetMemory) {
            setOverlayStatus("", false);
        }
    }

    function showOverlay() {
        $overlay.removeClass("d-none");
    }

    function hideOverlay() {
        requestRoadDetectSessionCleanup(latestCurrentVideoFileName);
        setCloseButtonToShowMode(mediaHiddenByUser);
        hideAllMedia(true);
        setOverlayStatus("", false);
        $overlay.addClass("d-none");
    }

    function hideMediaAreaOnly() {
        requestRoadDetectSessionCleanup(latestCurrentVideoFileName);
        mediaHiddenByUser = true;
        writeOverlayMediaHiddenState(true);
        hideAllMedia(false);
        setOverlayStatus("", false);
        applyCollapsedOverlayLayout();
        setCloseButtonToShowMode(true);
    }

    function restoreMediaAreaOnly() {
        mediaHiddenByUser = false;
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
        hideAllMedia();
        startFirstFrameWait();
        $image.attr("src", normalizedSrc).removeClass("d-none");
        lastMediaType = "image";
        lastMediaSource = normalizedSrc;
        mediaHiddenByUser = false;
        setCloseButtonToShowMode(false);
        showOverlay();

        const imageElement = $image[0];
        if (imageElement && imageElement.naturalWidth > 0 && imageElement.naturalHeight > 0) {
            lastMediaAspectRatio = imageElement.naturalWidth / imageElement.naturalHeight;
            applyCompactOverlayWidthByAspect(lastMediaAspectRatio);
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

        hideAllMedia();
        startFirstFrameWait();
        $video.attr("src", normalizedSrc).removeClass("d-none");
        lastMediaType = "video";
        lastMediaSource = normalizedSrc;
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
        if (mediaHiddenByUser) {
            restoreMediaAreaOnly();
        } else {
            hideMediaAreaOnly();
        }
    });

    $image.on("load", function () {
        if (!this.naturalWidth || !this.naturalHeight) {
            return;
        }
        markFirstFrameReady();
        lastMediaAspectRatio = this.naturalWidth / this.naturalHeight;
        applyCompactOverlayWidthByAspect(lastMediaAspectRatio);
    });

    $image.on("error", function () {
        // Keep loading message until first-frame timeout decides failure.
    });

    $video.on("loadeddata", function () {
        if (!this.videoWidth || !this.videoHeight) {
            return;
        }
        markFirstFrameReady();
        lastMediaAspectRatio = this.videoWidth / this.videoHeight;
        applyCompactOverlayWidthByAspect(lastMediaAspectRatio);
    });

    $video.on("error", function () {
        // Keep loading message until first-frame timeout decides failure.
    });

    $(window).on("resize", function () {
        if (overlayLayoutMode === "compact") {
            applyCompactOverlayWidthByAspect(lastMediaAspectRatio);
        }
    });

    mediaHiddenByUser = readOverlayMediaHiddenState();
    setCloseButtonToShowMode(mediaHiddenByUser);
    if (mediaHiddenByUser) {
        applyCollapsedOverlayLayout();
        showOverlay();
    }
    updateOverlayAudioHud();
    requestRoadDetectSessionCleanupAllOnLoad();
    setInterval(updateOverlayAudioHud, 400);
})();
