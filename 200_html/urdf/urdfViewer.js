import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const $ = window.jQuery;
const VEHICLE_AUDIO_STORAGE_KEY = 'wcs.vehicle.showAudio';

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
        this.carFrameRollAlertThresholdDeg = 8;
        this.carFrameAlertMaterials = [];
        this.isCarFrameAlertActive = false;
        this.carFrameAlertTintColor = new THREE.Color(0xd32f2f);
        this.carFrameAlertEmissiveColor = new THREE.Color(0x521414);
        this.attitudeOverlayElement = null;
        this.rollNeedleElement = null;
        this.pitchNeedleElement = null;
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
        this.renderer.setSize(width, height);
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
    }

    setupAttitudeOverlay() {
        this.ensureContainerOverlayPositioning();

        const panelElement = document.createElement('div');
        panelElement.style.position = 'absolute';
        panelElement.style.top = '16px';
        panelElement.style.right = '10px';
        panelElement.style.zIndex = '13';
        panelElement.style.padding = '8px';
        panelElement.style.background = 'rgba(255, 255, 255, 0.88)';
        panelElement.style.border = '1px solid rgba(30, 30, 30, 0.2)';
        panelElement.style.borderRadius = '10px';
        panelElement.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.12)';
        panelElement.style.pointerEvents = 'none';
        panelElement.style.width = 'auto';

        const dialElement = document.createElement('div');
        dialElement.style.position = 'relative';
        dialElement.style.width = '48px';
        dialElement.style.height = '48px';
        dialElement.style.margin = '4px auto';
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
        this.container.appendChild(panelElement);

        this.attitudeOverlayElement = panelElement;
        this.rollNeedleElement = rollNeedleElement;
        this.pitchNeedleElement = pitchNeedleElement;
        this.updateAttitudeOverlay();
    }

    setupViewCubeOverlay() {
        if (!this.container || this.viewCubeOverlayElement) {
            return;
        }

        this.ensureContainerOverlayPositioning();

        const panelElement = document.createElement('div');
        panelElement.style.position = 'absolute';
        panelElement.style.top = '16px';
        panelElement.style.left = '10px';
        panelElement.style.zIndex = '16';
        panelElement.style.width = 'auto';
        panelElement.style.padding = '8px';
        panelElement.style.background = 'rgba(255, 255, 255, 0.92)';
        panelElement.style.border = '1px solid rgba(20, 20, 20, 0.2)';
        panelElement.style.borderRadius = '10px';
        panelElement.style.boxShadow = '0 3px 10px rgba(0, 0, 0, 0.16)';
        panelElement.style.pointerEvents = 'auto';
        panelElement.style.userSelect = 'none';

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
            buttonElement.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.setCameraByViewCubeFace(faceKey);
            });
            this.viewCubeButtonByFace[faceKey] = buttonElement;
            return buttonElement;
        };

        gridElement.appendChild(createFaceButton('front', 'F', 'Front (+Y)'));
        gridElement.appendChild(createFaceButton('back', 'B', 'Back (-Y)'));
        gridElement.appendChild(createFaceButton('left', 'L', 'Left (-X)'));
        gridElement.appendChild(createFaceButton('right', 'R', 'Right (+X)'));
        gridElement.appendChild(createFaceButton('top', 'T', 'Top (+Z)'));
        gridElement.appendChild(createFaceButton('bottom', 'D', 'Down (-Z)'));

        panelElement.appendChild(gridElement);

        this.container.appendChild(panelElement);
        this.viewCubeOverlayElement = panelElement;
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

            // Invert angle so dragging the cube feels like rotating the view around the model.
            const rotation = new THREE.Quaternion().setFromAxisAngle(axisWorld, -angle);
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

        const directionByFace = {
            front: new THREE.Vector3(0, 1, 0),
            back: new THREE.Vector3(0, -1, 0),
            left: new THREE.Vector3(-1, 0, 0),
            right: new THREE.Vector3(1, 0, 0),
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

        const targetDirection = directionByFace[faceKey];
        if (!targetDirection) {
            return;
        }

        const target = this.controls.target.clone();
        const currentDistance = this.camera.position.distanceTo(target);
        const cameraDistance = Number.isFinite(currentDistance) && currentDistance > 0.001
            ? currentDistance
            : 3;

        const nextPosition = target.clone().add(targetDirection.clone().multiplyScalar(cameraDistance));
        const cameraUp = upByFace[faceKey] || upByFace.front;
        this.animateCameraToPose(nextPosition, cameraUp, 220);
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
        if (absY >= absX && absY >= absZ) {
            activeFaceKey = direction.y >= 0 ? 'front' : 'back';
        } else if (absX >= absY && absX >= absZ) {
            activeFaceKey = direction.x >= 0 ? 'right' : 'left';
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

    setupCameraAngleLogging() {
        if (this.cameraPosTextElement && this.cameraPosTextElement.length > 0) {
            this.cameraPosTextElement.attr('title', 'Click to copy cameraPose');
            this.cameraPosTextElement.off('click').on('click', () => {
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

        this.copyTextToClipboard(textToCopy)
            .then(() => {
                this.showCameraToastMessage('카메라 위치가 클립보드에 복사되었습니다.');
            })
            .catch(() => {
                this.showCameraToastMessage('카메라 위치 복사에 실패했습니다.');
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
            valueElement.text(`${this.getSignedWheelRpm(key)} rpm`);
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
            valueElement.text(`${this.getSignedWheelRpm(key)} rpm`);
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
                        console.log('[URDF] cameraPosition 지정됨: 사용자 카메라 위치 유지');
                    } else {
                        const fitDistance = this.calculateFitDistance(radius, this.cameraFitMarginRatio);
                        this.setCameraFromPosition(center, fitDistance);
                        console.log('[URDF] cameraPosition 미지정: 자동 피팅 카메라 적용 (마진 5%)');
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
            const newWidth = newRect.width;
            const newHeight = newRect.height;
            
            this.camera.aspect = newWidth / newHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(newWidth, newHeight);
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
    } catch (error) {
        console.warn('[URDF][Audio] speechSynthesis resume failed:', error);
    }

    // 브라우저 자동재생 정책 때문에 실제 활성화는 사용자 제스처에서만 확정한다.
    if (trigger !== 'gesture') {
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
    } catch (error) {
        console.warn('[URDF][Audio] speechSynthesis resume before queue speak failed:', error);
    }

    const utterance = new window.SpeechSynthesisUtterance(nextMessage);
    utterance.lang = 'ko-KR';
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
    window.speechSynthesis.speak(utterance);
}

function speakVehicleStatus(text, options = {}) {
    if (!isVehicleAudioEnabled() || !canUseSpeechSynthesis()) {
        return;
    }

    const message = String(text || '').trim();
    if (!message) {
        return;
    }

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
        vehicleAudioState.pendingMessage = message;
        vehicleAudioState.pendingOptions = options;
        setupVehicleAudioActivationListener();
        return;
    }

    const globalSpeechState = window.__wcsGlobalSpeechState || { message: '', at: 0 };
    if (globalSpeechState.message === message && (now - globalSpeechState.at) < 1200) {
        return;
    }
    window.__wcsGlobalSpeechState = { message: message, at: now };

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
        1: '단차',
        2: '포트홀',
        3: '빙판길'
    };

    // 첫 수신 장애물 상태는 기준만 설정하고 음성은 출력하지 않는다.
    if (!vehicleAudioState.baselineSeen.obstacle) {
        vehicleAudioState.baselineSeen.obstacle = true;
        vehicleAudioState.lastObstacle = (numericObstacle === 0) ? null : numericObstacle;
        return;
    }

    // 장애물 없음(0)이 들어오면 다음 검출 알림을 위해 상태만 초기화한다.
    if (numericObstacle === 0) {
        vehicleAudioState.lastObstacle = null;
        return;
    }

    const obstacleLabel = obstacleLabelByValue[numericObstacle];
    if (!obstacleLabel) {
        return;
    }

    if (vehicleAudioState.lastObstacle === numericObstacle) {
        return;
    }

    vehicleAudioState.lastObstacle = numericObstacle;
    speakVehicleStatus(`장애물 ${obstacleLabel} 검출`, { interrupt: true });
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
    if (storageEnabled == null) {
        const viewer = getRoadAttitudeTargetViewer();
        if (viewer) {
            setVehicleAudioEnabled(viewer.showAudio === true);
        }
    }

    console.log("[URDF] 🚀 모든 URDF Viewer 초기화 완료");
}

// DOM 준비 후 초기화
$(initURDFViewers);