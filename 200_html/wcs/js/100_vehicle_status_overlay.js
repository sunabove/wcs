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
            $existing = $('<div id="urdf-current-video-overlay" class="urdf-video-file-overlay"></div>');
            $existing.append('<span id="urdf-current-video-file-name" class="urdf-video-file-text">현재 동영상: -</span>');
            $host.append($existing);
        }

        $currentVideoOverlay = $existing;
        $currentVideoText = $existing.find("#urdf-current-video-file-name").first();
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
            return;
        }

        if (topicText === "ai/road/overlay/show") {
            if (toBoolean(value)) {
                showOverlay();
            } else {
                hideOverlay();
            }
            return;
        }

        if (topicText === "ai/road/overlay/image_url") {
            showImageSource(String(value || ""));
            return;
        }

        if (topicText === "ai/road/overlay/video_url") {
            showVideoSource(String(value || ""));
            return;
        }

        if (topicText === "ai/road/overlay/frame_b64") {
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
