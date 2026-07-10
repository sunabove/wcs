(function () {
    const $overlay = $("#road-detect-overlay");
    const $closeButton = $("#road-detect-overlay-close");
    const $image = $("#road-detect-overlay-image");
    const $video = $("#road-detect-overlay-video");
    const $viewer = $("#vehicle-urdf-viewer");

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
    let currentVideoResolveToken = 0;
    let overlayLayoutMode = "default";
    let latestCurrentVideoFileName = "";
    let mediaHiddenByUser = false;
    let lastMediaType = "";
    let lastMediaSource = "";

    function setCloseButtonToShowMode(isShowMode) {
        $closeButton.text(isShowMode ? "보이기" : "닫기");
    }

    function normalizePath(pathValue) {
        return String(pathValue || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
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

    function toAbsoluteUrl(url) {
        try {
            return new URL(String(url || ""), window.location.origin).toString();
        } catch (error) {
            return "";
        }
    }

    function buildVideoPlayableUrl(fileName) {
        const encodedPath = encodePathForRoute(fileName);
        if (!encodedPath) {
            return "";
        }

        return "/fast/video_playable/" + encodedPath + "?" + $.param({ force_transcode: false });
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

        // Top-center compact overlay, constrained to less than half of viewer size.
        $overlay.attr(
            "style",
            "inset:auto;top:10px;left:50%;transform:translateX(-50%);width:min(50%, 760px);height:min(46%, 420px);z-index:20;display:flex;flex-direction:column;background:rgba(0,0,0,0.82);border-radius:1rem;overflow:hidden;"
        );
        overlayLayoutMode = "compact";
    }

    function applyCollapsedOverlayLayout() {
        if (overlayLayoutMode === "collapsed") {
            return;
        }

        // Media hidden mode: keep only a small top-center area for the toggle button.
        $overlay.attr(
            "style",
            "inset:auto;top:10px;left:50%;transform:translateX(-50%);width:min(50%, 760px);height:52px;z-index:20;display:block;background:transparent;border-radius:0;overflow:visible;"
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
            return;
        }

        if (!normalizedFile) {
            hideOverlay();
            return;
        }

        const playableApiUrl = buildVideoPlayableUrl(normalizedFile);
        if (!playableApiUrl) {
            return;
        }

        const requestToken = ++currentVideoResolveToken;
        $.ajax({
            url: playableApiUrl,
            method: "GET",
        }).done(function (result) {
            if (requestToken !== currentVideoResolveToken) {
                return;
            }

            const resolvedUrl = toAbsoluteUrl(result && result.video_url);
            if (!resolvedUrl) {
                return;
            }

            applyCompactOverlayLayout();
            showVideoSource(resolvedUrl);
        }).fail(function () {
            // Keep title overlay even when video URL resolving fails.
        });
    }

    function hideAllMedia(resetMemory = true) {
        if (resetMemory) {
            lastMediaType = "";
            lastMediaSource = "";
        }
        $image.attr("src", "").addClass("d-none");

        if ($video[0] && typeof $video[0].pause === "function") {
            $video[0].pause();
        }
        $video.attr("src", "").addClass("d-none");
    }

    function showOverlay() {
        $overlay.removeClass("d-none");
    }

    function hideOverlay() {
        mediaHiddenByUser = false;
        setCloseButtonToShowMode(false);
        hideAllMedia(true);
        $overlay.addClass("d-none");
    }

    function hideMediaAreaOnly() {
        mediaHiddenByUser = true;
        hideAllMedia(false);
        applyCollapsedOverlayLayout();
        setCloseButtonToShowMode(true);
    }

    function restoreMediaAreaOnly() {
        mediaHiddenByUser = false;
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
        $image.attr("src", normalizedSrc).removeClass("d-none");
        lastMediaType = "image";
        lastMediaSource = normalizedSrc;
        mediaHiddenByUser = false;
        setCloseButtonToShowMode(false);
        showOverlay();
    }

    function showVideoSource(src) {
        if (!src) {
            return;
        }
        const normalizedSrc = String(src);
        hideAllMedia();
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

    setCloseButtonToShowMode(false);
})();
