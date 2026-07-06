import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const $ = window.jQuery;

// 각 뷰어를 위한 클래스
class URDFViewer {
    constructor(containerElement) {
        this.container = containerElement;
        this.robotModel = null;
        this.xyGridHelper = null;
        this.axesHelper = null;
        this.axisLineByKey = {
            x: null,
            y: null,
            z: null
        };
        this.axisLengthScaleRatio = 0.55;
        this.axisLabelSprites = [];
        this.axisLabelScaleRatio = 0.10;
        this.referenceToggleStep = 0;
        this.directionalLight = null;
        this.directionalLightRadius = 1;
        this.goalTarget = new THREE.Vector3(0, 0, 0);
        this.isDragging = false;
        this.lastAngleLogAt = 0;
        this.angleLogIntervalMs = 120;
        this.cameraPosTextElement = null;
        this.cameraToastElement = null;
        this.cameraToastHideTimer = null;
        this.cameraToastHideDelayMs = 3000;
        this.lastFrameTimeMs = performance.now();
        this.wheelSpeedInputByKey = {};
        this.wheelSpeedValueByKey = {};
        this.wheelSpeedRpmByKey = {
            fl: 0,
            fr: 0,
            rl: 0,
            rr: 0
        };
        this.wheelAngularSpeedRadByKey = {
            fl: this.convertRpmToRadPerSec(0),
            fr: this.convertRpmToRadPerSec(0),
            rl: this.convertRpmToRadPerSec(0),
            rr: this.convertRpmToRadPerSec(0)
        };
        this.wheelDirectionSignByKey = {
            fl: 1,
            fr: 1,
            rl: 1,
            rr: 1
        };
        this.driveMode = 'forward';
        this.driveSpeedKmh = 0;
        this.kmhToRpmFactor = 4;
        this.wheelJointNameByKey = {
            fl: 'joint_fl',
            fr: 'joint_fr',
            rl: 'joint_rl',
            rr: 'joint_rr'
        };
        this.wheelLinkNameByKey = {
            fl: 'wheel_fl',
            fr: 'wheel_fr',
            rl: 'wheel_rl',
            rr: 'wheel_rr'
        };
        this.wheelAngles = {
            fl: 0,
            fr: 0,
            rl: 0,
            rr: 0
        };
        this.wheelRuntimeTargetByKey = {
            fl: null,
            fr: null,
            rl: null,
            rr: null
        };
        this.wheelHighlightMeshesByKey = {
            fl: [],
            fr: [],
            rl: [],
            rr: []
        };
        this.wheelHighlightBaseColor = new THREE.Color(0x141414);
        this.wheelHighlightAccentColor = new THREE.Color(0xffb000);
        this.wheelHighlightDimColor = new THREE.Color(0x4f4f4f);
        this.wheelHighlightEmissiveColor = new THREE.Color(0x3a1f00);
        this.wheelFlashAccentColor = new THREE.Color(0xffc84d);
        this.wheelFlashEmissiveColor = new THREE.Color(0x6a3300);
        this.highlightedWheelKey = null;
        this.viewerWheelKey = this.parseViewerWheelKey(containerElement.id)
            || String(window.pendingWheelViewerKey || '').trim().toLowerCase()
            || this.getSelectedWheelKeyFromDom();
        this.wheelFlashTimeoutId = null;
        this.roadRollAngleDeg = 0;
        this.roadPitchAngleDeg = 0;
        this.attitudeOverlayElement = null;
        this.attitudeTextElement = null;
        this.rollNeedleElement = null;
        this.pitchNeedleElement = null;
        this.showAttitude = this.parseBooleanAttribute(
            containerElement.getAttribute('showAttitude'),
            false
        );
        this.urdfPath = containerElement.getAttribute('urdf') || '/urdf/vehicle/vehicle.urdf';
        const rawCameraPosition = containerElement.getAttribute('cameraPosition');
        this.hasCustomCameraPosition = rawCameraPosition != null && String(rawCameraPosition).trim().length > 0;
        this.cameraFitMarginRatio = 0.05;
        this.cameraPosition = this.hasCustomCameraPosition
            ? this.parseCameraPosition(rawCameraPosition)
            : new THREE.Vector3(4, 4, 8);
        
        this.init();
    }

    parseCameraPosition(rawValue) {
        const fallback = new THREE.Vector3(4, 4, 8);
        const tokens = String(rawValue || '').split(',').map(value => Number.parseFloat(value.trim()));
        if (tokens.length < 3 || !Number.isFinite(tokens[0]) || !Number.isFinite(tokens[1]) || !Number.isFinite(tokens[2])) {
            return fallback;
        }
        return new THREE.Vector3(tokens[0], tokens[1], tokens[2]);
    }

    parseBooleanAttribute(rawValue, fallbackValue) {
        if (rawValue == null) {
            return fallbackValue;
        }

        const normalized = String(rawValue).trim().toLowerCase();
        if (normalized === '' || normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
            return true;
        }

        if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
            return false;
        }

        return fallbackValue;
    }

    parseViewerWheelKey(containerId) {
        const idText = String(containerId || '').trim().toLowerCase();
        const matched = idText.match(/^([a-z]{2})-wheel-urdf-viewer$/);
        if (!matched) {
            return null;
        }

        const wheelKey = matched[1];
        if (!Object.prototype.hasOwnProperty.call(this.wheelSpeedRpmByKey, wheelKey)) {
            return null;
        }

        return wheelKey;
    }

    getSelectedWheelKeyFromDom() {
        const selectedWheel = document.querySelector('input[name="wheelPosition"]:checked');
        const wheelKey = String(selectedWheel?.value || '').trim().toLowerCase();

        if (!Object.prototype.hasOwnProperty.call(this.wheelSpeedRpmByKey, wheelKey)) {
            return null;
        }

        return wheelKey;
    }

    setViewerWheelKey(key) {
        const normalizedKey = String(key || '').trim().toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(this.wheelSpeedRpmByKey, normalizedKey)) {
            return;
        }

        this.viewerWheelKey = normalizedKey;

        if (this.robotModel) {
            this.resolveWheelAnimationTargets();
        }
    }

    flashViewerWheel() {
        if (!this.viewerWheelKey || !this.robotModel) {
            return;
        }

        const runtimeTarget = this.wheelRuntimeTargetByKey[this.viewerWheelKey] || null;
        const wheelObject = runtimeTarget?.ref || null;
        if (!wheelObject) {
            return;
        }

        if (this.wheelFlashTimeoutId) {
            clearTimeout(this.wheelFlashTimeoutId);
            this.wheelFlashTimeoutId = null;
        }

        const materials = [];
        wheelObject.traverse(node => {
            if (!node || !node.isMesh || !node.material) {
                return;
            }

            const nodeMaterials = Array.isArray(node.material) ? node.material : [node.material];
            nodeMaterials.forEach(material => {
                if (material) {
                    materials.push(material);
                }
            });
        });

        if (materials.length === 0) {
            return;
        }

        const originalStates = materials.map(material => ({
            material: material,
            color: material.color ? material.color.clone() : null,
            emissive: material.emissive ? material.emissive.clone() : null
        }));

        materials.forEach(material => {
            if (material.color) {
                material.color.copy(this.wheelFlashAccentColor);
            }

            if (material.emissive) {
                material.emissive.copy(this.wheelFlashEmissiveColor);
            }
            material.needsUpdate = true;
        });

        this.wheelFlashTimeoutId = setTimeout(() => {
            originalStates.forEach(state => {
                if (state.color && state.material.color) {
                    state.material.color.copy(state.color);
                }

                if (state.emissive && state.material.emissive) {
                    state.material.emissive.copy(state.emissive);
                }

                state.material.needsUpdate = true;
            });
            this.wheelFlashTimeoutId = null;
        }, 500);
    }

    init() {
        // 동적 크기 계산
        const containerRect = this.container.getBoundingClientRect();
        const width = containerRect.width;
        const height = containerRect.height;
        
        console.log(`[URDF] 컨테이너 크기: ${width}x${height}`);

        // Scene 생성
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xf8f8f8);

        // Camera 생성
        this.camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000);
        this.camera.position.copy(this.cameraPosition);

        // Renderer 생성
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(width, height);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);

        // Controls 설정
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.cameraPosTextElement = $('#camera-pos-text');
        this.setupCameraAngleLogging();
        this.setupCameraToastOverlay();
        this.setupWheelControls();
        if (this.showAttitude) {
            this.setupAttitudeOverlay();
        }

        // 조명 설정
        this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
        this.directionalLight.castShadow = true;
        this.scene.add(this.directionalLight);
        this.scene.add(this.directionalLight.target);
        this.resetDirectionalLight(new THREE.Vector3(0, 0, 0), 1);

        const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
        this.scene.add(ambientLight);

        // 바닥 그리드와 축 추가
        const gridHelper = new THREE.GridHelper(10, 20, 0x888888, 0xcccccc);
        gridHelper.rotation.x = Math.PI / 2;
        gridHelper.visible = false;
        gridHelper.renderOrder = 999;
        if (Array.isArray(gridHelper.material)) {
            gridHelper.material.forEach(material => {
                material.depthTest = false;
                material.depthWrite = false;
            });
        } else if (gridHelper.material) {
            gridHelper.material.depthTest = false;
            gridHelper.material.depthWrite = false;
        }
        this.scene.add(gridHelper);
        this.xyGridHelper = gridHelper;

        this.createAxisGuides(new THREE.Vector3(1, 1, 1));
        this.addAxisLabels(new THREE.Vector3(1, 1, 1));

        // 마우스 이벤트 설정
        this.setupMouseEvents();

        // URDF 로드
        this.loadURDF();

        // 애니메이션 시작
        this.animate();

        // 리사이즈 이벤트 설정
        this.setupResizeHandler();
    }

    setupAttitudeOverlay() {
        const panelElement = document.createElement('div');
        panelElement.style.position = 'absolute';
        panelElement.style.top = '12px';
        panelElement.style.right = '12px';
        panelElement.style.zIndex = '12';
        panelElement.style.padding = '8px 10px';
        panelElement.style.background = 'rgba(255, 255, 255, 0.88)';
        panelElement.style.border = '1px solid rgba(30, 30, 30, 0.2)';
        panelElement.style.borderRadius = '10px';
        panelElement.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.12)';
        panelElement.style.pointerEvents = 'none';
        panelElement.style.minWidth = '100px';

        const titleElement = document.createElement('div');
        titleElement.textContent = '';
        titleElement.style.fontSize = '11px';
        titleElement.style.fontWeight = '700';
        titleElement.style.color = '#222';

        const textElement = document.createElement('div');
        textElement.style.fontSize = '11px';
        textElement.style.marginTop = '2px';
        textElement.style.color = '#333';
        textElement.style.textAlign = 'center';

        const dialElement = document.createElement('div');
        dialElement.style.position = 'relative';
        dialElement.style.width = '56px';
        dialElement.style.height = '56px';
        dialElement.style.margin = '8px auto 2px';
        dialElement.style.border = '1px solid rgba(34, 34, 34, 0.28)';
        dialElement.style.borderRadius = '999px';
        dialElement.style.background = 'rgba(245, 247, 250, 0.9)';

        const crossXElement = document.createElement('div');
        crossXElement.style.position = 'absolute';
        crossXElement.style.left = '50%';
        crossXElement.style.top = '8px';
        crossXElement.style.width = '1px';
        crossXElement.style.height = '40px';
        crossXElement.style.transform = 'translateX(-50%)';
        crossXElement.style.background = 'rgba(50, 50, 50, 0.16)';

        const crossYElement = document.createElement('div');
        crossYElement.style.position = 'absolute';
        crossYElement.style.left = '8px';
        crossYElement.style.top = '50%';
        crossYElement.style.width = '40px';
        crossYElement.style.height = '1px';
        crossYElement.style.transform = 'translateY(-50%)';
        crossYElement.style.background = 'rgba(50, 50, 50, 0.16)';

        const rollNeedleElement = document.createElement('div');
        rollNeedleElement.style.position = 'absolute';
        rollNeedleElement.style.left = '50%';
        rollNeedleElement.style.top = '50%';
        rollNeedleElement.style.width = '2px';
        rollNeedleElement.style.height = '22px';
        rollNeedleElement.style.background = '#d33';
        rollNeedleElement.style.transformOrigin = '50% calc(100% - 2px)';
        rollNeedleElement.style.transform = 'translate(-50%, -100%) rotate(0deg)';
        rollNeedleElement.style.borderRadius = '2px';

        const pitchNeedleElement = document.createElement('div');
        pitchNeedleElement.style.position = 'absolute';
        pitchNeedleElement.style.left = '50%';
        pitchNeedleElement.style.top = '50%';
        pitchNeedleElement.style.width = '2px';
        pitchNeedleElement.style.height = '18px';
        pitchNeedleElement.style.background = '#2f6bdf';
        pitchNeedleElement.style.transformOrigin = '50% calc(100% - 2px)';
        pitchNeedleElement.style.transform = 'translate(-50%, -100%) rotate(90deg)';
        pitchNeedleElement.style.borderRadius = '2px';

        const centerDotElement = document.createElement('div');
        centerDotElement.style.position = 'absolute';
        centerDotElement.style.left = '50%';
        centerDotElement.style.top = '50%';
        centerDotElement.style.width = '6px';
        centerDotElement.style.height = '6px';
        centerDotElement.style.transform = 'translate(-50%, -50%)';
        centerDotElement.style.background = '#222';
        centerDotElement.style.borderRadius = '999px';

        dialElement.appendChild(crossXElement);
        dialElement.appendChild(crossYElement);
        dialElement.appendChild(rollNeedleElement);
        dialElement.appendChild(pitchNeedleElement);
        dialElement.appendChild(centerDotElement);

        panelElement.appendChild(titleElement);
        panelElement.appendChild(textElement);
        panelElement.appendChild(dialElement);
        this.container.appendChild(panelElement);

        this.attitudeOverlayElement = panelElement;
        this.attitudeTextElement = textElement;
        this.rollNeedleElement = rollNeedleElement;
        this.pitchNeedleElement = pitchNeedleElement;
        this.updateAttitudeOverlay();
    }

    updateAttitudeOverlay() {
        const rollDeg = Number.isFinite(this.roadRollAngleDeg) ? this.roadRollAngleDeg : 0;
        const pitchDeg = Number.isFinite(this.roadPitchAngleDeg) ? this.roadPitchAngleDeg : 0;

        if (this.attitudeTextElement) {
            this.attitudeTextElement.textContent = `Roll ${rollDeg.toFixed(1)}\u00b0 / Pitch ${pitchDeg.toFixed(1)}\u00b0`;
        }

        if (this.rollNeedleElement) {
            this.rollNeedleElement.style.transform = `translate(-50%, -100%) rotate(${rollDeg}deg)`;
        }

        if (this.pitchNeedleElement) {
            this.pitchNeedleElement.style.transform = `translate(-50%, -100%) rotate(${90 + pitchDeg}deg)`;
        }
    }

    setupCameraAngleLogging() {
        this.controls.addEventListener('start', () => {
            this.isDragging = true;
        });

        this.controls.addEventListener('end', () => {
            this.isDragging = false;
            this.logCameraInfos(true);
            this.hideCameraToastOverlayLater();
        });

        this.controls.addEventListener('change', () => {
            this.resetDirectionalLight(this.controls.target, this.directionalLightRadius);
            if (this.isDragging) {
                this.updateCameraToastOverlay();
                this.showCameraToastOverlay();
            }
            this.logCameraInfos(false);
        });
    }

    setupCameraToastOverlay() {
        if (!this.container || this.cameraToastElement) {
            return;
        }

        const toastElement = document.createElement('div');
        toastElement.style.position = 'absolute';
        toastElement.style.right = '12px';
        toastElement.style.bottom = '12px';
        toastElement.style.zIndex = '20';
        toastElement.style.padding = '8px 10px';
        toastElement.style.background = 'rgba(17, 17, 17, 0.82)';
        toastElement.style.border = '1px solid rgba(255, 255, 255, 0.12)';
        toastElement.style.borderRadius = '10px';
        toastElement.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.22)';
        toastElement.style.color = '#ffffff';
        toastElement.style.fontSize = '12px';
        toastElement.style.fontWeight = '700';
        toastElement.style.letterSpacing = '0.02em';
        toastElement.style.pointerEvents = 'auto';
        toastElement.style.cursor = 'pointer';
        toastElement.style.display = 'none';
        toastElement.style.whiteSpace = 'nowrap';
        toastElement.title = 'Click to copy camera position';
        toastElement.textContent = '0.000, 0.000, 0.000';

        toastElement.addEventListener('click', () => {
            this.copyCameraToastToClipboard();
        });

        this.container.appendChild(toastElement);
        this.cameraToastElement = toastElement;
    }

    updateCameraToastOverlay() {
        if (!this.cameraToastElement) {
            return;
        }

        const formatPositionValue = (value) => {
            const numberValue = Number(value);
            if (!Number.isFinite(numberValue)) {
                return '0.000';
            }
            return numberValue.toFixed(3);
        };

        const px = formatPositionValue(this.camera.position.x);
        const py = formatPositionValue(this.camera.position.y);
        const pz = formatPositionValue(this.camera.position.z);
        this.cameraToastElement.textContent = `${px}, ${py}, ${pz}`;
    }

    copyCameraToastToClipboard() {
        if (!this.cameraToastElement) {
            return;
        }

        const textToCopy = this.cameraToastElement.textContent || '0.000, 0.000, 0.000';

        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(textToCopy).catch(() => {
                this.copyTextToClipboardFallback(textToCopy);
            });
            return;
        }

        this.copyTextToClipboardFallback(textToCopy);
    }

    copyTextToClipboardFallback(text) {
        const tempTextArea = document.createElement('textarea');
        tempTextArea.value = text;
        tempTextArea.setAttribute('readonly', '');
        tempTextArea.style.position = 'fixed';
        tempTextArea.style.left = '-9999px';
        tempTextArea.style.top = '-9999px';
        document.body.appendChild(tempTextArea);
        tempTextArea.select();

        try {
            document.execCommand('copy');
        } catch (error) {
            console.warn('[URDF] 카메라 좌표 복사 실패:', error);
        }

        document.body.removeChild(tempTextArea);
    }

    showCameraToastOverlay() {
        if (!this.cameraToastElement) {
            return;
        }

        this.cameraToastElement.style.display = 'block';

        if (this.cameraToastHideTimer) {
            clearTimeout(this.cameraToastHideTimer);
        }

        this.cameraToastHideTimer = setTimeout(() => {
            this.hideCameraToastOverlay();
        }, this.cameraToastHideDelayMs);
    }

    hideCameraToastOverlay() {
        if (!this.cameraToastElement) {
            return;
        }

        this.cameraToastElement.style.display = 'none';
        if (this.cameraToastHideTimer) {
            clearTimeout(this.cameraToastHideTimer);
            this.cameraToastHideTimer = null;
        }
    }

    hideCameraToastOverlayLater() {
        if (!this.cameraToastElement) {
            return;
        }

        if (this.cameraToastHideTimer) {
            clearTimeout(this.cameraToastHideTimer);
        }

        this.cameraToastHideTimer = setTimeout(() => {
            this.hideCameraToastOverlay();
        }, this.cameraToastHideDelayMs);
    }

    setupWheelControls() {
        Object.keys(this.wheelSpeedRpmByKey).forEach(key => {
            const inputElement = $(`#wheel-speed-rpm-${key}`);
            const valueElement = $(`#wheel-speed-rpm-value-${key}`);

            this.wheelSpeedInputByKey[key] = inputElement;
            this.wheelSpeedValueByKey[key] = valueElement;

            if (inputElement.length === 0) {
                return;
            }

            inputElement.val(String(this.wheelSpeedRpmByKey[key]));
            this.updateWheelSpeedFromInput(key);
        });
    }

    convertRpmToRadPerSec(rpm) {
        return (rpm * Math.PI * 2) / 60;
    }

    updateWheelSpeedFromInput(key) {
        const inputElement = this.wheelSpeedInputByKey[key];
        if (!inputElement || inputElement.length === 0) {
            return;
        }

        const inputRpm = Number.parseFloat(inputElement.val());
        const normalizedRpm = Number.isFinite(inputRpm) ? Math.max(Math.round(inputRpm), 0) : this.wheelSpeedRpmByKey[key];

        this.wheelSpeedRpmByKey[key] = normalizedRpm;
        this.wheelAngularSpeedRadByKey[key] = this.convertRpmToRadPerSec(normalizedRpm);
        inputElement.val(String(normalizedRpm));

        const valueElement = this.wheelSpeedValueByKey[key];
        if (valueElement && valueElement.length > 0) {
            valueElement.text(`${normalizedRpm} rpm`);
        }
    }

    setWheelSpeedRpm(key, rpm) {
        const numericRpm = Number.parseFloat(rpm);
        const directionSign = Number.isFinite(numericRpm) && numericRpm < 0 ? -1 : 1;
        const normalizedRpm = Number.isFinite(numericRpm)
            ? Math.max(Math.round(Math.abs(numericRpm)), 0)
            : this.wheelSpeedRpmByKey[key];

        this.setWheelDirectionSign(key, directionSign);

        this.wheelSpeedRpmByKey[key] = normalizedRpm;
        this.wheelAngularSpeedRadByKey[key] = this.convertRpmToRadPerSec(normalizedRpm);

        const inputElement = this.wheelSpeedInputByKey[key];
        if (inputElement && inputElement.length > 0) {
            inputElement.val(String(normalizedRpm));
        }

        const valueElement = this.wheelSpeedValueByKey[key];
        if (valueElement && valueElement.length > 0) {
            valueElement.text(`${normalizedRpm} rpm`);
        }
    }

    setWheelDirectionSign(key, sign) {
        this.wheelDirectionSignByKey[key] = sign >= 0 ? 1 : -1;
    }

    convertKmhToRpm(kmh) {
        return Math.max(kmh, 0) * this.kmhToRpmFactor;
    }

    applyDriveMode(mode, speedKmh) {
        this.driveMode = mode;
        this.driveSpeedKmh = Number.isFinite(Number(speedKmh)) ? Math.max(Number(speedKmh), 0) : this.driveSpeedKmh;

        const baseRpm = this.convertKmhToRpm(this.driveSpeedKmh);
        const leftTurnRatio = 0.45;
        const rightTurnRatio = 0.45;

        if (mode === 'forward') {
            this.setWheelDirectionSign('fl', 1);
            this.setWheelDirectionSign('fr', 1);
            this.setWheelDirectionSign('rl', 1);
            this.setWheelDirectionSign('rr', 1);
            this.setWheelSpeedRpm('fl', baseRpm);
            this.setWheelSpeedRpm('fr', baseRpm);
            this.setWheelSpeedRpm('rl', baseRpm);
            this.setWheelSpeedRpm('rr', baseRpm);
            return;
        }

        if (mode === 'backward') {
            this.setWheelDirectionSign('fl', -1);
            this.setWheelDirectionSign('fr', -1);
            this.setWheelDirectionSign('rl', -1);
            this.setWheelDirectionSign('rr', -1);
            this.setWheelSpeedRpm('fl', -baseRpm);
            this.setWheelSpeedRpm('fr', -baseRpm);
            this.setWheelSpeedRpm('rl', -baseRpm);
            this.setWheelSpeedRpm('rr', -baseRpm);
            return;
        }

        if (mode === 'left') {
            this.setWheelDirectionSign('fl', 1);
            this.setWheelDirectionSign('fr', 1);
            this.setWheelDirectionSign('rl', 1);
            this.setWheelDirectionSign('rr', 1);
            this.setWheelSpeedRpm('fl', baseRpm * leftTurnRatio);
            this.setWheelSpeedRpm('fr', baseRpm);
            this.setWheelSpeedRpm('rl', baseRpm * leftTurnRatio);
            this.setWheelSpeedRpm('rr', baseRpm);
            return;
        }

        if (mode === 'right') {
            this.setWheelDirectionSign('fl', 1);
            this.setWheelDirectionSign('fr', 1);
            this.setWheelDirectionSign('rl', 1);
            this.setWheelDirectionSign('rr', 1);
            this.setWheelSpeedRpm('fl', baseRpm);
            this.setWheelSpeedRpm('fr', baseRpm * rightTurnRatio);
            this.setWheelSpeedRpm('rl', baseRpm);
            this.setWheelSpeedRpm('rr', baseRpm * rightTurnRatio);
            return;
        }

        if (mode === 'stop') {
            this.setWheelDirectionSign('fl', 1);
            this.setWheelDirectionSign('fr', 1);
            this.setWheelDirectionSign('rl', 1);
            this.setWheelDirectionSign('rr', 1);
            this.setWheelSpeedRpm('fl', 0);
            this.setWheelSpeedRpm('fr', 0);
            this.setWheelSpeedRpm('rl', 0);
            this.setWheelSpeedRpm('rr', 0);
        }
    }

    applyWheelAnimation(deltaSec) {
        if (!this.robotModel) {
            return;
        }

        Object.keys(this.wheelSpeedRpmByKey).forEach(key => {
            const runtimeTarget = this.wheelRuntimeTargetByKey[key];
            if (!runtimeTarget) {
                return;
            }

            const wheelAngularSpeedRad = this.wheelAngularSpeedRadByKey[key] || 0;
            if (Math.abs(wheelAngularSpeedRad) <= 0) {
                return;
            }

            const wheelDirection = this.wheelDirectionSignByKey[key] || 1;
            this.wheelAngles[key] += wheelDirection * wheelAngularSpeedRad * deltaSec;

            if (runtimeTarget.type === 'joint') {
                runtimeTarget.ref.setJointValue(this.wheelAngles[key]);
                return;
            }

            if (runtimeTarget.type === 'link') {
                const rotationAxis = this.viewerWheelKey ? 'x' : 'y';
                const rotationSign = this.viewerWheelKey ? -1 : 1;
                runtimeTarget.ref.rotation[rotationAxis] = this.wheelAngles[key] * rotationSign;
            }
        });
    }

    applyRoadAttitudeAngles() {
        this.updateAttitudeOverlay();

        if (!this.robotModel) {
            return;
        }

        const carFrame = this.robotModel.links?.car_frame || null;
        if (!carFrame) {
            return;
        }

        // 차량 차체와 노면만 함께 기울이고, 지표면은 고정한다.
        carFrame.rotation.set(
            THREE.MathUtils.degToRad(this.roadRollAngleDeg),
            THREE.MathUtils.degToRad(this.roadPitchAngleDeg),
            0
        );
    }

    applyRoadRollAngleDeg(angleDeg) {
        const numericAngleDeg = Number.parseFloat(angleDeg);
        const normalizedAngleDeg = Number.isFinite(numericAngleDeg)
            ? THREE.MathUtils.clamp(numericAngleDeg, -30, 30)
            : this.roadRollAngleDeg;

        this.roadRollAngleDeg = normalizedAngleDeg;
        this.applyRoadAttitudeAngles();
    }

    applyRoadPitchAngleDeg(angleDeg) {
        const numericAngleDeg = Number.parseFloat(angleDeg);
        const normalizedAngleDeg = Number.isFinite(numericAngleDeg)
            ? THREE.MathUtils.clamp(numericAngleDeg, -30, 30)
            : this.roadPitchAngleDeg;

        this.roadPitchAngleDeg = normalizedAngleDeg;
        this.applyRoadAttitudeAngles();
    }

    resolveWheelAnimationTargets() {
        const jointMap = this.robotModel?.joints || {};
        const linkMap = this.robotModel?.links || {};
        const jointNames = Object.keys(jointMap);

        if (this.viewerWheelKey) {
            const singleWheelLink = linkMap.wheel || null;
            if (singleWheelLink) {
                Object.keys(this.wheelRuntimeTargetByKey).forEach(key => {
                    this.wheelRuntimeTargetByKey[key] = key === this.viewerWheelKey
                        ? { type: 'link', ref: singleWheelLink }
                        : null;
                });

                console.log(`[URDF] ${this.viewerWheelKey.toUpperCase()} 단일 휠 뷰어 연결: wheel 링크`);
                return;
            }
        }

        Object.keys(this.wheelJointNameByKey).forEach(key => {
            const expectedJointName = this.wheelJointNameByKey[key];
            let joint = jointMap[expectedJointName] || null;

            if (!joint) {
                const keySuffix = `_${key}`;
                const candidateJointName = jointNames.find(name => (
                    name === expectedJointName ||
                    name.endsWith(expectedJointName) ||
                    name.endsWith(keySuffix)
                ));

                if (candidateJointName) {
                    joint = jointMap[candidateJointName];
                }
            }

            if (joint && typeof joint.setJointValue === 'function') {
                this.wheelRuntimeTargetByKey[key] = {
                    type: 'joint',
                    ref: joint
                };
                console.log(`[URDF] ${key.toUpperCase()} 휠 조인트 연결:`, joint.name || expectedJointName);
                return;
            }

            const expectedLinkName = this.wheelLinkNameByKey[key];
            const link = linkMap[expectedLinkName] || null;
            if (link) {
                this.wheelRuntimeTargetByKey[key] = {
                    type: 'link',
                    ref: link
                };
                console.warn(`[URDF] ${key.toUpperCase()} 조인트 미발견. 링크 회전 폴백 사용:`, expectedLinkName);
                return;
            }

            this.wheelRuntimeTargetByKey[key] = null;
            console.warn(`[URDF] ${key.toUpperCase()} 휠 대상(조인트/링크)을 찾지 못했습니다.`);
        });
    }

    logCameraInfos(force) {
        const now = performance.now();
        if (!force && now - this.lastAngleLogAt < this.angleLogIntervalMs) {
            return;
        }
        this.lastAngleLogAt = now;

        const formatPositionValue = (value) => {
            const numberValue = Number(value);
            if (!Number.isFinite(numberValue)) {
                return "0.000";
            }
            return numberValue.toFixed(3);
        };

        const px = formatPositionValue(this.camera.position.x);
        const py = formatPositionValue(this.camera.position.y);
        const pz = formatPositionValue(this.camera.position.z);
        const positionText = `${px}, ${py}, ${pz}`;

        if (this.cameraPosTextElement && this.cameraPosTextElement.length > 0) {
            this.cameraPosTextElement.text(positionText);
        }
    }

    setCameraFromPosition(center, distance) {
        const direction = this.camera.position.clone().sub(center);
        if (direction.lengthSq() < 1e-8) {
            direction.set(1, 1, 2);
        }

        direction.normalize().multiplyScalar(distance);
        this.camera.position.copy(center).add(direction);
        this.camera.lookAt(center);
    }

    calculateFitDistance(radius, marginRatio = 0.05) {
        const safeRadius = Math.max(radius, 0.001);
        const paddedRadius = safeRadius * (1 + Math.max(marginRatio, 0));

        const vFovHalfRad = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
        const hFovHalfRad = Math.atan(Math.tan(vFovHalfRad) * this.camera.aspect);
        const limitingHalfFov = Math.max(Math.min(vFovHalfRad, hFovHalfRad), 0.001);

        return paddedRadius / Math.tan(limitingHalfFov);
    }

    resetDirectionalLight(center, radius) {
        if (!this.directionalLight) {
            return;
        }

        const safeRadius = Math.max(radius, 0.001);
        this.directionalLightRadius = safeRadius;

        const lightDirection = this.camera.position.clone().sub(center);
        if (lightDirection.lengthSq() < 1e-8) {
            lightDirection.set(1, 1, 2);
        }

        lightDirection.normalize();

        const worldUp = new THREE.Vector3(0, 0, 1);
        const sideDirection = new THREE.Vector3().crossVectors(lightDirection, worldUp);
        if (sideDirection.lengthSq() < 1e-8) {
            sideDirection.set(0, 1, 0);
        } else {
            sideDirection.normalize();
        }

        const elevatedDirection = lightDirection
            .clone()
            .multiplyScalar(2.0)
            .add(sideDirection.multiplyScalar(0.7))
            .add(worldUp.clone().multiplyScalar(1.2))
            .normalize();

        this.directionalLight.position.copy(
            center.clone().add(elevatedDirection.multiplyScalar(safeRadius * 2.6))
        );
        this.directionalLight.target.position.copy(center);

        const shadowRange = safeRadius * 3.0;
        this.directionalLight.shadow.camera.left = -shadowRange;
        this.directionalLight.shadow.camera.right = shadowRange;
        this.directionalLight.shadow.camera.top = shadowRange;
        this.directionalLight.shadow.camera.bottom = -shadowRange;
        this.directionalLight.shadow.camera.near = 0.01;
        this.directionalLight.shadow.camera.far = safeRadius * 12.0;
        this.directionalLight.shadow.mapSize.set(1024, 1024);

        this.directionalLight.target.updateMatrixWorld();
        this.directionalLight.shadow.camera.updateProjectionMatrix();
    }

    createAxisLabel(text, colorHex, position) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;

        const context = canvas.getContext('2d');
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.font = 'bold 144px Arial';
        context.fillStyle = colorHex;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, 128, 128);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });

        const sprite = new THREE.Sprite(material);
        sprite.position.copy(position);
        sprite.scale.set(0.2, 0.2, 0.2);
        sprite.renderOrder = 1000;
        sprite.userData.axisLabelText = text;
        sprite.userData.axisLabelColor = colorHex;

        return sprite;
    }

    createAxisLine(endVector, colorHex) {
        const geometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            endVector
        ]);
        const material = new THREE.LineBasicMaterial({
            color: colorHex,
            depthTest: false,
            depthWrite: false,
            transparent: true,
            opacity: 0.95
        });
        return new THREE.Line(geometry, material);
    }

    createAxisGuides(axisLengths) {
        const lengthX = Math.max(Number(axisLengths?.x) || 0, 0.001);
        const lengthY = Math.max(Number(axisLengths?.y) || 0, 0.001);
        const lengthZ = Math.max(Number(axisLengths?.z) || 0, 0.001);

        const axesGroup = new THREE.Group();
        axesGroup.visible = false;

        const xLine = this.createAxisLine(new THREE.Vector3(lengthX, 0, 0), 0xff3333);
        const yLine = this.createAxisLine(new THREE.Vector3(0, lengthY, 0), 0x22aa22);
        const zLine = this.createAxisLine(new THREE.Vector3(0, 0, lengthZ), 0x3366ff);

        axesGroup.add(xLine);
        axesGroup.add(yLine);
        axesGroup.add(zLine);

        this.scene.add(axesGroup);
        this.axesHelper = axesGroup;
        this.axisLineByKey = {
            x: xLine,
            y: yLine,
            z: zLine
        };
    }

    updateAxisLineLength(axisKey, length) {
        const axisLine = this.axisLineByKey[axisKey];
        if (!axisLine) {
            return;
        }

        const safeLength = Math.max(Number(length) || 0, 0.001);
        const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0)];
        if (axisKey === 'x') {
            points[1].x = safeLength;
        } else if (axisKey === 'y') {
            points[1].y = safeLength;
        } else {
            points[1].z = safeLength;
        }

        axisLine.geometry.setFromPoints(points);
        axisLine.geometry.computeBoundingSphere();
    }


    addAxisLabels(axisLengths) {
        const lengthX = Math.max(Number(axisLengths?.x) || 0, 0.001);
        const lengthY = Math.max(Number(axisLengths?.y) || 0, 0.001);
        const lengthZ = Math.max(Number(axisLengths?.z) || 0, 0.001);
        const margin = Math.max(Math.max(lengthX, lengthY, lengthZ) * 0.05, 0.06);
        const xLabel = this.createAxisLabel('X', '#ff3333', new THREE.Vector3(lengthX + margin, 0, 0));
        const yLabel = this.createAxisLabel('Y', '#22aa22', new THREE.Vector3(0, lengthY + margin, 0));
        const zLabel = this.createAxisLabel('Z', '#3366ff', new THREE.Vector3(0, 0, lengthZ + margin));

        xLabel.visible = false;
        yLabel.visible = false;
        zLabel.visible = false;

        this.scene.add(xLabel);
        this.scene.add(yLabel);
        this.scene.add(zLabel);

        this.axisLabelSprites = [xLabel, yLabel, zLabel];
    }

    updateAxisGuideLengthsByModelSize(modelSizeVec3) {
        if (!modelSizeVec3) {
            return;
        }

        const sizeX = Math.max(Number(modelSizeVec3.x) || 0, 0.001);
        const sizeY = Math.max(Number(modelSizeVec3.y) || 0, 0.001);
        const sizeZ = Math.max(Number(modelSizeVec3.z) || 0, 0.001);

        const axisLengthX = sizeX * this.axisLengthScaleRatio;
        const axisLengthY = sizeY * this.axisLengthScaleRatio;
        const axisLengthZ = sizeZ * this.axisLengthScaleRatio;

        this.updateAxisLineLength('x', axisLengthX);
        this.updateAxisLineLength('y', axisLengthY);
        this.updateAxisLineLength('z', axisLengthZ);

        const margin = Math.max(Math.max(axisLengthX, axisLengthY, axisLengthZ) * 0.05, 0.06);
        if (this.axisLabelSprites.length >= 3) {
            this.axisLabelSprites[0].position.set(axisLengthX + margin, 0, 0);
            this.axisLabelSprites[1].position.set(0, axisLengthY + margin, 0);
            this.axisLabelSprites[2].position.set(0, 0, axisLengthZ + margin);
        }
    }

    redrawAxisLabelSpriteFont(sprite, fontPx) {
        if (!sprite || !sprite.material || !sprite.material.map) {
            return;
        }

        const canvas = sprite.material.map.image;
        if (!canvas) {
            return;
        }

        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }

        const text = sprite.userData.axisLabelText || '';
        const color = sprite.userData.axisLabelColor || '#ffffff';

        context.clearRect(0, 0, canvas.width, canvas.height);
        context.font = `bold ${fontPx}px Arial`;
        context.fillStyle = color;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, canvas.width / 2, canvas.height / 2);
        sprite.material.map.needsUpdate = true;
    }

    updateAxisLabelScaleByModelSize(modelSizeVec3) {
        if (!modelSizeVec3 || this.axisLabelSprites.length === 0) {
            return;
        }

        const sizeX = Number.isFinite(modelSizeVec3.x) ? modelSizeVec3.x : 0;
        const sizeY = Number.isFinite(modelSizeVec3.y) ? modelSizeVec3.y : 0;
        const sizeZ = Number.isFinite(modelSizeVec3.z) ? modelSizeVec3.z : 0;
        // Use the largest model dimension as the baseline so "10%" remains consistent
        // regardless of the model's aspect ratio.
        const maxDimension = Math.max(sizeX, sizeY, sizeZ, 0.001);
        const labelScale = maxDimension * this.axisLabelScaleRatio;
        const fontPx = Math.max(96, Math.min(240, Math.round(220 * (this.axisLabelScaleRatio / 0.10))));

        this.axisLabelSprites.forEach(sprite => {
            if (sprite) {
                sprite.scale.set(labelScale, labelScale, labelScale);
                this.redrawAxisLabelSpriteFont(sprite, fontPx);
            }
        });
    }

    setReferenceGuidesVisible(isVisible) {
        if (this.xyGridHelper) {
            this.xyGridHelper.visible = isVisible;
        }

        if (this.axesHelper) {
            this.axesHelper.visible = isVisible;
        }

        this.axisLabelSprites.forEach(sprite => {
            if (sprite) {
                sprite.visible = isVisible;
            }
        });
    }

    setAxesAndLabelsVisible(isVisible) {
        if (this.axesHelper) {
            this.axesHelper.visible = isVisible;
        }

        this.axisLabelSprites.forEach(sprite => {
            if (sprite) {
                sprite.visible = isVisible;
            }
        });
    }

    toggleAxesAndLabels() {
        const currentVisible = this.axesHelper ? this.axesHelper.visible : false;
        const nextVisible = !currentVisible;
        this.setAxesAndLabelsVisible(nextVisible);
        console.log(`[URDF] axes+labels ${nextVisible ? 'ON' : 'OFF'}`);
    }

    toggleXYGrid() {
        if (!this.xyGridHelper) {
            return;
        }

        const nextVisible = !this.xyGridHelper.visible;
        this.xyGridHelper.visible = nextVisible;
        console.log(`[URDF] XY grid ${nextVisible ? 'ON' : 'OFF'}`);
    }

    setupMouseEvents() {
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();

        this.container.addEventListener('mousedown', (event) => {
            if (event.ctrlKey) {
                if (this.referenceToggleStep === 0) {
                    this.toggleAxesAndLabels();
                } else {
                    this.toggleXYGrid();
                }

                this.referenceToggleStep = (this.referenceToggleStep + 1) % 2;
                return;
            }

            const rect = this.container.getBoundingClientRect();
            const width = rect.width;
            const height = rect.height;
            
            mouse.x = ((event.clientX - rect.left) / width) * 2 - 1;
            mouse.y = -((event.clientY - rect.top) / height) * 2 + 1;

            raycaster.setFromCamera(mouse, this.camera);

            if (this.robotModel) {
                const intersects = raycaster.intersectObject(this.robotModel, true);

                if (intersects.length > 0) {
                    this.goalTarget.copy(intersects[0].point);
                    console.log('[URDF] 목표 지점 설정:', this.goalTarget);
                }
            }
        });
    }

    loadURDF() {
        const loader = new URDFLoader();

        console.log(`[URDF] URDF 파일 로딩 중... (${this.urdfPath})`);

        loader.load(
            this.urdfPath,

            robot => {
                console.log('[URDF] ✅ URDF 로드 성공');

                this.scene.add(robot);
                this.robotModel = robot;
                this.resolveWheelAnimationTargets();
                this.resolveWheelHighlightTargets();
                this.applyRoadAttitudeAngles();

                if (this.container.id === 'vehicle-urdf-viewer' && Array.isArray(window.pendingVehicleWheelHighlightKeys) && window.pendingVehicleWheelHighlightKeys.length > 0) {
                    this.applyWheelHighlightByKeys(window.pendingVehicleWheelHighlightKeys);
                } else if (this.container.id === 'vehicle-urdf-viewer' && window.pendingVehicleWheelHighlightKey) {
                    this.applyWheelHighlightByKey(window.pendingVehicleWheelHighlightKey);
                }

                // 자동 피팅 로직
                setTimeout(() => {
                    const bbox = new THREE.Box3().setFromObject(robot);
                    const center = bbox.getCenter(new THREE.Vector3());
                    const size = bbox.getSize(new THREE.Vector3());
                    const sphere = bbox.getBoundingSphere(new THREE.Sphere());
                    const radius = Math.max(sphere.radius, 0.001);

                    console.log('[URDF] 📏 모델 반경:', radius);
                    console.log('[URDF] 📍 모델 중심:', center);

                    this.updateAxisGuideLengthsByModelSize(size);
                    this.updateAxisLabelScaleByModelSize(size);

                    if (this.hasCustomCameraPosition) {
                        console.log('[URDF] cameraPosition 지정됨: 사용자 카메라 위치 유지');
                    } else {
                        const fitDistance = this.calculateFitDistance(radius, this.cameraFitMarginRatio);
                        this.setCameraFromPosition(center, fitDistance);
                        console.log('[URDF] cameraPosition 미지정: 자동 피팅 카메라 적용 (마진 5%)');
                    }

                    const currentCameraDist = Math.max(this.camera.position.distanceTo(center), 0.01);
                    this.camera.near = Math.max(currentCameraDist / 100, 0.01);
                    this.camera.far = Math.max(currentCameraDist * 100, 10);
                    this.camera.updateProjectionMatrix();

                    this.goalTarget.copy(center);
                    this.controls.target.copy(center);
                    this.controls.minDistance = currentCameraDist * 0.2;
                    this.controls.maxDistance = currentCameraDist * 8;
                    this.resetDirectionalLight(center, radius);
                    this.controls.update();
                    this.logCameraInfos(true);

                    console.log('[URDF] ✅ 카메라/클리핑/컨트롤 범위 갱신 완료');
                }, 200);
            },
            progress => {
                if (progress?.total) {
                    const percent = ((progress.loaded / progress.total) * 100).toFixed(1);
                    console.log(`[URDF] URDF 로딩 진행률: ${percent}%`);
                }
            },
            error => {
                console.error('[URDF] ❌ URDF 로드 실패:', error);
            }
        );
    }

    resolveWheelHighlightTargets() {
        const linkMap = this.robotModel?.links || {};

        Object.keys(this.wheelLinkNameByKey).forEach(key => {
            const expectedLinkName = this.wheelLinkNameByKey[key];
            const link = linkMap[expectedLinkName] || null;
            const meshes = [];

            if (!link) {
                this.wheelHighlightMeshesByKey[key] = meshes;
                return;
            }

            link.traverse(node => {
                if (!node || !node.isMesh || !node.material) {
                    return;
                }

                if (Array.isArray(node.material)) {
                    node.material = node.material.map(material => material?.clone?.() || material);
                } else if (node.material?.clone) {
                    node.material = node.material.clone();
                }

                const clonedMaterials = Array.isArray(node.material) ? node.material : [node.material];
                clonedMaterials.forEach(material => {
                    if (!material) {
                        return;
                    }

                    if (material.color) {
                        material.userData = material.userData || {};
                        if (!(material.userData.wheelBaseColor instanceof THREE.Color)) {
                            material.userData.wheelBaseColor = material.color.clone();
                        }
                    }

                    if (material.emissive) {
                        material.userData = material.userData || {};
                        if (!(material.userData.wheelBaseEmissive instanceof THREE.Color)) {
                            material.userData.wheelBaseEmissive = material.emissive.clone();
                        }
                    }
                });

                meshes.push(node);
            });

            this.wheelHighlightMeshesByKey[key] = meshes;
        });
    }

    applyWheelHighlightByKey(selectedKey) {
        this.applyWheelHighlightByKeys([selectedKey]);
    }

    applyWheelHighlightByKeys(selectedKeys) {
        const normalizedKeySet = new Set(
            (Array.isArray(selectedKeys) ? selectedKeys : [])
                .map(key => String(key || '').trim().toLowerCase())
                .filter(key => key && Object.prototype.hasOwnProperty.call(this.wheelHighlightMeshesByKey, key))
        );

        if (normalizedKeySet.size === 0) {
            return;
        }

        const firstSelectedKey = normalizedKeySet.values().next().value || null;
        this.highlightedWheelKey = firstSelectedKey;

        Object.keys(this.wheelHighlightMeshesByKey).forEach(key => {
            const wheelMeshes = this.wheelHighlightMeshesByKey[key] || [];
            const isSelected = normalizedKeySet.has(key);

            wheelMeshes.forEach(mesh => {
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                materials.forEach(material => {
                    if (!material) {
                        return;
                    }

                    if (material.color) {
                        const baseColor = material.userData?.wheelBaseColor instanceof THREE.Color
                            ? material.userData.wheelBaseColor
                            : this.wheelHighlightBaseColor;
                        const targetColor = isSelected
                            ? baseColor.clone().lerp(this.wheelHighlightAccentColor, 0.72)
                            : baseColor.clone().lerp(this.wheelHighlightDimColor, 0.22);
                        material.color.copy(targetColor);
                    }

                    if (material.emissive) {
                        const baseEmissive = material.userData?.wheelBaseEmissive instanceof THREE.Color
                            ? material.userData.wheelBaseEmissive
                            : new THREE.Color(0x000000);
                        const targetEmissive = isSelected
                            ? this.wheelHighlightEmissiveColor
                            : baseEmissive;
                        material.emissive.copy(targetEmissive);
                    }

                    material.needsUpdate = true;
                });
            });
        });
    }

    clearWheelHighlights() {
        this.highlightedWheelKey = null;
        Object.keys(this.wheelHighlightMeshesByKey).forEach(key => {
            const wheelMeshes = this.wheelHighlightMeshesByKey[key] || [];
            wheelMeshes.forEach(mesh => {
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                materials.forEach(material => {
                    if (!material) {
                        return;
                    }

                    if (material.color && material.userData?.wheelBaseColor instanceof THREE.Color) {
                        material.color.copy(material.userData.wheelBaseColor);
                    }

                    if (material.emissive && material.userData?.wheelBaseEmissive instanceof THREE.Color) {
                        material.emissive.copy(material.userData.wheelBaseEmissive);
                    }

                    material.needsUpdate = true;
                });
            });
        });
    }

    setupResizeHandler() {
        window.addEventListener('resize', () => {
            const newRect = this.container.getBoundingClientRect();
            const newWidth = newRect.width;
            const newHeight = newRect.height;
            
            this.camera.aspect = newWidth / newHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(newWidth, newHeight);
            
            console.log(`[URDF] 리사이즈: ${newWidth}x${newHeight}`);
        });
    }

    animate() {
        const now = performance.now();
        const deltaSec = Math.min((now - this.lastFrameTimeMs) / 1000, 0.1);
        this.lastFrameTimeMs = now;

        this.applyWheelAnimation(deltaSec);
        requestAnimationFrame(() => this.animate());
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}

function setWheelAnimationByKey(key, rpm) {
    const targetViewers = getWheelAnimationTargetViewersByKey(key);
    if (targetViewers.length === 0) {
        return;
    }

    targetViewers.forEach(viewer => {
        viewer.setWheelSpeedRpm(key, rpm);
    });
}

function getWheelAnimationTargetViewersByKey(key) {
    const viewers = [];
    const vehicleViewer = getWheelAnimationTargetViewer();
    if (vehicleViewer) {
        viewers.push(vehicleViewer);
    }

    const wheelViewerId = `${key}-wheel-urdf-viewer`;
    const wheelViewer = window.urdfViewersById?.[wheelViewerId] || null;
    if (wheelViewer && !viewers.includes(wheelViewer)) {
        viewers.push(wheelViewer);
    }

    const genericWheelViewer = window.urdfViewersById?.['wheel-urdf-viewer'] || null;
    if (genericWheelViewer && !viewers.includes(genericWheelViewer)) {
        viewers.push(genericWheelViewer);
    }

    return viewers;
}

function getWheelAnimationTargetViewer() {
    if (window.urdfViewersById?.['vehicle-urdf-viewer']) {
        return window.urdfViewersById['vehicle-urdf-viewer'];
    }

    if (Array.isArray(window.urdfViewers)) {
        const vehicleViewer = window.urdfViewers.find(viewer => {
            const urdfPath = String(viewer?.urdfPath || '');
            return urdfPath.includes('/vehicle/vehicle.urdf');
        });

        if (vehicleViewer) {
            return vehicleViewer;
        }
    }

    return window.activeURDFViewer || null;
}

globalThis.setWheelAnimationByKey = setWheelAnimationByKey;

globalThis.setWheelViewerKey = function(key) {
    window.pendingWheelViewerKey = String(key || '').trim().toLowerCase();

    const viewer = window.urdfViewersById?.['wheel-urdf-viewer'] || null;
    if (!viewer || typeof viewer.setViewerWheelKey !== 'function') {
        return;
    }

    viewer.setViewerWheelKey(key);
};

globalThis.flashWheelViewer = function() {
    const viewer = window.urdfViewersById?.['wheel-urdf-viewer'] || null;
    if (!viewer || typeof viewer.flashViewerWheel !== 'function') {
        return;
    }

    viewer.flashViewerWheel();
};

globalThis.setVehicleWheelHighlightByKey = function(key) {
    window.pendingVehicleWheelHighlightKeys = null;
    window.pendingVehicleWheelHighlightKey = String(key || '').trim().toLowerCase();

    const vehicleViewer = window.urdfViewersById?.['vehicle-urdf-viewer'] || null;
    if (!vehicleViewer || typeof vehicleViewer.applyWheelHighlightByKey !== 'function') {
        return;
    }

    vehicleViewer.applyWheelHighlightByKey(key);
};

globalThis.setVehicleWheelHighlightByKeys = function(keys) {
    const normalizedKeys = (Array.isArray(keys) ? keys : [])
        .map(key => String(key || '').trim().toLowerCase())
        .filter(Boolean);

    window.pendingVehicleWheelHighlightKey = null;
    window.pendingVehicleWheelHighlightKeys = normalizedKeys;

    const vehicleViewer = window.urdfViewersById?.['vehicle-urdf-viewer'] || null;
    if (!vehicleViewer || typeof vehicleViewer.applyWheelHighlightByKeys !== 'function') {
        return;
    }

    vehicleViewer.applyWheelHighlightByKeys(normalizedKeys);
};

globalThis.clearVehicleWheelHighlights = function() {
    window.pendingVehicleWheelHighlightKey = null;
    window.pendingVehicleWheelHighlightKeys = [];

    const vehicleViewer = window.urdfViewersById?.['vehicle-urdf-viewer'] || null;
    if (!vehicleViewer || typeof vehicleViewer.clearWheelHighlights !== 'function') {
        return;
    }

    vehicleViewer.clearWheelHighlights();
};

function setDriveMode(mode) {
    if (!window.activeURDFViewer) {
        return;
    }

    const speedInput = $('#drive-speed-kmh');
    let speedKmh = speedInput.length > 0 ? Number.parseFloat(speedInput.val()) : 0;
    speedKmh = Number.isFinite(speedKmh) ? Math.max(speedKmh, 0) : 0;

    const requiresAutoSpeed = mode === 'forward' || mode === 'backward' || mode === 'left' || mode === 'right';
    if (requiresAutoSpeed && speedKmh === 0) {
        speedKmh = 10;
        if (speedInput.length > 0) {
            speedInput.val(String(speedKmh));
        }
        $('#drive-speed-kmh-value').text(`${speedKmh} km/h`);
    }

    window.activeURDFViewer.applyDriveMode(mode, speedKmh);
    updateDriveModeButtons(mode);
}

function setDriveSpeedKmh(kmh) {
    const numericKmh = Number.parseFloat(kmh);
    const normalizedKmh = Number.isFinite(numericKmh) ? Math.max(numericKmh, 0) : 0;
    const speedValueElement = document.getElementById('drive-speed-kmh-value');
    if (speedValueElement) {
        speedValueElement.textContent = `${normalizedKmh} km/h`;
    }

    if (!window.activeURDFViewer) {
        return;
    }

    const mode = window.activeURDFViewer.driveMode || 'forward';
    window.activeURDFViewer.applyDriveMode(mode, normalizedKmh);
}

function setRoadRollAngleDeg(angleDeg) {
    const numericAngleDeg = Number.parseFloat(angleDeg);
    const normalizedAngleDeg = Number.isFinite(numericAngleDeg)
        ? Math.min(30, Math.max(-30, numericAngleDeg))
        : 0;

    const spinner = document.getElementById('road-roll-angle-deg');
    if (spinner) {
        spinner.value = String(normalizedAngleDeg);
    }

    const valueElement = document.getElementById('road-roll-angle-deg-value');
    if (valueElement) {
        valueElement.textContent = `${normalizedAngleDeg}\u00b0`;
    }

    if (!window.activeURDFViewer) {
        return;
    }

    window.activeURDFViewer.applyRoadRollAngleDeg(normalizedAngleDeg);
}

function setRoadPitchAngleDeg(angleDeg) {
    const numericAngleDeg = Number.parseFloat(angleDeg);
    const normalizedAngleDeg = Number.isFinite(numericAngleDeg)
        ? Math.min(30, Math.max(-30, numericAngleDeg))
        : 0;

    const spinner = document.getElementById('road-pitch-angle-deg');
    if (spinner) {
        spinner.value = String(normalizedAngleDeg);
    }

    const valueElement = document.getElementById('road-pitch-angle-deg-value');
    if (valueElement) {
        valueElement.textContent = `${normalizedAngleDeg}\u00b0`;
    }

    if (!window.activeURDFViewer) {
        return;
    }

    window.activeURDFViewer.applyRoadPitchAngleDeg(normalizedAngleDeg);
}

function updateDriveModeButtons(activeMode) {
    const modes = ['forward', 'backward', 'left', 'right', 'stop'];
    modes.forEach(mode => {
        const button = $(`#drive-btn-${mode}`);
        if (button.length === 0) {
            return;
        }

        const isActive = mode === activeMode;
        button.toggleClass('btn-success', isActive && mode === 'forward');
        button.toggleClass('btn-secondary', isActive && mode === 'backward');
        button.toggleClass('btn-primary', isActive && (mode === 'left' || mode === 'right'));
        button.toggleClass('btn-danger', isActive && mode === 'stop');
        button.toggleClass('btn-outline-success', !isActive && mode === 'forward');
        button.toggleClass('btn-outline-secondary', !isActive && mode === 'backward');
        button.toggleClass('btn-outline-primary', !isActive && (mode === 'left' || mode === 'right'));
        button.toggleClass('btn-outline-danger', !isActive && mode === 'stop');
    });
}

globalThis.setDriveMode = setDriveMode;
globalThis.setDriveSpeedKmh = setDriveSpeedKmh;
globalThis.setRoadRollAngleDeg = setRoadRollAngleDeg;
globalThis.setRoadPitchAngleDeg = setRoadPitchAngleDeg;

// 초기화 함수
function initURDFViewers() {
    console.log("[URDF] 🚀 URDF Viewer 초기화 시작...");
    window.activeURDFViewer = null;
    window.urdfViewers = [];
    window.urdfViewersById = {};
    
    // robot-container 클래스를 가진 모든 요소들 찾기
    const containers = $('.urdf-container, .robot-container').toArray();
    
    if (containers.length === 0) {
        console.error("[URDF] ❌ urdf-container 또는 robot-container 클래스를 가진 요소를 찾을 수 없습니다.");
        return;
    }
    
    console.log(`[URDF] 📦 ${containers.length}개의 urdf-container 발견`);
    
    // 각 컨테이너에 대해 URDFViewer 생성
    containers.forEach((container, index) => {
        const viewIndex = index + 1;
        const containerClass = container.className;
        
        // 컨테이너 내부의 기존 HTML 요소들 모두 삭제
        container.innerHTML = '';
        
        console.log(`[URDF] 🔧 ${containerClass} 요소 초기화 중... (ViewIndex: ${viewIndex})`);
        
        const viewer = new URDFViewer(container);
        window.activeURDFViewer = viewer;
        window.urdfViewers.push(viewer);

        if (container.id) {
            window.urdfViewersById[container.id] = viewer;
        }
    });

    setDriveSpeedKmh($('#drive-speed-kmh').val());
    setRoadRollAngleDeg($('#road-roll-angle-deg').val());
    setRoadPitchAngleDeg($('#road-pitch-angle-deg').val());
    updateDriveModeButtons(null);

    console.log("[URDF] 🚀 모든 URDF Viewer 초기화 완료");
}

// DOM 준비 후 초기화
$(initURDFViewers);