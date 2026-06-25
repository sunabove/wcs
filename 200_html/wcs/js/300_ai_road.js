$(function () {
    const $dropZone = $("#image-drop-zone");
    const $fileInput = $("#road-image-input");
    const $selectedFileLabel = $("#selected-image-name");
    const $uploadedImagePreview = $("#original-image-preview");
    const $uploadedVideoPreview = $("#original-video-preview");
    const $detectedImagePreview = $("#detected-image-preview");
    const $detectedVideoPreview = $("#detected-video-preview");
    const $detectedStreamControls = $("#detected-stream-controls");
    const $detectedStreamRestartButton = $("#detected-stream-restart");
    const $detectedStreamPauseButton = $("#detected-stream-pause");
    const $detectedStreamResumeButton = $("#detected-stream-resume");
    const $detectedVideoDownloadButton = $("#detected-video-download");
    const $detectedImageDownloadWrap = $("#detected-image-download-wrap");
    const $detectedImageDownloadButton = $("#detected-image-download");
    const $detectedStreamFrameInput = $("#detected-stream-frame-input");
    const $detectedStreamFrameValue = $("#detected-stream-frame-value");
    const $detectedStreamFrameLabel = $("#detected-stream-frame-label");
    const $downloadProgressContainer = $("#download-progress-container");
    const $downloadProgressBar = $("#download-progress-bar");
    const $downloadProgressText = $("#download-progress-text");
    const $downloadProgressInfo = $("#download-progress-info");
    const $roiOverlay = $("#roi-overlay");
    const $roiSelection = $("#roi-selection");
    const $roiFullButton = $("#roi-full-button");
    const $roiResetButton = $("#roi-reset-button");
    const $roiEditorStatus = $("#roi-editor-status");
    const $originalImageTab = $("#original-image-tab");
    const $detectedImageTab = $("#detected-image-tab");
    const $workStatusTab = $("#work-status-tab");
    const $workStatusPaneMessage = $("#work-status-pane-message");
    const $originalLiveBadge = $("#original-live-badge");
    const $detectedLiveBadge = $("#detected-live-badge");
    const $uploadingIndicator = $("#working-indicator");
    const $uploadStatusMessage = $("#work-status-message");
    const $detectingIndicator = $("#detecting-indicator");
    const $detectTypeInputs = $("input[name='detect-type']");
    const $removeNoisyMasks = $("#remove-noisy-masks");
    const $showDetectStatsChart = $("#show-detect-stats-chart");
    const $cameraPane = $("#input-camera-pane");
    const $cameraTab = $("#input-camera-tab");
    const $cameraDeviceList = $("#camera-device-list");
    const $sampleImagePane = $("#input-sample-image-pane");
    const $sampleImageTab = $("#input-sample-image-tab");
    const $sampleVideoPane = $("#input-sample-video-pane");
    const $sampleVideoTab = $("#input-sample-video-tab");
    const sampleImageItemTemplate = document.getElementById("sample-image-item-template");
    const sampleVideoItemTemplate = document.getElementById("sample-video-item-template");
    const cameraDeviceItemTemplate = document.getElementById("camera-device-item-template");
    const cameraDeviceListContainerTemplate = document.getElementById("camera-device-list-container-template");
    const DETECT_AFTER_UPLOAD_DELAY_MS = 800;
    const DETECT_OPTIONS_STORAGE_KEY = "wcs.ai_road.detect_options.v1";
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
            $video.attr("src", "").addClass("d-none").css("aspect-ratio", "");
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
                $video.css("aspect-ratio", "").attr("src", url).removeClass("d-none");
                if ($video[0] && typeof $video[0].load === "function") {
                    $video[0].load();
                }
            }
            return;
        }

        if ($video && $video.length > 0) {
            $video.attr("src", "").addClass("d-none").css("aspect-ratio", "");
            if ($video[0] && typeof $video[0].pause === "function") {
                $video[0].pause();
            }
        }
        if ($img && $img.length > 0) {
            $img.attr("src", url).removeClass("d-none");
        }

        requestAnimationFrame(syncRoiOverlay);
    }

    function triggerBrowserDownload(url) {
        if (!url) {
            return;
        }

        // Use top-level navigation to make browser download handling more reliable
        // for large files than hidden iframe auto-download.
        window.location.assign(url);
    }

    function setupSampleVideoThumbnail(video) {
        if (!video || video.dataset.thumbnailReady === "1") {
            return;
        }

        video.dataset.thumbnailReady = "1";
        video.muted = true;
        video.playsInline = true;

        let didSeekPreview = false;

        function resolvePreviewTime(duration) {
            if (!Number.isFinite(duration) || duration <= 0) {
                return 0;
            }

            const preferred = Math.max(0.15, duration * 0.03);
            const upperBound = Math.max(0, duration - 0.05);
            return Math.min(preferred, upperBound, 1.5);
        }

        function seekForPreview() {
            if (didSeekPreview) {
                return;
            }

            const previewTime = resolvePreviewTime(Number(video.duration));
            if (previewTime <= 0) {
                return;
            }

            try {
                video.currentTime = previewTime;
                didSeekPreview = true;
            } catch (error) {
                // Ignore seek timing errors; browser will keep default preview frame.
            }
        }

        video.addEventListener("loadedmetadata", seekForPreview, { once: true });
        video.addEventListener("loadeddata", seekForPreview, { once: true });
        video.addEventListener("seeked", function () {
            if (typeof video.pause === "function") {
                video.pause();
            }
        }, { once: true });
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
        $roiFullButton.prop("disabled", !hasRoi);
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

        if ($workStatusTab.length > 0) {
            $workStatusTab.prop("disabled", false);
        }

        $uploadStatusMessage
            .removeClass("d-none text-success text-danger")
            .addClass(isSuccess ? "text-success" : "text-danger")
            .text(message);

        if ($workStatusPaneMessage.length > 0) {
            $workStatusPaneMessage
                .removeClass("text-muted text-success text-danger")
                .addClass(isSuccess ? "text-success" : "text-danger")
                .text(message || "대기 중...");
        }
    }

    function updateDetectedStreamControls() {
        const isVideo = Boolean(uploadedFileName) && isVideoPath(uploadedFileName);
        const isImage = Boolean(uploadedFileName) && !isVideo;

        $detectedImageDownloadWrap.toggleClass("d-none", !isImage);
        $detectedImageDownloadButton.prop("disabled", !isImage || isDetecting);

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
        const canRestart = hasSession && totalFrames > 0;
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

        $detectedStreamRestartButton.prop("disabled", !canRestart);
        $detectedStreamPauseButton.prop("disabled", !canPause);
        $detectedStreamResumeButton.prop("disabled", !canResume);
        $detectedStreamFrameInput.prop("disabled", !hasSession);
        $detectedVideoDownloadButton.prop("disabled", !isVideo || !uploadedFileName);

        $detectedStreamRestartButton
            .toggleClass("btn-outline-primary", canRestart)
            .toggleClass("btn-outline-secondary", !canRestart);
        $detectedStreamPauseButton
            .toggleClass("btn-outline-primary", canPause)
            .toggleClass("btn-outline-secondary", !canPause);
        $detectedStreamResumeButton
            .toggleClass("btn-outline-primary", canResume)
            .toggleClass("btn-outline-secondary", !canResume);

        $detectedStreamRestartButton.find("i")
            .toggleClass("text-primary", canRestart)
            .toggleClass("text-muted", !canRestart);
        $detectedStreamPauseButton.find("i")
            .toggleClass("text-primary", canPause)
            .toggleClass("text-muted", !canPause);
        $detectedStreamResumeButton.find("i")
            .toggleClass("text-primary", canResume)
            .toggleClass("text-muted", !canResume);
    }

    function buildDetectedDownloadFileName(fileName) {
        const normalized = normalizePath(fileName);
        const baseName = normalized.split("/").pop() || "detected_video";
        const dotIndex = baseName.lastIndexOf(".");
        const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
        return stem + "_detected.mp4";
    }

    function buildDetectedImageDownloadFileName(fileName, resultUrl) {
        const normalized = normalizePath(fileName);
        const baseName = normalized.split("/").pop() || "detected_image";
        const dotIndex = baseName.lastIndexOf(".");
        const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;

        const resultPath = normalizePath(String(resultUrl || "").split("?")[0]);
        const resultBase = resultPath.split("/").pop() || "";
        const resultDot = resultBase.lastIndexOf(".");
        const resultExt = resultDot > 0 ? resultBase.slice(resultDot) : "";
        const fallbackExt = dotIndex > 0 ? baseName.slice(dotIndex) : ".jpg";
        const ext = resultExt || fallbackExt;

        return stem + "_detected" + ext;
    }

    function triggerDetectedVideoDownload(fileName) {
        if (!fileName || !isVideoPath(fileName)) {
            showUploadStatusMessage("다운로드할 동영상을 먼저 선택해 주세요.", false);
            return;
        }

        const normalizedTargetFile = normalizePath(fileName);
        const hadVideoStreamSession = Boolean(frameStreamState[normalizedTargetFile]);

        // 전체 파일 다운로드 전, 현재 프레임 검출 출력은 먼저 중지합니다.
        stopActiveFrameProcessing();
        cleanupAllFrameStreams();

        const detectType = getSelectedDetectType();
        const removeNoisyMasks = getRemoveNoisyMasks();
        const showDetectStats = getShowDetectStatsOverlay();
        showUploadStatusMessage("전체 동영상 검출 파일 생성 중... (큰 파일의 경우 수 분이 소요될 수 있습니다)", true);
        setDetectingState(true);
        $detectingIndicator.removeClass("d-none");
        $downloadProgressContainer.removeClass("d-none");
        $downloadProgressBar.css("width", "0%");
        $downloadProgressBar.attr("aria-valuenow", "0");
        $downloadProgressText.text("0%");
        $downloadProgressInfo.text("검출 시작 대기 중...");
        updateDetectedStreamControls();

        // 생성 진행률 폴링 시작
        let pollInterval = null;
        let downloadRequest = null;
        let lastProgressPercent = 0;

        const renderDownloadProgress = function (percent) {
            const numeric = Number(percent);
            const bounded = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
            const stable = Math.max(lastProgressPercent, bounded);
            lastProgressPercent = stable;
            $downloadProgressBar.css("width", String(stable) + "%");
            $downloadProgressBar.attr("aria-valuenow", String(Math.round(stable)));
            $downloadProgressText.text(Math.round(stable) + "%");
        };

        const stopProgressPolling = function () {
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
        };

        const pollGenerationProgress = function() {
            $.ajax({
                url: buildRoadDetectProgressUrl(fileName),
                method: "GET",
                timeout: 5000
            }).done(function(progress) {
                if (progress.status === "not_started") {
                    $downloadProgressInfo.text("검출 시작 대기 중...");
                    return;
                }

                if (progress.total_frames > 0) {
                    const percent = progress.percentage || 0;
                    renderDownloadProgress(percent);
                    
                    const stage = progress.stage || "frame_processing";
                    const stageLabel = stage === "video_encoding" ? "인코딩 중" : "프레임 처리 중";
                    $downloadProgressInfo.text(`${stageLabel}: ${progress.current_frame} / ${progress.total_frames} 프레임 (${Math.round(percent)}%)`);
                }

                // 생성 완료 또는 에러
                if (progress.status === "error") {
                    stopProgressPolling();
                    if (downloadRequest && typeof downloadRequest.abort === "function") {
                        downloadRequest.abort();
                    }
                    showUploadStatusMessage(`검출 생성 실패: ${progress.error}`, false);
                    $downloadProgressContainer.addClass("d-none");
                    setDetectingState(false);
                    $detectingIndicator.addClass("d-none");
                    return;
                }

                if (progress.status === "completed") {
                    stopProgressPolling();
                    renderDownloadProgress(90);
                    $downloadProgressInfo.text("검출 완료. 다운로드 준비 중...");
                }
            }).fail(function(jqXHR) {
                // 폴링 실패는 무시하고 계속 진행
                console.log("Progress poll failed:", jqXHR.status);
            });
        };

        const performVideoDownload = function() {
            downloadRequest = $.ajax({
                url: buildRoadDetectUrl(fileName),
                data: {
                    detect_type: detectType,
                    remove_noisy_masks: removeNoisyMasks,
                    show_detect_stats: showDetectStats,
                },
                method: "GET",
                timeout: 600000,  // 10분 타임아웃
                xhr: function() {
                    const xhr = new window.XMLHttpRequest();
                    xhr.addEventListener("progress", function(e) {
                        if (e.lengthComputable) {
                            const percentComplete = 90 + (e.loaded / e.total) * 10; // 90-100% 범위
                            renderDownloadProgress(percentComplete);
                            
                            const loadedMB = (e.loaded / (1024 * 1024)).toFixed(2);
                            const totalMB = (e.total / (1024 * 1024)).toFixed(2);
                            $downloadProgressInfo.text(`다운로드 중: ${loadedMB} MB / ${totalMB} MB`);
                        }
                    }, false);
                    return xhr;
                }
            }).done(function (result) {
                if (!result || !result.image_url) {
                    showUploadStatusMessage("검출 동영상 생성에 실패했습니다.", false);
                    $downloadProgressContainer.addClass("d-none");
                    return;
                }

                renderDownloadProgress(100);
                $downloadProgressInfo.text("다운로드 완료. 파일을 저장하는 중...");

                const downloadFileName = buildDetectedDownloadFileName(fileName);
                const separator = result.image_url.indexOf("?") >= 0 ? "&" : "?";
                const downloadUrl = result.image_url
                    + separator
                    + $.param({
                        t: Date.now(),
                        download: true,
                        download_name: downloadFileName,
                    });
                triggerBrowserDownload(downloadUrl);

                showUploadStatusMessage("검출 동영상 생성이 완료되어 다운로드를 요청했습니다. 브라우저 다운로드 목록을 확인해 주세요.", true);
                setTimeout(() => {
                    $downloadProgressContainer.addClass("d-none");
                    $downloadProgressBar.css("width", "0%");
                    $downloadProgressBar.attr("aria-valuenow", "0");
                    $downloadProgressText.text("0%");
                    $downloadProgressInfo.text("");
                }, 2000);
            }).fail(function (jqXHR) {
                if (jqXHR.statusText === "abort") {
                    return;
                }

                $downloadProgressContainer.addClass("d-none");
                if (jqXHR.statusText === "timeout") {
                    showUploadStatusMessage("요청 시간이 초과했습니다. 작은 파일로 나누어 시도하거나 나중에 다시 시도해 주세요.", false);
                } else {
                    console.error("Detected video download error:", jqXHR.status, jqXHR.responseText);
                    showUploadStatusMessage("검출 동영상 생성/다운로드에 실패했습니다.", false);
                }
            }).always(function () {
                stopProgressPolling();
                setDetectingState(false);
                $detectingIndicator.addClass("d-none");

                // 다운로드 생성 과정에서 스트림 세션을 정리했으므로,
                // 동일 파일이 계속 선택된 경우 자동으로 재초기화하여 재생 버튼을 복구합니다.
                if (
                    hadVideoStreamSession
                    && normalizePath(uploadedFileName) === normalizedTargetFile
                    && isVideoPath(uploadedFileName)
                ) {
                    initFrameStream(uploadedFileName, detectType, removeNoisyMasks, { startPaused: true });
                }

                updateDetectedStreamControls();
            });
        };

        // 생성 진행률 폴링 시작 (0.5초마다)
        pollInterval = setInterval(pollGenerationProgress, 500);
        
        // 첫 번째 폴링 즉시 실행 + 실제 생성 요청 시작
        pollGenerationProgress();
        performVideoDownload();
    }

    function triggerDetectedImageDownload(fileName) {
        if (!fileName || isVideoPath(fileName)) {
            showUploadStatusMessage("다운로드할 이미지를 먼저 선택해 주세요.", false);
            return;
        }

        const detectType = getSelectedDetectType();
        const removeNoisyMasks = getRemoveNoisyMasks();
        const showDetectStats = getShowDetectStatsOverlay();
        showUploadStatusMessage("검출 이미지 생성 중...", true);
        setDetectingState(true);
        $detectingIndicator.removeClass("d-none");
        $downloadProgressContainer.removeClass("d-none");
        updateDetectedStreamControls();

        $.ajax({
            url: buildRoadDetectUrl(fileName),
            data: {
                detect_type: detectType,
                remove_noisy_masks: removeNoisyMasks,
                show_detect_stats: showDetectStats,
            },
            method: "GET",
            timeout: 600000,  // 10분 타임아웃
            xhr: function() {
                const xhr = new window.XMLHttpRequest();
                xhr.addEventListener("progress", function(e) {
                    if (e.lengthComputable) {
                        const percentComplete = (e.loaded / e.total) * 100;
                        $downloadProgressBar.css("width", String(percentComplete) + "%");
                        $downloadProgressBar.attr("aria-valuenow", String(Math.round(percentComplete)));
                        $downloadProgressText.text(Math.round(percentComplete) + "%");
                        
                        const loadedMB = (e.loaded / (1024 * 1024)).toFixed(2);
                        const totalMB = (e.total / (1024 * 1024)).toFixed(2);
                        $downloadProgressInfo.text(`다운로드 중: ${loadedMB} MB / ${totalMB} MB`);
                    }
                }, false);
                return xhr;
            }
        }).done(function (result) {
            if (!result || !result.image_url) {
                showUploadStatusMessage("검출 이미지 생성에 실패했습니다.", false);
                $downloadProgressContainer.addClass("d-none");
                return;
            }

            $downloadProgressBar.css("width", "100%");
            $downloadProgressBar.attr("aria-valuenow", "100");
            $downloadProgressText.text("100%");
            $downloadProgressInfo.text("다운로드 완료. 파일을 저장하는 중...");

            const downloadUrl = result.image_url + "?t=" + Date.now();
            showMediaPreview(downloadUrl, false, $detectedImagePreview, $detectedVideoPreview);

            const anchor = document.createElement("a");
            anchor.href = downloadUrl;
            anchor.download = buildDetectedImageDownloadFileName(fileName, result.image_url);
            anchor.style.display = "none";
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);

            showUploadStatusMessage("검출 이미지 다운로드를 시작했습니다.", true);
            setTimeout(() => {
                $downloadProgressContainer.addClass("d-none");
                $downloadProgressBar.css("width", "0%");
                $downloadProgressBar.attr("aria-valuenow", "0");
                $downloadProgressText.text("0%");
                $downloadProgressInfo.text("");
            }, 2000);
        }).fail(function (jqXHR) {
            $downloadProgressContainer.addClass("d-none");
            if (jqXHR.statusText === "timeout") {
                showUploadStatusMessage("요청 시간이 초과했습니다. 나중에 다시 시도해 주세요.", false);
            } else {
                console.error("Detected image download error:", jqXHR.status, jqXHR.responseText);
                showUploadStatusMessage("검출 이미지 생성/다운로드에 실패했습니다.", false);
            }
        }).always(function () {
            setDetectingState(false);
            $detectingIndicator.addClass("d-none");
            updateDetectedStreamControls();
        });
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

    function getRemoveNoisyMasks() {
        if ($removeNoisyMasks.length === 0) {
            return true;
        }
        return $removeNoisyMasks.is(":checked");
    }

    function getShowDetectStatsOverlay() {
        if ($showDetectStatsChart.length === 0) {
            return true;
        }
        return $showDetectStatsChart.is(":checked");
    }

    function saveDetectOptionsToStorage() {
        if (typeof window.localStorage === "undefined") {
            return;
        }

        const payload = {
            detectType: getSelectedDetectType(),
            removeNoisyMasks: getRemoveNoisyMasks(),
            showDetectStats: getShowDetectStatsOverlay(),
        };

        try {
            window.localStorage.setItem(DETECT_OPTIONS_STORAGE_KEY, JSON.stringify(payload));
        } catch (error) {
            // Ignore storage write errors (private mode, quota exceeded, etc.).
        }
    }

    function restoreDetectOptionsFromStorage() {
        if (typeof window.localStorage === "undefined") {
            return;
        }

        let parsed = null;
        try {
            const raw = window.localStorage.getItem(DETECT_OPTIONS_STORAGE_KEY);
            if (!raw) {
                return;
            }
            parsed = JSON.parse(raw);
        } catch (error) {
            return;
        }

        if (!parsed || typeof parsed !== "object") {
            return;
        }

        const detectType = String(parsed.detectType || "").trim();
        if (detectType) {
            const $target = $detectTypeInputs.filter("[value='" + detectType + "']");
            if ($target.length > 0) {
                $target.prop("checked", true);
            }
        }

        if (typeof parsed.removeNoisyMasks === "boolean" && $removeNoisyMasks.length > 0) {
            $removeNoisyMasks.prop("checked", parsed.removeNoisyMasks);
        }

        if (typeof parsed.showDetectStats === "boolean" && $showDetectStatsChart.length > 0) {
            $showDetectStatsChart.prop("checked", parsed.showDetectStats);
        }
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

    function buildVideoThumbnailUrl(fileName) {
        return "/fast/video_thumbnail/" + encodePathForRoute(fileName) + "?t=" + Date.now();
    }

    function buildRoadDetectUrl(fileName) {
        return "/fast/road_detect/" + encodePathForRoute(fileName);
    }

    function buildRoadDetectProgressUrl(fileName) {
        return "/fast/road_detect_progress/" + encodePathForRoute(fileName);
    }

    function buildRoadRoiUrl(fileName) {
        return "/fast/road_roi/" + encodePathForRoute(fileName);
    }

    function buildRoadDetectStreamUrl(fileName, detectType, removeNoisyMasks) {
        const base = "/fast/road_detect_stream/" + encodePathForRoute(fileName);
        const query = $.param({
            detect_type: detectType || "road",
            remove_noisy_masks: removeNoisyMasks !== false,
            t: Date.now(),
        });
        return base + "?" + query;
    }

    function buildRoadDetectStreamInitUrl(fileName, detectType, removeNoisyMasks, showDetectStats) {
        const base = "/fast/road_detect_stream_init/" + encodePathForRoute(fileName);
        const query = $.param({
            detect_type: detectType || "road",
            remove_noisy_masks: removeNoisyMasks !== false,
            show_detect_stats: showDetectStats !== false,
        });
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

    function buildCameraDetectStreamInitUrl(cameraIndex, detectType, cameraName, removeNoisyMasks, showDetectStats) {
        return "/fast/camera_detect_stream_init?" + $.param({
            camera_index: cameraIndex,
            detect_type: detectType || "road",
            camera_name: String(cameraName || ""),
            remove_noisy_masks: removeNoisyMasks !== false,
            show_detect_stats: showDetectStats !== false,
        });
    }

    function buildCameraDetectStreamNextUrl(sessionId) {
        return "/fast/camera_detect_stream_next/" + encodeURIComponent(sessionId);
    }

    function buildCameraDetectStreamModeUrl(sessionId, detectEnabled) {
        return "/fast/camera_detect_stream_mode/" + encodeURIComponent(sessionId) + "?" + $.param({
            detect_enabled: Boolean(detectEnabled),
        });
    }

    function buildCameraRoiUrl(sessionId) {
        return "/fast/camera_roi/" + encodeURIComponent(sessionId);
    }

    function buildCameraDetectStreamCleanupUrl(sessionId) {
        return "/fast/camera_detect_stream_cleanup/" + encodeURIComponent(sessionId);
    }

    function buildCameraDetectStreamCleanupAllUrl() {
        return "/fast/camera_detect_stream_cleanup_all";
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

        // 동영상의 경우 메타데이터(videoWidth/videoHeight)가 아직 로드되지 않았으면
        // clientHeight가 브라우저 기본값(예: 150px)이 되어 ROI 비율이 틀릴 수 있으므로
        // 메타데이터 로드 후 syncRoiOverlay()가 다시 호출될 때까지 null 반환.
        if (mediaElement.tagName === "VIDEO") {
            const vw = mediaElement.videoWidth;
            const vh = mediaElement.videoHeight;
            if (vw <= 0 || vh <= 0) {
                return null;
            }
            // clientHeight가 네이티브 컨트롤 영역을 포함하거나 아직 재계산 전일 수 있으므로
            // 실제 영상 프레임 크기를 videoWidth/videoHeight 비율로 재산출.
            const clientWidth = mediaElement.clientWidth;
            const clientHeight = mediaElement.clientHeight;
            if (clientWidth <= 0 || clientHeight <= 0) {
                return null;
            }
            const videoAspect = vw / vh;
            const elementAspect = clientWidth / clientHeight;
            let displayWidth, displayHeight;
            if (videoAspect > elementAspect) {
                // 영상이 요소보다 넓은 경우 — 너비 기준으로 축소
                displayWidth = clientWidth;
                displayHeight = Math.round(clientWidth / videoAspect);
            } else {
                // 영상이 요소보다 높은 경우 — 높이 기준으로 축소
                displayHeight = clientHeight;
                displayWidth = Math.round(clientHeight * videoAspect);
            }
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

    function loadCameraRoiInfo(sessionId) {
        if (!sessionId) {
            clearRoiEditor();
            return;
        }

        const requestToken = ++roiRequestToken;
        setRoiStatus("ROI 정보를 불러오는 중...", "muted");

        $.ajax({
            url: buildCameraRoiUrl(sessionId),
            method: "GET"
        }).done(function (result) {
            if (requestToken !== roiRequestToken) {
                return;
            }

            currentRoiInfo = {
                width: Number(result.width) || 0,
                height: Number(result.height) || 0,
                roiFile: "",
                roi: cloneRoi(result.roi),
            };
            draftRoiInfo = cloneRoi(result.roi);
            syncRoiOverlay();
            setRoiStatus("ROI를 수정할 수 있습니다.", "muted");
        }).fail(function (jqXHR) {
            if (requestToken !== roiRequestToken) {
                return;
            }

            console.error("Camera ROI load error:", jqXHR.status, jqXHR.responseText);
            clearRoiEditor();
            setRoiStatus("카메라 ROI 정보를 불러오지 못했습니다.", "danger");
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

            if (!result || !result.frame_original) {
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

            const isDetectEnabled = result.detect_enabled !== false;
            cameraStreamState.detectEnabled = isDetectEnabled;

            if (isDetectEnabled && result.frame_detected) {
                $detectedVideoPreview.addClass("d-none");
                $detectedImagePreview
                    .attr("src", "data:image/jpeg;base64," + result.frame_detected)
                    .removeClass("d-none");
            }

            if (isDetectEnabled) {
                showUploadStatusMessage("카메라 실시간 검출 중... (" + String(result.frame_number || 0) + ")", true);
            } else {
                showUploadStatusMessage("실시간 원본 영상을 출력중입니다.", true);
            }

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
        const removeNoisyMasks = getRemoveNoisyMasks();
        const showDetectStats = getShowDetectStatsOverlay();
        $.ajax({
            url: buildCameraDetectStreamInitUrl(cameraIndex, detectType, cameraName, removeNoisyMasks, showDetectStats),
            method: "POST",
        }).done(function (result) {
            cameraStreamState = {
                sessionId: String(result.session_id || ""),
                cameraIndex: Number(result.camera_index || cameraIndex),
                cameraName: String(cameraName || ("Camera " + cameraIndex)),
                detectType: detectType,
                removeNoisyMasks: removeNoisyMasks,
                showDetectStats: showDetectStats,
                fps: Number(result.fps || 20),
                detectEnabled: result.detect_enabled !== false,
                isPlaying: true,
            };
            updateCameraLiveBadges();
            loadCameraRoiInfo(cameraStreamState.sessionId);

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

    function setCameraDetectMode(detectEnabled) {
        if (!cameraStreamState || !cameraStreamState.sessionId || !cameraStreamState.isPlaying) {
            return;
        }

        const targetEnabled = Boolean(detectEnabled);
        if (cameraStreamState.detectEnabled === targetEnabled) {
            return;
        }

        $.ajax({
            url: buildCameraDetectStreamModeUrl(cameraStreamState.sessionId, targetEnabled),
            method: "POST",
        }).done(function (result) {
            if (!cameraStreamState) {
                return;
            }

            cameraStreamState.detectEnabled = result.detect_enabled !== false;
            if (cameraStreamState.detectEnabled) {
                setDetectingState(true);
                $detectingIndicator.removeClass("d-none");
                showUploadStatusMessage("카메라 실시간 검출을 다시 시작합니다.", true);
            } else {
                setDetectingState(false);
                $detectingIndicator.addClass("d-none");
                showUploadStatusMessage("실시간 원본 영상을 출력중입니다.", true);
            }
        }).fail(function (jqXHR) {
            console.error("Camera detect mode change error:", jqXHR.status, jqXHR.responseText);
            showUploadStatusMessage("카메라 검출 모드 변경에 실패했습니다.", false);
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

        const totalFrames = Number(state.totalFrames || 0);
        const currentFrame = Number(state.frameIndex || 0);
        if (totalFrames > 0 && currentFrame >= totalFrames) {
            seekFrameStream(fileName, 1, { autoResume: true });
            return;
        }

        state.isPlaying = true;
        state.isPaused = false;
        setDetectingState(true);
        $detectingIndicator.removeClass("d-none");
        updateDetectedStreamControls();
        playFrameStream(fileName);
    }

    function seekFrameStream(fileName, frameNumber, options) {
        const state = frameStreamState[fileName];
        if (!state) {
            return;
        }

        const seekOptions = options || {};

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
            playFrameStream(fileName, { singleStep: true, autoResume: Boolean(seekOptions.autoResume) });
        }).fail(function (jqXHR) {
            console.error("Stream seek error:", jqXHR.status, jqXHR.responseText);
            showUploadStatusMessage("프레임 이동에 실패했습니다.", false);
            setDetectingState(false);
            $detectingIndicator.addClass("d-none");
            updateDetectedStreamControls();
        });
    }

    function completeFrameStreamPlayback(fileName, state) {
        if (!state) {
            return;
        }

        state.isPlaying = false;
        state.isPaused = true;
        if (Number(state.totalFrames || 0) > 0) {
            state.frameIndex = Number(state.totalFrames);
        }

        if (frameTimerMap[fileName]) {
            clearTimeout(frameTimerMap[fileName]);
            delete frameTimerMap[fileName];
        }

        setDetectingState(false);
        $detectingIndicator.addClass("d-none");
        updateDetectedStreamControls();
    }

    function saveRoiInfo() {
        const isCameraMode = Boolean(cameraStreamState && cameraStreamState.sessionId && cameraStreamState.isPlaying);
        if (!draftRoiInfo || (!uploadedFileName && !isCameraMode)) {
            return;
        }

        if (currentRoiInfo && sameRoi(currentRoiInfo.roi, draftRoiInfo)) {
            return;
        }

        setRoiStatus("ROI 저장 중...", "muted");

        const saveUrl = isCameraMode
            ? buildCameraRoiUrl(cameraStreamState.sessionId)
            : buildRoadRoiUrl(uploadedFileName);

        $.ajax({
            url: saveUrl,
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

    function initFrameStream(fileName, detectType, removeNoisyMasks, options) {
        const initOptions = options || {};
        const showDetectStats = getShowDetectStatsOverlay();
        // 이미 활성인 세션이 있으면 정리
        if (frameStreamState[fileName]) {
            if (frameTimerMap[fileName]) {
                clearTimeout(frameTimerMap[fileName]);
                delete frameTimerMap[fileName];
            }
            delete frameStreamState[fileName];
        }

        $.ajax({
            url: buildRoadDetectStreamInitUrl(fileName, detectType, removeNoisyMasks, showDetectStats),
            method: "POST"
        }).done(function (result) {
            console.log("Stream initialized:", result);
            frameStreamState[fileName] = {
                sessionId: result.session_id,
                totalFrames: result.total_frames,
                fps: result.fps,
                detectType: detectType,
                removeNoisyMasks: removeNoisyMasks,
                showDetectStats: showDetectStats,
                frameIndex: 0,
                isPlaying: true,
                isPaused: false
            };

            if (initOptions.startPaused) {
                frameStreamState[fileName].isPlaying = false;
                frameStreamState[fileName].isPaused = true;
            }

            updateDetectedStreamControls();

            if (initOptions.startPaused) {
                setDetectingState(false);
                $detectingIndicator.addClass("d-none");
                playFrameStream(fileName, { singleStep: true, autoResume: false });
                showUploadStatusMessage("다운로드 후 일시정지 상태로 복구되었습니다. 재생 버튼을 눌러 계속 진행하세요.", true);
                return;
            }

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
                completeFrameStreamPlayback(fileName, currentState);
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
                completeFrameStreamPlayback(fileName, currentState);
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
        const removeNoisyMasks = getRemoveNoisyMasks();
        const showDetectStats = getShowDetectStatsOverlay();
        showUploadStatusMessage("도로 검출 중...", true);
        hideImageAndVideo($detectedImagePreview, $detectedVideoPreview);
        setDetectingState(true);
        $detectingIndicator.removeClass("d-none");

        if (isVideoPath(uploadedFileName)) {
            // 모든 이전 스트리밍 세션 정리
            cleanupAllFrameStreams();
            // 비디오: 프레임별 스트리밍 시작
            initFrameStream(uploadedFileName, detectType, removeNoisyMasks);
            return;
        }

        // 이미지: 기존 로직
        $.ajax({
            url: buildRoadDetectUrl(uploadedFileName),
            data: {
                detect_type: detectType,
                remove_noisy_masks: removeNoisyMasks,
                show_detect_stats: showDetectStats,
            },
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
            const thumbnailUrl = buildVideoThumbnailUrl(safeFileName);
            const label = safeFileName.split("/").pop() || safeFileName;

            if (!sampleVideoItemTemplate || !sampleVideoItemTemplate.content) {
                return;
            }

            const node = sampleVideoItemTemplate.content.firstElementChild.cloneNode(true);
            const button = node.querySelector(".sample-video-item");
            const thumbnailImage = node.querySelector(".sample-video-thumbnail");
            const video = node.querySelector("video");
            const caption = node.querySelector(".small");

            if (button) {
                button.setAttribute("data-file-name", safeFileName);
            }
            if (thumbnailImage) {
                thumbnailImage.setAttribute("src", thumbnailUrl);
                thumbnailImage.setAttribute("alt", label);
            } else if (video) {
                // Backward compatibility for old template shape.
                video.removeAttribute("src");
                video.setAttribute("poster", thumbnailUrl);
                video.setAttribute("preload", "none");
                if (typeof video.load === "function") {
                    video.load();
                }
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

        const normalizedDevices = Array.isArray(devices) ? devices.slice() : [];

        if (cameraStreamState && cameraStreamState.sessionId && Number.isFinite(Number(cameraStreamState.cameraIndex))) {
            const activeCameraIndex = Number(cameraStreamState.cameraIndex);
            const hasActiveCamera = normalizedDevices.some(function (device) {
                return Number(device.index) === activeCameraIndex;
            });

            if (!hasActiveCamera) {
                normalizedDevices.unshift({
                    index: activeCameraIndex,
                    name: String(cameraStreamState.cameraName || ("Camera " + activeCameraIndex)),
                    width: 0,
                    height: 0,
                    fps: Number(cameraStreamState.fps || 0),
                });
            }
        }

        if (normalizedDevices.length === 0) {
            $cameraDeviceList.html('<div class="text-muted text-center py-3">열 수 있는 카메라 장치가 없습니다.</div>');
            return;
        }

        if (!cameraDeviceItemTemplate || !cameraDeviceItemTemplate.content) {
            $cameraDeviceList.html('<div class="text-danger text-center py-3">카메라 템플릿을 찾지 못했습니다.</div>');
            return;
        }

        if (!cameraDeviceListContainerTemplate || !cameraDeviceListContainerTemplate.content) {
            $cameraDeviceList.html('<div class="text-danger text-center py-3">카메라 목록 템플릿을 찾지 못했습니다.</div>');
            return;
        }

        const containerNode = cameraDeviceListContainerTemplate.content.firstElementChild.cloneNode(true);
        const $container = $(containerNode);

        normalizedDevices.forEach(function (device) {
            const index = Number(device.index);
            const name = String(device.name || ("Camera " + index));
            const width = Number(device.width || 0);
            const height = Number(device.height || 0);
            const fps = Number(device.fps || 0);
            const isActiveCamera = Boolean(
                cameraStreamState
                && cameraStreamState.sessionId
                && Number(cameraStreamState.cameraIndex) === index
            );
            const detailParts = [];
            if (width > 0 && height > 0) {
                detailParts.push(width + "x" + height);
            }
            if (fps > 0) {
                detailParts.push(fps.toFixed(1) + " fps");
            }

            const detail = detailParts.join(" / ") || "열림 확인";

            const node = cameraDeviceItemTemplate.content.firstElementChild.cloneNode(true);
            const button = node;
            const nameLabel = node.querySelector(".camera-device-name");
            const detailLabel = node.querySelector(".camera-device-detail");
            const liveBadge = node.querySelector(".camera-device-live-badge");

            if (button) {
                button.setAttribute("data-camera-index", String(index));
                button.setAttribute("data-camera-name", name);
                button.classList.toggle("active", isActiveCamera);
            }
            if (nameLabel) {
                nameLabel.textContent = name;
            }
            if (detailLabel) {
                detailLabel.textContent = detail;
            }
            if (liveBadge) {
                liveBadge.classList.toggle("d-none", !isActiveCamera);
            }

            $container.append(node);
        });

        $cameraDeviceList.empty().append($container);
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

    restoreDetectOptionsFromStorage();

    $detectedImageTab.on("click", function () {
        if (cameraStreamState && cameraStreamState.isPlaying) {
            setCameraDetectMode(true);
            return;
        }

        if (!uploadedFileName) {
            showUploadStatusMessage("먼저 이미지를 업로드해 주세요.", false);
            return;
        }

        if (isVideoPath(uploadedFileName)) {
            const state = frameStreamState[uploadedFileName];
            if (state) {
                if (state.isPaused) {
                    resumeFrameStream(uploadedFileName);
                    showUploadStatusMessage("프레임 출력을 이어서 재생합니다.", true);
                }
                return;
            }
        }

        runDetect();
    });

    $detectedImageTab.on("shown.bs.tab", function () {
        if (uploadedFileName && isVideoPath(uploadedFileName)) {
            const state = frameStreamState[uploadedFileName];
            if (state && state.isPaused && !state.isPlaying) {
                resumeFrameStream(uploadedFileName);
                showUploadStatusMessage("프레임 출력을 이어서 재생합니다.", true);
            }
        }
        updateDetectedStreamControls();
    });

    $detectTypeInputs.on("change", function () {
        saveDetectOptionsToStorage();
        scheduleDetectUpdate();
    });

    $removeNoisyMasks.on("change", function () {
        saveDetectOptionsToStorage();
        scheduleDetectUpdate();
    });

    $showDetectStatsChart.on("change", function () {
        saveDetectOptionsToStorage();
        scheduleDetectUpdate();
        if (cameraStreamState && cameraStreamState.isPlaying) {
            startCameraLiveStream(cameraStreamState.cameraIndex, cameraStreamState.cameraName);
        }
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
        const imgElement = $uploadedImagePreview[0];
        if (imgElement && imgElement.naturalWidth > 0 && imgElement.naturalHeight > 0) {
            // ROI 정보가 없거나 불완전하면 이미지 크기 기반으로 기본 ROI 설정
            if (!currentRoiInfo || currentRoiInfo.width <= 0 || currentRoiInfo.height <= 0) {
                currentRoiInfo = {
                    width: imgElement.naturalWidth,
                    height: imgElement.naturalHeight,
                    roiFile: "",
                    roi: {
                        x1: 0,
                        y1: 0,
                        x2: imgElement.naturalWidth,
                        y2: imgElement.naturalHeight,
                    }
                };
                draftRoiInfo = cloneRoi(currentRoiInfo.roi);
                updateRoiEditorButtons();
            }
        }
        syncRoiOverlay();
    });

    $uploadedVideoPreview.on("loadedmetadata loadeddata", function () {
        const videoElement = $uploadedVideoPreview[0];
        if (videoElement && videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
            const aspectRatio = videoElement.videoWidth / videoElement.videoHeight;
            $uploadedVideoPreview.css("aspect-ratio", String(aspectRatio));
            
            // ROI 정보가 없거나 불완전하면 동영상 크기 기반으로 기본 ROI 설정
            if (!currentRoiInfo || currentRoiInfo.width <= 0 || currentRoiInfo.height <= 0) {
                currentRoiInfo = {
                    width: videoElement.videoWidth,
                    height: videoElement.videoHeight,
                    roiFile: "",
                    roi: {
                        x1: 0,
                        y1: 0,
                        x2: videoElement.videoWidth,
                        y2: videoElement.videoHeight,
                    }
                };
                draftRoiInfo = cloneRoi(currentRoiInfo.roi);
                updateRoiEditorButtons();
            }
        }
        syncRoiOverlay();
    });

    $("#original-media-stage").on("click", function () {
        if (!uploadedFileName || !isVideoPath(uploadedFileName)) {
            return;
        }

        const state = frameStreamState[uploadedFileName];
        if (state && state.isPlaying && !state.isPaused) {
            pauseFrameStream(uploadedFileName);
        }
    });

    $(window).on("resize", function () {
        syncRoiOverlay();
    });

    $originalImageTab.on("click", function () {
        if (!cameraStreamState || !cameraStreamState.isPlaying) {
            return;
        }

        setCameraDetectMode(false);
        showUploadStatusMessage("실시간 원본 영상을 출력중입니다.", true);
    });

    $originalImageTab.on("shown.bs.tab", function () {
        if (uploadedFileName && isVideoPath(uploadedFileName)) {
            const state = frameStreamState[uploadedFileName];
            if (state && state.isPlaying && !state.isPaused) {
                pauseFrameStream(uploadedFileName);
            }
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

    $detectedStreamRestartButton.on("click", function () {
        if (!uploadedFileName || !isVideoPath(uploadedFileName)) {
            return;
        }

        const state = frameStreamState[uploadedFileName];
        if (!state) {
            return;
        }

        seekFrameStream(uploadedFileName, 1, { autoResume: true });
        showUploadStatusMessage("처음부터 다시 재생합니다.", true);
    });

    $detectedStreamResumeButton.on("click", function () {
        if (!uploadedFileName) {
            return;
        }

        resumeFrameStream(uploadedFileName);
    });

    $detectedVideoDownloadButton.on("click", function () {
        triggerDetectedVideoDownload(uploadedFileName);
    });

    $detectedImageDownloadButton.on("click", function () {
        triggerDetectedImageDownload(uploadedFileName);
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
        if (!currentRoiInfo || currentRoiInfo.width <= 0 || currentRoiInfo.height <= 0) {
            return;
        }

        const fullWidth = Number(currentRoiInfo.width);
        const fullHeight = Number(currentRoiInfo.height);
        const roiWidth = Math.max(1, Math.round(fullWidth * 0.8));
        const roiHeight = Math.max(1, Math.round(fullHeight * 0.8));
        const offsetX = Math.max(0, Math.floor((fullWidth - roiWidth) / 2));
        const offsetY = Math.max(0, Math.floor((fullHeight - roiHeight) / 2));

        draftRoiInfo = {
            x1: offsetX,
            y1: offsetY,
            x2: offsetX + roiWidth,
            y2: offsetY + roiHeight,
        };

        syncRoiOverlay();
        setRoiStatus("ROI를 전체 대비 80% 영역으로 설정했습니다. 저장 중...", "muted");
        saveRoiInfo();
    });

    $roiFullButton.on("click", function () {
        if (!currentRoiInfo || currentRoiInfo.width <= 0 || currentRoiInfo.height <= 0) {
            return;
        }

        draftRoiInfo = {
            x1: 0,
            y1: 0,
            x2: Number(currentRoiInfo.width),
            y2: Number(currentRoiInfo.height),
        };

        syncRoiOverlay();
        setRoiStatus("ROI를 전체 크기로 설정했습니다. 저장 중...", "muted");
        saveRoiInfo();
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
        if (!cameraStreamState || !cameraStreamState.sessionId) {
            $.ajax({
                url: buildCameraDetectStreamCleanupAllUrl(),
                method: "POST",
                timeout: 3000,
            }).always(function () {
                loadCameraDevices(true);
            });
            return;
        }

        loadCameraDevices(true);
    });

    $detectTypeInputs.on("change.cameraLive", function () {
        if (!cameraStreamState || !cameraStreamState.isPlaying) {
            return;
        }

        startCameraLiveStream(cameraStreamState.cameraIndex, cameraStreamState.cameraName);
    });

    $removeNoisyMasks.on("change.cameraLive", function () {
        if (!cameraStreamState || !cameraStreamState.isPlaying) {
            return;
        }

        startCameraLiveStream(cameraStreamState.cameraIndex, cameraStreamState.cameraName);
    });

    updateCameraLiveBadges();
});
