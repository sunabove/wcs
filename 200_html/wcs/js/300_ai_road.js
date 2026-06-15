$(function () {
    const $dropZone = $("#image-drop-zone");
    const $fileInput = $("#road-image-input");
    const $selectedFileLabel = $("#selected-image-name");
    const $uploadedImagePreview = $("#original-image-preview");
    const $detectedImagePreview = $("#detected-image-preview");
    const $detectedImageTab = $("#detected-image-tab");
    const $uploadingIndicator = $("#uploading-indicator");
    const $uploadStatusMessage = $("#upload-status-message");
    const $detectingIndicator = $("#detecting-indicator");
    const $detectConfidenceSpinner = $("#detect-confidence");
    const $detectTypeInputs = $("input[name='detect-type']");
    const $defaultConfidencePothole = $("#default-confidence-pothole");
    const $defaultConfidenceOthers = $("#default-confidence-others");
    const FALLBACK_POTHOLE_CONFIDENCE_PERCENT = 20;
    const FALLBACK_DEFAULT_CONFIDENCE_PERCENT = 60;
    let uploadedFileName = "";
    let detectDebounceTimer = null;

    if ($dropZone.length === 0 || $fileInput.length === 0 || $uploadedImagePreview.length === 0) {
        return;
    }

    function updateSelectedFile(file) {
        if ($selectedFileLabel.length > 0) {
            $selectedFileLabel.text(file ? "선택 파일: " + file.name : "선택된 파일 없음");
        }
    }

    function setUploadingState(isUploading) {
        if ($uploadingIndicator.length === 0) {
            return;
        }

        $uploadingIndicator.toggleClass("d-none", !isUploading);
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
        $uploadedImagePreview.attr("src", "").addClass("d-none");
        $detectedImagePreview.attr("src", "").addClass("d-none");
    }

    function getDetectConfidenceValue() {
        const parsed = parseFloat($detectConfidenceSpinner.val());
        if (Number.isNaN(parsed)) {
            return 0.5;
        }
        const clampedPercent = Math.min(95, Math.max(5, parsed));
        if (String(clampedPercent) !== String($detectConfidenceSpinner.val())) {
            $detectConfidenceSpinner.val(clampedPercent);
        }
        return clampedPercent / 100;
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

    function applyDefaultConfidenceByType() {
        const detectType = getSelectedDetectType();
        const confidencePercent = detectType === "pothole"
            ? getValidPercent($defaultConfidencePothole, FALLBACK_POTHOLE_CONFIDENCE_PERCENT)
            : getValidPercent($defaultConfidenceOthers, FALLBACK_DEFAULT_CONFIDENCE_PERCENT);
        $detectConfidenceSpinner.val(confidencePercent);
    }

    function uploadSelectedImage(file) {
        if (!file) {
            return;
        }

        resetPreviewImages();

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
                    uploadedFileName = result.filename;
                    const imageUrl = "/fast/image/" + encodeURIComponent(result.filename) + "?t=" + Date.now();
                    $uploadedImagePreview.attr("src", imageUrl).removeClass("d-none");

                    if ($detectedImageTab.length > 0 && typeof bootstrap !== "undefined" && bootstrap.Tab) {
                        bootstrap.Tab.getOrCreateInstance($detectedImageTab[0]).show();
                    }
                }
                showUploadStatusMessage("업로드가 완료되었습니다.", true);
                runDetect();
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

    $dropZone.on("click", function () {
        $fileInput.trigger("click");
    });

    $fileInput.on("change", function () {
        const files = this.files;
        const file = files && files[0] ? files[0] : null;
        updateSelectedFile(file);
        uploadSelectedImage(file);
    });

    $dropZone.on("dragenter dragover", function (event) {
        event.preventDefault();
        event.stopPropagation();
        $dropZone.addClass("drag-over");
    });

    $dropZone.on("dragleave drop", function (event) {
        event.preventDefault();
        event.stopPropagation();
        $dropZone.removeClass("drag-over");
    });

    $dropZone.on("drop", function (event) {
        const originalEvent = event.originalEvent;
        const files = originalEvent && originalEvent.dataTransfer ? originalEvent.dataTransfer.files : null;
        if (!files || files.length === 0) {
            return;
        }

        const file = files[0];
        if (!file.type.startsWith("image/")) {
            if ($selectedFileLabel.length > 0) {
                $selectedFileLabel.text("이미지 파일만 업로드할 수 있습니다.");
            }
            return;
        }

        $fileInput[0].files = files;
        updateSelectedFile(file);
        uploadSelectedImage(file);
    });

    function runDetect() {
        if (!uploadedFileName) {
            return;
        }

        const confidence = getDetectConfidenceValue();
        const detectType = getSelectedDetectType();
        showUploadStatusMessage("도로 검출 중...", true);
        $detectedImagePreview.addClass("d-none");
        $detectingIndicator.removeClass("d-none");

        $.ajax({
            url: "/fast/road_detect/" + encodeURIComponent(uploadedFileName),
            data: { conf: confidence, detect_type: detectType },
            method: "GET"
        }).done(function (result) {
            if (result && result.image_url) {
                const detectedImageUrl = result.image_url + "?t=" + Date.now();
                $detectedImagePreview.attr("src", detectedImageUrl).removeClass("d-none");
                showUploadStatusMessage("검출 이미지가 생성되었습니다.", true);
            } else {
                showUploadStatusMessage("검출 결과를 받지 못했습니다.", false);
            }
        }).fail(function (jqXHR) {
            console.error("Detect road error:", jqXHR.status, jqXHR.responseText);
            showUploadStatusMessage("도로 검출에 실패했습니다.", false);
        }).always(function () {
            $detectingIndicator.addClass("d-none");
        });
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
        applyDefaultConfidenceByType();
        scheduleDetectUpdate();
    });

    $detectConfidenceSpinner.on("input change", function () {
        scheduleDetectUpdate();
    });

    $defaultConfidencePothole.on("input change", function () {
        if (getSelectedDetectType() === "pothole") {
            applyDefaultConfidenceByType();
            scheduleDetectUpdate();
        }
    });

    $defaultConfidenceOthers.on("input change", function () {
        if (getSelectedDetectType() !== "pothole") {
            applyDefaultConfidenceByType();
            scheduleDetectUpdate();
        }
    });

    applyDefaultConfidenceByType();
});
