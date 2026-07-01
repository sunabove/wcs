import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// 각 뷰어를 위한 클래스
class URDFViewer {
    constructor(containerElement, viewLabel, viewIndex) {
        this.container = containerElement;
        this.viewLabel = viewLabel;
        this.viewIndex = viewIndex;
        this.robotModel = null;
        this.goalTarget = new THREE.Vector3(0, 0, 0);
        this.isDragging = false;
        this.lastAngleLogAt = 0;
        this.angleLogIntervalMs = 120;
        this.cameraAngleTextElement = null;
        this.initialAzimuthDeg = 0.7;
        this.initialPolarDeg = 145.4;
        this.lastFrameTimeMs = performance.now();
        this.wheelAngularSpeedRad = 4.0;
        this.wheelJointNameByKey = {
            fl: 'joint_fl',
            fr: 'joint_fr',
            rl: 'joint_rl',
            rr: 'joint_rr'
        };
        this.wheelAngles = {
            fl: 0,
            fr: 0,
            rl: 0,
            rr: 0
        };
        this.wheelAnimationEnabled = {
            fl: false,
            fr: false,
            rl: false,
            rr: false
        };
        this.wheelButtonByKey = {};
        this.urdfPath = containerElement.getAttribute('urdf') || '/urdf/vehicle/vehicle.urdf';
        this.urdfScale = parseFloat(containerElement.getAttribute('urdf-scale')) || 1;
        this.urdfRotation = (containerElement.getAttribute('urdf-rotation') || '0,0,0')
            .split(',')
            .map(value => parseFloat(value) * Math.PI / 180);
        
        this.init();
    }

    init() {
        // 동적 크기 계산
        const containerRect = this.container.getBoundingClientRect();
        const width = containerRect.width;
        const height = containerRect.height;
        
        console.log(`${this.viewLabel} 컨테이너 크기: ${width}x${height}`);

        // Scene 생성
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xf8f8f8);

        // Camera 생성
        this.camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000);
        this.camera.position.set(4, 4, 8);

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
        this.cameraAngleTextElement = document.getElementById('camera-angle-text');
        this.setupCameraAngleLogging();
        this.setupWheelControls();

        // 조명 설정
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
        directionalLight.position.set(5, 5, 5);
        directionalLight.castShadow = true;
        this.scene.add(directionalLight);

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
            this.logCameraAngles(true);
        });

        this.controls.addEventListener('change', () => {
            this.logCameraAngles(false);
        });
    }

    setupWheelControls() {
        const buttonIdByKey = {
            fl: 'wheel-btn-fl',
            fr: 'wheel-btn-fr',
            rl: 'wheel-btn-rl',
            rr: 'wheel-btn-rr'
        };

        Object.keys(buttonIdByKey).forEach(key => {
            const button = document.getElementById(buttonIdByKey[key]);
            if (!button) {
                return;
            }

            this.wheelButtonByKey[key] = button;
            button.addEventListener('click', () => {
                this.toggleWheelAnimation(key);
            });
            this.updateWheelButtonState(key);
        });
    }

    toggleWheelAnimation(key) {
        if (!(key in this.wheelAnimationEnabled)) {
            return;
        }

        this.wheelAnimationEnabled[key] = !this.wheelAnimationEnabled[key];
        this.updateWheelButtonState(key);
    }

    updateWheelButtonState(key) {
        const button = this.wheelButtonByKey[key];
        if (!button) {
            return;
        }

        const wheelLabel = key.toUpperCase();
        const isEnabled = this.wheelAnimationEnabled[key];
        button.textContent = `${wheelLabel} Wheel: ${isEnabled ? 'ON' : 'OFF'}`;
        button.classList.toggle('btn-outline-primary', !isEnabled);
        button.classList.toggle('btn-primary', isEnabled);
    }

    applyWheelAnimation(deltaSec) {
        if (!this.robotModel || !this.robotModel.joints) {
            return;
        }

        Object.keys(this.wheelAnimationEnabled).forEach(key => {
            if (!this.wheelAnimationEnabled[key]) {
                return;
            }

            const jointName = this.wheelJointNameByKey[key];
            const joint = this.robotModel.joints[jointName];
            if (!joint || typeof joint.setJointValue !== 'function') {
                return;
            }

            this.wheelAngles[key] += this.wheelAngularSpeedRad * deltaSec;
            joint.setJointValue(this.wheelAngles[key]);
        });
    }

    logCameraAngles(force) {
        const now = performance.now();
        if (!force && now - this.lastAngleLogAt < this.angleLogIntervalMs) {
            return;
        }
        this.lastAngleLogAt = now;

        const azimuthDeg = THREE.MathUtils.radToDeg(this.controls.getAzimuthalAngle());
        const polarDeg = THREE.MathUtils.radToDeg(this.controls.getPolarAngle());
        const distance = this.camera.position.distanceTo(this.controls.target);
        const angleText = `azimuth: ${azimuthDeg.toFixed(1)}°, polar: ${polarDeg.toFixed(1)}°`;
        const distanceText = `distance: ${distance.toFixed(3)}`;

        console.log(
            `[URDF] ${this.viewLabel} 카메라 정보 - ${angleText}, ${distanceText}`
        );

        if (this.cameraAngleTextElement) {
            this.cameraAngleTextElement.textContent = `${this.viewLabel}: ${angleText} | ${distanceText}`;
        }
    }

    setCameraFromAngles(center, distance, azimuthDeg, polarDeg) {
        const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
        const polar = THREE.MathUtils.degToRad(polarDeg);

        const sinPolar = Math.sin(polar);
        const x = center.x + distance * sinPolar * Math.sin(azimuth);
        const y = center.y + distance * Math.cos(polar);
        const z = center.z + distance * sinPolar * Math.cos(azimuth);

        this.camera.position.set(x, y, z);
        this.camera.lookAt(center);
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
                    console.log(`[URDF] ${this.viewLabel} 목표 지점 설정:`, this.goalTarget);
                }
            }
        });
    }

    loadURDF() {
        const loader = new URDFLoader();
        
        console.log(`${this.viewLabel} URDF 파일 로딩 중... (${this.urdfPath})`);

        loader.load(
            this.urdfPath,

            robot => {
                console.log(`[URDF] ✅ ${this.viewLabel} URDF 로드 성공`);

                // 스케일링 (단위 변환)
                robot.scale.set(this.urdfScale, this.urdfScale, this.urdfScale);
                robot.rotation.set(this.urdfRotation[0], this.urdfRotation[1], this.urdfRotation[2]);

                this.scene.add(robot);
                this.robotModel = robot;

                // 자동 피팅 로직
                setTimeout(() => {
                    const bbox = new THREE.Box3().setFromObject(robot);
                    const center = bbox.getCenter(new THREE.Vector3());
                    const sphere = bbox.getBoundingSphere(new THREE.Sphere());
                    const radius = Math.max(sphere.radius, 0.001);

                    console.log(`[URDF] 📏 ${this.viewLabel} 모델 반경:`, radius);
                    console.log(`[URDF] 📍 ${this.viewLabel} 모델 중심:`, center);

                    // 카메라 위치 자동 조정 - 모델 전체가 화면에 보이도록 설정
                    const verticalHalfFov = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
                    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * this.camera.aspect);
                    const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
                    const fitOffset = 1.05;
                    const cameraDist = (radius / Math.sin(limitingHalfFov)) * fitOffset;

                    this.setCameraFromAngles(center, cameraDist, this.initialAzimuthDeg, this.initialPolarDeg);
                    this.camera.near = Math.max(cameraDist / 100, 0.01);
                    this.camera.far = cameraDist * 100;
                    this.camera.updateProjectionMatrix();

                    // 회전 중심 업데이트
                    this.goalTarget.copy(center);
                    this.controls.target.copy(center);
                    this.controls.minDistance = cameraDist * 0.2;
                    this.controls.maxDistance = cameraDist * 8;
                    this.controls.update();
                    this.logCameraAngles(true);

                    console.log(`[URDF] ✅ ${this.viewLabel} 자동 피팅 완료: 거리`, cameraDist.toFixed(4));
                }, 200);
            },
            progress => {
                if (progress?.total) {
                    const percent = ((progress.loaded / progress.total) * 100).toFixed(1);
                    console.log(`[URDF] ${this.viewLabel} URDF 로딩 진행률: ${percent}%`);
                }
            },
            error => {
                console.error(`[URDF] ❌ ${this.viewLabel} URDF 로드 실패:`, error);
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
            
            console.log(`[URDF] ${this.viewLabel} 리사이즈: ${newWidth}x${newHeight}`);
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

// 초기화 함수
function initURDFViewers() {
    console.log("[URDF] 🚀 URDF Viewer 초기화 시작...");
    
    // robot-container 클래스를 가진 모든 요소들 찾기
    const containers = document.querySelectorAll('.urdf-container, .robot-container');
    
    if (containers.length === 0) {
        console.error("[URDF] ❌ urdf-container 또는 robot-container 클래스를 가진 요소를 찾을 수 없습니다.");
        return;
    }
    
    console.log(`[URDF] 📦 ${containers.length}개의 urdf-container 발견`);
    
    // 각 컨테이너에 대해 URDFViewer 생성 (viewIndex는 1부터 시작)
    containers.forEach((container, index) => {
        var viewIndex = index + 1; // 1부터 시작
        viewIndex = 3 ; 
        const containerClass = container.className;
        const viewLabel = `View ${viewIndex}`;
        
        // 컨테이너 내부의 기존 HTML 요소들 모두 삭제
        container.innerHTML = '';
        
        console.log(`[URDF] 🔧 ${containerClass} 요소 초기화 중... (ViewIndex: ${viewIndex})`);
        
        const viewer = new URDFViewer(container, viewLabel, viewIndex);
    });

    console.log("[URDF] 🚀 모든 URDF Viewer 초기화 완료");
}

// DOM 준비 후 초기화
document.addEventListener('DOMContentLoaded', initURDFViewers);