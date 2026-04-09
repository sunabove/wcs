import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

const container = document.getElementById('robot-container');

let robotModel = null;
let goalTarget = new THREE.Vector3(0, 0, 0); // 이 줄을 추가하세요!

// 1. 렌더러 크기를 컨테이너(500x500)에 맞게 고정
const width = 500;
const height = 500;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
camera.position.set(3, 3, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(width, height); // 기존 window.innerWidth/2 대신 고정 크기 사용
container.appendChild(renderer.domElement);

// 2. OrbitControls 설정 및 관성 추가
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; // 부드러운 회전 효과
controls.dampingFactor = 0.05;

// 3. 조명 설정
const light = new THREE.DirectionalLight(0xffffff, 1.5);
light.position.set(1, 1, 1);
scene.add(light, new THREE.AmbientLight(0x404040));

// --- Raycaster 설정 (마우스 위치 감지용) ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// 마우스가 이동할 때마다 좌표 업데이트
container.addEventListener('mousedown', (event) => {
	const rect = container.getBoundingClientRect();
	mouse.x = ((event.clientX - rect.left) / width) * 2 - 1;
	mouse.y = -((event.clientY - rect.top) / height) * 2 + 1;

	raycaster.setFromCamera(mouse, camera);

	// 로봇 모델만 검사하도록 필터링하여 정확도 향상
	if (robotModel) {
		const intersects = raycaster.intersectObject(robotModel, true);

		if (intersects.length > 0) {
			// 즉시 대입하지 않고 목표 지점만 설정
			goalTarget.copy(intersects[0].point);
			console.log("목표 지점 변경:", goalTarget);
		}
	}
});

let nextTarget = new THREE.Vector3(0, 0, 0);
// 휠을 굴릴 때 마우스 위치를 기준으로 확대하고 싶다면 아래 주석 해제
// container.addEventListener('wheel', updatePivot, { passive: true });

// --- URDF 로드 ---
const loader = new URDFLoader();
loader.load("wheel_3/urdf/wheel.urdf", robot => {
    // 1. 단위를 mm에서 m로 강제 변환 (1000배 확대)
    // SolidWorks에서 온 파일이 너무 작을 때 가장 확실한 방법입니다.
    robot.scale.set(1000, 1000, 1000); 

    scene.add(robot);
    robotModel = robot;

    // 2. 모델이 메모리에 완전히 올라오도록 약간의 지연(Timeout)을 줍니다.
    setTimeout(() => {
        const bbox = new THREE.Box3().setFromObject(robot);
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);

        console.log("📏 실제 측정된 크기:", size);
        console.log("📍 실제 측정된 중심:", center);

        // 3. 카메라 거리를 모델 크기에 바짝 붙입니다. (배율을 2.0으로 하향)
        const cameraDist = maxDim === 0 ? 2 : maxDim * 0.6; 
        
        camera.position.set(
            center.x + cameraDist, 
            center.y + cameraDist, 
            center.z + cameraDist
        );
        camera.lookAt(center);

        // 4. 회전 중심(Target) 업데이트
        goalTarget.copy(center);
        controls.target.copy(center); 
        controls.update();

        console.log("✅ 자동 피팅 완료: 거리", cameraDist.toFixed(4));
    }, 200); // 0.2초 대기
});

// --- WebSocket 설정 ---
const socket = new WebSocket('ws://' + window.location.hostname + ':8080');
socket.onmessage = (event) => {
    // 1. 데이터 파싱
    const angle = parseFloat(event.data);
    
    // 데이터가 잘 들어오는지 콘솔에서 먼저 확인 (F12 누르면 보임)
    // console.log("받은 값:", angle); 

    if (robotModel) {
        // 2. 기둥 회전 (Joint 사용)
        //const rotateJoint = robotModel.joints['base_link_to_base_par'];
        const rotateJoint = robotModel.joints['base_to_empty_link'];
        if (rotateJoint) {
            rotateJoint.setJointValue(angle);
        }
/*
        // 3. 라이다 길이 조절 (Link의 Scale 사용)
        const laserLink = robotModel.links['front_laser_link'];
        if (laserLink) {
            // 변수 이름을 'angle'로 수정했습니다! 
            // Math.abs(angle)을 사용하여 값이 -3.14여도 길이는 양수로 늘어나게 합니다.
            const lengthFactor = 1 + Math.abs(angle); 

            // Three.js의 스케일 조절 (Z축이 기둥 방향)
            laserLink.scale.set(1, 1, lengthFactor);

            // 한쪽 방향으로만 늘어나 보이게 위치 보정
            // 기둥 원래 높이가 0.085이므로 그 절반을 기준으로 계산
            laserLink.position.z = (lengthFactor - 1) * (0.085 / 2);
            
            // 이 로그가 콘솔에 찍히면 성공입니다!
            console.log("📏 라이다 길이 배율 업데이트:", lengthFactor.toFixed(2));
        } else {
            console.warn("⚠️ 'front_laser_link'를 찾을 수 없습니다.");
        }
	*/
    }
};


// --- 애니메이션 루프 ---
function animate() {
	requestAnimationFrame(animate);
	// controls.target을 goalTarget으로 부드럽게 이동 (0.1은 속도, 0~1 사이 조절 가능)
	controls.target.lerp(goalTarget, 0.1); 
	// 중요: enableDamping이나 target 변경을 반영하려면 매 프레임 update 호출 필요
	controls.update(); 

	renderer.render(scene, camera);
}
animate();
