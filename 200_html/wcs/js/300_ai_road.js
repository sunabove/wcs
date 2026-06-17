$(function () {
    const $dropZone = $("#image-drop-zone");
    const $fileInput = $("#road-image-input");
    const $selectedFileLabel = $("#selected-image-name");
    const $uploadedImagePreview = $("#original-image-preview");
    const $uploadedVideoPreview = $("#original-video-preview");
    const $detectedImagePreview = $("#detected-image-preview");
    const $detectedVideoPreview = $("#detected-video-preview");
    const $detectedImageTab = $("#detected-image-tab");
    const $uploadingIndicator = $("#working-indicator");
    const $uploadStatusMessage = $("#work-status-message");
    const $detectingIndicator = $("#detecting-indicator");
    const $detectTypeInputs = $("input[name='detect-type']");
    const $sampleImagePane = $("#input-sample-image-pane");
    const $sampleImageTab = $("#input-sample-image-tab");
    const sampleImageItemTemplate = document.getElementById("sample-image-item-template");
    const DETECT_AFTER_UPLOAD_DELAY_MS = 800;
    let uploadedFileName = "";
    let previousFileName = "";  // 이전 파일명 추적
    let detectDebounceTimer = null;
    let sampleDetectTimer = null;
    let isUploading = false;
    let isDetecting = false;
    let isSampleImagesLoaded = false;
    let isSampleImagesLoading = false;
    let frameStreamState = {};  // 프레임 스트리밍 상태
    let frameTimerMap = {};     // 프레임 타이머 맵

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
    }

    function updateSelectedFile(file) {
        if ($selectedFileLabel.length > 0) {
            $selectedFileLabel.text(file ? "선택 파일: " + file.name : "선택된 파일 없음");
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

    function showUploadStatusMessage(message, isSuccess) {
        if ($uploadStatusMessage.length === 0) {
            return;
        }

        $uploadStatusMessage
            .removeClass("d-none text-success text-danger")
            .addClass(isSuccess ? "text-success" : "text-danger")
            .text(message);
    }

    function resetPreviewImages() {
        uploadedFileName = "";
        previousFileName = "";
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

    function buildRoadDetectStreamCleanupUrl(fileName) {
        return "/fast/road_detect_stream_cleanup/" + encodePathForRoute(fileName);
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
    }

    function uploadSelectedImage(file) {
        if (!file) {
            return;
        }

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
                    const mediaUrl = buildImageUrl(result.filename);
                    showMediaPreview(mediaUrl, isVideoPath(result.filename), $uploadedImagePreview, $uploadedVideoPreview);

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
                isPlaying: true
            };
            playFrameStream(fileName);
        }).fail(function (jqXHR) {
            console.error("Stream init error:", jqXHR.status, jqXHR.responseText);
            showUploadStatusMessage("프레임 스트림 초기화에 실패했습니다.", false);
            setDetectingState(false);
            $detectingIndicator.addClass("d-none");
        });
    }

    function playFrameStream(fileName) {
        const state = frameStreamState[fileName];
        if (!state || !state.isPlaying) {
            return;
        }

        $.ajax({
            url: buildRoadDetectStreamNextUrl(fileName),
            method: "GET"
        }).done(function (result) {
            // 응답 도착 시점에 세션이 이미 정리되었으면 중단
            const currentState = frameStreamState[fileName];
            if (!currentState || !currentState.isPlaying) {
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
            showUploadStatusMessage(
                "프레임 처리 중... (" + result.frame_number + "/" + currentState.totalFrames + ")",
                true
            );

            // 다음 프레임을 위한 타이머 설정
            if (result.has_next) {
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
        if (!uploadedFileName) {
            showUploadStatusMessage("먼저 이미지를 업로드해 주세요.", false);
            return;
        }

        runDetect();
    });

    $detectTypeInputs.on("change", function () {
        scheduleDetectUpdate();
    });

    $sampleImagePane.on("click", ".sample-image-item", function () {
        const selectedFileName = $(this).data("file-name");
        if (!selectedFileName) {
            return;
        }

        if (sampleDetectTimer) {
            clearTimeout(sampleDetectTimer);
            sampleDetectTimer = null;
        }
        if (detectDebounceTimer) {
            clearTimeout(detectDebounceTimer);
            detectDebounceTimer = null;
        }

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
        const imageUrl = buildImageUrl(uploadedFileName);
        showMediaPreview(imageUrl, isVideoPath(uploadedFileName), $uploadedImagePreview, $uploadedVideoPreview);
        showUploadStatusMessage("샘플 영상을 선택하였습니다. 잠시 후 검출합니다.", true);
        showDetectedTabAndRunDetect(DETECT_AFTER_UPLOAD_DELAY_MS);
    });

    $sampleImageTab.on("click", function () {
        ensureSampleImagesLoaded();
    });

    $sampleImageTab.on("shown.bs.tab", function () {
        ensureSampleImagesLoaded();
    });
});
