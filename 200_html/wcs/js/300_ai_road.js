$(function () {
    const $dropZone = $("#image-drop-zone");
    const $fileInput = $("#road-image-input");
    const $selectedFileLabel = $("#selected-image-name");
    const $uploadedImagePreview = $("#original-image-preview");
    const $detectedImagePreview = $("#detected-image-preview");
    const $detectedImageTab = $("#detected-image-tab");
    const $uploadingIndicator = $("#working-indicator");
    const $uploadStatusMessage = $("#work-status-message");
    const $detectingIndicator = $("#detecting-indicator");
    const $detectTypeInputs = $("input[name='detect-type']");
    const $sampleImagePane = $("#input-sample-image-pane");
    const DETECT_AFTER_UPLOAD_DELAY_MS = 800;
    let uploadedFileName = "";
    let detectDebounceTimer = null;
    let isUploading = false;
    let isDetecting = false;

    if ($dropZone.length === 0 || $fileInput.length === 0 || $uploadedImagePreview.length === 0) {
        return;
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
        $uploadedImagePreview.attr("src", "").addClass("d-none");
        $detectedImagePreview.attr("src", "").addClass("d-none");
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
                    const imageUrl = buildImageUrl(result.filename);
                    $uploadedImagePreview.attr("src", imageUrl).removeClass("d-none");

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

        const detectType = getSelectedDetectType();
        showUploadStatusMessage("도로 검출 중...", true);
        $detectedImagePreview.addClass("d-none");
        setDetectingState(true);
        $detectingIndicator.removeClass("d-none");

        $.ajax({
            url: buildRoadDetectUrl(uploadedFileName),
            data: { detect_type: detectType },
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

        const cards = fileNames.map(function (fileName) {
            const safeFileName = normalizePath(fileName);
            const imageUrl = buildImageUrl(safeFileName);
            const label = safeFileName.split("/").pop() || safeFileName;

            return [
                '<div class="col-6 col-md-4 col-lg-3">',
                    '<button type="button" class="btn btn-outline-secondary w-100 p-2 h-100 sample-image-item" data-file-name="' + safeFileName + '">',
                        '<img src="' + imageUrl + '" alt="' + label + '" class="img-fluid rounded mb-2" style="height: 120px; width: 100%; object-fit: cover;">',
                        '<div class="small text-truncate" title="' + safeFileName + '">' + label + '</div>',
                    '</button>',
                '</div>'
            ].join("");
        }).join("");

        $sampleImagePane.html('<div class="row g-2">' + cards + '</div>');
    }

    function loadSampleImages() {
        if ($sampleImagePane.length === 0) {
            return;
        }

        $sampleImagePane.html('<div class="text-muted text-center py-3">샘플 영상을 불러오는 중...</div>');

        $.ajax({
            url: "/fast/samples/image",
            method: "GET"
        }).done(function (result) {
            const fileNames = Array.isArray(result)
                ? result
                : (result && Array.isArray(result.image_files) ? result.image_files : []);
            renderSampleImageThumbnails(fileNames);
        }).fail(function (jqXHR) {
            console.error("Sample image list error:", jqXHR.status, jqXHR.responseText);
            $sampleImagePane.html('<div class="text-danger text-center py-3">샘플 영상을 불러오지 못했습니다.</div>');
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
        scheduleDetectUpdate();
    });

    $sampleImagePane.on("click", ".sample-image-item", function () {
        const selectedFileName = $(this).data("file-name");
        if (!selectedFileName) {
            return;
        }

        uploadedFileName = normalizePath(selectedFileName);
        const imageUrl = buildImageUrl(uploadedFileName);
        $uploadedImagePreview.attr("src", imageUrl).removeClass("d-none");
        $detectedImagePreview.attr("src", "").addClass("d-none");
        showUploadStatusMessage("샘플 영상을 선택했습니다.", true);
    });

    loadSampleImages();
});
