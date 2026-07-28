import * as THREE from 'three';

const RAPIER_CDN = 'https://cdn.skypack.dev/@dimforge/rapier3d-compat@0.11.2';
const SIM_SPEED_STORAGE_KEY = 'wcs.simulation.driveSpeedKmh';
const SIM_SPEED_DEFAULT_KMH = 10;
const SIM_SPEED_MAX_KMH = 20;

class RapierDriveSimulation {
    constructor() {
        this.viewer = null;
        this.rapier = null;
        this.world = null;
        this.body = null;
        this.vehicleCollider = null;
        this.vehicleColliders = [];
        this.obstacleColliders = [];
        this.isVehicleObstacleContact = false;
        this.carFrame = null;
        this.initialPosition = null;
        this.initialQuaternion = null;
        this.vehicleHalfExtents = null;
        this.vehicleLocalMinZ = null;
        this.wheelLocalMinZ = null;
        this.groundContactLocalMinZ = null;
        this.groundContactBiasMeters = 0;
        this.groundZ = 0;
        this.urdfObstacleLinkNames = ['obstacle_rock_01', 'obstacle_rock_02', 'obstacle_rock', 'rock_obstacle'];
        this.urdfObstacleLinkNamePatterns = [
            /^obstacle/i,
            /^ostacle/i,
            /^wall/i,
            /^rock_obstacle/i,
            /^step/i,
            /^curb/i,
            /^pothole/i,
            /^soil/i,
            /^dirt/i,
            /^gravel/i,
            /^bump/i,
            /^ditch/i
        ];
        this.passUnderObstacleNamePatterns = [/pass_under/i, /underbody/i];
        this.maxSpeedMps = 100 / 3.6;
        this.maxYawRateRad = THREE.MathUtils.degToRad(80);
        this.enableVisualCollisionFallback = false;
        this.isInitializing = false;
        this.isReady = false;
        this.hasFailed = false;
        this.lastStepTimeMs = 0;
        this.isKeyboardControlEnabled = true;
        this.keyHoldState = {
            ArrowUp: 0,
            ArrowDown: 0,
            ArrowLeft: 0,
            ArrowRight: 0
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

    computeLinkOwnBounds(linkObject, linkMap) {
        if (!linkObject) {
            return null;
        }

        const otherLinkRoots = Object.values(linkMap || {}).filter((root) => root && root !== linkObject);
        const bounds = new THREE.Box3();
        let hasMesh = false;

        linkObject.updateWorldMatrix(true, true);

        linkObject.traverse((node) => {
            if (!node || !node.isMesh || !node.geometry) {
                return;
            }

            const belongsToOtherLink = otherLinkRoots.some((root) => node === root || this.isDescendantObject3D(node, root));
            if (belongsToOtherLink) {
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

        return hasMesh ? bounds : null;
    }

    computeChassisBounds(carFrame, linkMap) {
        const fallbackBounds = new THREE.Box3().setFromObject(carFrame);
        if (!carFrame || !linkMap) {
            return fallbackBounds;
        }

        const obstacleLinkNames = this.getObstacleLinkNamesFromMap(linkMap);
        const obstacleRoots = obstacleLinkNames.map((name) => linkMap[name]).filter(Boolean);

        const excludedRoots = [...obstacleRoots].filter(Boolean);

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

    normalizeLinkName(linkName) {
        if (!linkName) {
            return '';
        }

        return String(linkName)
            .split(/[:/]/)
            .filter(Boolean)
            .pop()
            .toLowerCase();
    }

    findLinkByName(linkMap, targetName) {
        if (!linkMap || !targetName) {
            return null;
        }

        if (linkMap[targetName]) {
            return linkMap[targetName];
        }

        const normalizedTarget = this.normalizeLinkName(targetName);
        const entries = Object.entries(linkMap);
        for (let i = 0; i < entries.length; i += 1) {
            const [name, link] = entries[i];
            if (!link) {
                continue;
            }

            const normalizedName = this.normalizeLinkName(name);
            if (normalizedName === normalizedTarget) {
                return link;
            }
        }

        return null;
    }

    getObstacleLinkNamesFromMap(linkMap) {
        if (!linkMap) {
            return [];
        }

        const names = new Set();
        const targetNames = new Set(this.urdfObstacleLinkNames.map((name) => String(name).toLowerCase()));

        Object.keys(linkMap).forEach((name) => {
            const normalizedName = this.normalizeLinkName(name);
            const matchedByExactName = targetNames.has(String(name).toLowerCase()) || targetNames.has(normalizedName);
            const matchedByPattern = this.urdfObstacleLinkNamePatterns.some((pattern) => pattern.test(name) || pattern.test(normalizedName));
            const matched = matchedByExactName || matchedByPattern;
            if (matched) {
                names.add(name);
            }
        });

        return Array.from(names);
    }

    attachKeyboardControls() {
        if (!this.isKeyboardControlEnabled) {
            return;
        }

        const handledKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
        const driveModeByArrowKey = {
            ArrowUp: 'forward',
            ArrowDown: 'backward',
            ArrowLeft: 'left',
            ArrowRight: 'right'
        };

        window.addEventListener('keydown', (event) => {
            const isSpaceKey = event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
            if (isSpaceKey) {
                if (event.ctrlKey) {
                    this.reset();
                } else if (typeof window.setDriveMode === 'function') {
                    window.setDriveMode('stop');
                }
                event.preventDefault();
                return;
            }

            if (!handledKeys.has(event.key)) {
                return;
            }

            if (event.ctrlKey) {
                const nextDriveMode = driveModeByArrowKey[event.key] || null;
                if (nextDriveMode && typeof window.setDriveMode === 'function') {
                    window.setDriveMode(nextDriveMode);
                }
                event.preventDefault();
                return;
            }

            this.keyHoldState[event.key] = 1;
            event.preventDefault();
        }, { passive: false });

        window.addEventListener('keyup', (event) => {
            if (!handledKeys.has(event.key)) {
                return;
            }

            this.keyHoldState[event.key] = 0;
            event.preventDefault();
        }, { passive: false });

        window.addEventListener('blur', () => {
            this.keyHoldState.ArrowUp = 0;
            this.keyHoldState.ArrowDown = 0;
            this.keyHoldState.ArrowLeft = 0;
            this.keyHoldState.ArrowRight = 0;
        });
    }

    isFrontFacingViewActive() {
        const faceKey = String(this.viewer?.viewCubeActiveFaceKey || '').toLowerCase();
        if (faceKey) {
            return faceKey === 'front';
        }

        const camera = this.viewer?.camera || null;
        const target = this.viewer?.controls?.target || null;
        if (!camera || !target) {
            return false;
        }

        const cameraOffset = camera.position.clone().sub(target);
        if (cameraOffset.lengthSq() < 1e-8) {
            return false;
        }

        const direction = cameraOffset.normalize();
        const absX = Math.abs(direction.x);
        const absY = Math.abs(direction.y);
        const absZ = Math.abs(direction.z);

        if (absX >= absY && absX >= absZ) {
            return direction.x >= 0;
        }

        return false;
    }

    getKeyboardDriveState() {
        const upPressed = this.keyHoldState.ArrowUp === 1;
        const downPressed = this.keyHoldState.ArrowDown === 1;
        const leftPressed = this.keyHoldState.ArrowLeft === 1;
        const rightPressed = this.keyHoldState.ArrowRight === 1;

        const moveX = (upPressed ? 1 : 0) - (downPressed ? 1 : 0);
        const lateralBase = (leftPressed ? 1 : 0) - (rightPressed ? 1 : 0);
        const lateralSign = this.isFrontFacingViewActive() ? -1 : 1;
        const moveYRaw = lateralBase * lateralSign;
        const magnitude = Math.hypot(moveX, moveYRaw);
        const moveY = magnitude > 0 ? moveYRaw / magnitude : 0;
        const normalizedMoveX = magnitude > 0 ? moveX / magnitude : 0;
        const isActive = moveX !== 0 || moveY !== 0;

        return {
            isActive,
            moveX: normalizedMoveX,
            moveY
        };
    }

    getKeyboardNudgeDistance() {
        const halfWidth = Number(this.vehicleHalfExtents?.y);
        const fullWidth = Number.isFinite(halfWidth) && halfWidth > 0
            ? halfWidth * 2
            : 0.5;
        return fullWidth / 10;
    }

    updateSpeedSliderVisual(sliderElement) {
        if (!sliderElement) {
            return;
        }

        const minValue = Number.parseFloat(sliderElement.min);
        const maxValue = Number.parseFloat(sliderElement.max);
        const currentValue = Number.parseFloat(sliderElement.value);

        if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || maxValue <= minValue || !Number.isFinite(currentValue)) {
            sliderElement.style.setProperty('--slider-percent', '0%');
            return;
        }

        const clampedValue = Math.max(minValue, Math.min(maxValue, currentValue));
        const percent = ((clampedValue - minValue) / (maxValue - minValue)) * 100;
        sliderElement.style.setProperty('--slider-percent', `${percent}%`);
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
            return Math.max(0, Math.min(SIM_SPEED_MAX_KMH, numeric));
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
        this.updateSpeedSliderVisual(speedSlider);
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

    resetSpeedSliderToDefault() {
        const speedSlider = document.getElementById('drive-speed-kmh');
        const speedLabel = document.getElementById('drive-speed-kmh-value');
        if (!speedSlider) {
            return;
        }

        speedSlider.value = String(SIM_SPEED_DEFAULT_KMH);
        this.updateSpeedSliderVisual(speedSlider);

        if (speedLabel) {
            speedLabel.textContent = `${SIM_SPEED_DEFAULT_KMH} km/h`;
        }

        if (typeof window.setDriveSpeedKmh === 'function') {
            window.setDriveSpeedKmh(SIM_SPEED_DEFAULT_KMH);
        }

        try {
            window.localStorage.setItem(SIM_SPEED_STORAGE_KEY, String(SIM_SPEED_DEFAULT_KMH));
        } catch (error) {
            // Ignore storage failures and continue runtime behavior.
        }
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
            const groundBounds = this.computeLinkOwnBounds(groundLink, linkMap);
            if (groundBounds && !groundBounds.isEmpty()) {
                this.groundZ = groundBounds.max.z;
            } else {
                const groundWorldPos = new THREE.Vector3();
                groundLink.getWorldPosition(groundWorldPos);
                this.groundZ = groundWorldPos.z;
            }
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
        const obstacleLinkNames = this.getObstacleLinkNamesFromMap(linkMap);
        if (obstacleLinkNames.length === 0) {
            console.warn('[URDF][Simulation] URDF obstacle link not found. Expected one of:', this.urdfObstacleLinkNames);
            return;
        }

        this.obstacleColliders = [];

        obstacleLinkNames.forEach((obstacleLinkName) => {
            const obstacleLink = linkMap[obstacleLinkName];
            obstacleLink.updateWorldMatrix(true, true);

            const bbox = new THREE.Box3().setFromObject(obstacleLink);
            const center = bbox.getCenter(new THREE.Vector3());
            const size = bbox.getSize(new THREE.Vector3());
            const halfX = Math.max(size.x * 0.5, 0.02);
            const halfY = Math.max(size.y * 0.5, 0.02);
            const halfZ = Math.max(size.z * 0.5, 0.02);
            const normalizedObstacleName = this.normalizeLinkName(obstacleLinkName);
            const isPassUnderTagged = this.passUnderObstacleNamePatterns.some((pattern) => pattern.test(obstacleLinkName) || pattern.test(normalizedObstacleName));

            const isPotholeObstacle = /^pothole/i.test(obstacleLinkName) || /^pothole/i.test(normalizedObstacleName);
            const clampedCenterZ = !isPotholeObstacle
                ? Math.max(center.z, this.groundZ + halfZ)
                : center.z;

            const obstacleBodyDesc = this.rapier.RigidBodyDesc.fixed().setTranslation(
                center.x,
                center.y,
                clampedCenterZ
            );
            const obstacleBody = this.world.createRigidBody(obstacleBodyDesc);
            const obstacleColliderDesc = this.rapier.ColliderDesc.cuboid(halfX, halfY, halfZ)
                .setFriction(1.4)
                .setRestitution(0.02);

            // Only explicitly tagged links are sensors; generic obstacles must physically collide.
            if (isPassUnderTagged && typeof obstacleColliderDesc.setSensor === 'function') {
                obstacleColliderDesc.setSensor(true);
                console.log('[URDF][Simulation] obstacle treated as pass-under sensor:', {
                    obstacleLinkName,
                    isPassUnderTagged
                });
            }

            const obstacleCollider = this.world.createCollider(obstacleColliderDesc, obstacleBody);
            this.obstacleColliders.push(obstacleCollider);
            console.log(`[URDF][Simulation] obstacle collider created from URDF link: ${obstacleLinkName}`);
        });
    }

    clampVehicleAboveGround() {
        if (!this.body || !Number.isFinite(this.groundZ) || !Number.isFinite(this.groundContactLocalMinZ)) {
            return;
        }

        const translation = this.body.translation();
        const groundBasedMinZ = this.groundZ - this.groundContactLocalMinZ - this.groundContactBiasMeters;
        const initialBasedMinZ = Number.isFinite(this.initialPosition?.z) ? this.initialPosition.z : groundBasedMinZ;
        const minAllowedZ = Math.min(groundBasedMinZ, initialBasedMinZ);
        if (translation.z < minAllowedZ) {
            this.body.setTranslation(new this.rapier.Vector3(translation.x, translation.y, minAllowedZ), true);

            const velocity = this.body.linvel();
            this.body.setLinvel(new this.rapier.Vector3(velocity.x, velocity.y, Math.max(0, velocity.z)), true);
        }
    }

    addWheelCollidersFromUrdf(body, carFrame, linkMap) {
        if (!this.world || !this.rapier || !body || !carFrame || !linkMap) {
            return;
        }

        const wheelLinkNames = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
        let createdWheelColliderCount = 0;

        wheelLinkNames.forEach((wheelLinkName) => {
            const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
            if (!wheelLink) {
                return;
            }

            wheelLink.updateWorldMatrix(true, true);

            const wheelBounds = new THREE.Box3().setFromObject(wheelLink);
            if (wheelBounds.isEmpty()) {
                return;
            }

            const centerWorld = wheelBounds.getCenter(new THREE.Vector3());
            const size = wheelBounds.getSize(new THREE.Vector3());
            const approxRadius = Math.max(size.x * 0.5, size.z * 0.5, 0.05);
            const localCenter = carFrame.worldToLocal(centerWorld.clone());

            const wheelColliderDesc = this.rapier.ColliderDesc.ball(approxRadius)
                .setTranslation(localCenter.x, localCenter.y, localCenter.z)
                .setFriction(1.6)
                .setRestitution(0.01);

            const wheelCollider = this.world.createCollider(wheelColliderDesc, body);
            this.vehicleColliders.push(wheelCollider);
            createdWheelColliderCount += 1;
        });

        if (createdWheelColliderCount === 0) {
            console.warn('[URDF][Simulation] Wheel colliders were not created. Check wheel link names in URDF.');
        }
    }

    getWheelGeometryStats(carFrame, linkMap) {
        if (!carFrame || !linkMap) {
            return null;
        }

        const wheelLinkNames = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
        const wheelHeights = [];
        const wheelRadii = [];

        wheelLinkNames.forEach((wheelLinkName) => {
            const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
            if (!wheelLink) {
                return;
            }

            wheelLink.updateWorldMatrix(true, true);
            const wheelBounds = new THREE.Box3().setFromObject(wheelLink);
            if (wheelBounds.isEmpty()) {
                return;
            }

            const centerWorld = wheelBounds.getCenter(new THREE.Vector3());
            const centerLocal = carFrame.worldToLocal(centerWorld.clone());
            const wheelSize = wheelBounds.getSize(new THREE.Vector3());
            const wheelRadius = Math.max(wheelSize.x * 0.5, wheelSize.z * 0.5, 0.05);

            wheelHeights.push(centerLocal.z);
            wheelRadii.push(wheelRadius);
        });

        if (wheelHeights.length === 0 || wheelRadii.length === 0) {
            return null;
        }

        const avgWheelCenterZ = wheelHeights.reduce((sum, value) => sum + value, 0) / wheelHeights.length;
        const avgWheelRadius = wheelRadii.reduce((sum, value) => sum + value, 0) / wheelRadii.length;

        return {
            avgWheelCenterZ,
            avgWheelRadius
        };
    }

    getWheelLocalMinZ(carFrame, linkMap) {
        if (!carFrame || !linkMap) {
            return null;
        }

        const wheelLinkNames = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
        const minValues = [];

        wheelLinkNames.forEach((wheelLinkName) => {
            const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
            if (!wheelLink) {
                return;
            }

            wheelLink.updateWorldMatrix(true, true);
            const wheelBounds = new THREE.Box3().setFromObject(wheelLink);
            if (wheelBounds.isEmpty()) {
                return;
            }

            const centerWorld = wheelBounds.getCenter(new THREE.Vector3());
            const centerLocal = carFrame.worldToLocal(centerWorld.clone());
            const wheelSize = wheelBounds.getSize(new THREE.Vector3());
            const wheelRadius = Math.max(wheelSize.x * 0.5, wheelSize.z * 0.5, 0.05);
            minValues.push(centerLocal.z - wheelRadius);
        });

        if (minValues.length === 0) {
            return null;
        }

        return Math.min(...minValues);
    }

    alignVehicleWheelContactToGround() {
        if (!this.body || !Number.isFinite(this.groundZ) || !Number.isFinite(this.groundContactLocalMinZ)) {
            return;
        }

        const translation = this.body.translation();
        const targetZ = this.groundZ - this.groundContactLocalMinZ - this.groundContactBiasMeters;
        this.body.setTranslation(new this.rapier.Vector3(translation.x, translation.y, targetZ), true);
    }

    updateObstacleContactState() {
        if (!this.world || this.vehicleColliders.length === 0 || this.obstacleColliders.length === 0) {
            return false;
        }

        let hasContact = false;

        if (typeof this.world.contactPair === 'function') {
            this.vehicleColliders.forEach((vehicleCollider) => {
                if (hasContact) {
                    return;
                }

                this.obstacleColliders.forEach((obstacleCollider) => {
                    if (hasContact) {
                        return;
                    }

                    this.world.contactPair(vehicleCollider, obstacleCollider, () => {
                        hasContact = true;
                    });
                });
            });
        }

        if (hasContact !== this.isVehicleObstacleContact) {
            this.isVehicleObstacleContact = hasContact;
            console.log(`[URDF][Simulation] vehicle-obstacle contact: ${hasContact ? 'ON' : 'OFF'}`);
        }

        return hasContact;
    }

    rollbackToPreviousPose(previousPose) {
        if (!previousPose || !this.body || !this.rapier || !this.carFrame) {
            return;
        }

        this.body.setTranslation(new this.rapier.Vector3(previousPose.x, previousPose.y, previousPose.z), true);
        this.body.setRotation({ x: previousPose.qx, y: previousPose.qy, z: previousPose.qz, w: previousPose.qw }, true);
        this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
        this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);

        this.carFrame.position.set(previousPose.x, previousPose.y, previousPose.z);
        this.carFrame.quaternion.set(previousPose.qx, previousPose.qy, previousPose.qz, previousPose.qw).normalize();
    }

    isVehicleOverlappingObstacleVisualBounds() {
        const linkMap = this.viewer?.robotModel?.links || null;
        if (!this.carFrame || !linkMap) {
            return false;
        }

        this.carFrame.updateWorldMatrix(true, true);
        const vehicleBounds = this.computeChassisBounds(this.carFrame, linkMap);
        if (!vehicleBounds || vehicleBounds.isEmpty()) {
            return false;
        }

        const obstacleNames = this.getObstacleLinkNamesFromMap(linkMap);
        for (let i = 0; i < obstacleNames.length; i += 1) {
            const obstacleName = obstacleNames[i];
            const normalizedName = this.normalizeLinkName(obstacleName);
            const isPothole = /^pothole/i.test(obstacleName) || /^pothole/i.test(normalizedName);
            if (isPothole) {
                continue;
            }

            const obstacleLink = linkMap[obstacleName];
            if (!obstacleLink) {
                continue;
            }

            obstacleLink.updateWorldMatrix(true, true);
            const obstacleBounds = this.computeLinkOwnBounds(obstacleLink, linkMap) || new THREE.Box3().setFromObject(obstacleLink);
            if (!obstacleBounds || obstacleBounds.isEmpty()) {
                continue;
            }

            const overlapX = Math.min(vehicleBounds.max.x, obstacleBounds.max.x) - Math.max(vehicleBounds.min.x, obstacleBounds.min.x);
            const overlapY = Math.min(vehicleBounds.max.y, obstacleBounds.max.y) - Math.max(vehicleBounds.min.y, obstacleBounds.min.y);
            const overlapZ = Math.min(vehicleBounds.max.z, obstacleBounds.max.z) - Math.max(vehicleBounds.min.z, obstacleBounds.min.z);

            const hasSufficientPenetration = overlapX > this.visualCollisionMinPenetrationMeters
                && overlapY > this.visualCollisionMinPenetrationMeters
                && overlapZ > this.visualCollisionMinPenetrationMeters;

            if (hasSufficientPenetration) {
                return true;
            }
        }

        return false;
    }

    rollbackIfVisualCollisionMiss(previousPose) {
        if (!previousPose || !this.body || !this.rapier || !this.carFrame) {
            return;
        }

        const overlapped = this.isVehicleOverlappingObstacleVisualBounds();
        if (!overlapped) {
            return;
        }

        this.body.setTranslation(new this.rapier.Vector3(previousPose.x, previousPose.y, previousPose.z), true);
        this.body.setRotation({ x: previousPose.qx, y: previousPose.qy, z: previousPose.qz, w: previousPose.qw }, true);
        this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
        this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);

        this.carFrame.position.set(previousPose.x, previousPose.y, previousPose.z);
        this.carFrame.quaternion.set(previousPose.qx, previousPose.qy, previousPose.qz, previousPose.qw).normalize();
        this.isVehicleObstacleContact = true;
    }

    async ensureRapierInitialized() {
        if (this.isReady || this.isInitializing || this.hasFailed) {
            return;
        }

        if (!this.viewer?.robotModel) {
            return;
        }

        const linkMap = this.viewer.robotModel.links || {};
        const carFrame = this.findLinkByName(linkMap, 'car_frame') || this.findLinkByName(linkMap, 'base_link') || null;
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
                .setAngularDamping(3.2)
                .setCcdEnabled(true);

            const body = world.createRigidBody(rigidBodyDesc);

            const bbox = this.computeChassisBounds(carFrame, linkMap);
            const size = bbox.getSize(new THREE.Vector3());
            const worldCenter = bbox.getCenter(new THREE.Vector3());
            const localCenter = carFrame.worldToLocal(worldCenter.clone());
            const halfX = Math.max((size.x || 0.6) * 0.5, 0.12);
            const halfY = Math.max((size.y || 0.4) * 0.5, 0.10);

            const bboxMinLocalZ = localCenter.z - Math.max((size.z || 0.25) * 0.5, 0.06);
            const bboxMaxLocalZ = localCenter.z + Math.max((size.z || 0.25) * 0.5, 0.06);
            this.vehicleLocalMinZ = bboxMinLocalZ;
            this.wheelLocalMinZ = this.getWheelLocalMinZ(carFrame, linkMap);
            if (Number.isFinite(this.wheelLocalMinZ)) {
                this.groundContactLocalMinZ = this.wheelLocalMinZ;
            } else if (Number.isFinite(this.vehicleLocalMinZ)) {
                this.groundContactLocalMinZ = this.vehicleLocalMinZ;
            } else {
                this.groundContactLocalMinZ = null;
            }
            const halfZ = Math.max((bboxMaxLocalZ - bboxMinLocalZ) * 0.5, 0.06);
            const adjustedCenterZ = (bboxMaxLocalZ + bboxMinLocalZ) * 0.5;

            const colliderDesc = RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
                .setTranslation(localCenter.x, localCenter.y, adjustedCenterZ)
                .setFriction(1.1)
                .setRestitution(0.04);
            this.vehicleCollider = world.createCollider(colliderDesc, body);
            this.vehicleColliders = [this.vehicleCollider];
            this.addWheelCollidersFromUrdf(body, carFrame, linkMap);

            this.rapier = RAPIER;
            this.world = world;
            this.body = body;
            this.carFrame = carFrame;
            this.initialPosition = initialPosition.clone();
            this.initialQuaternion = initialQuaternion.clone();
            this.vehicleHalfExtents = { x: halfX, y: halfY, z: halfZ };
            this.addGroundCollider();

            this.clampVehicleAboveGround();
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
        let keyboardMoveX = 0;
        let keyboardMoveY = 0;
        let driveSpeedKmh = Math.max(Number(this.viewer.driveSpeedKmh) || 0, 0);

        if (keyboardState.isActive) {
            keyboardMoveX = keyboardState.moveX;
            keyboardMoveY = keyboardState.moveY;
        } else {
            const driveMode = String(this.viewer.driveMode || 'stop');
            if (driveMode === 'forward') {
                throttleSign = 1;
            } else if (driveMode === 'backward') {
                throttleSign = -1;
            } else if (driveMode === 'left') {
                throttleSign = 0;
                steerSign = 1;
            } else if (driveMode === 'right') {
                throttleSign = 0;
                steerSign = -1;
            }
        }

        const speedMps = driveSpeedKmh / 3.6;
        const clampedSpeed = Math.min(speedMps, this.maxSpeedMps);
        const effectiveSteerSign = clampedSpeed > 1e-3 ? steerSign : 0;

        const previousTranslation = this.body.translation();
        const previousRotation = this.body.rotation();
        const previousPose = {
            x: previousTranslation.x,
            y: previousTranslation.y,
            z: previousTranslation.z,
            qx: previousRotation.x,
            qy: previousRotation.y,
            qz: previousRotation.z,
            qw: previousRotation.w
        };

        const currentLinearVelocity = this.body.linvel();
        let lockedRotation = null;
        if (keyboardState.isActive) {
            lockedRotation = this.body.rotation();
            const velocitySmoothingAlpha = 1 - Math.exp(-12 * deltaSec);
            const targetVelocityX = keyboardMoveX * clampedSpeed;
            const targetVelocityY = keyboardMoveY * clampedSpeed;
            const velocityX = currentLinearVelocity.x + ((targetVelocityX - currentLinearVelocity.x) * velocitySmoothingAlpha);
            const velocityY = currentLinearVelocity.y + ((targetVelocityY - currentLinearVelocity.y) * velocitySmoothingAlpha);

            this.body.setLinvel(new this.rapier.Vector3(velocityX, velocityY, currentLinearVelocity.z), true);
            this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
        } else {
            const bodyRotation = this.body.rotation();
            const yaw = this.extractYawFromQuaternion(bodyRotation);
            const currentAngularVelocity = this.body.angvel();
            const velocityX = Math.cos(yaw) * clampedSpeed * throttleSign;
            const velocityY = Math.sin(yaw) * clampedSpeed * throttleSign;

            this.body.setLinvel(new this.rapier.Vector3(velocityX, velocityY, currentLinearVelocity.z), true);
            this.body.setAngvel(new this.rapier.Vector3(currentAngularVelocity.x, currentAngularVelocity.y, this.maxYawRateRad * effectiveSteerSign), true);
        }

        const simulationDelta = Math.max(deltaSec, 1 / 240);
        const maxSubStepSec = 1 / 120;
        const stepCount = Math.max(1, Math.ceil(simulationDelta / maxSubStepSec));
        const subStepSec = simulationDelta / stepCount;
        for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
            this.world.timestep = subStepSec;
            this.world.step();
            this.clampVehicleAboveGround();
        }

        if (keyboardState.isActive && lockedRotation) {
            this.body.setRotation(lockedRotation, true);
            this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
        }

        const hasObstacleContact = this.updateObstacleContactState();

        const isMoveCommandActive = keyboardState.isActive || throttleSign !== 0;
        if (hasObstacleContact && isMoveCommandActive) {
            this.rollbackToPreviousPose(previousPose);
            return;
        }

        const nextPosition = this.body.translation();
        const nextRotation = this.body.rotation();

        this.carFrame.position.set(nextPosition.x, nextPosition.y, nextPosition.z);
        this.carFrame.quaternion.set(nextRotation.x, nextRotation.y, nextRotation.z, nextRotation.w).normalize();
        if (this.enableVisualCollisionFallback) {
            this.rollbackIfVisualCollisionMiss(previousPose);
        }
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

        this.resetRoadAttitude();

        const wheelKeys = ['fl', 'fr', 'rl', 'rr'];
        wheelKeys.forEach((key) => {
            if (typeof window.setWheelAnimationByKey === 'function') {
                window.setWheelAnimationByKey(key, 0);
            }
        });
    }

    resetRoadAttitude() {
        this.resetRoadRoll();
        this.resetRoadPitch();
    }

    resetRoadRoll() {
        if (typeof window.setRoadRollAngleDeg === 'function') {
            window.setRoadRollAngleDeg(0);
        }

        const rollInput = document.getElementById('road-roll-angle-deg');
        if (rollInput) {
            rollInput.value = '0';
        }
    }

    resetRoadPitch() {
        if (typeof window.setRoadPitchAngleDeg === 'function') {
            window.setRoadPitchAngleDeg(0);
        }

        const pitchInput = document.getElementById('road-pitch-angle-deg');
        if (pitchInput) {
            pitchInput.value = '0';
        }
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
        this.isVehicleObstacleContact = false;

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

globalThis.resetSimulationSpeed = function() {
    rapierDriveSimulation.resetSpeedSliderToDefault();
};

globalThis.resetSimulationAttitude = function() {
    rapierDriveSimulation.resetRoadAttitude();
};

globalThis.resetSimulationRoll = function() {
    rapierDriveSimulation.resetRoadRoll();
};

globalThis.resetSimulationPitch = function() {
    rapierDriveSimulation.resetRoadPitch();
};
