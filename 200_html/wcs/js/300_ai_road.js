$(function () {
    const $dropZone = $("#image-drop-zone");
    const $fileInput = $("#road-image-input");
    const $selectedFileLabel = $("#selected-image-name");
    const $uploadedImagePreview = $("#uploaded-image-preview");

    if ($dropZone.length === 0 || $fileInput.length === 0 || $uploadedImagePreview.length === 0) {
        return;
    }

    function updateSelectedFile(file) {
        if ($selectedFileLabel.length > 0) {
            $selectedFileLabel.text(file ? "선택 파일: " + file.name : "선택된 파일 없음");
        }
    }

    function uploadSelectedImage(file) {
        if (!file) {
            return;
        }

        prepareUploadFile(file).then(function (uploadFile) {
            const formData = new FormData();
            formData.append("file", uploadFile, uploadFile.name || file.name);

            $.ajax({
                url: "/fast/upload_image",
                method: "POST",
                data: formData,
                processData: false,
                contentType: false
            }).done(function (result) {
                console.log(result.filename);
                if (result && result.filename) {
                    const imageUrl = "/fast/image/" + encodeURIComponent(result.filename) + "?t=" + Date.now();
                    $uploadedImagePreview.attr("src", imageUrl).removeClass("d-none");
                }
            }).fail(function (jqXHR) {
                console.error("Image upload error:", jqXHR.status, jqXHR.responseText);
            });
        }).catch(function (error) {
            console.error("Image preprocess error:", error);
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
});
