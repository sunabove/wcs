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
    let $currentVideoOverlay = $();
    let $currentVideoText = $();
    let currentVideoResolveToken = 0;
    let overlayLayoutMode = "default";
    const overlayInlineStyle = "position:absolute;top:8px;left:8px;right:8px;z-index:15;pointer-events:none;display:flex;justify-content:center;align-items:flex-start;";
    const textInlineStyle = "display:inline-block;max-width:min(90%, 760px);padding:0.3rem 0.55rem;border-radius:0.4rem;color:#f8f9fa;background:rgba(11, 18, 32, 0.78);font-size:0.84rem;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;";

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

    function ensureCurrentVideoOverlay() {
        if (!showVideoOverlayEnabled || $viewer.length === 0) {
            return;
        }
        if ($currentVideoOverlay.length > 0 && $currentVideoText.length > 0) {
            return;
        }

        const $host = $viewer.closest(".position-relative").first();
        if ($host.length === 0) {
            return;
        }

        let $existing = $host.find("#urdf-current-video-overlay").first();
        if ($existing.length === 0) {
            $existing = $('<div id="urdf-current-video-overlay" style="' + overlayInlineStyle + '"></div>');
            $existing.append('<span id="urdf-current-video-file-name" style="' + textInlineStyle + '">현재 동영상: -</span>');
            $host.append($existing);
        } else {
            $existing.attr("style", overlayInlineStyle);
        }

        $currentVideoOverlay = $existing;
        $currentVideoText = $existing.find("#urdf-current-video-file-name").first();
        if ($currentVideoText.length > 0) {
            $currentVideoText.attr("style", textInlineStyle);
        }
    }

    function updateCurrentVideoOverlay(fileName) {
        if (!showVideoOverlayEnabled) {
            return;
        }

        ensureCurrentVideoOverlay();
        if ($currentVideoText.length === 0) {
            return;
        }

        const normalized = String(fileName || "").trim();
        const displayName = normalized || "-";
        $currentVideoText.text("현재 동영상: " + displayName);
        $currentVideoText.attr("title", displayName);
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

    function showOverlay() {
        $overlay.removeClass("d-none");
    }

    function hideOverlay() {
        hideAllMedia();
        $overlay.addClass("d-none");
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
            updateCurrentVideoOverlay(value);
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

    ensureCurrentVideoOverlay();

    $closeButton.on("click", function () {
        hideOverlay();
    });
})();
