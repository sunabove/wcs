import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const $ = window.jQuery;

// 각 뷰어를 위한 클래스
class URDFViewer {
    constructor(containerElement) {
        this.container = containerElement;
        this.robotModel = null;
        this.directionalLight = null;
        this.goalTarget = new THREE.Vector3(0, 0, 0);
        this.isDragging = false;
        this.lastAngleLogAt = 0;
        this.angleLogIntervalMs = 120;
        this.cameraPosTextElement = null;
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
        this.roadRollAngleDeg = 0;
        this.roadPitchAngleDeg = 0;
        this.roadPatchLinkName = 'ground_patch';
        this.urdfPath = containerElement.getAttribute('urdf') || '/urdf/vehicle/vehicle.urdf';
        this.cameraPosition = this.parseCameraPosition(
            containerElement.getAttribute('cameraPosition') || '4,4,8'
        );
        
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
        this.setupWheelControls();

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

        const axesHelper = new THREE.AxesHelper(1);
        axesHelper.renderOrder = 999;
        if (Array.isArray(axesHelper.material)) {
            axesHelper.material.forEach(material => {
                material.depthTest = false;
                material.depthWrite = false;
            });
        } else if (axesHelper.material) {
            axesHelper.material.depthTest = false;
            axesHelper.material.depthWrite = false;
        }
        this.scene.add(axesHelper);

        this.addAxisLabels(1);

        // 마우스 이벤트 설정
        this.setupMouseEvents();

        // URDF 로드
        this.loadURDF();

        // 애니메이션 시작
        this.animate();

        // 리사이즈 이벤트 설정
        this.setupResizeHandler();
    }

    setupCameraAngleLogging() {
        this.controls.addEventListener('start', () => {
            this.isDragging = true;
        });

        this.controls.addEventListener('end', () => {
            this.isDragging = false;
            this.logCameraInfos(true);
        });

        this.controls.addEventListener('change', () => {
            this.logCameraInfos(false);
        });
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
        const normalizedRpm = Number.isFinite(numericRpm) ? Math.max(Math.round(numericRpm), 0) : this.wheelSpeedRpmByKey[key];

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
            this.setWheelSpeedRpm('fl', baseRpm);
            this.setWheelSpeedRpm('fr', baseRpm);
            this.setWheelSpeedRpm('rl', baseRpm);
            this.setWheelSpeedRpm('rr', baseRpm);
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
                runtimeTarget.ref.rotation.y = this.wheelAngles[key];
            }
        });
    }

    applyRoadAttitudeAngles() {
        if (!this.robotModel || !this.robotModel.links) {
            return;
        }

        const groundLink = this.robotModel.links[this.roadPatchLinkName] || null;
        if (!groundLink) {
            return;
        }

        // 차량의 roll/pitch를 함께 표현하기 위해 x/y축 회전을 사용
        groundLink.rotation.set(
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
        const positionText = `(${px}, ${py}, ${pz})`;

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

    resetDirectionalLight(center, radius) {
        if (!this.directionalLight) {
            return;
        }

        const safeRadius = Math.max(radius, 0.001);
        this.directionalLight.position.set(
            center.x + safeRadius * 1.6,
            center.y + safeRadius * 1.2,
            center.z + safeRadius * 2.0
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
        canvas.width = 128;
        canvas.height = 128;

        const context = canvas.getContext('2d');
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.font = 'bold 76px Arial';
        context.fillStyle = colorHex;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, 64, 64);

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

        return sprite;
    }

    addAxisLabels(axisLength) {
        const margin = 0.14;
        const xLabel = this.createAxisLabel('X', '#ff3333', new THREE.Vector3(axisLength + margin, 0, 0));
        const yLabel = this.createAxisLabel('Y', '#22aa22', new THREE.Vector3(0, axisLength + margin, 0));
        const zLabel = this.createAxisLabel('Z', '#3366ff', new THREE.Vector3(0, 0, axisLength + margin));

        this.scene.add(xLabel);
        this.scene.add(yLabel);
        this.scene.add(zLabel);
    }

    setupMouseEvents() {
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();

        this.container.addEventListener('mousedown', (event) => {
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
                this.applyRoadAttitudeAngles();

                // 자동 피팅 로직
                setTimeout(() => {
                    const bbox = new THREE.Box3().setFromObject(robot);
                    const center = bbox.getCenter(new THREE.Vector3());
                    const sphere = bbox.getBoundingSphere(new THREE.Sphere());
                    const radius = Math.max(sphere.radius, 0.001);

                    console.log('[URDF] 📏 모델 반경:', radius);
                    console.log('[URDF] 📍 모델 중심:', center);

                    this.resetDirectionalLight(center, radius);

                    // cameraPosition으로 설정된 초기 카메라 위치를 유지하고
                    // 클리핑 범위만 현재 카메라-모델 중심 거리 기준으로 업데이트
                    const currentCameraDist = Math.max(this.camera.position.distanceTo(center), 0.01);
                    this.camera.near = Math.max(currentCameraDist / 100, 0.01);
                    this.camera.far = Math.max(currentCameraDist * 100, 10);
                    this.camera.updateProjectionMatrix();

                    // 회전 중심 업데이트
                    this.goalTarget.copy(center);
                    this.controls.target.copy(center);
                    this.controls.minDistance = currentCameraDist * 0.2;
                    this.controls.maxDistance = currentCameraDist * 8;
                    this.controls.update();
                    this.logCameraInfos(true);

                    console.log('[URDF] ✅ 카메라 위치 유지(cameraPosition) 및 컨트롤 범위 갱신 완료');
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
    if (!window.activeURDFViewer) {
        return;
    }

    window.activeURDFViewer.setWheelSpeedRpm(key, rpm);
}

globalThis.setWheelAnimationByKey = setWheelAnimationByKey;

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
        
        window.activeURDFViewer = new URDFViewer(container);
    });

    setDriveSpeedKmh($('#drive-speed-kmh').val());
    setRoadRollAngleDeg($('#road-roll-angle-deg').val());
    setRoadPitchAngleDeg($('#road-pitch-angle-deg').val());
    updateDriveModeButtons(null);

    console.log("[URDF] 🚀 모든 URDF Viewer 초기화 완료");
}

// DOM 준비 후 초기화
$(initURDFViewers);