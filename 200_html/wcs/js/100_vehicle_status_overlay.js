(function () {
    const $overlay = $("#road-detect-overlay");
    const $closeButton = $("#road-detect-overlay-close");
    const $showButton = $("#road-detect-overlay-show");
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

    function resolveAndShowCurrentVideo(fileName) {
        if (!showVideoOverlayEnabled) {
            return;
        }

        const normalizedFile = normalizePath(fileName);
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

    function hideAllMedia() {
        $image.attr("src", "").addClass("d-none");

        if ($video[0] && typeof $video[0].pause === "function") {
            $video[0].pause();
        }
        $video.attr("src", "").addClass("d-none");
    }

    function syncShowButtonVisibility() {
        if ($showButton.length === 0) {
            return;
        }

        // showVideo 옵션이 꺼져 있으면 보이기 버튼도 숨김
        if (!showVideoOverlayEnabled) {
            $showButton.addClass("d-none");
            return;
        }

        const isOverlayHidden = $overlay.hasClass("d-none");
        $showButton.toggleClass("d-none", !isOverlayHidden);
    }

    function showOverlay() {
        $overlay.removeClass("d-none");
        syncShowButtonVisibility();
    }

    function hideOverlay() {
        hideAllMedia();
        $overlay.addClass("d-none");
        syncShowButtonVisibility();
    }

    function showImageSource(src) {
        if (!src) {
            return;
        }
        hideAllMedia();
        $image.attr("src", String(src)).removeClass("d-none");
        showOverlay();
    }

    function showVideoSource(src) {
        if (!src) {
            return;
        }
        hideAllMedia();
        $video.attr("src", String(src)).removeClass("d-none");

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

    $showButton.on("click", function () {
        showOverlay();
    });

    $closeButton.on("click", function () {
        hideOverlay();

        // 닫기 버튼 클릭 직후에는 보이기 버튼을 즉시 노출한다.
        if ($showButton.length > 0 && showVideoOverlayEnabled) {
            $showButton.removeClass("d-none");
        }
    });

    syncShowButtonVisibility();
})();
