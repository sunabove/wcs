import * as THREE from 'three';

const RAPIER_CDN = 'https://cdn.skypack.dev/@dimforge/rapier3d-compat@0.11.2';

class RapierDriveSimulation {
    constructor() {
        this.viewer = null;
        this.rapier = null;
        this.world = null;
        this.body = null;
        this.carFrame = null;
        this.fixedLocalZ = 0;
        this.initialPosition = null;
        this.initialQuaternion = null;
        this.maxSpeedMps = 3.5;
        this.maxYawRateRad = THREE.MathUtils.degToRad(80);
        this.isInitializing = false;
        this.isReady = false;
        this.hasFailed = false;
        this.lastStepTimeMs = 0;
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

    async ensureRapierInitialized() {
        if (this.isReady || this.isInitializing || this.hasFailed) {
            return;
        }

        if (!this.viewer?.robotModel) {
            return;
        }

        const linkMap = this.viewer.robotModel.links || {};
        const carFrame = linkMap.car_frame || null;
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

            const world = new RAPIER.World(new RAPIER.Vector3(0, 0, 0));
            const initialPosition = carFrame.position.clone();
            const initialQuaternion = carFrame.quaternion.clone();

            const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
                .setTranslation(initialPosition.x, initialPosition.y, initialPosition.z)
                .setRotation(initialQuaternion)
                .setLinearDamping(8.0)
                .setAngularDamping(10.0);

            const body = world.createRigidBody(rigidBodyDesc);

            const bbox = new THREE.Box3().setFromObject(carFrame);
            const size = bbox.getSize(new THREE.Vector3());
            const halfX = Math.max((size.x || 0.6) * 0.5, 0.12);
            const halfY = Math.max((size.y || 0.4) * 0.5, 0.10);
            const halfZ = Math.max((size.z || 0.25) * 0.5, 0.06);

            const colliderDesc = RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ).setRestitution(0.05);
            world.createCollider(colliderDesc, body);

            this.rapier = RAPIER;
            this.world = world;
            this.body = body;
            this.carFrame = carFrame;
            this.fixedLocalZ = initialPosition.z;
            this.initialPosition = initialPosition.clone();
            this.initialQuaternion = initialQuaternion.clone();
            this.isReady = true;
            this.hasFailed = false;

            console.log('[URDF][Simulation] Rapier direction control initialized');
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

        const driveMode = String(this.viewer.driveMode || 'stop');
        const speedMps = Math.max(Number(this.viewer.driveSpeedKmh) || 0, 0) / 3.6;
        const clampedSpeed = Math.min(speedMps, this.maxSpeedMps);

        let throttleSign = 0;
        let steerSign = 0;

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

        const bodyRotation = this.body.rotation();
        const yaw = this.extractYawFromQuaternion(bodyRotation);

        const velocityX = Math.cos(yaw) * clampedSpeed * throttleSign;
        const velocityY = Math.sin(yaw) * clampedSpeed * throttleSign;

        this.body.setLinvel(new this.rapier.Vector3(velocityX, velocityY, 0), true);
        this.body.setAngvel(new this.rapier.Vector3(0, 0, this.maxYawRateRad * steerSign), true);

        this.world.timestep = Math.max(Math.min(deltaSec, 1 / 30), 1 / 240);
        this.world.step();

        const nextPosition = this.body.translation();
        const nextRotation = this.body.rotation();

        this.carFrame.position.set(nextPosition.x, nextPosition.y, this.fixedLocalZ);
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
        requestAnimationFrame(() => this.runLoop());
    }

    resetUiStates() {
        if (typeof window.setDriveMode === 'function') {
            window.setDriveMode('stop');
        }

        if (typeof window.setDriveSpeedKmh === 'function') {
            window.setDriveSpeedKmh(0);
        }

        const speedSlider = document.getElementById('drive-speed-kmh');
        if (speedSlider) {
            speedSlider.value = '0';
        }

        const speedLabel = document.getElementById('drive-speed-kmh-value');
        if (speedLabel) {
            speedLabel.textContent = '0 km/h';
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
