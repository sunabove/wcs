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
        this.urdfPath = containerElement.getAttribute('urdf') || '/urdf/wheel_3/urdf/wheel.urdf';
        this.urdfScale = parseFloat(containerElement.getAttribute('urdf-scale')) || 1;
        this.urdfRotation = (containerElement.getAttribute('urdf-rotation') || (this.urdfPath.includes('/vehicle/') ? '90,0,0' : '0,0,0'))
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
        this.camera.position.set(3*2, 3*2, 3*2);

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

        // 조명 설정
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
        directionalLight.position.set(5, 5, 5);
        directionalLight.castShadow = true;
        this.scene.add(directionalLight);

        const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
        this.scene.add(ambientLight);

        // 바닥 그리드와 축 추가
        const gridHelper = new THREE.GridHelper(10, 20, 0x888888, 0xcccccc);
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

        // 마우스 이벤트 설정
        this.setupMouseEvents();

        // URDF 로드
        this.loadURDF();

        // 애니메이션 시작
        this.animate();

        // 리사이즈 이벤트 설정
        this.setupResizeHandler();
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

                    // 카메라 위치 자동 조정 - 모델 전체가 프레임 안에 들어오도록 설정
                    const fitOffset = 1.8;
                    const cameraDist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov * 0.5)) * fitOffset;

                    this.camera.position.set(
                        center.x + cameraDist * 0.0,
                        center.y + cameraDist * 0.9,
                        center.z + cameraDist * 1.1
                    );
                    this.camera.near = Math.max(cameraDist / 100, 0.01);
                    this.camera.far = cameraDist * 100;
                    this.camera.updateProjectionMatrix();
                    this.camera.lookAt(center);

                    // 회전 중심 업데이트
                    this.goalTarget.copy(center);
                    this.controls.target.copy(center);
                    this.controls.minDistance = cameraDist * 0.2;
                    this.controls.maxDistance = cameraDist * 8;
                    this.controls.update();

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
        requestAnimationFrame(() => this.animate());
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}

// 초기화 함수
function initURDFViewers() {
    console.log("[URDF] 🚀 URDF Viewer 초기화 시작...");
    
    // robot-container 클래스를 가진 모든 요소들 찾기
    const containers = document.querySelectorAll('.urdf-container');
    
    if (containers.length === 0) {
        console.error("[URDF] ❌ urdf-container 클래스를 가진 요소를 찾을 수 없습니다.");
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