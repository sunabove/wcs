import * as THREE from 'three';

const RAPIER_CDN = 'https://cdn.skypack.dev/@dimforge/rapier3d-compat@0.11.2';
const SIM_SPEED_STORAGE_KEY = 'wcs.simulation.driveSpeedKmh';
const SIM_SPEED_DEFAULT_KMH = 20;

class RapierDriveSimulation {
    constructor() {
        this.viewer = null;
        this.rapier = null;
        this.world = null;
        this.body = null;
        this.carFrame = null;
        this.initialPosition = null;
        this.initialQuaternion = null;
        this.vehicleHalfExtents = null;
        this.groundZ = 0;
        this.urdfObstacleLinkNames = ['obstacle_rock_01', 'obstacle_rock', 'rock_obstacle'];
        this.passUnderObstacleNamePatterns = [/^obstacle_rock/i, /pass_under/i, /underbody/i];
        this.maxSpeedMps = 100 / 3.6;
        this.maxYawRateRad = THREE.MathUtils.degToRad(80);
        this.isInitializing = false;
        this.isReady = false;
        this.hasFailed = false;
        this.lastStepTimeMs = 0;
        this.isKeyboardControlEnabled = true;
        this.keyState = {
            ArrowUp: false,
            ArrowDown: false,
            ArrowLeft: false,
            ArrowRight: false
        };
    }

    findSimulationViewer() {
        const viewerById = window.urdfViewersById?.['robot-container-1'] || null;
        if (viewerById) {
            return viewerById;
        }

        if (Array.isArray(window.urdfViewers)) {
            const matched = window.urdfViewers.find((viewer) => {
                const urdfPath = String(viewer?.urdfPath || '');
                return urdfPath.includes('/vehicle/vehicle.urdf');
            });

            if (matched) {
                return matched;
            }
        }

        return window.activeURDFViewer || null;
    }

    extractYawFromQuaternion(quaternion) {
        return Math.atan2(
            2 * (quaternion.w * quaternion.z + quaternion.x * quaternion.y),
            1 - 2 * (quaternion.y * quaternion.y + quaternion.z * quaternion.z)
        );
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

    computeChassisBounds(carFrame, linkMap) {
        const fallbackBounds = new THREE.Box3().setFromObject(carFrame);
        if (!carFrame || !linkMap) {
            return fallbackBounds;
        }

        const excludedRoots = [
            linkMap.wheel_fl,
            linkMap.wheel_fr,
            linkMap.wheel_rl,
            linkMap.wheel_rr,
            linkMap.pinion_fl,
            linkMap.pinion_fr,
            linkMap.pinion_rl,
            linkMap.pinion_rr,
            linkMap.obstacle_rock_01,
            linkMap.obstacle_rock,
            linkMap.rock_obstacle
        ].filter(Boolean);

        const bounds = new THREE.Box3();
        let hasMesh = false;

        carFrame.updateWorldMatrix(true, true);

        carFrame.traverse((node) => {
            if (!node || !node.isMesh || !node.geometry) {
                return;
            }

            const isExcluded = excludedRoots.some((root) => node === root || this.isDescendantObject3D(node, root));
            if (isExcluded) {
                return;
            }

            if (!node.geometry.boundingBox) {
                node.geometry.computeBoundingBox();
            }

            if (!node.geometry.boundingBox) {
                return;
            }

            const meshBounds = node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld);
            bounds.union(meshBounds);
            hasMesh = true;
        });

        return hasMesh ? bounds : fallbackBounds;
    }

    attachKeyboardControls() {
        if (!this.isKeyboardControlEnabled) {
            return;
        }

        const handledKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

        window.addEventListener('keydown', (event) => {
            if (!handledKeys.has(event.key)) {
                return;
            }

            this.keyState[event.key] = true;
            event.preventDefault();
        }, { passive: false });

        window.addEventListener('keyup', (event) => {
            if (!handledKeys.has(event.key)) {
                return;
            }

            this.keyState[event.key] = false;
            event.preventDefault();
        }, { passive: false });

        window.addEventListener('blur', () => {
            this.keyState.ArrowUp = false;
            this.keyState.ArrowDown = false;
            this.keyState.ArrowLeft = false;
            this.keyState.ArrowRight = false;
        });
    }

    getKeyboardDriveState() {
        const up = this.keyState.ArrowUp === true;
        const down = this.keyState.ArrowDown === true;
        const left = this.keyState.ArrowLeft === true;
        const right = this.keyState.ArrowRight === true;

        const throttleSign = (up ? 1 : 0) + (down ? -1 : 0);
        const steerSign = (left ? 1 : 0) + (right ? -1 : 0);
        const isActive = throttleSign !== 0 || steerSign !== 0;

        return {
            isActive,
            throttleSign: Math.max(-1, Math.min(1, throttleSign)),
            steerSign: Math.max(-1, Math.min(1, steerSign))
        };
    }

    initializeSpeedSliderPreference() {
        const speedSlider = document.getElementById('drive-speed-kmh');
        const speedLabel = document.getElementById('drive-speed-kmh-value');
        if (!speedSlider) {
            return;
        }

        const parseSpeed = (rawValue, fallbackValue) => {
            const numeric = Number.parseFloat(rawValue);
            if (!Number.isFinite(numeric)) {
                return fallbackValue;
            }
            return Math.max(0, Math.min(100, numeric));
        };

        let initialSpeed = SIM_SPEED_DEFAULT_KMH;
        try {
            const storedValue = window.localStorage.getItem(SIM_SPEED_STORAGE_KEY);
            if (storedValue != null) {
                initialSpeed = parseSpeed(storedValue, SIM_SPEED_DEFAULT_KMH);
            }
        } catch (error) {
            initialSpeed = SIM_SPEED_DEFAULT_KMH;
        }

        speedSlider.value = String(initialSpeed);
        if (speedLabel) {
            speedLabel.textContent = `${initialSpeed} km/h`;
        }

        if (typeof window.setDriveSpeedKmh === 'function') {
            window.setDriveSpeedKmh(initialSpeed);
        }

        const persistSpeed = () => {
            const normalizedSpeed = parseSpeed(speedSlider.value, SIM_SPEED_DEFAULT_KMH);
            try {
                window.localStorage.setItem(SIM_SPEED_STORAGE_KEY, String(normalizedSpeed));
            } catch (error) {
                // Ignore storage failures and continue runtime behavior.
            }
        };

        speedSlider.addEventListener('input', persistSpeed);
        speedSlider.addEventListener('change', persistSpeed);
    }

    addGroundCollider() {
        if (!this.world || !this.rapier || !this.initialPosition || !this.vehicleHalfExtents) {
            return;
        }

        const groundHalfThickness = 0.2;
        const linkMap = this.viewer?.robotModel?.links || {};
        const groundLink = linkMap.ground || linkMap.ground_link || linkMap.ground_patch || null;

        if (groundLink) {
            groundLink.updateWorldMatrix(true, true);
            const groundWorldPos = new THREE.Vector3();
            groundLink.getWorldPosition(groundWorldPos);
            this.groundZ = groundWorldPos.z;
        } else {
            this.groundZ = this.initialPosition.z - this.vehicleHalfExtents.z - 0.01;
        }

        const groundCenterZ = this.groundZ - groundHalfThickness;
        const groundBodyDesc = this.rapier.RigidBodyDesc.fixed().setTranslation(0, 0, groundCenterZ);
        const groundBody = this.world.createRigidBody(groundBodyDesc);
        const groundColliderDesc = this.rapier.ColliderDesc.cuboid(30, 30, groundHalfThickness)
            .setFriction(1.2)
            .setRestitution(0.02);
        this.world.createCollider(groundColliderDesc, groundBody);
    }

    addObstacleColliderFromUrdf() {
        if (!this.world || !this.rapier || !this.viewer?.robotModel || !this.carFrame) {
            return;
        }

        const linkMap = this.viewer.robotModel.links || {};
        const obstacleLinkName = this.urdfObstacleLinkNames.find((name) => !!linkMap[name]);
        if (!obstacleLinkName) {
            console.warn('[URDF][Simulation] URDF obstacle link not found. Expected one of:', this.urdfObstacleLinkNames);
            return;
        }

        const obstacleLink = linkMap[obstacleLinkName];
        obstacleLink.updateWorldMatrix(true, true);

        const bbox = new THREE.Box3().setFromObject(obstacleLink);
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
        const halfX = Math.max(size.x * 0.5, 0.02);
        const halfY = Math.max(size.y * 0.5, 0.02);
        const halfZ = Math.max(size.z * 0.5, 0.02);

        const chassisBounds = this.computeChassisBounds(this.carFrame, linkMap);
        const chassisBottomZ = chassisBounds.min.z;
        const obstacleTopZ = bbox.max.z;

        const leftWheel = linkMap.wheel_fl || linkMap.wheel_rl || null;
        const rightWheel = linkMap.wheel_fr || linkMap.wheel_rr || null;
        let wheelTrackWidth = 0;
        if (leftWheel && rightWheel) {
            const leftPos = new THREE.Vector3();
            const rightPos = new THREE.Vector3();
            leftWheel.getWorldPosition(leftPos);
            rightWheel.getWorldPosition(rightPos);
            wheelTrackWidth = Math.abs(leftPos.y - rightPos.y);
        }

        const isLowerThanChassisBottom = obstacleTopZ <= (chassisBottomZ - 0.005);
        const isNarrowerThanWheelTrack = wheelTrackWidth > 0
            ? size.y <= (wheelTrackWidth - 0.03)
            : false;
        const isPassUnderTagged = this.passUnderObstacleNamePatterns.some((pattern) => pattern.test(obstacleLinkName));
        const shouldPassUnderChassis = isPassUnderTagged || (isLowerThanChassisBottom && isNarrowerThanWheelTrack);

        const obstacleBodyDesc = this.rapier.RigidBodyDesc.fixed().setTranslation(
            center.x,
            center.y,
            center.z
        );
        const obstacleBody = this.world.createRigidBody(obstacleBodyDesc);
        const obstacleColliderDesc = this.rapier.ColliderDesc.cuboid(halfX, halfY, halfZ)
            .setFriction(1.4)
            .setRestitution(0.02);

        if (shouldPassUnderChassis && typeof obstacleColliderDesc.setSensor === 'function') {
            obstacleColliderDesc.setSensor(true);
            console.log('[URDF][Simulation] obstacle treated as pass-under sensor:', {
                obstacleLinkName,
                isPassUnderTagged,
                obstacleTopZ,
                chassisBottomZ,
                obstacleWidth: size.y,
                wheelTrackWidth
            });
        }

        this.world.createCollider(obstacleColliderDesc, obstacleBody);

        console.log(`[URDF][Simulation] obstacle collider created from URDF link: ${obstacleLinkName}`);
    }

    async ensureRapierInitialized() {
        if (this.isReady || this.isInitializing || this.hasFailed) {
            return;
        }

        if (!this.viewer?.robotModel) {
            return;
        }

        const linkMap = this.viewer.robotModel.links || {};
        const carFrame = linkMap.car_frame || linkMap.base_link || null;
        if (!carFrame) {
            return;
        }

        this.isInitializing = true;

        try {
            const rapierModule = await import(RAPIER_CDN);
            const RAPIER = rapierModule?.default || rapierModule;

            if (!RAPIER || typeof RAPIER.init !== 'function') {
                throw new Error('RAPIER init function not found');
            }

            await RAPIER.init();

            const world = new RAPIER.World(new RAPIER.Vector3(0, 0, -9.81));
            const initialPosition = carFrame.position.clone();
            const initialQuaternion = carFrame.quaternion.clone();

            const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
                .setTranslation(initialPosition.x, initialPosition.y, initialPosition.z)
                .setRotation(initialQuaternion)
                .setLinearDamping(2.2)
                .setAngularDamping(3.2);

            if (typeof rigidBodyDesc.setEnabledRotations === 'function') {
                rigidBodyDesc.setEnabledRotations(false, false, true);
            } else if (typeof rigidBodyDesc.enabledRotations === 'function') {
                rigidBodyDesc.enabledRotations(false, false, true);
            }

            const body = world.createRigidBody(rigidBodyDesc);

            const bbox = this.computeChassisBounds(carFrame, linkMap);
            const size = bbox.getSize(new THREE.Vector3());
            const worldCenter = bbox.getCenter(new THREE.Vector3());
            const localCenter = carFrame.worldToLocal(worldCenter.clone());
            const halfX = Math.max((size.x || 0.6) * 0.5, 0.12);
            const halfY = Math.max((size.y || 0.4) * 0.5, 0.10);
            const halfZ = Math.max((size.z || 0.25) * 0.5, 0.06);

            const colliderDesc = RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
                .setTranslation(localCenter.x, localCenter.y, localCenter.z)
                .setFriction(1.1)
                .setRestitution(0.04);
            world.createCollider(colliderDesc, body);

            this.rapier = RAPIER;
            this.world = world;
            this.body = body;
            this.carFrame = carFrame;
            this.initialPosition = initialPosition.clone();
            this.initialQuaternion = initialQuaternion.clone();
            this.vehicleHalfExtents = { x: halfX, y: halfY, z: halfZ };
            this.addGroundCollider();
            this.addObstacleColliderFromUrdf();
            this.isReady = true;
            this.hasFailed = false;

            console.log('[URDF][Simulation] Rapier direction control with URDF obstacle initialized');
        } catch (error) {
            this.hasFailed = true;
            console.warn('[URDF][Simulation] Rapier initialization failed:', error);
        } finally {
            this.isInitializing = false;
        }
    }

    stepSimulation() {
        if (!this.isReady) {
            return;
        }

        if (!this.viewer || !this.rapier || !this.world || !this.body || !this.carFrame) {
            return;
        }

        const now = performance.now();
        if (!this.lastStepTimeMs) {
            this.lastStepTimeMs = now;
        }

        const deltaSec = Math.min((now - this.lastStepTimeMs) / 1000, 0.1);
        this.lastStepTimeMs = now;

        const keyboardState = this.getKeyboardDriveState();

        let throttleSign = 0;
        let steerSign = 0;
        let driveSpeedKmh = Math.max(Number(this.viewer.driveSpeedKmh) || 0, 0);

        if (keyboardState.isActive) {
            throttleSign = keyboardState.throttleSign;
            steerSign = keyboardState.steerSign;
        } else {
            const driveMode = String(this.viewer.driveMode || 'stop');
            if (driveMode === 'forward') {
                throttleSign = 1;
            } else if (driveMode === 'backward') {
                throttleSign = -1;
            } else if (driveMode === 'left') {
                throttleSign = 0.65;
                steerSign = 1;
            } else if (driveMode === 'right') {
                throttleSign = 0.65;
                steerSign = -1;
            }
        }

        const speedMps = driveSpeedKmh / 3.6;
        const clampedSpeed = Math.min(speedMps, this.maxSpeedMps);

        const bodyRotation = this.body.rotation();
        const yaw = this.extractYawFromQuaternion(bodyRotation);
        const currentLinearVelocity = this.body.linvel();

        const velocityX = Math.cos(yaw) * clampedSpeed * throttleSign;
        const velocityY = Math.sin(yaw) * clampedSpeed * throttleSign;

        this.body.setLinvel(new this.rapier.Vector3(velocityX, velocityY, currentLinearVelocity.z), true);
        this.body.setAngvel(new this.rapier.Vector3(0, 0, this.maxYawRateRad * steerSign), true);

        this.world.timestep = Math.max(Math.min(deltaSec, 1 / 30), 1 / 240);
        this.world.step();

        const nextPosition = this.body.translation();
        const nextRotation = this.body.rotation();

        this.carFrame.position.set(nextPosition.x, nextPosition.y, nextPosition.z);
        this.carFrame.quaternion.set(nextRotation.x, nextRotation.y, nextRotation.z, nextRotation.w).normalize();
    }

    async runLoop() {
        if (!this.viewer) {
            this.viewer = this.findSimulationViewer();
        }

        if (this.viewer && !this.isReady && !this.hasFailed) {
            await this.ensureRapierInitialized();
        }

        this.stepSimulation();
        requestAnimationFrame(() => this.runLoop());
    }

    start() {
        this.initializeSpeedSliderPreference();
        this.attachKeyboardControls();
        requestAnimationFrame(() => this.runLoop());
    }

    resetUiStates() {
        if (typeof window.setDriveMode === 'function') {
            window.setDriveMode('stop');
        }

        if (typeof window.setRoadRollAngleDeg === 'function') {
            window.setRoadRollAngleDeg(0);
        }

        if (typeof window.setRoadPitchAngleDeg === 'function') {
            window.setRoadPitchAngleDeg(0);
        }

        const rollInput = document.getElementById('road-roll-angle-deg');
        if (rollInput) {
            rollInput.value = '0';
        }

        const pitchInput = document.getElementById('road-pitch-angle-deg');
        if (pitchInput) {
            pitchInput.value = '0';
        }

        const wheelKeys = ['fl', 'fr', 'rl', 'rr'];
        wheelKeys.forEach((key) => {
            if (typeof window.setWheelAnimationByKey === 'function') {
                window.setWheelAnimationByKey(key, 0);
            }
        });
    }

    resetPhysicalState() {
        if (!this.isReady || !this.body || !this.carFrame || !this.rapier || !this.initialPosition || !this.initialQuaternion) {
            return;
        }

        this.body.setTranslation(
            new this.rapier.Vector3(this.initialPosition.x, this.initialPosition.y, this.initialPosition.z),
            true
        );
        this.body.setRotation(this.initialQuaternion, true);
        this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
        this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);

        this.carFrame.position.copy(this.initialPosition);
        this.carFrame.quaternion.copy(this.initialQuaternion);
    }

    async reset() {
        this.resetUiStates();
        this.lastStepTimeMs = 0;

        if (!this.viewer) {
            this.viewer = this.findSimulationViewer();
        }

        if (this.viewer && !this.isReady && !this.hasFailed) {
            await this.ensureRapierInitialized();
        }

        this.resetPhysicalState();
    }
}

const rapierDriveSimulation = new RapierDriveSimulation();
rapierDriveSimulation.start();

globalThis.resetSimulation = function() {
    rapierDriveSimulation.reset();
};
