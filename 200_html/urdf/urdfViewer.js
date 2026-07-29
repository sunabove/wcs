import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const $ = window.jQuery;
const VEHICLE_AUDIO_STORAGE_KEY = 'wcs.vehicle.showAudio';

function ensureGlobalUserGestureTracker() {
    if (window.__wcsUserGestureTrackerAttached === true) {
        return;
    }

    const markGesture = function () {
        window.__wcsAnyUserGestureDetected = true;
    };

    document.addEventListener('pointerdown', markGesture, true);
    document.addEventListener('keydown', markGesture, true);
    document.addEventListener('touchstart', markGesture, true);

    window.__wcsUserGestureTrackerAttached = true;
}

function hasGlobalUserGestureDetected() {
    return window.__wcsAnyUserGestureDetected === true;
}

ensureGlobalUserGestureTracker();

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
        this.axisLengthExtraRatio = 0.625;
        this.axisLabelSprites = [];
        this.axisLabelScaleRatio = 0.10;
        this.axisLabelNearOriginRatio = 0.06;
        this.axisLabelMinOffset = 0.03;
        this.referenceToggleStep = 0;
        this.directionalLight = null;
        this.directionalLightRadius = 1;
        this.goalTarget = new THREE.Vector3(0, 0, 0);
        this.goalTargetVerticalOffset = 0;
        this.overlayDragPanPixels = 0;
        this.overlayZoomOutRatio = 0;
        this.isInitialCameraPoseReady = false;
        this.pendingOverlayDragPixels = null;
        this.pendingOverlayZoomOutRatio = null;
        this.isOrbitInteractionActive = false;
        this.isDragging = false;
        this.lastAngleLogAt = 0;
        this.angleLogIntervalMs = 120;
        this.cameraPosTextElement = null;
        this.cameraPosCopyText = '0.000, 0.000, 0.000|0.000, 0.000, 0.000|0.000, 1.000, 0.000';
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
        this.driveMode = 'stop';
        this.driveSpeedKmh = 0;
        this.kmhToRpmFactor = 4;
        this.wheelJointNameByKey = {
            fl: 'wheel_fl_joint',
            fr: 'wheel_fr_joint',
            rl: 'wheel_rl_joint',
            rr: 'wheel_rr_joint'
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
        this.wheelVisualAngularSpeedRadByKey = {
            fl: 0,
            fr: 0,
            rl: 0,
            rr: 0
        };
        this.enableWheelVisualFilter = this.parseBooleanAttribute(
            containerElement.getAttribute('wheelVisualFilter'),
            true
        );
        this.wheelVisualAngularSpeedCapRad = 20;
        this.wheelVisualCompressionK = 8;
        this.wheelVisualSmoothingHz = 12;
        this.wheelVisualMaxStepRadPerFrame = Math.PI / 8;
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
        this.carFrameRollAlertThresholdDeg = 8;
        this.carFrameAlertMaterials = [];
        this.isCarFrameAlertActive = false;
        this.carFrameAlertTintColor = new THREE.Color(0xd32f2f);
        this.carFrameAlertEmissiveColor = new THREE.Color(0x521414);
        this.attitudeOverlayElement = null;
        this.rollNeedleElement = null;
        this.pitchNeedleElement = null;
        this.showCompass = this.parseBooleanAttribute(
            containerElement.getAttribute('showCompass'),
            false
        );
        this.compassOverlayElement = null;
        this.compassRenderer = null;
        this.compassScene = null;
        this.compassCamera = null;
        this.compassModelGroup = null;
        this.compassDragState = null;
        this.compassArcballSensitivity = 1.0;
        this.compassDragActivateDistancePx = 3;
        this.initialCameraPose = null;
        this.viewCubeOverlayElement = null;
        this.viewCubeCubeElement = null;
        this.viewCubeActiveFaceKey = null;
        this.viewCubeButtonByFace = {};
        this.viewCubeDragState = null;
        this.viewCubeSuppressClickUntilMs = 0;
        this.viewCubeIgnoreFaceClickUntilMs = 0;
        this.viewCubeArcballSensitivity = 1.0;
        this.viewCubeDragActivateDistancePx = 4;
        this.mainOrbitDragState = null;
        this.mainOrbitArcballSensitivity = 1.0;
        this.mainOrbitDragActivateDistancePx = 4;
        this.showAttitude = this.parseBooleanAttribute(
            containerElement.getAttribute('showAttitude'),
            false
        );
        this.showWheelInfo = this.parseBooleanAttribute(
            containerElement.getAttribute('showWheelInfo'),
            false
        );
        this.showAudio = this.parseBooleanAttribute(
            containerElement.getAttribute('showAudio'),
            false
        );
        this.showViewCube = this.parseBooleanAttribute(
            containerElement.getAttribute('showViewCube'),
            false
        );
        this.wheelInfoOverlayElement = null;
        this.wheelInfoToggleButtonElement = null;
        this.isWheelInfoOverlayVisible = this.showWheelInfo;
        this.urdfPath = containerElement.getAttribute('urdf') || '/urdf/vehicle/vehicle.urdf';
        const rawCameraPose = containerElement.getAttribute('cameraPose');
        const rawCameraPosition = containerElement.getAttribute('cameraPosition');
        const rawCameraTarget = containerElement.getAttribute('cameraTarget');
        const rawCameraUp = containerElement.getAttribute('cameraUp');
        const parsedCameraPose = this.parseCameraPose(rawCameraPose);
        this.hasCustomCameraPose = parsedCameraPose != null;
        this.hasCustomCameraPosition = this.hasCustomCameraPose || (rawCameraPosition != null && String(rawCameraPosition).trim().length > 0);
        this.hasCustomCameraTarget = this.hasCustomCameraPose || (rawCameraTarget != null && String(rawCameraTarget).trim().length > 0);
        this.hasCustomCameraUp = this.hasCustomCameraPose || (rawCameraUp != null && String(rawCameraUp).trim().length > 0);
        this.cameraFitMarginRatio = 0.05;
        this.cameraPosition = this.hasCustomCameraPose
            ? parsedCameraPose.position.clone()
            : this.hasCustomCameraPosition
            ? this.parseVector3Attribute(rawCameraPosition, new THREE.Vector3(4, 4, 8))
            : new THREE.Vector3(4, 4, 8);
        this.cameraTarget = this.hasCustomCameraPose
            ? parsedCameraPose.target.clone()
            : this.hasCustomCameraTarget
            ? this.parseVector3Attribute(rawCameraTarget, new THREE.Vector3(0, 0, 0))
            : new THREE.Vector3(0, 0, 0);
        this.cameraUp = this.hasCustomCameraPose
            ? parsedCameraPose.up.clone()
            : this.hasCustomCameraUp
            ? this.parseUpVector(rawCameraUp)
            : new THREE.Vector3(0, 1, 0);
        
        this.init();
    }

    parseVector3Attribute(rawValue, fallback) {
        const tokens = String(rawValue || '').split(',').map(value => Number.parseFloat(value.trim()));
        if (tokens.length < 3 || !Number.isFinite(tokens[0]) || !Number.isFinite(tokens[1]) || !Number.isFinite(tokens[2])) {
            return fallback;
        }
        return new THREE.Vector3(tokens[0], tokens[1], tokens[2]);
    }

    parseUpVector(rawValue) {
        const fallback = new THREE.Vector3(0, 1, 0);
        const parsed = this.parseVector3Attribute(rawValue, fallback.clone());
        if (parsed.lengthSq() < 1e-8) {
            return fallback;
        }
        return parsed.normalize();
    }

    parseCameraPose(rawValue) {
        const normalizedValue = String(rawValue || '').trim();
        if (!normalizedValue) {
            return null;
        }

        const parts = normalizedValue.split('|').map(value => value.trim());
        if (parts.length < 1 || parts.length > 3 || !parts[0]) {
            return null;
        }

        const fallbackPosition = new THREE.Vector3(4, 4, 8);
        const fallbackTarget = new THREE.Vector3(0, 0, 0);
        const position = this.parseVector3Attribute(parts[0], fallbackPosition.clone());
        const target = parts[1]
            ? this.parseVector3Attribute(parts[1], fallbackTarget.clone())
            : fallbackTarget.clone();
        const up = parts[2]
            ? this.parseUpVector(parts[2])
            : new THREE.Vector3(0, 1, 0);

        return {
            position,
            target,
            up
        };
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

        // Scene 생성
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xf8f8f8);

        // Camera 생성
        this.camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000);
        this.camera.position.copy(this.cameraPosition);
        this.camera.up.copy(this.cameraUp);

        // Renderer 생성
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        // Keep canvas size tied to container CSS to avoid cumulative inline-height growth on resize.
        this.renderer.setSize(width, height, false);
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.renderer.domElement.style.display = 'block';
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);

        // Controls 설정
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        // 휠 줌은 항상 허용하고, 좌클릭은 회전, 우클릭은 패닝으로 분리한다.
        this.controls.enabled = true;
        this.controls.enableZoom = true;
        this.controls.enableRotate = false;
        this.controls.enablePan = true;
        this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
        if (this.hasCustomCameraTarget) {
            this.goalTarget.copy(this.cameraTarget);
            this.applyGoalTargetToControls();
        }
        this.cameraPosTextElement = $('#camera-pos-text');
        this.setupCameraAngleLogging();
        if (this.showViewCube) {
            this.setupViewCubeOverlay();
        }
        this.setupCameraToastOverlay();
        this.setupWheelControls();
        if (this.showAttitude) {
            this.setupAttitudeOverlay();
        }
        if (this.showCompass) {
            this.setupCompassOverlay();
        }
        if (this.showWheelInfo) {
            this.setupWheelInfoOverlay();
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

    ensureContainerOverlayPositioning() {
        if (!this.container) {
            return;
        }

        const computedStyle = window.getComputedStyle(this.container);
        if (computedStyle.position === 'static') {
            this.container.style.position = 'relative';
        }
    }

    blockOverlayPointerInteractions(overlayElement) {
        if (!overlayElement) {
            return;
        }

        const stopOverlayEvent = (event) => {
            event.preventDefault();
            event.stopPropagation();
        };

        const blockedEvents = [
            'pointerdown',
            'pointermove',
            'pointerup',
            'pointercancel',
            'mousedown',
            'mousemove',
            'mouseup',
            'touchstart',
            'touchmove',
            'touchend',
            'wheel',
            'click',
            'contextmenu',
        ];

        blockedEvents.forEach((eventName) => {
            overlayElement.addEventListener(eventName, stopOverlayEvent, true);
        });
    }

    setupWheelInfoOverlay() {
        if (!this.container || this.wheelInfoOverlayElement) {
            return;
        }

        const templateElement = document.getElementById('wheel-info-table-template');
        if (!templateElement) {
            console.warn('[URDF] wheel-info-table-template not found. Wheel info overlay skipped.');
            return;
        }

        this.ensureContainerOverlayPositioning();

        const overlayElement = document.createElement('div');
        overlayElement.style.position = 'absolute';
        overlayElement.style.inset = '0';
        overlayElement.style.zIndex = '14';
        overlayElement.style.pointerEvents = 'none';

        const wheelLayout = [
            { key: 'fl', label: 'FL', top: '96px', left: '10px' },
            { key: 'fr', label: 'FR', top: '96px', right: '10px' },
            { key: 'rl', label: 'RL', bottom: '10px', left: '10px' },
            { key: 'rr', label: 'RR', bottom: '10px', right: '10px' }
        ];

        const templateHtml = templateElement.innerHTML;
        wheelLayout.forEach(wheel => {
            const panelElement = document.createElement('div');
            panelElement.style.position = 'absolute';
            panelElement.style.width = '230px';
            panelElement.style.maxWidth = '34%';
            panelElement.style.pointerEvents = 'none';
            panelElement.style.background = 'rgba(255, 255, 255, 0.92)';
            panelElement.style.border = '1px solid rgba(0, 0, 0, 0.08)';
            panelElement.style.borderRadius = '8px';
            panelElement.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.16)';
            panelElement.style.overflow = 'hidden';
            panelElement.style.backdropFilter = 'blur(1px)';

            if (wheel.top) {
                panelElement.style.top = wheel.top;
            }
            if (wheel.bottom) {
                panelElement.style.bottom = wheel.bottom;
            }
            if (wheel.left) {
                panelElement.style.left = wheel.left;
            }
            if (wheel.right) {
                panelElement.style.right = wheel.right;
            }

            panelElement.innerHTML = templateHtml
                .replaceAll('__WHEEL_KEY__', wheel.key)
                .replaceAll('__WHEEL_LABEL__', wheel.label);

            overlayElement.appendChild(panelElement);
        });

        this.container.appendChild(overlayElement);
        this.wheelInfoOverlayElement = overlayElement;
        this.setWheelInfoOverlayVisible(this.isWheelInfoOverlayVisible);
    }

    setWheelInfoOverlayVisible(isVisible) {
        this.isWheelInfoOverlayVisible = !!isVisible;

        if (this.wheelInfoOverlayElement) {
            this.wheelInfoOverlayElement.style.display = this.isWheelInfoOverlayVisible ? '' : 'none';
        }

        this.updateWheelInfoToggleButtonState();
    }

    toggleWheelInfoOverlayVisible() {
        this.setWheelInfoOverlayVisible(!this.isWheelInfoOverlayVisible);
    }

    updateWheelInfoToggleButtonState() {
        if (!this.wheelInfoToggleButtonElement) {
            return;
        }

        const isVisible = this.isWheelInfoOverlayVisible;
        this.wheelInfoToggleButtonElement.setAttribute('aria-pressed', isVisible ? 'true' : 'false');
        this.wheelInfoToggleButtonElement.title = isVisible ? '휠 정보 숨기기' : '휠 정보 표시';
        this.wheelInfoToggleButtonElement.style.background = isVisible
            ? 'rgba(37, 99, 235, 0.12)'
            : 'rgba(255, 255, 255, 0.98)';
        this.wheelInfoToggleButtonElement.style.borderColor = isVisible
            ? 'rgba(37, 99, 235, 0.75)'
            : 'rgba(32, 46, 66, 0.45)';
        this.wheelInfoToggleButtonElement.style.color = isVisible ? '#0b2a66' : '#1f2937';
    }

    setupAttitudeOverlay() {
        this.ensureContainerOverlayPositioning();

        // Match overlay widgets with road video overlay vertical start.
        const overlayTopPx = '10px';

        const panelElement = document.createElement('div');
        panelElement.style.position = 'absolute';
        panelElement.style.top = overlayTopPx;
        panelElement.style.right = this.showCompass ? '80px' : '10px';
        panelElement.style.zIndex = '13';
        panelElement.style.padding = '8px';
        panelElement.style.background = 'rgba(255, 255, 255, 0.88)';
        panelElement.style.border = '1px solid rgba(30, 30, 30, 0.2)';
        panelElement.style.borderRadius = '10px';
        panelElement.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.12)';
        panelElement.style.pointerEvents = 'auto';
        panelElement.style.cursor = 'pointer';
        panelElement.style.transition = 'box-shadow 140ms ease, transform 140ms ease, border-color 140ms ease';
        panelElement.style.width = 'auto';

        const dialElement = document.createElement('div');
        dialElement.style.position = 'relative';
        dialElement.style.width = '48px';
        dialElement.style.height = '48px';
        dialElement.style.margin = '0 auto';
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

        panelElement.appendChild(dialElement);
        this.blockOverlayPointerInteractions(panelElement);
        this.container.appendChild(panelElement);

        this.attitudeOverlayElement = panelElement;
        this.rollNeedleElement = rollNeedleElement;
        this.pitchNeedleElement = pitchNeedleElement;
        this.updateAttitudeOverlay();
    }

    setupCompassOverlay() {
        if (!this.container || this.compassOverlayElement) {
            return;
        }

        this.ensureContainerOverlayPositioning();

        const panelElement = document.createElement('div');
        panelElement.style.position = 'absolute';
        panelElement.style.top = '10px';
        panelElement.style.right = '10px';
        panelElement.style.zIndex = '13';
        panelElement.style.padding = '8px';
        panelElement.style.background = 'rgba(255, 255, 255, 0.9)';
        panelElement.style.border = '1px solid rgba(30, 30, 30, 0.2)';
        panelElement.style.borderRadius = '10px';
        panelElement.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.12)';
        panelElement.style.pointerEvents = 'auto';

        const viewportElement = document.createElement('div');
        viewportElement.style.position = 'relative';
        viewportElement.style.width = '48px';
        viewportElement.style.height = '48px';
        viewportElement.style.margin = '0 auto';
        viewportElement.style.border = '1px solid rgba(34, 34, 34, 0.28)';
        viewportElement.style.borderRadius = '999px';
        viewportElement.style.background = 'rgba(245, 247, 250, 0.92)';
        viewportElement.style.overflow = 'hidden';
        viewportElement.style.cursor = 'pointer';
        viewportElement.style.transition = 'box-shadow 140ms ease, border-color 140ms ease, background-color 140ms ease';

        panelElement.addEventListener('mouseenter', () => {
            panelElement.style.borderColor = 'rgba(54, 120, 255, 0.35)';
            panelElement.style.boxShadow = '0 5px 14px rgba(37, 99, 235, 0.20)';
            panelElement.style.transform = 'translateY(-1px)';
        });

        panelElement.addEventListener('mouseleave', () => {
            panelElement.style.borderColor = 'rgba(30, 30, 30, 0.2)';
            panelElement.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.12)';
            panelElement.style.transform = 'translateY(0)';
        });

        panelElement.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.restoreInitialCameraPose();
        }, true);

        viewportElement.addEventListener('mouseenter', () => {
            viewportElement.style.borderColor = 'rgba(30, 90, 220, 0.55)';
            viewportElement.style.background = 'rgba(234, 242, 255, 0.96)';
            viewportElement.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.16) inset';
        });

        viewportElement.addEventListener('mouseleave', () => {
            viewportElement.style.borderColor = 'rgba(34, 34, 34, 0.28)';
            viewportElement.style.background = 'rgba(245, 247, 250, 0.92)';
            viewportElement.style.boxShadow = 'none';
        });

        const compassRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        compassRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        compassRenderer.setSize(48, 48, false);
        compassRenderer.setClearColor(0x000000, 0);
        compassRenderer.domElement.style.width = '48px';
        compassRenderer.domElement.style.height = '48px';
        compassRenderer.domElement.style.display = 'block';
        compassRenderer.domElement.style.cursor = 'default';
        viewportElement.appendChild(compassRenderer.domElement);

        const compassScene = new THREE.Scene();
        const compassCamera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
        compassCamera.position.set(0, 0, 4.2);
        compassCamera.lookAt(0, 0, 0);

        const ambientLight = new THREE.AmbientLight(0xffffff, 1.1);
        compassScene.add(ambientLight);

        const keyLight = new THREE.DirectionalLight(0xffffff, 0.7);
        keyLight.position.set(2, 2, 3);
        compassScene.add(keyLight);

        const compassModelGroup = this.createCompassModelGroup();
        compassScene.add(compassModelGroup);

        panelElement.appendChild(viewportElement);
        this.blockOverlayPointerInteractions(panelElement);
        this.setupCompassDragInteraction(panelElement, viewportElement);

        this.container.appendChild(panelElement);
        this.compassOverlayElement = panelElement;
        this.compassRenderer = compassRenderer;
        this.compassScene = compassScene;
        this.compassCamera = compassCamera;
        this.compassModelGroup = compassModelGroup;
        this.updateCameraToastAnchorPosition();
        this.updateCompassOverlay();
    }

    setupCompassDragInteraction(interactionElement, viewportElement) {
        if (!interactionElement || !viewportElement) {
            return;
        }

        viewportElement.style.cursor = 'pointer';

        const projectToArcball = (clientX, clientY) => {
            const rect = viewportElement.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return new THREE.Vector3(0, 0, 1);
            }

            const x = ((clientX - rect.left) / rect.width) * 2 - 1;
            const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
            const lengthSq = x * x + y * y;

            if (lengthSq > 1) {
                const invLength = 1 / Math.sqrt(lengthSq);
                return new THREE.Vector3(x * invLength, y * invLength, 0);
            }

            const z = Math.sqrt(Math.max(0, 1 - lengthSq));
            return new THREE.Vector3(x, y, z).normalize();
        };

        const onPointerMove = (event) => {
            if (!this.compassDragState || !this.controls || !this.camera) {
                return;
            }

            const deltaX = event.clientX - this.compassDragState.lastClientX;
            const deltaY = event.clientY - this.compassDragState.lastClientY;
            this.compassDragState.lastClientX = event.clientX;
            this.compassDragState.lastClientY = event.clientY;
            this.compassDragState.totalMove += Math.hypot(deltaX, deltaY);
            const nextArcball = projectToArcball(event.clientX, event.clientY);

            if (this.compassDragState.totalMove <= this.compassDragActivateDistancePx) {
                this.compassDragState.arcballVector = nextArcball;
                return;
            }

            if (!this.compassDragState.isActivated) {
                this.compassDragState.isActivated = true;
                this.compassDragState.arcballVector = nextArcball;
                return;
            }

            const previousArcball = this.compassDragState.arcballVector;
            this.compassDragState.arcballVector = nextArcball;

            const axisCamera = new THREE.Vector3().crossVectors(previousArcball, nextArcball);
            if (axisCamera.lengthSq() < 1e-10) {
                return;
            }

            const dot = THREE.MathUtils.clamp(previousArcball.dot(nextArcball), -1, 1);
            const angle = Math.acos(dot) * this.compassArcballSensitivity;
            if (!Number.isFinite(angle) || angle <= 1e-6) {
                return;
            }

            axisCamera.normalize();
            const axisWorld = axisCamera.clone().applyQuaternion(this.camera.quaternion).normalize();

            const target = this.controls.target.clone();
            const offset = this.camera.position.clone().sub(target);
            const rotation = new THREE.Quaternion().setFromAxisAngle(axisWorld, angle);
            offset.applyQuaternion(rotation);
            this.camera.up.applyQuaternion(rotation).normalize();

            this.camera.position.copy(target.clone().add(offset));
            this.camera.lookAt(target);
            this.controls.update();
            this.updateCompassOverlay();
            this.updateViewCubeOverlay();
            this.resetDirectionalLight(this.controls.target, this.directionalLightRadius);
            this.logCameraInfos(false);
        };

        const endDrag = () => {
            if (!this.compassDragState) {
                return;
            }

            const movedEnough = this.compassDragState.totalMove > this.compassDragActivateDistancePx;
            this.compassDragState = null;
            viewportElement.style.cursor = 'pointer';

            if (movedEnough) {
                this.logCameraInfos(true);
            }

            window.removeEventListener('pointermove', onPointerMove, true);
            window.removeEventListener('pointerup', endDrag, true);
            window.removeEventListener('pointercancel', endDrag, true);
            window.removeEventListener('blur', endDrag);
        };

        interactionElement.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || !this.controls || !this.camera) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            viewportElement.style.cursor = 'grabbing';
            this.compassDragState = {
                lastClientX: event.clientX,
                lastClientY: event.clientY,
                totalMove: 0,
                isActivated: false,
                arcballVector: projectToArcball(event.clientX, event.clientY)
            };

            window.addEventListener('pointermove', onPointerMove, true);
            window.addEventListener('pointerup', endDrag, true);
            window.addEventListener('pointercancel', endDrag, true);
            window.addEventListener('blur', endDrag);
        }, true);
    }

    createCompassModelGroup() {
        const group = new THREE.Group();

        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(1.04, 0.035, 10, 40),
            new THREE.MeshBasicMaterial({ color: 0x8b98a9, transparent: true, opacity: 0.9 })
        );
        group.add(ring);

        const globe = new THREE.Mesh(
            new THREE.SphereGeometry(0.76, 20, 16),
            new THREE.MeshPhongMaterial({
                color: 0x7fb3ff,
                transparent: true,
                opacity: 0.28,
                shininess: 70,
                side: THREE.DoubleSide,
                depthWrite: false,
            })
        );
        group.add(globe);

        const shaftNorth = new THREE.Mesh(
            new THREE.CylinderGeometry(0.04, 0.04, 0.66, 10),
            new THREE.MeshPhongMaterial({ color: 0xef4444, shininess: 80 })
        );
        shaftNorth.position.y = 0.33;
        group.add(shaftNorth);

        const tipNorth = new THREE.Mesh(
            new THREE.ConeGeometry(0.1, 0.22, 12),
            new THREE.MeshPhongMaterial({ color: 0xdc2626, shininess: 90 })
        );
        tipNorth.position.y = 0.77;
        group.add(tipNorth);

        const shaftSouth = new THREE.Mesh(
            new THREE.CylinderGeometry(0.03, 0.03, 0.48, 10),
            new THREE.MeshPhongMaterial({ color: 0x1d4ed8, shininess: 80 })
        );
        shaftSouth.position.y = -0.25;
        group.add(shaftSouth);

        const tipSouth = new THREE.Mesh(
            new THREE.ConeGeometry(0.08, 0.18, 12),
            new THREE.MeshPhongMaterial({ color: 0x1e40af, shininess: 90 })
        );
        tipSouth.position.y = -0.58;
        tipSouth.rotation.z = Math.PI;
        group.add(tipSouth);

        const centerDot = new THREE.Mesh(
            new THREE.SphereGeometry(0.08, 12, 10),
            new THREE.MeshPhongMaterial({ color: 0x111827, shininess: 100 })
        );
        group.add(centerDot);

        const axisDefs = [
            { dir: new THREE.Vector3(1, 0, 0), color: 0xff3333 },
            { dir: new THREE.Vector3(0, 1, 0), color: 0x22aa22 },
            { dir: new THREE.Vector3(0, 0, 1), color: 0x3366ff },
        ];

        axisDefs.forEach((axisDef) => {
            const axisLength = 1.0;
            const coneHeight = 0.2;
            const lineEnd = axisDef.dir.clone().multiplyScalar(axisLength - coneHeight);
            const coneCenter = axisDef.dir.clone().multiplyScalar(axisLength - (coneHeight * 0.5));

            const axisLine = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(0, 0, 0),
                    lineEnd,
                ]),
                new THREE.LineBasicMaterial({ color: axisDef.color, transparent: true, opacity: 0.95 })
            );
            group.add(axisLine);

            const axisCone = new THREE.Mesh(
                new THREE.ConeGeometry(0.08, coneHeight, 12),
                new THREE.MeshPhongMaterial({ color: axisDef.color, shininess: 90 })
            );
            axisCone.position.copy(coneCenter);
            axisCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisDef.dir.clone().normalize());
            group.add(axisCone);
        });

        return group;
    }

    setupViewCubeOverlay() {
        if (!this.container || this.viewCubeOverlayElement) {
            return;
        }

        this.ensureContainerOverlayPositioning();

        // Match overlay widgets with road video overlay vertical start.
        const overlayTopPx = '10px';

        const wrapperElement = document.createElement('div');
        wrapperElement.style.position = 'absolute';
        wrapperElement.style.top = overlayTopPx;
        wrapperElement.style.left = '10px';
        wrapperElement.style.zIndex = '16';
        wrapperElement.style.display = 'inline-flex';
        wrapperElement.style.alignItems = 'flex-start';
        wrapperElement.style.columnGap = '6px';
        wrapperElement.style.pointerEvents = 'none';

        const panelElement = document.createElement('div');
        panelElement.style.position = 'relative';
        panelElement.style.width = 'auto';
        panelElement.style.padding = '8px';
        panelElement.style.background = 'rgba(255, 255, 255, 0.92)';
        panelElement.style.border = '1px solid rgba(20, 20, 20, 0.2)';
        panelElement.style.borderRadius = '10px';
        panelElement.style.boxShadow = '0 3px 10px rgba(0, 0, 0, 0.16)';
        panelElement.style.pointerEvents = 'auto';
        panelElement.style.userSelect = 'none';
        panelElement.style.transition = 'box-shadow 140ms ease, transform 140ms ease, border-color 140ms ease';

        panelElement.addEventListener('mouseenter', () => {
            panelElement.style.borderColor = 'rgba(51, 102, 255, 0.35)';
            panelElement.style.boxShadow = '0 6px 14px rgba(37, 99, 235, 0.22)';
            panelElement.style.transform = 'translateY(-1px)';
        });

        panelElement.addEventListener('mouseleave', () => {
            panelElement.style.borderColor = 'rgba(20, 20, 20, 0.2)';
            panelElement.style.boxShadow = '0 3px 10px rgba(0, 0, 0, 0.16)';
            panelElement.style.transform = 'translateY(0)';
        });

        this.viewCubeButtonByFace = {};

        const gridElement = document.createElement('div');
        gridElement.style.display = 'grid';
        gridElement.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
        gridElement.style.columnGap = '4px';
        gridElement.style.rowGap = '4px';

        const createFaceButton = (faceKey, label, title) => {
            const buttonElement = document.createElement('button');
            buttonElement.type = 'button';
            buttonElement.textContent = label;
            buttonElement.title = title;
            buttonElement.style.minWidth = '28px';
            buttonElement.style.height = '24px';
            buttonElement.style.border = '1px solid rgba(32, 46, 66, 0.45)';
            buttonElement.style.borderRadius = '4px';
            buttonElement.style.background = 'rgba(255, 255, 255, 0.98)';
            buttonElement.style.color = '#1f2937';
            buttonElement.style.fontSize = '9px';
            buttonElement.style.fontWeight = '700';
            buttonElement.style.cursor = 'pointer';
            buttonElement.style.padding = '0 4px';
            buttonElement.style.lineHeight = '1.1';
            buttonElement.style.whiteSpace = 'nowrap';
            buttonElement.style.transition = 'background-color 120ms ease, color 120ms ease, border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease';

            const applyHoverOn = () => {
                buttonElement.style.background = 'rgba(59, 130, 246, 0.16)';
                buttonElement.style.borderColor = 'rgba(37, 99, 235, 0.78)';
                buttonElement.style.color = '#0b2a66';
                buttonElement.style.boxShadow = '0 1px 4px rgba(37, 99, 235, 0.26)';
                buttonElement.style.transform = 'translateY(-1px)';
            };

            const applyHoverOff = () => {
                buttonElement.style.background = 'rgba(255, 255, 255, 0.98)';
                buttonElement.style.borderColor = 'rgba(32, 46, 66, 0.45)';
                buttonElement.style.color = '#1f2937';
                buttonElement.style.boxShadow = 'none';
                buttonElement.style.transform = 'translateY(0)';
            };

            buttonElement.addEventListener('mouseenter', applyHoverOn);
            buttonElement.addEventListener('mouseleave', applyHoverOff);
            buttonElement.addEventListener('focus', applyHoverOn);
            buttonElement.addEventListener('blur', applyHoverOff);
            buttonElement.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.setCameraByViewCubeFace(faceKey);
            });
            this.viewCubeButtonByFace[faceKey] = buttonElement;
            return buttonElement;
        };

        gridElement.appendChild(createFaceButton('front', 'F', 'Front (+X)'));
        gridElement.appendChild(createFaceButton('back', 'B', 'Back (-X)'));
        gridElement.appendChild(createFaceButton('left', 'L', 'Left (+Y)'));
        gridElement.appendChild(createFaceButton('right', 'R', 'Right (-Y)'));
        gridElement.appendChild(createFaceButton('top', 'U', 'Up (+Z)'));
        gridElement.appendChild(createFaceButton('bottom', 'D', 'Down (-Z)'));

        panelElement.appendChild(gridElement);
        wrapperElement.appendChild(panelElement);

        if (this.showWheelInfo) {
            const wheelToggleButtonElement = document.createElement('button');
            wheelToggleButtonElement.type = 'button';
            wheelToggleButtonElement.textContent = 'WHEEL';
            wheelToggleButtonElement.setAttribute('aria-label', '휠 정보 오버레이 토글');
            wheelToggleButtonElement.style.pointerEvents = 'auto';
            wheelToggleButtonElement.style.height = '32px';
            wheelToggleButtonElement.style.padding = '0 10px';
            wheelToggleButtonElement.style.marginTop = '8px';
            wheelToggleButtonElement.style.border = '1px solid rgba(32, 46, 66, 0.45)';
            wheelToggleButtonElement.style.borderRadius = '8px';
            wheelToggleButtonElement.style.fontSize = '11px';
            wheelToggleButtonElement.style.fontWeight = '700';
            wheelToggleButtonElement.style.letterSpacing = '0.03em';
            wheelToggleButtonElement.style.lineHeight = '1';
            wheelToggleButtonElement.style.cursor = 'pointer';
            wheelToggleButtonElement.style.userSelect = 'none';
            wheelToggleButtonElement.style.transition = 'background-color 120ms ease, color 120ms ease, border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease';

            const applyHoverOn = () => {
                wheelToggleButtonElement.style.boxShadow = '0 2px 6px rgba(37, 99, 235, 0.2)';
                wheelToggleButtonElement.style.transform = 'translateY(-1px)';
            };

            const applyHoverOff = () => {
                wheelToggleButtonElement.style.boxShadow = 'none';
                wheelToggleButtonElement.style.transform = 'translateY(0)';
            };

            wheelToggleButtonElement.addEventListener('mouseenter', applyHoverOn);
            wheelToggleButtonElement.addEventListener('mouseleave', applyHoverOff);
            wheelToggleButtonElement.addEventListener('focus', applyHoverOn);
            wheelToggleButtonElement.addEventListener('blur', applyHoverOff);
            wheelToggleButtonElement.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.toggleWheelInfoOverlayVisible();
            });

            this.wheelInfoToggleButtonElement = wheelToggleButtonElement;
            this.updateWheelInfoToggleButtonState();
            wrapperElement.appendChild(wheelToggleButtonElement);
        }

        this.container.appendChild(wrapperElement);
        this.viewCubeOverlayElement = wrapperElement;
        this.viewCubeCubeElement = null;
        this.updateViewCubeOverlay();
    }

    setupViewCubeDragInteraction(interactionElement) {
        if (!interactionElement) {
            return;
        }

        interactionElement.style.cursor = 'grab';

        const projectToArcball = (clientX, clientY) => {
            const rect = interactionElement.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return new THREE.Vector3(0, 0, 1);
            }

            const x = ((clientX - rect.left) / rect.width) * 2 - 1;
            const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
            const lengthSq = x * x + y * y;

            if (lengthSq > 1) {
                const invLength = 1 / Math.sqrt(lengthSq);
                return new THREE.Vector3(x * invLength, y * invLength, 0);
            }

            const z = Math.sqrt(Math.max(0, 1 - lengthSq));
            return new THREE.Vector3(x, y, z).normalize();
        };

        const onPointerMove = (event) => {
            if (!this.viewCubeDragState || !this.controls || !this.camera) {
                return;
            }

            const deltaX = event.clientX - this.viewCubeDragState.lastClientX;
            const deltaY = event.clientY - this.viewCubeDragState.lastClientY;
            this.viewCubeDragState.lastClientX = event.clientX;
            this.viewCubeDragState.lastClientY = event.clientY;
            this.viewCubeDragState.totalMove += Math.hypot(deltaX, deltaY);
            const nextArcball = projectToArcball(event.clientX, event.clientY);

            if (this.viewCubeDragState.totalMove <= this.viewCubeDragActivateDistancePx) {
                this.viewCubeDragState.arcballVector = nextArcball;
                return;
            }

            if (!this.viewCubeDragState.isActivated) {
                this.viewCubeDragState.isActivated = true;
                this.viewCubeSuppressClickUntilMs = performance.now() + 150;
                this.viewCubeDragState.arcballVector = nextArcball;
                return;
            }

            this.viewCubeSuppressClickUntilMs = performance.now() + 150;

            const previousArcball = this.viewCubeDragState.arcballVector;
            this.viewCubeDragState.arcballVector = nextArcball;

            const axisCamera = new THREE.Vector3().crossVectors(previousArcball, nextArcball);
            if (axisCamera.lengthSq() < 1e-10) {
                return;
            }

            const dot = THREE.MathUtils.clamp(previousArcball.dot(nextArcball), -1, 1);
            const angle = Math.acos(dot) * this.viewCubeArcballSensitivity;
            if (!Number.isFinite(angle) || angle <= 1e-6) {
                return;
            }

            axisCamera.normalize();
            const axisWorld = axisCamera.clone().applyQuaternion(this.camera.quaternion).normalize();

            const target = this.controls.target.clone();
            const offset = this.camera.position.clone().sub(target);

            // Use standard drag direction: pointer movement rotates the camera in the same arcball direction.
            const rotation = new THREE.Quaternion().setFromAxisAngle(axisWorld, angle);
            offset.applyQuaternion(rotation);
            this.camera.up.applyQuaternion(rotation).normalize();

            this.camera.position.copy(target.clone().add(offset));
            this.camera.lookAt(target);
            this.controls.update();
            this.updateViewCubeOverlay();
            this.resetDirectionalLight(this.controls.target, this.directionalLightRadius);
            this.logCameraInfos(false);
        };

        const endDrag = () => {
            if (!this.viewCubeDragState) {
                return;
            }
            const movedEnough = this.viewCubeDragState.totalMove > this.viewCubeDragActivateDistancePx;
            this.viewCubeDragState = null;
            interactionElement.style.cursor = 'grab';
            if (movedEnough) {
                this.viewCubeIgnoreFaceClickUntilMs = performance.now() + 300;
                this.logCameraInfos(true);
            }
            window.removeEventListener('pointermove', onPointerMove, true);
            window.removeEventListener('pointerup', endDrag, true);
            window.removeEventListener('pointercancel', endDrag, true);
            window.removeEventListener('blur', endDrag);
        };

        interactionElement.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            interactionElement.style.cursor = 'grabbing';
            this.viewCubeDragState = {
                lastClientX: event.clientX,
                lastClientY: event.clientY,
                totalMove: 0,
                isActivated: false,
                arcballVector: projectToArcball(event.clientX, event.clientY)
            };

            window.addEventListener('pointermove', onPointerMove, true);
            window.addEventListener('pointerup', endDrag, true);
            window.addEventListener('pointercancel', endDrag, true);
            window.addEventListener('blur', endDrag);
        });
    }

    setCameraByViewCubeFace(faceKey) {
        if (!this.controls || !this.camera) {
            return;
        }

        const faceVectors = this.getCameraVectorsByFace(faceKey);
        if (!faceVectors) {
            return;
        }

        const focusBounds = this.getPrimaryFocusBounds();
        const nextTarget = focusBounds.center;
        const currentDistanceFromChassisCenter = this.camera.position.distanceTo(nextTarget);
        const nextDistance = Number.isFinite(currentDistanceFromChassisCenter) && currentDistanceFromChassisCenter > 0.001
            ? currentDistanceFromChassisCenter
            : this.calculateFitDistanceForFace(focusBounds.size, faceKey, this.cameraFitMarginRatio);
        const nextPosition = nextTarget.clone().add(faceVectors.direction.multiplyScalar(nextDistance));

        this.animateCameraToPoseWithTarget(nextPosition, nextTarget, faceVectors.up, 240);
    }

    getPrimaryFocusBounds() {
        const fallbackTarget = this.controls?.target?.clone?.() || new THREE.Vector3(0, 0, 0);
        const fallbackSize = new THREE.Vector3(1, 1, 1);

        if (!this.robotModel) {
            return {
                center: fallbackTarget,
                size: fallbackSize
            };
        }

        const linkMap = this.robotModel.links || {};
        const carFrame = linkMap.car_frame || null;
        const focusRoot = carFrame || this.robotModel;
        const bbox = new THREE.Box3().setFromObject(focusRoot);

        if (bbox.isEmpty()) {
            return {
                center: fallbackTarget,
                size: fallbackSize
            };
        }

        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());

        return {
            center,
            size
        };
    }

    getCameraVectorsByFace(faceKey) {
        const directionByFace = {
            front: new THREE.Vector3(1, 0, 0),
            back: new THREE.Vector3(-1, 0, 0),
            left: new THREE.Vector3(0, 1, 0),
            right: new THREE.Vector3(0, -1, 0),
            top: new THREE.Vector3(0, 0, 1),
            bottom: new THREE.Vector3(0, 0, -1)
        };

        const upByFace = {
            front: new THREE.Vector3(0, 0, 1),
            back: new THREE.Vector3(0, 0, 1),
            left: new THREE.Vector3(0, 0, 1),
            right: new THREE.Vector3(0, 0, 1),
            top: new THREE.Vector3(1, 0, 0),
            bottom: new THREE.Vector3(-1, 0, 0)
        };

        const direction = directionByFace[faceKey];
        if (!direction) {
            return null;
        }

        return {
            direction: direction.clone(),
            up: (upByFace[faceKey] || upByFace.front).clone()
        };
    }

    setCameraFromFace(center, distance, faceKey) {
        const faceVectors = this.getCameraVectorsByFace(faceKey);
        if (!this.camera || !center || !faceVectors) {
            return;
        }

        const safeDistance = Number.isFinite(distance) && distance > 0.001 ? distance : 3;
        this.camera.position.copy(center).add(faceVectors.direction.multiplyScalar(safeDistance));
        this.camera.up.copy(faceVectors.up);
        this.camera.lookAt(center);
    }

    animateCameraToPose(nextPosition, nextUp, durationMs = 220) {
        if (!this.camera || !this.controls || !nextPosition || !nextUp) {
            return;
        }

        const startPosition = this.camera.position.clone();
        const startUp = this.camera.up.clone();
        const target = this.controls.target.clone();
        const startTimeMs = performance.now();

        const easeInOut = (t) => {
            return t < 0.5
                ? 2 * t * t
                : 1 - Math.pow(-2 * t + 2, 2) / 2;
        };

        const step = () => {
            const elapsedMs = performance.now() - startTimeMs;
            const progress = durationMs > 0 ? THREE.MathUtils.clamp(elapsedMs / durationMs, 0, 1) : 1;
            const eased = easeInOut(progress);

            this.camera.position.copy(startPosition.clone().lerp(nextPosition, eased));
            this.camera.up.copy(startUp.clone().lerp(nextUp, eased).normalize());
            this.camera.lookAt(target);
            this.controls.update();
            this.updateViewCubeOverlay();
            this.resetDirectionalLight(this.controls.target, this.directionalLightRadius);

            if (progress < 1) {
                requestAnimationFrame(step);
                return;
            }

            this.logCameraInfos(true);
        };

        requestAnimationFrame(step);
    }

    animateCameraToPoseWithTarget(nextPosition, nextTarget, nextUp, durationMs = 260) {
        if (!this.camera || !this.controls || !nextPosition || !nextTarget || !nextUp) {
            return;
        }

        const startPosition = this.camera.position.clone();
        const startUp = this.camera.up.clone();
        const startTarget = this.controls.target.clone();
        const targetPosition = nextPosition.clone();
        const targetUp = nextUp.clone().normalize();
        const targetTarget = nextTarget.clone();
        const startTimeMs = performance.now();

        const easeInOut = (t) => {
            return t < 0.5
                ? 2 * t * t
                : 1 - Math.pow(-2 * t + 2, 2) / 2;
        };

        const step = () => {
            const elapsedMs = performance.now() - startTimeMs;
            const progress = durationMs > 0 ? THREE.MathUtils.clamp(elapsedMs / durationMs, 0, 1) : 1;
            const eased = easeInOut(progress);

            this.camera.position.copy(startPosition.clone().lerp(targetPosition, eased));
            this.camera.up.copy(startUp.clone().lerp(targetUp, eased).normalize());
            this.controls.target.copy(startTarget.clone().lerp(targetTarget, eased));
            this.camera.lookAt(this.controls.target);
            this.controls.update();
            this.updateCompassOverlay();
            this.updateViewCubeOverlay();
            this.resetDirectionalLight(this.controls.target, this.directionalLightRadius);

            if (progress < 1) {
                requestAnimationFrame(step);
                return;
            }

            this.goalTarget.set(
                this.controls.target.x,
                this.controls.target.y + this.goalTargetVerticalOffset,
                this.controls.target.z
            );
            this.logCameraInfos(true);
        };

        requestAnimationFrame(step);
    }

    updateViewCubeOverlay() {
        const hasButtons = this.viewCubeButtonByFace && Object.keys(this.viewCubeButtonByFace).length > 0;
        if (!hasButtons || !this.controls || !this.camera) {
            return;
        }

        const target = this.controls.target.clone();
        const cameraOffset = this.camera.position.clone().sub(target);
        if (cameraOffset.lengthSq() < 1e-8) {
            return;
        }

        const direction = cameraOffset.normalize();
        const absX = Math.abs(direction.x);
        const absY = Math.abs(direction.y);
        const absZ = Math.abs(direction.z);

        let activeFaceKey = 'front';
        if (absX >= absY && absX >= absZ) {
            activeFaceKey = direction.x >= 0 ? 'front' : 'back';
        } else if (absY >= absX && absY >= absZ) {
            activeFaceKey = direction.y >= 0 ? 'left' : 'right';
        } else {
            activeFaceKey = direction.z >= 0 ? 'top' : 'bottom';
        }

        this.viewCubeActiveFaceKey = activeFaceKey;
    }

    updateAttitudeOverlay() {
        const rollDeg = Number.isFinite(this.roadRollAngleDeg) ? this.roadRollAngleDeg : 0;
        const pitchDeg = Number.isFinite(this.roadPitchAngleDeg) ? this.roadPitchAngleDeg : 0;

        if (this.rollNeedleElement) {
            this.rollNeedleElement.style.transform = `translate(-50%, -100%) rotate(${rollDeg}deg)`;
        }

        if (this.pitchNeedleElement) {
            this.pitchNeedleElement.style.transform = `translate(-50%, -100%) rotate(${90 + pitchDeg}deg)`;
        }
    }

    updateCompassOverlay() {
        if (!this.compassRenderer || !this.compassScene || !this.compassCamera || !this.compassModelGroup || !this.camera) {
            return;
        }

        const cameraQuaternion = new THREE.Quaternion();
        this.camera.getWorldQuaternion(cameraQuaternion);

        // Keep world north fixed and rotate the compass opposite to camera orientation.
        this.compassModelGroup.quaternion.copy(cameraQuaternion).invert();
        this.compassRenderer.render(this.compassScene, this.compassCamera);
    }

    setupCameraAngleLogging() {
        if (this.cameraPosTextElement && this.cameraPosTextElement.length > 0) {
            this.cameraPosTextElement.off('click').on('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.copyTextToClipboard(this.cameraPosCopyText)
                    .then(() => {
                        this.showCameraToastMessage('cameraPose가 클립보드에 복사되었습니다.');
                    })
                    .catch(() => {
                        this.showCameraToastMessage('cameraPose 복사에 실패했습니다.');
                    });
            });
        }

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
            this.updateViewCubeOverlay();
            this.updateCompassOverlay();
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
        toastElement.title = 'cameraPose="0.000, 0.000, 0.000|0.000, 0.000, 0.000|0.000, 1.000, 0.000"';
        toastElement.textContent = '0.000, 0.000, 0.000|0.000, 0.000, 0.000|0.000, 1.000, 0.000';

        const stopOverlayEvent = (event) => {
            event.preventDefault();
            event.stopPropagation();
        };

        toastElement.addEventListener('pointerdown', stopOverlayEvent, true);
        toastElement.addEventListener('mousedown', stopOverlayEvent, true);
        toastElement.addEventListener('click', (event) => {
            stopOverlayEvent(event);
            this.copyCameraToastToClipboard();
        });

        this.container.appendChild(toastElement);
        this.cameraToastElement = toastElement;
        this.updateCameraToastAnchorPosition();
    }

    updateCameraToastAnchorPosition() {
        if (!this.cameraToastElement) {
            return;
        }

        if (this.showCompass && this.compassOverlayElement) {
            const compassTopPx = Number.parseFloat(this.compassOverlayElement.style.top || '10') || 10;
            const compassHeightPx = Number(this.compassOverlayElement.offsetHeight || 64);
            const toastTopPx = compassTopPx + compassHeightPx + 8;

            this.cameraToastElement.style.right = '10px';
            this.cameraToastElement.style.top = `${toastTopPx}px`;
            this.cameraToastElement.style.bottom = 'auto';
            return;
        }

        this.cameraToastElement.style.right = '12px';
        this.cameraToastElement.style.top = 'auto';
        this.cameraToastElement.style.bottom = '12px';
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
        const tx = formatPositionValue(this.controls?.target?.x);
        const ty = formatPositionValue(this.controls?.target?.y);
        const tz = formatPositionValue(this.controls?.target?.z);
        const ux = formatPositionValue(this.camera.up.x);
        const uy = formatPositionValue(this.camera.up.y);
        const uz = formatPositionValue(this.camera.up.z);
        const poseValueText = `${px}, ${py}, ${pz}|${tx}, ${ty}, ${tz}|${ux}, ${uy}, ${uz}`;
        this.cameraToastElement.textContent = poseValueText;
        this.cameraToastElement.title = `cameraPose="${poseValueText}"`;
    }

    copyCameraToastToClipboard() {
        if (!this.cameraToastElement) {
            return;
        }

        const textToCopy = this.cameraToastElement.textContent || '0.000, 0.000, 0.000|0.000, 0.000, 0.000|0.000, 1.000, 0.000';

        this.copyTextToClipboard(textToCopy)
            .then(() => {
                this.showCameraToastMessage('cameraPose가 클립보드에 복사되었습니다.');
            })
            .catch(() => {
                this.showCameraToastMessage('cameraPose 복사에 실패했습니다.');
            });
    }

    copyTextToClipboard(textToCopy) {
        if (!textToCopy) {
            return Promise.reject(new Error('No text to copy'));
        }

        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(textToCopy).catch(() => {
                this.copyTextToClipboardFallback(textToCopy);
            });
        }

        return Promise.resolve(this.copyTextToClipboardFallback(textToCopy));
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
            const copied = document.execCommand('copy');
            if (!copied) {
                throw new Error('execCommand returned false');
            }
        } catch (error) {
            console.warn('[URDF] 카메라 좌표 복사 실패:', error);
            document.body.removeChild(tempTextArea);
            throw error;
        }

        document.body.removeChild(tempTextArea);
    }

    showCameraToastMessage(message, durationMs = 1600) {
        if (!this.cameraToastElement || !message) {
            return;
        }

        this.cameraToastElement.textContent = String(message);
        this.cameraToastElement.title = String(message);
        this.cameraToastElement.style.display = 'block';

        if (this.cameraToastHideTimer) {
            clearTimeout(this.cameraToastHideTimer);
        }

        this.cameraToastHideTimer = setTimeout(() => {
            this.hideCameraToastOverlay();
        }, durationMs);
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

    getSignedWheelRpm(key) {
        const rpm = Number(this.wheelSpeedRpmByKey[key]) || 0;
        const directionSign = Number(this.wheelDirectionSignByKey[key]) || 1;
        return rpm * directionSign;
    }

    formatRpmText(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return '0';
        }

        const rounded = Math.round(numeric * 10) / 10;
        return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    }

    updateWheelSpeedFromInput(key) {
        const inputElement = this.wheelSpeedInputByKey[key];
        if (!inputElement || inputElement.length === 0) {
            return;
        }

        const inputRpm = Number.parseFloat(inputElement.val());
        const signedRpm = Number.isFinite(inputRpm)
            ? THREE.MathUtils.clamp(Math.round(inputRpm), -120, 120)
            : this.getSignedWheelRpm(key);
        const normalizedRpm = Math.abs(signedRpm);
        const directionSign = signedRpm < 0 ? -1 : 1;

        this.setWheelDirectionSign(key, directionSign);
        this.wheelSpeedRpmByKey[key] = normalizedRpm;
        this.wheelAngularSpeedRadByKey[key] = this.convertRpmToRadPerSec(normalizedRpm);
        inputElement.val(String(signedRpm));

        const valueElement = this.wheelSpeedValueByKey[key];
        if (valueElement && valueElement.length > 0) {
            valueElement.text(`${this.getSignedWheelRpm(key)} rpm`);
        }
    }

    setWheelSpeedRpm(key, rpm) {
        const numericRpm = Number.parseFloat(rpm);
        const directionSign = Number.isFinite(numericRpm) && numericRpm < 0 ? -1 : 1;
        const normalizedRpm = Number.isFinite(numericRpm)
            ? Math.max(Math.abs(numericRpm), 0)
            : this.wheelSpeedRpmByKey[key];

        this.setWheelDirectionSign(key, directionSign);

        this.wheelSpeedRpmByKey[key] = normalizedRpm;
        this.wheelAngularSpeedRadByKey[key] = this.convertRpmToRadPerSec(normalizedRpm);

        const inputElement = this.wheelSpeedInputByKey[key];
        if (inputElement && inputElement.length > 0) {
            inputElement.val(this.formatRpmText(this.getSignedWheelRpm(key)));
        }

        const valueElement = this.wheelSpeedValueByKey[key];
        if (valueElement && valueElement.length > 0) {
            valueElement.text(`${this.formatRpmText(this.getSignedWheelRpm(key))} rpm`);
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

        if (mode === 'forward') {
            this.setWheelDirectionSign('fl', 1);
            this.setWheelDirectionSign('fr', 1);
            this.setWheelDirectionSign('rl', 1);
            this.setWheelDirectionSign('rr', 1);
            this.setWheelSpeedRpm('fl', baseRpm);
            this.setWheelSpeedRpm('fr', baseRpm);
            this.setWheelSpeedRpm('rl', baseRpm);
            this.setWheelSpeedRpm('rr', baseRpm);
            this.updateWheelHighlightsByDriveDirection();
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
            this.updateWheelHighlightsByDriveDirection();
            return;
        }

        if (mode === 'left') {
            this.setWheelDirectionSign('fl', -1);
            this.setWheelDirectionSign('fr', 1);
            this.setWheelDirectionSign('rl', -1);
            this.setWheelDirectionSign('rr', 1);
            this.setWheelSpeedRpm('fl', -baseRpm);
            this.setWheelSpeedRpm('fr', baseRpm);
            this.setWheelSpeedRpm('rl', -baseRpm);
            this.setWheelSpeedRpm('rr', baseRpm);
            this.updateWheelHighlightsByDriveDirection();
            return;
        }

        if (mode === 'right') {
            this.setWheelDirectionSign('fl', 1);
            this.setWheelDirectionSign('fr', -1);
            this.setWheelDirectionSign('rl', 1);
            this.setWheelDirectionSign('rr', -1);
            this.setWheelSpeedRpm('fl', baseRpm);
            this.setWheelSpeedRpm('fr', -baseRpm);
            this.setWheelSpeedRpm('rl', baseRpm);
            this.setWheelSpeedRpm('rr', -baseRpm);
            this.updateWheelHighlightsByDriveDirection();
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
            this.updateWheelHighlightsByDriveDirection();
        }
    }

    updateWheelHighlightsByDriveDirection() {
        if (this.container.id !== 'vehicle-urdf-viewer') {
            return;
        }

        const forwardWheelKeys = Object.keys(this.wheelSpeedRpmByKey).filter(key => {
            const rpm = Number(this.wheelSpeedRpmByKey[key]) || 0;
            const directionSign = Number(this.wheelDirectionSignByKey[key]) || 1;
            return rpm > 0 && directionSign > 0;
        });

        if (forwardWheelKeys.length > 0) {
            this.applyWheelHighlightByKeys(forwardWheelKeys);
            return;
        }

        this.clearWheelHighlights();
    }

    toVisualWheelAngularSpeedRad(targetAngularSpeedRad) {
        const numericTarget = Number(targetAngularSpeedRad);
        if (!Number.isFinite(numericTarget) || Math.abs(numericTarget) <= 1e-8) {
            return 0;
        }

        const sign = numericTarget >= 0 ? 1 : -1;
        const absTarget = Math.abs(numericTarget);
        const omegaCap = Math.max(Number(this.wheelVisualAngularSpeedCapRad) || 0, 0.001);
        const compressionK = Math.max(Number(this.wheelVisualCompressionK) || 0, 0.001);

        // 1) Hard cap for extreme values, 2) nonlinear compression for readability at high speed.
        const capped = Math.min(absTarget, omegaCap * 4);
        const compressed = omegaCap * (1 - Math.exp(-capped / compressionK));

        return sign * Math.min(compressed, omegaCap);
    }

    setWheelVisualFilterEnabled(enabled) {
        this.enableWheelVisualFilter = enabled !== false;
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
            const wheelDirection = this.wheelDirectionSignByKey[key] || 1;
            const targetAngularSpeedRad = wheelDirection * wheelAngularSpeedRad;
            let clampedAngleStep = targetAngularSpeedRad * deltaSec;

            if (this.enableWheelVisualFilter) {
                const visualTargetAngularSpeedRad = this.toVisualWheelAngularSpeedRad(targetAngularSpeedRad);

                const smoothingHz = Math.max(Number(this.wheelVisualSmoothingHz) || 0, 0);
                const alpha = smoothingHz > 0
                    ? (1 - Math.exp(-smoothingHz * Math.max(deltaSec, 0)))
                    : 1;
                const currentVisualAngularSpeedRad = Number(this.wheelVisualAngularSpeedRadByKey[key]) || 0;
                const nextVisualAngularSpeedRad = currentVisualAngularSpeedRad
                    + (visualTargetAngularSpeedRad - currentVisualAngularSpeedRad) * alpha;
                this.wheelVisualAngularSpeedRadByKey[key] = nextVisualAngularSpeedRad;

                const maxStepRad = Math.max(Number(this.wheelVisualMaxStepRadPerFrame) || 0, 0.001);
                const rawAngleStep = nextVisualAngularSpeedRad * deltaSec;
                clampedAngleStep = THREE.MathUtils.clamp(rawAngleStep, -maxStepRad, maxStepRad);
            } else {
                // Physical-mode rendering path: use raw signed angular velocity without visual compression.
                this.wheelVisualAngularSpeedRadByKey[key] = targetAngularSpeedRad;
            }

            if (Math.abs(clampedAngleStep) <= 1e-10) {
                return;
            }

            this.wheelAngles[key] += clampedAngleStep;

            if (runtimeTarget.type === 'joint') {
                runtimeTarget.ref.setJointValue(this.wheelAngles[key]);
                return;
            }

            if (runtimeTarget.type === 'link') {
                const rotationAxis = runtimeTarget.axis || (this.viewerWheelKey ? 'x' : 'y');
                const rotationSign = Number.isFinite(runtimeTarget.rotationSign)
                    ? runtimeTarget.rotationSign
                    : (this.viewerWheelKey ? -1 : 1);
                runtimeTarget.ref.rotation[rotationAxis] = this.wheelAngles[key] * rotationSign;
            }
        });
    }

    resolveLinkRotationInfoFromJoint(joint) {
        const axisCandidates = [
            joint?.axis,
            joint?.jointAxis,
            joint?.urdfJoint?.axis,
            joint?.urdfNode?.axis,
        ];

        for (const axisCandidate of axisCandidates) {
            let x = NaN;
            let y = NaN;
            let z = NaN;

            if (Array.isArray(axisCandidate) && axisCandidate.length >= 3) {
                x = Number(axisCandidate[0]);
                y = Number(axisCandidate[1]);
                z = Number(axisCandidate[2]);
            } else if (axisCandidate && typeof axisCandidate === 'object') {
                x = Number(axisCandidate.x);
                y = Number(axisCandidate.y);
                z = Number(axisCandidate.z);
            }

            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                continue;
            }

            const axisEntries = [
                { axis: 'x', value: x },
                { axis: 'y', value: y },
                { axis: 'z', value: z },
            ];

            axisEntries.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
            const dominant = axisEntries[0];
            if (!dominant || Math.abs(dominant.value) < 1e-6) {
                continue;
            }

            return {
                axis: dominant.axis,
                rotationSign: dominant.value >= 0 ? 1 : -1,
            };
        }

        return null;
    }

    applyRoadAttitudeAngles() {
        this.updateAttitudeOverlay();

        if (!this.robotModel) {
            return;
        }

        const linkMap = this.robotModel.links || {};
        const carFrame = linkMap.car_frame || null;
        const groundLink = linkMap.ground_patch || linkMap.ground || null;
        const rollRad = THREE.MathUtils.degToRad(this.roadRollAngleDeg);
        const pitchRad = THREE.MathUtils.degToRad(this.roadPitchAngleDeg);

        const attitudeTargets = [];
        // 현재 URDF 구조(ellipsoid_surface -> ground -> car_frame) 기준으로
        // ground만 기울여도 car_frame 및 하위 링크에 회전이 전파된다.
        if (groundLink) {
            attitudeTargets.push(groundLink);
        } else if (carFrame) {
            // ground 링크를 찾지 못할 때만 기존처럼 차체를 직접 회전한다.
            attitudeTargets.push(carFrame);
        }

        attitudeTargets.forEach(target => {
            target.rotation.set(rollRad, pitchRad, 0);
        });

        this.applyCarFrameRollAlertVisual(carFrame);
    }

    ensureCarFrameAlertMaterials(carFrame) {
        if (!carFrame) {
            return [];
        }

        if (Array.isArray(this.carFrameAlertMaterials) && this.carFrameAlertMaterials.length > 0) {
            return this.carFrameAlertMaterials;
        }

        const linkMap = this.robotModel?.links || {};
        const excludedRoots = [
            linkMap.ellipsoid_surface_patch || null,
            linkMap.ground_patch || null,
        ].filter(Boolean);

        const isExcludedRoadNode = (node) => {
            if (!node || excludedRoots.length === 0) {
                return false;
            }

            return excludedRoots.some(root => node === root || this.isDescendantObject3D(node, root));
        };

        const collectedMaterials = [];
        carFrame.traverse(node => {
            if (!node || !node.isMesh || !node.material || isExcludedRoadNode(node)) {
                return;
            }

            if (!node.userData.__wcsCarFrameMaterialCloned) {
                if (Array.isArray(node.material)) {
                    node.material = node.material.map(material => material?.clone?.() || material);
                } else if (node.material?.clone) {
                    node.material = node.material.clone();
                }
                node.userData.__wcsCarFrameMaterialCloned = true;
            }

            const materials = Array.isArray(node.material) ? node.material : [node.material];
            materials.forEach(material => {
                if (!material || collectedMaterials.some(item => item.material === material)) {
                    return;
                }

                collectedMaterials.push({
                    material: material,
                    baseColor: material.color ? material.color.clone() : null,
                    baseEmissive: material.emissive ? material.emissive.clone() : null,
                });
            });
        });

        this.carFrameAlertMaterials = collectedMaterials;
        return this.carFrameAlertMaterials;
    }

    applyCarFrameRollAlertVisual(carFrame) {
        const alertMaterials = this.ensureCarFrameAlertMaterials(carFrame);
        if (!alertMaterials || alertMaterials.length === 0) {
            return;
        }

        const shouldAlert = Math.abs(Number(this.roadRollAngleDeg) || 0) > this.carFrameRollAlertThresholdDeg;
        if (this.isCarFrameAlertActive === shouldAlert) {
            return;
        }

        alertMaterials.forEach(item => {
            if (!item || !item.material) {
                return;
            }

            if (item.baseColor && item.material.color) {
                if (shouldAlert) {
                    item.material.color.copy(item.baseColor).lerp(this.carFrameAlertTintColor, 0.85);
                } else {
                    item.material.color.copy(item.baseColor);
                }
            }

            if (item.baseEmissive && item.material.emissive) {
                if (shouldAlert) {
                    item.material.emissive.copy(this.carFrameAlertEmissiveColor);
                } else {
                    item.material.emissive.copy(item.baseEmissive);
                }
            }

            item.material.needsUpdate = true;
        });

        this.isCarFrameAlertActive = shouldAlert;
    }

    isDescendantObject3D(childObject, ancestorObject) {
        if (!childObject || !ancestorObject || childObject === ancestorObject) {
            return false;
        }

        let current = childObject.parent;
        while (current) {
            if (current === ancestorObject) {
                return true;
            }
            current = current.parent;
        }

        return false;
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
                const keyJointSuffix = `${key}_joint`;
                const keyTokenRegex = new RegExp(`(^|[_/.-])${key}([_/.-]|$)`, 'i');
                const canonicalWheelJointName = `wheel_${key}_joint`;
                const canonicalLower = canonicalWheelJointName.toLowerCase();

                // 1) wheel_${key}_joint 를 최우선으로 직접 탐색한다.
                const preferredJointName = jointNames.find(name => {
                    const lower = String(name || '').toLowerCase();
                    return (
                        lower === canonicalLower ||
                        lower.endsWith(`/${canonicalLower}`) ||
                        lower.endsWith(`.${canonicalLower}`) ||
                        lower.endsWith(`_${canonicalLower}`)
                    );
                });

                if (preferredJointName) {
                    joint = jointMap[preferredJointName] || null;
                }

                if (joint) {
                    // 최우선 후보를 찾았으면 추가 매칭을 생략한다.
                } else {
                const candidateJointName = jointNames
                    .filter(name => (
                        name === expectedJointName ||
                        name.endsWith(expectedJointName) ||
                        name.endsWith(keySuffix) ||
                        name.endsWith(keyJointSuffix) ||
                        (name.toLowerCase().includes('joint') && keyTokenRegex.test(name))
                    ))
                    .sort((a, b) => {
                        const score = (name) => {
                            const lower = String(name || '').toLowerCase();
                            const canonical = canonicalWheelJointName.toLowerCase();
                            const isInner = lower.includes('inner');

                            if (lower === canonical) {
                                return 0;
                            }
                            if (lower.endsWith(`/${canonical}`) || lower.endsWith(`.${canonical}`) || lower.endsWith(`_${canonical}`)) {
                                return 1;
                            }
                            if (lower.includes(`wheel_${key}`) && !isInner) {
                                return 2;
                            }
                            if (lower.endsWith(keyJointSuffix.toLowerCase()) && !isInner) {
                                return 3;
                            }
                            if (lower.endsWith(expectedJointName.toLowerCase())) {
                                return 4;
                            }
                            if (isInner) {
                                return 8;
                            }
                            return 6;
                        };

                        return score(a) - score(b);
                    })[0];

                if (candidateJointName) {
                    joint = jointMap[candidateJointName];
                }
                }
            }

            if (joint && typeof joint.setJointValue === 'function') {
                const expectedLinkName = this.wheelLinkNameByKey[key];
                const link = linkMap[expectedLinkName] || null;

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
                const linkRotationInfo = this.resolveLinkRotationInfoFromJoint(joint)
                    || { axis: this.viewerWheelKey ? 'x' : 'y', rotationSign: this.viewerWheelKey ? -1 : 1 };
                this.wheelRuntimeTargetByKey[key] = {
                    type: 'link',
                    ref: link,
                    axis: linkRotationInfo.axis,
                    rotationSign: linkRotationInfo.rotationSign,
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
        const tx = formatPositionValue(this.controls?.target?.x);
        const ty = formatPositionValue(this.controls?.target?.y);
        const tz = formatPositionValue(this.controls?.target?.z);
        const ux = formatPositionValue(this.camera.up.x);
        const uy = formatPositionValue(this.camera.up.y);
        const uz = formatPositionValue(this.camera.up.z);
        const poseValueText = `${px}, ${py}, ${pz}|${tx}, ${ty}, ${tz}|${ux}, ${uy}, ${uz}`;
        this.cameraPosCopyText = poseValueText;

        if (this.cameraPosTextElement && this.cameraPosTextElement.length > 0) {
            this.cameraPosTextElement.text(poseValueText);
            this.cameraPosTextElement.attr('title', `cameraPose="${poseValueText}"`);
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

    calculateFitDistanceForFace(sizeVec3, faceKey, marginRatio = 0.05) {
        if (!sizeVec3) {
            return this.calculateFitDistance(1, marginRatio);
        }

        const axisPairsByFace = {
            front: ['y', 'z'],
            back: ['y', 'z'],
            left: ['x', 'z'],
            right: ['x', 'z'],
            top: ['x', 'y'],
            bottom: ['x', 'y']
        };

        const [verticalAxis, horizontalAxis] = axisPairsByFace[faceKey] || ['x', 'y'];
        const verticalSize = Math.max(Number(sizeVec3[verticalAxis]) || 0, 0.001) * (1 + Math.max(marginRatio, 0));
        const horizontalSize = Math.max(Number(sizeVec3[horizontalAxis]) || 0, 0.001) * (1 + Math.max(marginRatio, 0));

        const vFovHalfRad = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
        const hFovHalfRad = Math.atan(Math.tan(vFovHalfRad) * this.camera.aspect);

        const distanceByHeight = (verticalSize * 0.5) / Math.tan(Math.max(vFovHalfRad, 0.001));
        const distanceByWidth = (horizontalSize * 0.5) / Math.tan(Math.max(hFovHalfRad, 0.001));

        return Math.max(distanceByHeight, distanceByWidth, 0.001);
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
        const maxAxisLength = Math.max(lengthX, lengthY, lengthZ);
        const nearOriginOffset = Math.max(maxAxisLength * this.axisLabelNearOriginRatio, this.axisLabelMinOffset);
        const xLabel = this.createAxisLabel('X', '#ff3333', new THREE.Vector3(nearOriginOffset, 0, 0));
        const yLabel = this.createAxisLabel('Y', '#22aa22', new THREE.Vector3(0, nearOriginOffset, 0));
        const zLabel = this.createAxisLabel('Z', '#3366ff', new THREE.Vector3(0, 0, nearOriginOffset));

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

        const axisLengthX = sizeX * this.axisLengthExtraRatio;
        const axisLengthY = sizeY * this.axisLengthExtraRatio;
        const axisLengthZ = sizeZ * this.axisLengthExtraRatio * 2;

        this.updateAxisLineLength('x', axisLengthX);
        this.updateAxisLineLength('y', axisLengthY);
        this.updateAxisLineLength('z', axisLengthZ);

        const maxAxisLength = Math.max(axisLengthX, axisLengthY, axisLengthZ);
        const nearOriginOffset = Math.max(maxAxisLength * this.axisLabelNearOriginRatio, this.axisLabelMinOffset);
        if (this.axisLabelSprites.length >= 3) {
            this.axisLabelSprites[0].position.set(nearOriginOffset, 0, 0);
            this.axisLabelSprites[1].position.set(0, nearOriginOffset, 0);
            this.axisLabelSprites[2].position.set(0, 0, nearOriginOffset);
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

        const labelScale = 0.09;
        const fontPx = 162;

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

        const projectToArcball = (clientX, clientY) => {
            const rect = this.container.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return new THREE.Vector3(0, 0, 1);
            }

            const x = ((clientX - rect.left) / rect.width) * 2 - 1;
            const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
            const lengthSq = x * x + y * y;

            if (lengthSq > 1) {
                const invLength = 1 / Math.sqrt(lengthSq);
                return new THREE.Vector3(x * invLength, y * invLength, 0);
            }

            const z = Math.sqrt(Math.max(0, 1 - lengthSq));
            return new THREE.Vector3(x, y, z).normalize();
        };

        const getRobotIntersections = (event) => {
            if (!this.robotModel) {
                return [];
            }

            const rect = this.container.getBoundingClientRect();
            const width = rect.width;
            const height = rect.height;

            if (!width || !height) {
                return [];
            }

            mouse.x = ((event.clientX - rect.left) / width) * 2 - 1;
            mouse.y = -((event.clientY - rect.top) / height) * 2 + 1;
            raycaster.setFromCamera(mouse, this.camera);

            return raycaster.intersectObject(this.robotModel, true);
        };

        const isChassisHit = (hitObject) => {
            if (!hitObject || !this.robotModel) {
                return false;
            }

            const linkMap = this.robotModel?.links || {};
            const carFrame = linkMap.car_frame || null;
            if (!carFrame) {
                return true;
            }

            const excludedLinkRoots = [
                linkMap.ellipsoid_surface_patch || null,
                linkMap.ground_patch || null,
                linkMap.wheel_fl || null,
                linkMap.wheel_fr || null,
                linkMap.wheel_rl || null,
                linkMap.wheel_rr || null,
            ].filter(Boolean);

            const isExcludedNode = excludedLinkRoots.some(root => {
                return hitObject === root || this.isDescendantObject3D(hitObject, root);
            });

            if (isExcludedNode) {
                return false;
            }

            return hitObject === carFrame || this.isDescendantObject3D(hitObject, carFrame);
        };

        const disableOrbitInteraction = () => {
            this.isOrbitInteractionActive = false;
            this.mainOrbitDragState = null;
        };

        const startMainOrbitDrag = (event) => {
            this.mainOrbitDragState = {
                lastClientX: event.clientX,
                lastClientY: event.clientY,
                totalMove: 0,
                isActivated: false,
                arcballVector: projectToArcball(event.clientX, event.clientY)
            };
        };

        const updateMainOrbitDrag = (event) => {
            if (!this.mainOrbitDragState || !this.controls || !this.camera) {
                return;
            }

            const deltaX = event.clientX - this.mainOrbitDragState.lastClientX;
            const deltaY = event.clientY - this.mainOrbitDragState.lastClientY;
            this.mainOrbitDragState.lastClientX = event.clientX;
            this.mainOrbitDragState.lastClientY = event.clientY;
            this.mainOrbitDragState.totalMove += Math.hypot(deltaX, deltaY);

            const nextArcball = projectToArcball(event.clientX, event.clientY);
            if (this.mainOrbitDragState.totalMove <= this.mainOrbitDragActivateDistancePx) {
                this.mainOrbitDragState.arcballVector = nextArcball;
                return;
            }

            if (!this.mainOrbitDragState.isActivated) {
                this.mainOrbitDragState.isActivated = true;
                this.mainOrbitDragState.arcballVector = nextArcball;
                return;
            }

            const previousArcball = this.mainOrbitDragState.arcballVector;
            this.mainOrbitDragState.arcballVector = nextArcball;

            const axisCamera = new THREE.Vector3().crossVectors(previousArcball, nextArcball);
            if (axisCamera.lengthSq() < 1e-10) {
                return;
            }

            const dot = THREE.MathUtils.clamp(previousArcball.dot(nextArcball), -1, 1);
            const angle = Math.acos(dot) * this.mainOrbitArcballSensitivity;
            if (!Number.isFinite(angle) || angle <= 1e-6) {
                return;
            }

            axisCamera.normalize();
            const axisWorld = axisCamera.clone().applyQuaternion(this.camera.quaternion).normalize();

            const target = this.controls.target.clone();
            const offset = this.camera.position.clone().sub(target);
            const rotation = new THREE.Quaternion().setFromAxisAngle(axisWorld, -angle);
            offset.applyQuaternion(rotation);
            this.camera.up.applyQuaternion(rotation).normalize();

            this.camera.position.copy(target.clone().add(offset));
            this.camera.lookAt(target);
            this.controls.update();
            this.resetDirectionalLight(this.controls.target, this.directionalLightRadius);
            this.logCameraInfos(false);
        };

        const endMainOrbitDrag = () => {
            if (!this.mainOrbitDragState) {
                return;
            }

            this.mainOrbitDragState = null;
        };

        this.renderer.domElement.addEventListener('pointerdown', (event) => {
            if (!this.controls || event.ctrlKey) {
                return;
            }

            if (event.button === 0) {
                event.preventDefault();
                startMainOrbitDrag(event);
            } else if (event.button === 2) {
                event.preventDefault();
            }

            const intersects = getRobotIntersections(event);
            const chassisHit = intersects.find(intersection => isChassisHit(intersection?.object));
            this.isOrbitInteractionActive = event.button === 0 || event.button === 2;
        }, true);

        this.renderer.domElement.addEventListener('pointermove', (event) => {
            updateMainOrbitDrag(event);
        }, true);

        this.renderer.domElement.addEventListener('contextmenu', (event) => {
            event.preventDefault();
        });

        window.addEventListener('pointerup', (event) => {
            disableOrbitInteraction();
            if (event.button === 0) {
                endMainOrbitDrag();
            }
        }, true);
        window.addEventListener('pointercancel', disableOrbitInteraction, true);
        window.addEventListener('blur', disableOrbitInteraction);

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

            if (event.button !== 0) {
                return;
            }

            const intersects = getRobotIntersections(event);
            const chassisHit = intersects.find(intersection => isChassisHit(intersection?.object));
            if (chassisHit && chassisHit.point) {
                this.goalTarget.copy(chassisHit.point);
                this.applyGoalTargetToControls();
                console.log('[URDF] 목표 지점 설정:', this.goalTarget);
            }
        });
    }

    applyGoalTargetToControls() {
        if (!this.controls) {
            return;
        }

        this.controls.target.set(
            this.goalTarget.x,
            this.goalTarget.y - this.goalTargetVerticalOffset,
            this.goalTarget.z
        );
        this.controls.update();
    }

    snapshotInitialCameraPose() {
        if (!this.camera || !this.controls) {
            return;
        }

        this.initialCameraPose = {
            position: this.camera.position.clone(),
            target: this.controls.target.clone(),
            up: this.camera.up.clone(),
        };
    }

    restoreInitialCameraPose() {
        if (!this.initialCameraPose || !this.camera || !this.controls) {
            return;
        }

        const positionDiff = this.camera.position.distanceTo(this.initialCameraPose.position);
        const targetDiff = this.controls.target.distanceTo(this.initialCameraPose.target);
        const currentUp = this.camera.up.clone().normalize();
        const initialUp = this.initialCameraPose.up.clone().normalize();
        const upDot = THREE.MathUtils.clamp(currentUp.dot(initialUp), -1, 1);
        const upAngle = Math.acos(upDot);

        const isSamePose = positionDiff < 1e-4 && targetDiff < 1e-4 && upAngle < 1e-3;
        if (isSamePose) {
            return;
        }

        this.overlayDragPanPixels = 0;
        this.overlayZoomOutRatio = 0;

        this.animateCameraToPoseWithTarget(
            this.initialCameraPose.position,
            this.initialCameraPose.target,
            this.initialCameraPose.up,
            260
        );
        this.showCameraToastMessage('초기 위치로 복귀했습니다.', 1200);
    }

    setGoalTargetVerticalOffset(offsetValue) {
        const numericOffset = Number(offsetValue);
        this.goalTargetVerticalOffset = Number.isFinite(numericOffset)
            ? THREE.MathUtils.clamp(numericOffset, -2, 2)
            : 0;
        this.applyGoalTargetToControls();
        this.resetDirectionalLight(this.controls.target, this.directionalLightRadius);
    }

    markInitialCameraPoseReady() {
        this.isInitialCameraPoseReady = true;

        if (this.pendingOverlayDragPixels != null) {
            const queuedPixels = this.pendingOverlayDragPixels;
            this.pendingOverlayDragPixels = null;
            this.setOverlayVerticalDragPixels(queuedPixels);
        }

        if (this.pendingOverlayZoomOutRatio != null) {
            const queuedZoomOutRatio = this.pendingOverlayZoomOutRatio;
            this.pendingOverlayZoomOutRatio = null;
            this.setOverlayZoomOutRatio(queuedZoomOutRatio);
        }
    }

    setOverlayVerticalDragPixels(pixelHeight) {
        if (!this.controls || !this.camera) {
            return;
        }

        const requestedPixels = Number(pixelHeight);
        if (!this.isInitialCameraPoseReady) {
            this.pendingOverlayDragPixels = Number.isFinite(requestedPixels) ? requestedPixels : 0;
            return;
        }

        const containerHeight = Number(this.container?.clientHeight || this.container?.getBoundingClientRect?.().height || 0);
        if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
            return;
        }

        const nextPixels = Number.isFinite(requestedPixels)
            ? THREE.MathUtils.clamp(requestedPixels, 0, containerHeight * 0.85)
            : 0;
        const deltaPixels = nextPixels - this.overlayDragPanPixels;

        if (Math.abs(deltaPixels) < 0.5) {
            return;
        }

        const target = this.controls.target.clone();
        const viewDir = target.clone().sub(this.camera.position).normalize();
        if (viewDir.lengthSq() === 0) {
            return;
        }

        let worldPerPixel = 0;
        if (this.camera.isPerspectiveCamera) {
            const distance = Math.max(this.camera.position.distanceTo(target), 0.001);
            const fovRad = THREE.MathUtils.degToRad(this.camera.fov || 50);
            worldPerPixel = (2 * distance * Math.tan(fovRad / 2)) / containerHeight;
        } else if (this.camera.isOrthographicCamera) {
            const frustumHeight = (this.camera.top - this.camera.bottom) / Math.max(this.camera.zoom || 1, 0.001);
            worldPerPixel = frustumHeight / containerHeight;
        }

        if (!Number.isFinite(worldPerPixel) || worldPerPixel <= 0) {
            return;
        }

        const right = new THREE.Vector3().crossVectors(viewDir, this.camera.up).normalize();
        if (right.lengthSq() === 0) {
            return;
        }

        const screenUp = new THREE.Vector3().crossVectors(right, viewDir).normalize();
        const panOffset = screenUp.multiplyScalar(deltaPixels * worldPerPixel);

        this.camera.position.add(panOffset);
        this.goalTarget.add(panOffset);
        this.overlayDragPanPixels = nextPixels;
        this.applyGoalTargetToControls();
        this.resetDirectionalLight(this.controls.target, this.directionalLightRadius);
    }

    setOverlayZoomOutRatio(zoomOutRatio) {
        if (!this.controls || !this.camera) {
            return;
        }

        const requestedRatio = Number(zoomOutRatio);
        const nextRatio = Number.isFinite(requestedRatio)
            ? THREE.MathUtils.clamp(requestedRatio, 0, 0.35)
            : 0;

        if (!this.isInitialCameraPoseReady) {
            this.pendingOverlayZoomOutRatio = nextRatio;
            return;
        }

        const currentRatio = Number(this.overlayZoomOutRatio) || 0;
        if (Math.abs(nextRatio - currentRatio) < 0.0005) {
            return;
        }

        const target = this.controls.target.clone();
        const cameraOffset = this.camera.position.clone().sub(target);
        const currentDistance = cameraOffset.length();
        if (!Number.isFinite(currentDistance) || currentDistance <= 0.0001) {
            return;
        }

        const baseDistance = currentDistance / Math.max(1 + currentRatio, 0.001);
        const nextDistance = baseDistance * (1 + nextRatio);
        const normalizedOffset = cameraOffset.normalize().multiplyScalar(nextDistance);

        this.camera.position.copy(target.clone().add(normalizedOffset));
        this.overlayZoomOutRatio = nextRatio;
        this.controls.update();
        this.resetDirectionalLight(this.controls.target, this.directionalLightRadius);
        this.logCameraInfos(true);
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
                this.carFrameAlertMaterials = [];
                this.isCarFrameAlertActive = false;
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
                        console.log('[URDF] cameraPose 지정됨: 사용자 카메라 위치 유지');
                    } else {
                        const fitDistance = this.calculateFitDistanceForFace(size, 'top', this.cameraFitMarginRatio);
                        this.setCameraFromFace(center, fitDistance, 'top');
                        console.log('[URDF] cameraPose 미지정: top view 자동 피팅 카메라 적용 (마진 5%)');
                    }

                    const poseTarget = this.hasCustomCameraTarget ? this.cameraTarget.clone() : center.clone();
                    const currentCameraDist = Math.max(this.camera.position.distanceTo(poseTarget), 0.01);
                    this.camera.near = Math.max(currentCameraDist / 100, 0.01);
                    this.camera.far = Math.max(currentCameraDist * 100, 10);
                    this.camera.updateProjectionMatrix();

                    this.goalTarget.copy(poseTarget);
                    this.applyGoalTargetToControls();
                    this.controls.minDistance = currentCameraDist * 0.2;
                    this.controls.maxDistance = currentCameraDist * 8;
                    this.resetDirectionalLight(this.controls.target, radius);
                    this.snapshotInitialCameraPose();
                    this.logCameraInfos(true);
                    this.markInitialCameraPoseReady();

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
            const newWidth = Math.max(newRect.width, 1);
            const newHeight = Math.max(newRect.height, 1);
            
            this.camera.aspect = newWidth / newHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(newWidth, newHeight, false);
            this.renderer.domElement.style.width = '100%';
            this.renderer.domElement.style.height = '100%';

            if (this.compassRenderer) {
                this.compassRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
                this.compassRenderer.setSize(48, 48, false);
            }
        });
    }

    animate() {
        const now = performance.now();
        const deltaSec = Math.min((now - this.lastFrameTimeMs) / 1000, 0.1);
        this.lastFrameTimeMs = now;

        this.applyWheelAnimation(deltaSec);
        requestAnimationFrame(() => this.animate());
        this.controls.update();
        this.updateCompassOverlay();
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

globalThis.setWheelVisualFilterEnabled = function(enabled, viewerId = 'vehicle-urdf-viewer') {
    const viewer = window.urdfViewersById?.[viewerId] || window.activeURDFViewer || null;
    if (!viewer || typeof viewer.setWheelVisualFilterEnabled !== 'function') {
        return;
    }

    viewer.setWheelVisualFilterEnabled(enabled);
};

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

    const mode = window.activeURDFViewer.driveMode || 'stop';

    if (mode === 'stop') {
        // Keep the configured speed for the next drive command, but do not move while stopped.
        window.activeURDFViewer.driveSpeedKmh = normalizedKmh;
        return;
    }

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

    const targetViewer = getRoadAttitudeTargetViewer();
    if (!targetViewer || typeof targetViewer.applyRoadRollAngleDeg !== 'function') {
        return;
    }

    targetViewer.applyRoadRollAngleDeg(normalizedAngleDeg);
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

    const targetViewer = getRoadAttitudeTargetViewer();
    if (!targetViewer || typeof targetViewer.applyRoadPitchAngleDeg !== 'function') {
        return;
    }

    targetViewer.applyRoadPitchAngleDeg(normalizedAngleDeg);
}

function getRoadAttitudeTargetViewer() {
    const vehicleViewer = window.urdfViewersById?.['vehicle-urdf-viewer'] || null;
    if (vehicleViewer) {
        return vehicleViewer;
    }

    if (Array.isArray(window.urdfViewers)) {
        const matchedViewer = window.urdfViewers.find(viewer => {
            const urdfPath = String(viewer?.urdfPath || '');
            return urdfPath.includes('/vehicle/vehicle.urdf');
        });

        if (matchedViewer) {
            return matchedViewer;
        }
    }

    return window.activeURDFViewer || null;
}

const vehicleAudioState = {
    lastCommand: null,
    lastSurfaceState: null,
    lastObstacle: null,
    lastRollAngleDeg: null,
    baselineSeen: {
        command: false,
        surface: false,
        obstacle: false,
        roll: false,
    },
    lastRollAnnouncedAt: 0,
    minRollDeltaDeg: 2,
    minRollAnnounceIntervalMs: 1200,
    isActivated: false,
    isActivationListenerAttached: false,
    pendingMessage: null,
    pendingOptions: null,
    speakTimerId: null,
    speechQueue: [],
    isSpeaking: false,
    lastSpokenMessage: '',
    lastSpokenAt: 0,
    duplicateMessageBlockMs: 350
};

function canUseSpeechSynthesis() {
    return typeof window !== 'undefined'
        && typeof window.SpeechSynthesisUtterance === 'function'
        && window.speechSynthesis
        && typeof window.speechSynthesis.speak === 'function';
}

function getPreferredSpeechVoice() {
    if (!canUseSpeechSynthesis()) {
        return null;
    }

    let voices = [];
    try {
        voices = window.speechSynthesis.getVoices() || [];
    } catch (error) {
        voices = [];
    }

    if (!Array.isArray(voices) || voices.length === 0) {
        return null;
    }

    const koVoice = voices.find(function (voice) {
        return String(voice && voice.lang || '').toLowerCase().startsWith('ko');
    });
    return koVoice || voices[0] || null;
}

function hasUserActivatedDocument() {
    if (hasGlobalUserGestureDetected()) {
        return true;
    }

    try {
        return !!(navigator.userActivation && navigator.userActivation.hasBeenActive === true);
    } catch (error) {
        return false;
    }
}

function readVehicleAudioEnabledFromStorage() {
    try {
        const rawValue = window.localStorage.getItem(VEHICLE_AUDIO_STORAGE_KEY);
        if (rawValue == null) {
            return null;
        }

        const normalized = String(rawValue).trim().toLowerCase();
        if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
            return true;
        }

        if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
            return false;
        }
    } catch (error) {
        console.warn('[URDF][Audio] localStorage read failed:', error);
    }

    return null;
}

function writeVehicleAudioEnabledToStorage(enabled) {
    try {
        window.localStorage.setItem(VEHICLE_AUDIO_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch (error) {
        console.warn('[URDF][Audio] localStorage write failed:', error);
    }
}

function isVehicleAudioEnabled() {
    if (typeof window.vehicleAudioEnabled === 'boolean') {
        return window.vehicleAudioEnabled;
    }

    const storageEnabled = readVehicleAudioEnabledFromStorage();
    if (storageEnabled != null) {
        return storageEnabled;
    }

    const viewer = getRoadAttitudeTargetViewer();
    return !!(viewer && viewer.showAudio === true);
}

function setVehicleAudioEnabled(enabled) {
    const normalizedEnabled = !!enabled;
    window.vehicleAudioEnabled = normalizedEnabled;
    window.__wcsAudioEnabled = normalizedEnabled;
    writeVehicleAudioEnabledToStorage(normalizedEnabled);

    if (normalizedEnabled) {
        setupVehicleAudioActivationListener();
        if (hasUserActivatedDocument()) {
            tryActivateVehicleAudio('auto');
        }
        return;
    }

    vehicleAudioState.pendingMessage = null;
    vehicleAudioState.pendingOptions = null;
    if (vehicleAudioState.speakTimerId) {
        clearTimeout(vehicleAudioState.speakTimerId);
        vehicleAudioState.speakTimerId = null;
    }

    if (canUseSpeechSynthesis()) {
        window.speechSynthesis.cancel();
    }

    vehicleAudioState.speechQueue = [];
    vehicleAudioState.isSpeaking = false;
    window.__wcsAudioSpeaking = false;
}

function tryActivateVehicleAudio(trigger = 'system') {
    if (!canUseSpeechSynthesis()) {
        return false;
    }

    try {
        window.speechSynthesis.resume();
        window.speechSynthesis.getVoices();
    } catch (error) {
        console.warn('[URDF][Audio] speechSynthesis resume failed:', error);
    }

    const canActivateByGesture = trigger === 'gesture';
    const canActivateByPriorInteraction = trigger === 'auto' && hasUserActivatedDocument();

    // 브라우저 자동재생 정책상 사용자 제스처 또는 이미 사용자 상호작용이 확인된 경우에만 활성화한다.
    if (!canActivateByGesture && !canActivateByPriorInteraction) {
        return false;
    }

    vehicleAudioState.isActivated = true;

    const pendingMessage = vehicleAudioState.pendingMessage;
    const pendingOptions = vehicleAudioState.pendingOptions || {};
    if (pendingMessage) {
        vehicleAudioState.pendingMessage = null;
        vehicleAudioState.pendingOptions = null;
        speakVehicleStatus(pendingMessage, pendingOptions);
    }

    return true;
}

function setupVehicleAudioActivationListener() {
    if (vehicleAudioState.isActivationListenerAttached || !isVehicleAudioEnabled()) {
        return;
    }

    if (hasUserActivatedDocument()) {
        tryActivateVehicleAudio('auto');
        return;
    }

    vehicleAudioState.isActivationListenerAttached = true;

    const onFirstUserGesture = () => {
        tryActivateVehicleAudio('gesture');
        document.removeEventListener('pointerdown', onFirstUserGesture, true);
        document.removeEventListener('keydown', onFirstUserGesture, true);
        document.removeEventListener('touchstart', onFirstUserGesture, true);
    };

    document.addEventListener('pointerdown', onFirstUserGesture, true);
    document.addEventListener('keydown', onFirstUserGesture, true);
    document.addEventListener('touchstart', onFirstUserGesture, true);
}

function processVehicleSpeechQueue() {
    if (!isVehicleAudioEnabled() || !canUseSpeechSynthesis()) {
        return;
    }

    if (!vehicleAudioState.isActivated || vehicleAudioState.isSpeaking) {
        return;
    }

    if (!Array.isArray(vehicleAudioState.speechQueue) || vehicleAudioState.speechQueue.length === 0) {
        return;
    }

    const nextMessage = String(vehicleAudioState.speechQueue.shift() || '').trim();
    if (!nextMessage) {
        processVehicleSpeechQueue();
        return;
    }

    vehicleAudioState.isSpeaking = true;
    window.__wcsAudioSpeaking = true;

    try {
        window.speechSynthesis.resume();
        window.speechSynthesis.getVoices();
    } catch (error) {
        console.warn('[URDF][Audio] speechSynthesis resume before queue speak failed:', error);
    }

    const utterance = new window.SpeechSynthesisUtterance(nextMessage);
    const preferredVoice = getPreferredSpeechVoice();
    if (preferredVoice) {
        utterance.voice = preferredVoice;
        if (preferredVoice.lang) {
            utterance.lang = preferredVoice.lang;
        }
    } else {
        utterance.lang = 'ko-KR';
    }
    utterance.rate = 1.05;
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.onend = () => {
        vehicleAudioState.isSpeaking = false;
        window.__wcsAudioSpeaking = false;
        processVehicleSpeechQueue();
    };
    utterance.onerror = () => {
        vehicleAudioState.isSpeaking = false;
        window.__wcsAudioSpeaking = false;
        processVehicleSpeechQueue();
    };
    try {
        window.speechSynthesis.speak(utterance);
    } catch (error) {
        console.warn('[URDF][Audio] speechSynthesis.speak failed:', error);
        vehicleAudioState.isSpeaking = false;
        window.__wcsAudioSpeaking = false;
        processVehicleSpeechQueue();
    }
}

function speakVehicleStatus(text, options = {}) {
    if (!isVehicleAudioEnabled() || !canUseSpeechSynthesis()) {
        return;
    }

    const message = String(text || '').trim();
    if (!message) {
        return;
    }

    const shouldInterrupt = !!(options && options.interrupt === true);

    const now = Date.now();
    window.__wcsAudioEnabled = true;
    window.__wcsLastSpeechText = message;
    window.__wcsLastSpeechAt = now;
    if (
        vehicleAudioState.lastSpokenMessage === message
        && (now - vehicleAudioState.lastSpokenAt) < vehicleAudioState.duplicateMessageBlockMs
    ) {
        return;
    }

    if (!vehicleAudioState.isActivated) {
        if (hasUserActivatedDocument()) {
            tryActivateVehicleAudio('auto');
        }

        if (vehicleAudioState.isActivated) {
            // continue to enqueue/speak below.
        } else {
            vehicleAudioState.pendingMessage = message;
            vehicleAudioState.pendingOptions = options;
            setupVehicleAudioActivationListener();
            return;
        }
    }

    const globalSpeechState = window.__wcsGlobalSpeechState || { message: '', at: 0 };
    if (globalSpeechState.message === message && (now - globalSpeechState.at) < 1200) {
        return;
    }
    window.__wcsGlobalSpeechState = { message: message, at: now };

    if (shouldInterrupt && canUseSpeechSynthesis()) {
        try {
            window.speechSynthesis.cancel();
        } catch (error) {
            // Ignore cancel failures and continue queue handling.
        }
        vehicleAudioState.speechQueue = [];
        vehicleAudioState.isSpeaking = false;
        window.__wcsAudioSpeaking = false;
    } else if (vehicleAudioState.speechQueue.length >= 6) {
        // Keep queue bounded to prevent stale delayed speech.
        vehicleAudioState.speechQueue = vehicleAudioState.speechQueue.slice(-3);
    }

    vehicleAudioState.speechQueue.push(message);
    processVehicleSpeechQueue();

    vehicleAudioState.lastSpokenMessage = message;
    vehicleAudioState.lastSpokenAt = now;
}

function announceVehicleDriveCommand(commandValue) {
    if (!isVehicleAudioEnabled()) {
        return;
    }

    const numericCommand = Number.parseInt(commandValue, 10);
    const commandLabelByValue = {
        0: '정지',
        1: '전진',
        2: '후진',
        3: '좌회전',
        4: '우회전'
    };

    const commandLabel = commandLabelByValue[numericCommand];
    if (!commandLabel) {
        return;
    }

    // 첫 수신 명령값은 기준값만 설정하고 음성은 출력하지 않는다.
    if (!vehicleAudioState.baselineSeen.command) {
        vehicleAudioState.baselineSeen.command = true;
        vehicleAudioState.lastCommand = numericCommand;
        return;
    }

    if (vehicleAudioState.lastCommand === numericCommand) {
        return;
    }

    vehicleAudioState.lastCommand = numericCommand;
    speakVehicleStatus(`차량 ${commandLabel}`, { interrupt: true });
}

function announceVehicleRollAngleDeg(angleDeg) {
    if (!isVehicleAudioEnabled()) {
        return;
    }

    const numericAngle = Number(angleDeg);
    if (!Number.isFinite(numericAngle)) {
        return;
    }

    const roundedAngleDeg = Math.round(numericAngle);
    const now = Date.now();

    // 첫 수신값(대개 초기 0도)은 기준값만 설정하고 음성 출력하지 않는다.
    if (!vehicleAudioState.baselineSeen.roll) {
        vehicleAudioState.baselineSeen.roll = true;
        vehicleAudioState.lastRollAngleDeg = roundedAngleDeg;
        vehicleAudioState.lastRollAnnouncedAt = now;
        return;
    }

    if (vehicleAudioState.lastRollAngleDeg != null) {
        const angleDelta = Math.abs(roundedAngleDeg - vehicleAudioState.lastRollAngleDeg);
        const elapsedMs = now - vehicleAudioState.lastRollAnnouncedAt;
        if (angleDelta < vehicleAudioState.minRollDeltaDeg || elapsedMs < vehicleAudioState.minRollAnnounceIntervalMs) {
            return;
        }
    }

    vehicleAudioState.lastRollAngleDeg = roundedAngleDeg;
    vehicleAudioState.lastRollAnnouncedAt = now;
    speakVehicleStatus(`롤 각도 ${roundedAngleDeg}도`, { interrupt: true });
}

function announceVehicleObstacle(obstacleValue) {
    if (!isVehicleAudioEnabled()) {
        return;
    }

    const numericObstacle = Number.parseInt(obstacleValue, 10);
    const obstacleLabelByValue = {
        0: '없음',
        1: '단차',
        2: '포트홀',
        3: '빙판길'
    };

    const obstacleLabel = obstacleLabelByValue[numericObstacle];
    if (!obstacleLabel) {
        return;
    }

    vehicleAudioState.baselineSeen.obstacle = true;

    if (vehicleAudioState.lastObstacle === numericObstacle) {
        return;
    }

    vehicleAudioState.lastObstacle = numericObstacle;
    speakVehicleStatus(`장애물 ${obstacleLabel}`, { interrupt: true });
}

function announceVehicleSurfaceState(surfaceStateValue) {
    if (!isVehicleAudioEnabled()) {
        return;
    }

    const numericSurfaceState = Number.parseInt(surfaceStateValue, 10);
    const surfaceLabelByValue = {
        0: '아스팔트',
        1: '보도블록',
        2: '흙길',
        3: '자갈길'
    };

    const surfaceLabel = surfaceLabelByValue[numericSurfaceState];
    if (!surfaceLabel) {
        return;
    }

    // 첫 수신 노면 상태(대개 초기 아스팔트)는 기준만 설정하고 음성은 출력하지 않는다.
    if (!vehicleAudioState.baselineSeen.surface) {
        vehicleAudioState.baselineSeen.surface = true;
        vehicleAudioState.lastSurfaceState = numericSurfaceState;
        return;
    }

    if (vehicleAudioState.lastSurfaceState === numericSurfaceState) {
        return;
    }

    vehicleAudioState.lastSurfaceState = numericSurfaceState;
    speakVehicleStatus(`${surfaceLabel}`, { interrupt: true });
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
globalThis.setVehicleViewerVerticalOffset = function(offsetValue) {
    const vehicleViewer = window.urdfViewersById?.['vehicle-urdf-viewer'] || null;
    if (!vehicleViewer || typeof vehicleViewer.setGoalTargetVerticalOffset !== 'function') {
        return;
    }

    vehicleViewer.setGoalTargetVerticalOffset(offsetValue);
};
globalThis.setVehicleViewerOverlayDragPixels = function(pixelHeight) {
    const vehicleViewer = window.urdfViewersById?.['vehicle-urdf-viewer'] || null;
    if (!vehicleViewer || typeof vehicleViewer.setOverlayVerticalDragPixels !== 'function') {
        return;
    }

    vehicleViewer.setOverlayVerticalDragPixels(pixelHeight);
};
globalThis.setVehicleViewerOverlayZoomOutRatio = function(zoomOutRatio) {
    const vehicleViewer = window.urdfViewersById?.['vehicle-urdf-viewer'] || null;
    if (!vehicleViewer || typeof vehicleViewer.setOverlayZoomOutRatio !== 'function') {
        return;
    }

    vehicleViewer.setOverlayZoomOutRatio(zoomOutRatio);
};
globalThis.isVehicleAudioEnabled = isVehicleAudioEnabled;
globalThis.setVehicleAudioEnabled = setVehicleAudioEnabled;
globalThis.activateVehicleAudioByGesture = function() {
    setVehicleAudioEnabled(true);
    return tryActivateVehicleAudio('gesture');
};
globalThis.announceVehicleDriveCommand = announceVehicleDriveCommand;
globalThis.announceVehicleRollAngleDeg = announceVehicleRollAngleDeg;
globalThis.announceVehicleObstacle = announceVehicleObstacle;
globalThis.announceVehicleSurfaceState = announceVehicleSurfaceState;

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

    if (isVehicleAudioEnabled()) {
        // 사용자 제스처 전에 MQTT 이벤트가 먼저 와도 안내 문구를 보류해 두었다가 재생하기 위해 리스너를 준비한다.
        setupVehicleAudioActivationListener();
        tryActivateVehicleAudio('system');
    }

    const storageEnabled = readVehicleAudioEnabledFromStorage();
    const viewer = getRoadAttitudeTargetViewer();
    if (viewer) {
        if (viewer.showAudio === true) {
            // showAudio=true 페이지에서는 과거 localStorage의 OFF 값으로 영구 음소거되지 않게 ON을 우선한다.
            setVehicleAudioEnabled(true);
        } else {
            // showAudio=false일 때는 명시적으로 음소거 (localStorage 값 무시)
            setVehicleAudioEnabled(false);
        }
    }

    console.log("[URDF] 🚀 모든 URDF Viewer 초기화 완료");
}

// DOM 준비 후 초기화
$(initURDFViewers);