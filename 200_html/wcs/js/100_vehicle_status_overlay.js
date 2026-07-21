(function () {
    const $overlay = $("#road-detect-overlay");
    const $closeButton = $("#road-detect-overlay-close");
    const $playToggleButton = $("#road-detect-overlay-play-toggle");
    const $status = $("#road-detect-overlay-status");
    const $image = $("#road-detect-overlay-image");
    const $video = $("#road-detect-overlay-video");
    const $viewer = $("#vehicle-urdf-viewer");
    const VEHICLE_AUDIO_STORAGE_KEY = "wcs.vehicle.showAudio";
    const OVERLAY_MEDIA_HIDDEN_STORAGE_KEY = "wcs.status.overlay.media_hidden";

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
    let lastMediaType = "";
    let lastMediaSource = "";
    let lastMediaAspectRatio = 16 / 9;
    let cleanupRequest = null;
    let firstFrameTimeoutId = null;
    let firstFrameRequestToken = 0;
    let audioHudBlinkPhase = false;
    const FIRST_FRAME_TIMEOUT_MS = 10000;
    const LOADING_MESSAGE = "로딩중입니다.";
    const FIRST_FRAME_TIMEOUT_MESSAGE = "동영상 로딩이 되지 않았습니다.";
    const VIEWER_DRAG_PIXELS_RATIO = 0.47;
    const VIEWER_ZOOM_OUT_RATIO = 0.07;

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

    function setCloseButtonToShowMode(isShowMode) {
        if (isShowMode) {
            $closeButton
                .attr("title", "동영상 다시 보기")
                .attr("aria-label", "동영상 다시 보기")
                .html('<i class="bi bi-play-btn-fill overlay-toggle-icon overlay-toggle-icon-video" aria-hidden="true"></i>');
            return;
        }

        $closeButton
            .attr("title", "오버레이 닫기")
            .attr("aria-label", "오버레이 닫기")
            .html('<i class="bi bi-x-lg overlay-toggle-icon overlay-toggle-icon-close" aria-hidden="true"></i>');
    }

    function updateVideoControlButtons() {
        if ($playToggleButton.length === 0 || $video.length === 0) {
            return;
        }

        if (mediaHiddenByUser) {
            $playToggleButton.addClass("d-none");
            return;
        }

        $playToggleButton.removeClass("d-none");

        if (lastMediaType === "image") {
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
        const isVideoReady = isVideoVisible && hasVideoSource;
        const isPaused = !isVideoReady || videoElement.paused || videoElement.ended;

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
            url: "/fast/road_detect_stream_cleanup_all?" + $.param({ t: Date.now() }),
            method: "POST",
            timeout: 3000,
        }).fail(function () {
            // Ignore startup cleanup failures; overlay can still work without this.
        });
    }

    function requestRoadDetectSessionCleanupAll() {
        requestRoadDetectSessionCleanupAllOnLoad();
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
            "inset:auto;top:10px;left:50%;transform:translateX(-50%);width:" + initialWidth + "px;height:min(46%, 420px);z-index:20;display:flex;flex-direction:column;background:rgba(0,0,0,0.82);border-radius:1rem;overflow:hidden;"
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
            "inset:auto;top:10px;left:50%;transform:translateX(-50%);width:" + collapsedWidth + ";height:52px;z-index:20;display:block;background:transparent;border-radius:0;overflow:visible;"
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

        // 사용자가 미디어 영역을 숨긴 상태에서는 자동으로 다시 열지 않는다.
        if (mediaHiddenByUser) {
            applyCollapsedOverlayLayout();
            setCloseButtonToShowMode(true);
            showOverlay();
            return;
        }

        if (!normalizedFile) {
            requestRoadDetectSessionCleanupAll();
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
            mediaPlaybackPaused = false;
            markFirstFrameReady();
        }
        $image.attr("src", "").addClass("d-none");

        if ($video[0] && typeof $video[0].pause === "function") {
            $video[0].pause();
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
        requestRoadDetectSessionCleanup(latestCurrentVideoFileName);
        setCloseButtonToShowMode(mediaHiddenByUser);
        hideAllMedia(true);
        setOverlayStatus("", false);
        $overlay.addClass("d-none");
    }

    function hideMediaAreaOnly() {
        requestRoadDetectSessionCleanup(latestCurrentVideoFileName);
        mediaHiddenByUser = true;
        mediaPlaybackPaused = false;
        writeOverlayMediaHiddenState(true);
        hideAllMedia(false);
        setOverlayStatus("", false);
        applyCollapsedOverlayLayout();
        setCloseButtonToShowMode(true);
    }

    function restoreMediaAreaOnly() {
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
        hideAllMedia();
        startFirstFrameWait();
        $image.attr("src", normalizedSrc).removeClass("d-none");
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

    $playToggleButton.on("click", function () {
        const videoElement = $video[0];
        const hasImageSource = !!String(lastMediaSource || "").trim();

        if (lastMediaType === "image" && hasImageSource) {
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
                requestRoadDetectSessionCleanup(latestCurrentVideoFileName);
                setOverlayStatus("일시 정지", true);
                $image.addClass("d-none");
            }
            updateVideoControlButtons();
            return;
        }

        if (!videoElement || $video.hasClass("d-none")) {
            return;
        }

        if (videoElement.paused || videoElement.ended) {
            mediaPlaybackPaused = false;
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
        }

        updateVideoControlButtons();
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
        updateVideoControlButtons();
    });

    $video.on("play pause ended", function () {
        mediaPlaybackPaused = this.paused || this.ended;
        updateVideoControlButtons();
    });

    $video.on("error", function () {
        // Keep loading message until first-frame timeout decides failure.
    });

    $(window).on("resize", function () {
        if (overlayLayoutMode === "compact") {
            applyCompactOverlayWidthByAspect(lastMediaAspectRatio);
            applyVehicleViewerDragByOverlayHeight();
            applyVehicleViewerZoomByOverlayMode();
        }
    });

    mediaHiddenByUser = readOverlayMediaHiddenState();
    setCloseButtonToShowMode(mediaHiddenByUser);
    updateVideoControlButtons();
    if (mediaHiddenByUser) {
        applyCollapsedOverlayLayout();
        showOverlay();
    }
    updateOverlayAudioHud();
    requestRoadDetectSessionCleanupAllOnLoad();
    setInterval(updateOverlayAudioHud, 400);
})();
