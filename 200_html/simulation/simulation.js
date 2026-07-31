import * as THREE from 'three';

const RAPIER_CDN = 'https://cdn.skypack.dev/@dimforge/rapier3d-compat@0.11.2';
const SIM_SPEED_STORAGE_KEY = 'wcs.simulation.driveSpeedMps';
const SIM_SPEED_LEGACY_STORAGE_KEY = 'wcs.simulation.driveSpeedKmh';
const SIM_SPEED_DEFAULT_MPS = 0.1;
const SIM_SPEED_MAX_MPS = 2.0;
const SIM_VISUAL_SPEED_STORAGE_KEY = 'wcs.simulation.visualSpeedScale';
const SIM_VISUAL_SPEED_DEFAULT_SCALE = 0.5;
const SIM_VISUAL_SPEED_MIN_SCALE = 1 / 30;
const SIM_VISUAL_SPEED_MAX_SCALE = 1;
const SIM_VISUAL_SPEED_LEGACY_MAX_SCALE = 1.5;
const SIM_VISUAL_SPEED_MIN_DENOMINATOR = 1;
const SIM_VISUAL_SPEED_MAX_DENOMINATOR = 30;

class RapierDriveSimulation {
    constructor() {
        this.viewer = null;
        this.rapier = null;
        this.world = null;
        this.body = null;
        this.vehicleCollider = null;
        this.vehicleColliders = [];
        this.vehicleColliderLocalCenter = new THREE.Vector3(0, 0, 0);
        this.vehicleColliderHalfExtents = { x: 0.1, y: 0.1, z: 0.1 };
        this.obstacleColliders = [];
        this.obstacleColliderInfos = [];
        this.obstacleContactSurfaceToleranceMeters = 0.012;
        this.obstacleApproachDisableSnapDistanceMeters = 0.05;
        this.obstacleDepenetrationEpsilonMeters = 0.015;
        this.obstacleGeometryContactMarginMeters = 0.06;
        this.obstacleDepenetrationMaxIterations = 8;
        this.isVehicleObstacleContact = false;
        this.carFrame = null;
        this.initialPosition = null;
        this.initialQuaternion = null;
        this.vehicleHalfExtents = null;
        this.vehicleLocalMinZ = null;
        this.wheelLocalMinZ = null;
        this.wheelEffectiveRadiusMeters = 0.16;
        this.groundContactLocalMinZ = null;
        this.groundContactBiasMeters = 0;
        this.groundZ = 0;
        this.holeRegions = [];
        this.underbodyPassThroughClearanceMeters = 0.02;
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
        this.enableWheelPhysicsColliders = true;
        this.blockMotionOnObstacleContact = false;
        this.keepUprightOnFlatGround = true;
        this.isUprightRotationLockActive = false;
        this.groundPenetrationToleranceMeters = 0.003;
        this.bodyGroundClampActivationMarginMeters = 0.004;
        this.wheelGroundHardClampOffsetMeters = 0.001;
        this.wheelGroundClampActivationMarginMeters = 0.003;
        this.postObstacleGroundReattachToleranceMeters = 0.001;
        this.postObstacleGroundReattachBlend = 0.75;
        this.postObstacleGroundRecoverDurationSec = 0.35;
        this.postObstacleGroundRecoverRemainingSec = 0;
        this.flatGroundSnapDistanceMeters = 0.01;
        this.flatGroundVerticalVelocitySnapThresholdMps = 0.35;
        this.maxLiftWithoutObstacleMeters = 0.03;
        this.maxLiftWithObstacleMeters = 0.24;
        this.isInitializing = false;
        this.isReady = false;
        this.hasFailed = false;
        this.lastStepTimeMs = 0;
        this.physicsAccumulatorSec = 0;
        this.physicsFixedTimeStepSec = 1 / 90;
        this.maxPhysicsCatchupSteps = 6;
        this.hasLoggedGroundDiagnostics = false;
        this.enableRuntimeDiagnostics = true;
        this.runtimeDiagnosticsIntervalSec = 1;
        this.runtimeDiagnosticsElapsedSec = 0;
        this.isKeyboardControlEnabled = true;
        this.keyHoldState = {
            ArrowUp: 0,
            ArrowDown: 0,
            ArrowLeft: 0,
            ArrowRight: 0
        };
        this.commandedDriveMode = 'stop';
        this.commandedSpeedMps = SIM_SPEED_DEFAULT_MPS;
        this.isPaused = false;
        this.pauseStateSnapshot = null;
        this.hasInstalledDriveCommandHooks = false;
        this.hasActivatedSimulationMotion = false;
        this.hasActivatedDynamicGroundClamp = false;
        this.visualSpeedScale = SIM_VISUAL_SPEED_DEFAULT_SCALE;
        this.debugPanelElement = null;
        this.debugTextElement = null;
        this.debugStatusUpdateIntervalSec = 0.2;
        this.debugStatusElapsedSec = 0;
        this.wheelZChartOverlayElement = null;
        this.wheelZChartPanelElement = null;
        this.wheelZChartBodyElement = null;
        this.wheelZChartTitleRowElement = null;
        this.wheelZChartTitleElement = null;
        this.wheelZChartToggleButtonElement = null;
        this.wheelZChartCanvasElement = null;
        this.wheelZChartContext = null;
        this.wheelZChartWindowSec = 20;
        this.wheelZChartElapsedSec = 0;
        this.wheelZChartRenderIntervalSec = 0.25;
        this.wheelZChartLastRenderTimeMs = null;
        this.wheelZChartVisibleStorageKey = 'wcs.simulation.wheelZChartVisible';
        this.isWheelZChartVisible = this.loadWheelZChartVisibleState();
        this.wheelZChartHistoryByKey = {
            fl: [],
            fr: [],
            rl: [],
            rr: []
        };
        this.wheelChartColorByKey = {
            fl: '#0d6efd',
            fr: '#dc3545',
            rl: '#198754',
            rr: '#fd7e14'
        };
        this.wheelDotColorByKey = {
            fl: '#7fb3ff',
            fr: '#ff8d9a',
            rl: '#63c78d',
            rr: '#ffb36b'
        };
        this.wheelLinkNameByKey = {
            fl: 'wheel_fl',
            fr: 'wheel_fr',
            rl: 'wheel_rl',
            rr: 'wheel_rr'
        };
        this.wheelRadiusMetersByKey = {
            fl: null,
            fr: null,
            rl: null,
            rr: null
        };
        this.wheelColliderInflationMeters = 0.012;
    }

    kmhToMps(kmh) {
        const numeric = Number.parseFloat(kmh);
        if (!Number.isFinite(numeric)) {
            return 0;
        }

        return numeric / 3.6;
    }

    mpsToKmh(mps) {
        const numeric = Number.parseFloat(mps);
        if (!Number.isFinite(numeric)) {
            return 0;
        }

        return numeric * 3.6;
    }

    normalizeDriveSpeedMps(rawValue, fallbackValue = SIM_SPEED_DEFAULT_MPS) {
        const numeric = Number.parseFloat(rawValue);
        const base = Number.isFinite(numeric) ? numeric : fallbackValue;
        const clamped = Math.max(0, Math.min(SIM_SPEED_MAX_MPS, base));
        return Math.round(clamped * 10) / 10;
    }

    initDebugPanel() {
        this.debugPanelElement = document.getElementById('simulation-debug-panel');
        this.debugTextElement = document.getElementById('simulation-debug-text');
        if (!this.debugPanelElement || !this.debugTextElement) {
            return;
        }

        this.debugPanelElement.style.display = 'block';
        this.debugTextElement.textContent = '초기화 중...';
    }

    ensureWheelZChartOverlay() {
        if (this.wheelZChartOverlayElement && this.wheelZChartCanvasElement && this.wheelZChartContext) {
            return;
        }

        const container = this.viewer?.container || null;
        if (!container) {
            return;
        }

        const containerStyle = window.getComputedStyle(container);
        if (containerStyle.position === 'static') {
            container.style.position = 'relative';
        }

        const overlay = document.createElement('div');
        overlay.id = 'wheel-z-chart-overlay';
        overlay.className = 'position-absolute';
        overlay.style.right = '12px';
        overlay.style.bottom = '12px';
        overlay.style.width = 'min(360px, 84vw)';
        overlay.style.minHeight = '32px';
        overlay.style.overflow = 'visible';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '15';

        const buttonDock = document.createElement('div');
        buttonDock.style.position = 'absolute';
        buttonDock.style.top = '8px';
        buttonDock.style.right = '8px';
        buttonDock.style.width = '28px';
        buttonDock.style.height = '28px';
        buttonDock.style.pointerEvents = 'none';
        buttonDock.style.zIndex = '16';

        const panel = document.createElement('div');
        panel.className = 'border border-primary-subtle rounded-3 shadow-sm';
        panel.style.width = '100%';
        panel.style.minHeight = '48px';
        panel.style.background = 'rgba(255, 255, 255, 0.92)';
        panel.style.backdropFilter = 'blur(2px)';
        panel.style.pointerEvents = 'auto';
        panel.style.padding = '8px 8px 6px 8px';
        panel.style.position = 'relative';
        panel.style.touchAction = 'none';

        const titleRow = document.createElement('div');
        titleRow.className = 'd-flex align-items-center justify-content-center gap-2';
        titleRow.style.marginBottom = '4px';
        titleRow.style.position = 'relative';
        titleRow.style.minHeight = '20px';
        titleRow.style.padding = '0 36px 0 8px';
        titleRow.style.width = '100%';
        titleRow.style.zIndex = '3';

        const title = document.createElement('div');
        title.className = 'small fw-semibold text-primary';
        title.style.lineHeight = '1.1';
        title.style.textAlign = 'center';
        title.style.width = '100%';
        title.textContent = 'Wheel Z Position';

        const toggleButton = document.createElement('button');
        toggleButton.type = 'button';
        toggleButton.className = 'btn btn-sm btn-outline-primary shadow-sm';
        toggleButton.style.flex = '0 0 auto';
        toggleButton.style.width = '28px';
        toggleButton.style.height = '28px';
        toggleButton.style.padding = '0';
        toggleButton.style.display = 'inline-flex';
        toggleButton.style.alignItems = 'center';
        toggleButton.style.justifyContent = 'center';
        toggleButton.style.position = 'absolute';
        toggleButton.style.right = '0';
        toggleButton.style.top = '50%';
        toggleButton.style.transform = 'translateY(-50%)';
        toggleButton.style.pointerEvents = 'auto';
        toggleButton.style.whiteSpace = 'nowrap';
        toggleButton.style.borderRadius = '999px';
        toggleButton.style.borderWidth = '1px';
        toggleButton.style.lineHeight = '1';
        toggleButton.style.overflow = 'hidden';
        toggleButton.innerHTML = this.getWheelZChartToggleButtonIconSvg(this.isWheelZChartVisible);

        const canvas = document.createElement('canvas');
        canvas.width = 344;
        canvas.height = 154;
        canvas.style.width = '100%';
        canvas.style.height = '154px';
        canvas.style.display = 'block';

        const body = document.createElement('div');
        body.style.display = 'block';
        body.appendChild(canvas);

        titleRow.appendChild(title);
        panel.appendChild(titleRow);
        panel.appendChild(body);
        buttonDock.appendChild(toggleButton);
        overlay.appendChild(buttonDock);
        overlay.appendChild(panel);

        const blockViewerInteraction = (event) => {
            event.preventDefault();
            event.stopPropagation();
        };

        ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'wheel', 'touchstart', 'touchmove', 'touchend'].forEach((eventName) => {
            overlay.addEventListener(eventName, blockViewerInteraction, { passive: false });
            canvas.addEventListener(eventName, blockViewerInteraction, { passive: false });
        });

        container.appendChild(overlay);

        this.wheelZChartOverlayElement = overlay;
        this.wheelZChartPanelElement = panel;
        this.wheelZChartBodyElement = body;
        this.wheelZChartTitleRowElement = titleRow;
        this.wheelZChartTitleElement = title;
        this.wheelZChartToggleButtonElement = toggleButton;
        this.wheelZChartCanvasElement = canvas;
        this.wheelZChartContext = canvas.getContext('2d');
        toggleButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.toggleWheelZChartVisible();
        });

        this.updateWheelZChartVisibility();
    }

    loadWheelZChartVisibleState() {
        try {
            if (typeof window.localStorage === 'undefined') {
                return true;
            }

            const savedValue = window.localStorage.getItem(this.wheelZChartVisibleStorageKey);
            if (savedValue == null) {
                return true;
            }

            return savedValue === '1' || savedValue === 'true';
        } catch (error) {
            return true;
        }
    }

    saveWheelZChartVisibleState() {
        try {
            if (typeof window.localStorage === 'undefined') {
                return;
            }

            window.localStorage.setItem(this.wheelZChartVisibleStorageKey, this.isWheelZChartVisible ? '1' : '0');
        } catch (error) {
            // Ignore storage failures in restricted browser modes.
        }
    }

    updateWheelZChartToggleButtonState() {
        if (!this.wheelZChartToggleButtonElement) {
            return;
        }

        const isVisible = this.isWheelZChartVisible;
        this.wheelZChartToggleButtonElement.innerHTML = this.getWheelZChartToggleButtonIconSvg(isVisible);
        this.wheelZChartToggleButtonElement.setAttribute('aria-pressed', isVisible ? 'true' : 'false');
        this.wheelZChartToggleButtonElement.setAttribute('aria-label', isVisible ? '휠 차트 숨기기' : '휠 차트 표시');
        this.wheelZChartToggleButtonElement.title = isVisible ? '휠 차트 숨기기' : '휠 차트 표시';
    }

    updateWheelZChartVisibility() {
        const isVisible = this.isWheelZChartVisible;

        if (this.wheelZChartToggleButtonElement) {
            this.wheelZChartToggleButtonElement.style.top = isVisible ? '50%' : '0';
            this.wheelZChartToggleButtonElement.style.transform = isVisible ? 'translateY(-50%)' : 'translateY(0)';
            this.wheelZChartToggleButtonElement.style.right = isVisible ? '0' : '0';
        }

        if (this.wheelZChartTitleRowElement) {
            this.wheelZChartTitleRowElement.style.marginBottom = isVisible ? '4px' : '0';
            this.wheelZChartTitleRowElement.style.justifyContent = 'center';
            this.wheelZChartTitleRowElement.style.minHeight = isVisible ? '28px' : '0';
            this.wheelZChartTitleRowElement.style.paddingRight = '0';
        }

        if (this.wheelZChartTitleElement) {
            this.wheelZChartTitleElement.style.display = isVisible ? 'block' : 'none';
        }

        if (this.wheelZChartBodyElement) {
            this.wheelZChartBodyElement.style.display = isVisible ? 'block' : 'none';
        }

        if (this.wheelZChartPanelElement) {
            this.wheelZChartPanelElement.style.display = isVisible ? 'block' : 'none';
            this.wheelZChartPanelElement.style.opacity = '1';
        }

        this.updateWheelZChartToggleButtonState();
    }

    toggleWheelZChartVisible(forceVisible = null) {
        this.isWheelZChartVisible = typeof forceVisible === 'boolean'
            ? forceVisible
            : !this.isWheelZChartVisible;
        this.saveWheelZChartVisibleState();
        this.updateWheelZChartVisibility();
    }

    getWheelZChartToggleButtonIconSvg(isVisible) {
        if (isVisible) {
            return '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12.5V3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2 12.5H14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M3 11L6 9L8.5 10.5L13 5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="3" cy="11" r="0.85" fill="currentColor"/><circle cx="6" cy="9" r="0.85" fill="currentColor"/><circle cx="8.5" cy="10.5" r="0.85" fill="currentColor"/><circle cx="13" cy="5.5" r="0.85" fill="currentColor"/></svg>';
        }

        return '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12.5V3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2 12.5H14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M3 10.5L6.2 8.5L8.6 9.8L12.8 4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="3" cy="10.5" r="0.85" fill="currentColor"/><circle cx="6.2" cy="8.5" r="0.85" fill="currentColor"/><circle cx="8.6" cy="9.8" r="0.85" fill="currentColor"/><circle cx="12.8" cy="4.8" r="0.85" fill="currentColor"/></svg>';
    }

    trimWheelZChartHistory(nowSec) {
        const minTimeSec = Math.max(nowSec - this.wheelZChartWindowSec, 0);
        Object.keys(this.wheelZChartHistoryByKey).forEach((key) => {
            const samples = this.wheelZChartHistoryByKey[key];
            if (!Array.isArray(samples) || samples.length === 0) {
                return;
            }

            let keepIndex = 0;
            while (keepIndex < samples.length && samples[keepIndex].t < minTimeSec) {
                keepIndex += 1;
            }

            if (keepIndex > 0) {
                this.wheelZChartHistoryByKey[key] = samples.slice(keepIndex);
            }
        });
    }

    extractWheelRadiusMetersFromLink(wheelLink) {
        if (!wheelLink) {
            return null;
        }

        let detectedRadiusMeters = null;

        wheelLink.traverse((node) => {
            if (!node?.isMesh || !node.geometry) {
                return;
            }

            const geometryType = String(node.geometry.type || '');
            const geometryParams = node.geometry.parameters || {};
            const hasCylinderRadius = Number.isFinite(geometryParams.radiusTop) && Number.isFinite(geometryParams.radiusBottom);
            if (!geometryType.includes('Cylinder') || !hasCylinderRadius) {
                return;
            }

            const worldScale = new THREE.Vector3(1, 1, 1);
            node.getWorldScale(worldScale);
            const maxScale = Math.max(Math.abs(worldScale.x), Math.abs(worldScale.y), Math.abs(worldScale.z), 1e-6);
            const candidateRadius = Math.max(geometryParams.radiusTop, geometryParams.radiusBottom) * maxScale;
            if (!Number.isFinite(candidateRadius) || candidateRadius <= 0) {
                return;
            }

            detectedRadiusMeters = Math.max(detectedRadiusMeters || 0, candidateRadius);
        });

        return Number.isFinite(detectedRadiusMeters) ? detectedRadiusMeters : null;
    }

    sampleWheelCenterZForChart(nowSec) {
        if (!this.viewer?.robotModel?.links) {
            return;
        }

        const linkMap = this.viewer.robotModel.links || {};
        Object.entries(this.wheelLinkNameByKey).forEach(([wheelKey, wheelLinkName]) => {
            const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
            if (!wheelLink) {
                return;
            }

            if (!Number.isFinite(this.wheelRadiusMetersByKey[wheelKey])) {
                const extractedRadius = this.extractWheelRadiusMetersFromLink(wheelLink);
                if (Number.isFinite(extractedRadius)) {
                    this.wheelRadiusMetersByKey[wheelKey] = extractedRadius;
                }
            }

            const wheelRadiusMeters = Number.isFinite(this.wheelRadiusMetersByKey[wheelKey])
                ? this.wheelRadiusMetersByKey[wheelKey]
                : Math.max(Number(this.wheelEffectiveRadiusMeters) || 0.16, 0.05);

            wheelLink.updateWorldMatrix(true, true);
            const centerWorld = new THREE.Vector3();
            wheelLink.getWorldPosition(centerWorld);
            const zValue = Number(centerWorld.z - wheelRadiusMeters);

            if (!Number.isFinite(zValue)) {
                return;
            }

            this.wheelZChartHistoryByKey[wheelKey].push({ t: nowSec, z: zValue });
        });

        this.trimWheelZChartHistory(nowSec);
    }

    renderWheelZChart(nowSec) {
        const ctx = this.wheelZChartContext;
        const canvas = this.wheelZChartCanvasElement;
        if (!ctx || !canvas || !this.isWheelZChartVisible) {
            return;
        }

        const dpr = Math.max(window.devicePixelRatio || 1, 1);
        const cssWidth = Math.max(Math.floor(canvas.clientWidth || 344), 120);
        const cssHeight = Math.max(Math.floor(canvas.clientHeight || 154), 90);
        const targetWidth = Math.floor(cssWidth * dpr);
        const targetHeight = Math.floor(cssHeight * dpr);
        if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
            canvas.width = targetWidth;
            canvas.height = targetHeight;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const width = cssWidth;
        const height = cssHeight;
        ctx.clearRect(0, 0, width, height);

        const margin = { left: 38, right: 12, top: 12, bottom: 24 };
        const plotWidth = width - margin.left - margin.right;
        const plotHeight = height - margin.top - margin.bottom;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);

        const rawSamples = [];
        Object.keys(this.wheelZChartHistoryByKey).forEach((wheelKey) => {
            const samples = this.wheelZChartHistoryByKey[wheelKey] || [];
            rawSamples.push(...samples);
        });

        const maxMeasuredCount = 20;
        const uniqueSampleTimesSec = Array.from(new Set(rawSamples.map((sample) => sample.t))).sort((a, b) => a - b);
        const recentSampleTimesSec = uniqueSampleTimesSec.slice(-maxMeasuredCount);
        const hasRecentSamples = recentSampleTimesSec.length > 0;
        const minTimeSec = hasRecentSamples ? recentSampleTimesSec[0] : Math.max(nowSec - this.wheelZChartWindowSec, 0);
        const windowEndSec = hasRecentSamples ? recentSampleTimesSec[recentSampleTimesSec.length - 1] : nowSec;
        const effectiveWindowSec = Math.max(windowEndSec - minTimeSec, this.physicsFixedTimeStepSec);

        const visibleSamples = rawSamples.filter((sample) => sample.t >= minTimeSec && sample.t <= windowEndSec);

        const hasVisibleSamples = visibleSamples.length > 0;
        let minZ = hasVisibleSamples ? Math.min(...visibleSamples.map((sample) => sample.z)) : Number.POSITIVE_INFINITY;
        let maxZ = hasVisibleSamples ? Math.max(...visibleSamples.map((sample) => sample.z)) : Number.NEGATIVE_INFINITY;

        const maxHoleDepthMeters = (Array.isArray(this.holeRegions) ? this.holeRegions : []).reduce((maxDepth, holeRegion) => {
            const floorZ = Number(holeRegion?.floorZ);
            if (!Number.isFinite(floorZ) || !Number.isFinite(this.groundZ)) {
                return maxDepth;
            }

            const depth = Math.max(this.groundZ - floorZ, 0);
            return Math.max(maxDepth, depth);
        }, 0);
        if (maxHoleDepthMeters > 0 && Number.isFinite(this.groundZ)) {
            const holeMinZ = this.groundZ - maxHoleDepthMeters;
            minZ = Math.min(minZ, holeMinZ);
            if (!hasVisibleSamples) {
                maxZ = Number.isFinite(this.groundZ) ? this.groundZ : Math.max(maxZ, holeMinZ + 0.05);
            }
        }

        if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
            minZ = 0;
            maxZ = 0.05;
        }

        if ((maxZ - minZ) < 0.001) {
            maxZ += 0.0005;
            minZ -= 0.0005;
        }
        const zPadding = (maxZ - minZ) * 0.12;
        minZ -= zPadding;
        maxZ += zPadding;

        // Snap Y-axis to integer centimeter intervals for stable, easy-to-read labels.
        const intervalCount = 4;
        const rawMinCm = minZ * 100;
        const rawMaxCm = maxZ * 100;
        const spanCm = Math.max(rawMaxCm - rawMinCm, 1);
        const stepCm = Math.max(1, Math.ceil(spanCm / intervalCount));
        const minCmAligned = Math.floor(rawMinCm / stepCm) * stepCm;
        const maxCmAligned = minCmAligned + (stepCm * intervalCount);
        minZ = minCmAligned / 100;
        maxZ = maxCmAligned / 100;

        const toX = (t) => margin.left + ((t - minTimeSec) / effectiveWindowSec) * plotWidth;
        const toY = (z) => margin.top + ((maxZ - z) / (maxZ - minZ)) * plotHeight;

        const maxTickCount = 8;
        const xStepSec = effectiveWindowSec / Math.max(maxTickCount - 1, 1);
        const xTickValuesSec = [];
        for (let i = 0; i < maxTickCount; i += 1) {
            xTickValuesSec.push(minTimeSec + (xStepSec * i));
        }
        if (xTickValuesSec.length === 0) {
            xTickValuesSec.push(minTimeSec, windowEndSec);
        }

        const formatXAxisTimeLabel = (timeSec) => {
            const absSpanSec = Math.max(effectiveWindowSec, 1e-6);
            if (absSpanSec >= 3600) {
                return `${(timeSec / 3600).toFixed(1)}h`;
            }
            if (absSpanSec >= 120) {
                return `${(timeSec / 60).toFixed(1)}m`;
            }
            if (absSpanSec < 10) {
                return `${timeSec.toFixed(1)}s`;
            }
            return `${timeSec.toFixed(0)}s`;
        };

        ctx.strokeStyle = '#d6deea';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i += 1) {
            const gy = margin.top + (plotHeight / 4) * i;
            ctx.beginPath();
            ctx.moveTo(margin.left, gy);
            ctx.lineTo(margin.left + plotWidth, gy);
            ctx.stroke();
        }
        xTickValuesSec.forEach((tickTimeSec) => {
            const gx = toX(tickTimeSec);
            ctx.beginPath();
            ctx.moveTo(gx, margin.top);
            ctx.lineTo(gx, margin.top + plotHeight);
            ctx.stroke();
        });

        ctx.strokeStyle = '#495057';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(margin.left, margin.top + plotHeight);
        ctx.lineTo(margin.left + plotWidth, margin.top + plotHeight);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(margin.left, margin.top);
        ctx.lineTo(margin.left, margin.top + plotHeight);
        ctx.stroke();

        ctx.fillStyle = '#5f6b7a';
        ctx.font = '11px Segoe UI';
        xTickValuesSec.forEach((tickTimeSec, tickIndex) => {
            if (tickIndex === 0) {
                return;
            }

            const labelX = toX(tickTimeSec);
            const label = formatXAxisTimeLabel(tickTimeSec);
            ctx.fillText(label, labelX - 12, margin.top + plotHeight + 16);
        });

        const zTicks = intervalCount;
        ctx.fillText('cm', 8, 10);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let i = 0; i <= zTicks; i += 1) {
            const ratio = i / zTicks;
            const z = maxZ - (maxZ - minZ) * ratio;
            const y = margin.top + plotHeight * ratio;
            ctx.fillText(String(Math.round(z * 100)), margin.left - 4, y);
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        // Small per-wheel Y pixel offset so lines stay visible when values are identical.
        const yPixelOffsetByKey = { fl: -2, fr: -1, rl: 1, rr: 2 };

        Object.keys(this.wheelZChartHistoryByKey).forEach((wheelKey) => {
            const samples = (this.wheelZChartHistoryByKey[wheelKey] || [])
                .filter((sample) => sample.t >= minTimeSec && sample.t <= windowEndSec);
            if (samples.length < 2) {
                return;
            }

            // Keep visual spacing readable by rendering a decimated subset.
            const minPixelGap = 12;
            const targetPointCount = Math.max(Math.floor(plotWidth / minPixelGap), 1);
            const minTimeGapSec = effectiveWindowSec / targetPointCount;
            const renderSamples = [];
            let lastAcceptedTimeSec = Number.NEGATIVE_INFINITY;
            for (let i = 0; i < samples.length; i += 1) {
                const sample = samples[i];
                const isLast = i === (samples.length - 1);
                if ((sample.t - lastAcceptedTimeSec) >= minTimeGapSec || isLast) {
                    renderSamples.push(sample);
                    lastAcceptedTimeSec = sample.t;
                }
            }
            if (renderSamples.length < 2) {
                return;
            }

            const yOffset = yPixelOffsetByKey[wheelKey] || 0;
            const seriesColor = this.wheelChartColorByKey[wheelKey] || '#222';
            ctx.strokeStyle = seriesColor;
            ctx.lineWidth = 1.7;
            ctx.beginPath();
            renderSamples.forEach((sample, index) => {
                const x = toX(sample.t);
                const y = toY(sample.z) + yOffset;
                if (index === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });
            ctx.stroke();

            ctx.fillStyle = seriesColor;
            renderSamples.forEach((sample) => {
                const x = toX(sample.t);
                const y = toY(sample.z) + yOffset;
                const markerSize = 5.0;
                ctx.beginPath();
                if (wheelKey === 'fl') {
                    // Circle marker
                    ctx.arc(x, y, markerSize * 0.5, 0, Math.PI * 2);
                } else if (wheelKey === 'fr') {
                    // Square marker
                    ctx.rect(x - markerSize * 0.5, y - markerSize * 0.5, markerSize, markerSize);
                } else if (wheelKey === 'rl') {
                    // Triangle marker
                    ctx.moveTo(x, y - markerSize * 0.7);
                    ctx.lineTo(x + markerSize * 0.65, y + markerSize * 0.5);
                    ctx.lineTo(x - markerSize * 0.65, y + markerSize * 0.5);
                    ctx.closePath();
                } else {
                    // Diamond marker (rr)
                    ctx.moveTo(x, y - markerSize * 0.8);
                    ctx.lineTo(x + markerSize * 0.8, y);
                    ctx.lineTo(x, y + markerSize * 0.8);
                    ctx.lineTo(x - markerSize * 0.8, y);
                    ctx.closePath();
                }
                ctx.fill();
            });
        });

        const legendKeys = ['fl', 'fr', 'rl', 'rr'];
        const legendX = margin.left + plotWidth - 50;
        const legendStartY = margin.top + 14;
        const legendRowHeight = 18;
        ctx.font = '13px Segoe UI';
        ctx.textBaseline = 'middle';
        legendKeys.forEach((wheelKey, index) => {
            const legendY = legendStartY + (legendRowHeight * index);
            ctx.fillStyle = this.wheelChartColorByKey[wheelKey] || '#222';
            ctx.fillRect(legendX, legendY - 4, 14, 6);
            ctx.fillStyle = '#334155';
            ctx.fillText(wheelKey.toUpperCase(), legendX + 19, legendY);
        });
        ctx.textBaseline = 'alphabetic';
    }

    updateDebugPanel(deltaSec = 0) {
        if (!this.debugTextElement) {
            return;
        }

        this.debugStatusElapsedSec += Math.max(Number(deltaSec) || 0, 0);
        if (this.debugStatusElapsedSec < this.debugStatusUpdateIntervalSec) {
            return;
        }
        this.debugStatusElapsedSec = 0;

        const activeViewerId = String(window.activeURDFViewer?.container?.id || 'null');
        const simulationViewerId = String(this.viewer?.container?.id || 'null');
        const driveViewer = this.getDriveSourceViewer();
        const driveViewerId = String(driveViewer?.container?.id || 'null');
        const driveMode = String(this.commandedDriveMode || driveViewer?.driveMode || this.viewer?.driveMode || 'stop');
        const speedMpsInput = Number(this.commandedSpeedMps);
        const speedKmhInput = this.mpsToKmh(speedMpsInput);
        const speedMps = this.getCommandedDriveSpeedMps();
        const visualSpeedScale = Number(this.visualSpeedScale);
        const isReady = this.isReady ? 'Y' : 'N';
        const isFailed = this.hasFailed ? 'Y' : 'N';
        const isPaused = this.isPaused ? 'Y' : 'N';
        const hookState = this.hasInstalledDriveCommandHooks ? 'Y' : 'N';

        let bodySummary = 'body=unavailable';
        let obstacleSummary = 'wheelPlaneZ=n/a rock01TopZ=n/a underbodyGap=n/a';
        if (this.body) {
            const pos = this.body.translation();
            const vel = this.body.linvel();
            bodySummary = `pos=(${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)}) vel=(${vel.x.toFixed(3)}, ${vel.y.toFixed(3)}, ${vel.z.toFixed(3)})`;

            const wheelContactPlaneZ = this.getWheelContactPlaneZ();
            const obstacleRock01TopZ = this.getObstacleTopZByName('obstacle_rock_01');
            const gap = Number.isFinite(wheelContactPlaneZ) && Number.isFinite(obstacleRock01TopZ)
                ? (wheelContactPlaneZ - obstacleRock01TopZ)
                : null;

            obstacleSummary = `wheelPlaneZ=${Number.isFinite(wheelContactPlaneZ) ? wheelContactPlaneZ.toFixed(3) : 'n/a'} rock01TopZ=${Number.isFinite(obstacleRock01TopZ) ? obstacleRock01TopZ.toFixed(3) : 'n/a'} underbodyGap=${Number.isFinite(gap) ? gap.toFixed(3) : 'n/a'}`;
        }

        this.debugTextElement.textContent = [
            `ready=${isReady} failed=${isFailed} paused=${isPaused} hooks=${hookState}`,
            `activeViewer=${activeViewerId}`,
            `simulationViewer=${simulationViewerId}`,
            `driveViewer=${driveViewerId}`,
            `visualSpeed=${Number.isFinite(visualSpeedScale) ? this.formatVisualSpeedScaleLabel(visualSpeedScale) : 'NaN'}`,
            `mode=${driveMode} inputMps=${Number.isFinite(speedMpsInput) ? speedMpsInput.toFixed(1) : 'NaN'} inputKmh=${Number.isFinite(speedKmhInput) ? speedKmhInput.toFixed(1) : 'NaN'} speedMps=${Number.isFinite(speedMps) ? speedMps.toFixed(3) : 'NaN'}`,
            bodySummary,
            obstacleSummary
        ].join('\n');
    }

    installDriveCommandHooks() {
        if (this.hasInstalledDriveCommandHooks) {
            return;
        }

        let hasHookedAnyCommand = false;

        const originalSetDriveMode = globalThis.setDriveMode;
        if (typeof originalSetDriveMode === 'function') {
            globalThis.setDriveMode = (mode) => {
                this.commandedDriveMode = String(mode || 'stop');
                return originalSetDriveMode(mode);
            };
            hasHookedAnyCommand = true;
        }

        const originalSetDriveSpeedKmh = globalThis.setDriveSpeedKmh;
        if (typeof originalSetDriveSpeedKmh === 'function') {
            globalThis.setDriveSpeedKmh = (kmh) => {
                const numericKmh = Number.parseFloat(kmh);
                if (Number.isFinite(numericKmh)) {
                    this.commandedSpeedMps = this.normalizeDriveSpeedMps(this.kmhToMps(numericKmh), SIM_SPEED_DEFAULT_MPS);
                }
                return originalSetDriveSpeedKmh(kmh);
            };
            hasHookedAnyCommand = true;
        }

        // Keep retrying on later frames until command functions are available and wrapped.
        this.hasInstalledDriveCommandHooks = hasHookedAnyCommand;
    }

    syncInitialDriveStateFromUi() {
        const speedInput = document.getElementById('drive-speed-mps');
        const initialSpeedMps = speedInput
            ? Number.parseFloat(speedInput.value)
            : SIM_SPEED_DEFAULT_MPS;

        this.commandedDriveMode = 'stop';
        this.commandedSpeedMps = this.normalizeDriveSpeedMps(initialSpeedMps, SIM_SPEED_DEFAULT_MPS);

        if (typeof globalThis.setDriveSpeedKmh === 'function') {
            globalThis.setDriveSpeedKmh(this.mpsToKmh(this.commandedSpeedMps));
        }

        if (typeof globalThis.setDriveMode === 'function') {
            globalThis.setDriveMode('stop');
        }
    }

    stopSimulationMotion() {
        if (this.body && this.rapier) {
            const translation = this.body.translation();
            const rotation = this.body.rotation();
            this.body.setTranslation(new this.rapier.Vector3(translation.x, translation.y, translation.z), true);
            this.body.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }, true);
            this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
            this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
        }

        ['fl', 'fr', 'rl', 'rr'].forEach((key) => {
            if (typeof globalThis.setWheelAnimationByKey === 'function') {
                globalThis.setWheelAnimationByKey(key, 0);
            }
        });

        this.hasActivatedSimulationMotion = false;
        this.hasActivatedDynamicGroundClamp = false;

        if (this.carFrame) {
            this.syncCarFrameFromBody();
        }
    }

    applyDriveModeCommand(mode) {
        const normalizedMode = String(mode || 'stop');
        this.commandedDriveMode = normalizedMode;

        if (normalizedMode === 'stop') {
            this.stopSimulationMotion();
        }

        if (typeof globalThis.setDriveMode === 'function') {
            globalThis.setDriveMode(normalizedMode);
            return;
        }

        const viewer = this.getDriveSourceViewer() || this.viewer;
        if (viewer && typeof viewer.applyDriveMode === 'function') {
            const speedKmh = Math.max(this.mpsToKmh(this.commandedSpeedMps), 0);
            viewer.applyDriveMode(normalizedMode, speedKmh);
        }
    }

    applyDriveSpeedCommandMps(mps) {
        const normalizedMps = this.normalizeDriveSpeedMps(mps, 0);
        this.commandedSpeedMps = normalizedMps;

        if (typeof globalThis.setDriveSpeedKmh === 'function') {
            globalThis.setDriveSpeedKmh(this.mpsToKmh(normalizedMps));
            return;
        }

        const viewer = this.getDriveSourceViewer() || this.viewer;
        if (!viewer) {
            return;
        }

        const normalizedKmh = this.mpsToKmh(normalizedMps);
        viewer.driveSpeedKmh = normalizedKmh;
        if (viewer.driveMode && viewer.driveMode !== 'stop' && typeof viewer.applyDriveMode === 'function') {
            viewer.applyDriveMode(viewer.driveMode, normalizedKmh);
        }
    }

    applyDriveSpeedCommandKmh(kmh) {
        this.applyDriveSpeedCommandMps(this.kmhToMps(kmh));
    }

    findSimulationViewer() {
        const viewerById = window.urdfViewersById?.['robot-container-1'] || null;
        if (viewerById) {
            return viewerById;
        }

        if (Array.isArray(window.urdfViewers)) {
            const matched = window.urdfViewers.find((viewer) => {
                const urdfPath = String(viewer?.urdfPath || '');
                return urdfPath.includes('/model/vehicle/vehicle.urdf');
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
        return this.computeLinkOwnBoundsWithMeshFilter(linkObject, linkMap, null);
    }

    computeLinkOwnBoundsWithMeshFilter(linkObject, linkMap, meshFilter) {
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

            if (typeof meshFilter === 'function' && !meshFilter(node)) {
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

    computeGroundBoundsPreferCollision(linkObject, linkMap) {
        if (!linkObject) {
            return null;
        }

        const collisionBounds = this.computeLinkOwnBoundsWithMeshFilter(linkObject, linkMap, (node) => {
            const nodeName = String(node?.name || '').toLowerCase();
            const parentName = String(node?.parent?.name || '').toLowerCase();
            const userDataType = String(node?.userData?.type || '').toLowerCase();
            const userDataTag = String(node?.userData?.urdfTag || '').toLowerCase();
            const hint = `${nodeName} ${parentName} ${userDataType} ${userDataTag}`;
            return hint.includes('collision');
        });

        if (collisionBounds && !collisionBounds.isEmpty()) {
            return collisionBounds;
        }

        return this.computeLinkOwnBounds(linkObject, linkMap);
    }

    computeChassisBounds(carFrame, linkMap) {
        const fallbackBounds = new THREE.Box3().setFromObject(carFrame);
        if (!carFrame || !linkMap) {
            return fallbackBounds;
        }

        const obstacleLinkNames = this.getObstacleLinkNamesFromMap(linkMap);
        const obstacleRoots = obstacleLinkNames.map((name) => linkMap[name]).filter(Boolean);
        const excludedRoots = [...obstacleRoots].filter(Boolean);
        const ignoredChassisLinkNames = [
            'wheel_fl',
            'wheel_fr',
            'wheel_rl',
            'wheel_rr',
            'gear_fl',
            'gear_fr',
            'gear_rl',
            'gear_rr'
        ];

        ignoredChassisLinkNames.forEach((name) => {
            const ignoredRoot = this.findLinkByName(linkMap, name);
            if (ignoredRoot && !excludedRoots.includes(ignoredRoot)) {
                excludedRoots.push(ignoredRoot);
            }
        });

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
            const isOriginObject = /(^|[_-])origin($|[_-])/i.test(name) || /(^|[_-])origin($|[_-])/i.test(normalizedName);
            if (isOriginObject) {
                return;
            }

            const matchedByExactName = targetNames.has(String(name).toLowerCase()) || targetNames.has(normalizedName);
            const matchedByPattern = this.urdfObstacleLinkNamePatterns.some((pattern) => pattern.test(name) || pattern.test(normalizedName));
            const matched = matchedByExactName || matchedByPattern;
            if (matched) {
                names.add(name);
            }
        });

        return Array.from(names);
    }

    isTextInputElement(targetElement) {
        if (!targetElement || typeof targetElement !== 'object') {
            return false;
        }

        const tagName = String(targetElement.tagName || '').toLowerCase();
        return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || Boolean(targetElement.isContentEditable);
    }

    getSignedWheelRpmSnapshotByKey(viewer) {
        if (!viewer) {
            return null;
        }

        const wheelKeys = ['fl', 'fr', 'rl', 'rr'];
        const snapshot = {};
        wheelKeys.forEach((key) => {
            let signedRpm = null;
            if (typeof viewer.getSignedWheelRpm === 'function') {
                const value = Number(viewer.getSignedWheelRpm(key));
                if (Number.isFinite(value)) {
                    signedRpm = value;
                }
            }

            if (!Number.isFinite(signedRpm)) {
                const rpm = Number(viewer?.wheelSpeedRpmByKey?.[key]);
                const sign = Number(viewer?.wheelDirectionSignByKey?.[key]);
                if (Number.isFinite(rpm)) {
                    signedRpm = rpm * (Number.isFinite(sign) ? sign : 1);
                }
            }

            snapshot[key] = Number.isFinite(signedRpm) ? signedRpm : 0;
        });

        return snapshot;
    }

    togglePause(forcePaused = null) {
        const nextPausedState = (typeof forcePaused === 'boolean')
            ? forcePaused
            : !this.isPaused;

        if (this.isPaused === nextPausedState) {
            return;
        }

        this.isPaused = nextPausedState;
        this.lastStepTimeMs = 0;

        if (this.isPaused) {
            const driveViewer = this.getDriveSourceViewer();
            const snapshotDriveMode = String(this.commandedDriveMode || driveViewer?.driveMode || this.viewer?.driveMode || 'stop');
            const snapshotSpeedMps = this.normalizeDriveSpeedMps(
                Number.isFinite(Number(this.commandedSpeedMps))
                    ? this.commandedSpeedMps
                    : this.kmhToMps(Number(driveViewer?.driveSpeedKmh) || 0),
                SIM_SPEED_DEFAULT_MPS
            );
            this.pauseStateSnapshot = {
                driveMode: snapshotDriveMode,
                speedMps: snapshotSpeedMps,
                wheelSignedRpmByKey: this.getSignedWheelRpmSnapshotByKey(driveViewer)
            };

            this.keyHoldState.ArrowUp = 0;
            this.keyHoldState.ArrowDown = 0;
            this.keyHoldState.ArrowLeft = 0;
            this.keyHoldState.ArrowRight = 0;

            // Pause mode should freeze visual wheel rotation as well.
            this.applyDriveModeCommand('stop');
            ['fl', 'fr', 'rl', 'rr'].forEach((key) => {
                if (typeof globalThis.setWheelAnimationByKey === 'function') {
                    globalThis.setWheelAnimationByKey(key, 0);
                }
            });

            if (this.body && this.rapier) {
                this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
                this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
            }
        } else if (this.pauseStateSnapshot) {
            const snapshot = this.pauseStateSnapshot;
            this.applyDriveSpeedCommandMps(snapshot.speedMps);
            this.applyDriveModeCommand(snapshot.driveMode);

            if (snapshot.driveMode === 'stop' && snapshot.wheelSignedRpmByKey) {
                Object.entries(snapshot.wheelSignedRpmByKey).forEach(([key, signedRpm]) => {
                    if (typeof globalThis.setWheelAnimationByKey === 'function') {
                        globalThis.setWheelAnimationByKey(key, signedRpm);
                    }
                });
            }

            this.pauseStateSnapshot = null;
        }

        this.updateDebugPanel(this.debugStatusUpdateIntervalSec);
        console.log(`[URDF][Simulation] ${this.isPaused ? 'Paused' : 'Resumed'}`);
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
            if (this.isTextInputElement(event.target)) {
                return;
            }

            const isSpaceKey = event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
            if (isSpaceKey) {
                if (event.ctrlKey) {
                    this.reset();
                } else {
                    this.togglePause();
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
        const speedSlider = document.getElementById('drive-speed-mps');
        const speedLabel = document.getElementById('drive-speed-mps-value');
        const speedInput = document.getElementById('drive-speed-mps-input');
        if (!speedSlider) {
            return;
        }

        const sliderMin = Number.parseFloat(speedSlider.min);
        const sliderMax = Number.parseFloat(speedSlider.max);
        const effectiveMin = Number.isFinite(sliderMin) ? sliderMin : 0;
        const effectiveMax = Number.isFinite(sliderMax) && sliderMax >= effectiveMin
            ? sliderMax
            : SIM_SPEED_MAX_MPS;

        const parseSpeed = (rawValue, fallbackValue) => {
            const numeric = Number.parseFloat(rawValue);
            if (!Number.isFinite(numeric)) {
                return fallbackValue;
            }
            const clamped = Math.max(effectiveMin, Math.min(effectiveMax, numeric));
            return Math.round(clamped * 10) / 10;
        };

        let initialSpeed = SIM_SPEED_DEFAULT_MPS;
        try {
            const storedValue = window.localStorage.getItem(SIM_SPEED_STORAGE_KEY);
            if (storedValue != null) {
                initialSpeed = parseSpeed(storedValue, SIM_SPEED_DEFAULT_MPS);
            } else {
                const legacyKmhValue = window.localStorage.getItem(SIM_SPEED_LEGACY_STORAGE_KEY);
                if (legacyKmhValue != null) {
                    initialSpeed = parseSpeed(this.kmhToMps(legacyKmhValue), SIM_SPEED_DEFAULT_MPS);
                }
            }
        } catch (error) {
            initialSpeed = SIM_SPEED_DEFAULT_MPS;
        }

        speedSlider.value = initialSpeed.toFixed(1);
        this.updateSpeedSliderVisual(speedSlider);
        if (speedInput) {
            speedInput.value = initialSpeed.toFixed(1);
        }
        if (speedLabel) {
            speedLabel.textContent = `${initialSpeed.toFixed(1)} m/s`;
        }

        this.applyDriveSpeedCommandMps(initialSpeed);

        const persistSpeed = () => {
            const normalizedSpeed = parseSpeed(speedSlider.value, SIM_SPEED_DEFAULT_MPS);
            speedSlider.value = normalizedSpeed.toFixed(1);
            if (speedInput) {
                speedInput.value = normalizedSpeed.toFixed(1);
            }
            if (speedLabel) {
                speedLabel.textContent = `${normalizedSpeed.toFixed(1)} m/s`;
            }
            this.applyDriveSpeedCommandMps(normalizedSpeed);
            try {
                window.localStorage.setItem(SIM_SPEED_STORAGE_KEY, String(normalizedSpeed));
            } catch (error) {
                // Ignore storage failures and continue runtime behavior.
            }
        };

        speedSlider.addEventListener('input', persistSpeed);
        speedSlider.addEventListener('change', persistSpeed);
        if (speedInput) {
            speedInput.addEventListener('input', () => {
                const normalizedSpeed = parseSpeed(speedInput.value, SIM_SPEED_DEFAULT_MPS);
                speedSlider.value = normalizedSpeed.toFixed(1);
                this.updateSpeedSliderVisual(speedSlider);
                if (speedLabel) {
                    speedLabel.textContent = `${normalizedSpeed.toFixed(1)} m/s`;
                }
                this.applyDriveSpeedCommandMps(normalizedSpeed);
                try {
                    window.localStorage.setItem(SIM_SPEED_STORAGE_KEY, String(normalizedSpeed));
                } catch (error) {
                    // Ignore storage failures and continue runtime behavior.
                }
            });
        }
    }

    normalizeVisualSpeedScale(rawValue) {
        const numericValue = Number.parseFloat(rawValue);
        if (!Number.isFinite(numericValue)) {
            return SIM_VISUAL_SPEED_DEFAULT_SCALE;
        }

        if (numericValue > SIM_VISUAL_SPEED_LEGACY_MAX_SCALE) {
            const denominator = Math.max(
                SIM_VISUAL_SPEED_MIN_DENOMINATOR,
                Math.min(SIM_VISUAL_SPEED_MAX_DENOMINATOR, Math.round(numericValue))
            );
            return 1 / denominator;
        }

        return Math.max(SIM_VISUAL_SPEED_MIN_SCALE, Math.min(SIM_VISUAL_SPEED_MAX_SCALE, numericValue));
    }

    normalizeVisualSpeedSliderValue(rawValue) {
        const numericValue = Number.parseFloat(rawValue);
        if (!Number.isFinite(numericValue)) {
            return Math.round(1 / SIM_VISUAL_SPEED_DEFAULT_SCALE);
        }

        return Math.max(
            SIM_VISUAL_SPEED_MIN_DENOMINATOR,
            Math.min(SIM_VISUAL_SPEED_MAX_DENOMINATOR, Math.round(numericValue))
        );
    }

    getVisualSpeedSliderValueFromScale(scale) {
        const normalizedScale = this.normalizeVisualSpeedScale(scale);
        const denominator = Math.round(1 / Math.max(normalizedScale, SIM_VISUAL_SPEED_MIN_SCALE));
        return this.normalizeVisualSpeedSliderValue(denominator);
    }

    formatVisualSpeedScaleLabel(scale) {
        const denominator = this.getVisualSpeedSliderValueFromScale(scale);
        return denominator <= 1 ? '1x' : `1/${denominator}x`;
    }

    applyVisualSpeedScale(value) {
        const normalizedScale = this.normalizeVisualSpeedScale(value);
        this.visualSpeedScale = normalizedScale;

        const speedSlider = document.getElementById('simulation-visual-speed-scale');
        const speedLabel = document.getElementById('simulation-visual-speed-scale-value');
        if (speedSlider) {
            speedSlider.value = String(this.getVisualSpeedSliderValueFromScale(normalizedScale));
            this.updateSpeedSliderVisual(speedSlider);
        }
        if (speedLabel) {
            speedLabel.textContent = this.formatVisualSpeedScaleLabel(normalizedScale);
        }

        try {
            window.localStorage.setItem(SIM_VISUAL_SPEED_STORAGE_KEY, String(normalizedScale));
        } catch (error) {
            // Ignore storage failures and continue runtime behavior.
        }
    }

    initializeVisualSpeedSliderPreference() {
        const speedSlider = document.getElementById('simulation-visual-speed-scale');
        const speedLabel = document.getElementById('simulation-visual-speed-scale-value');
        if (!speedSlider) {
            return;
        }

        let initialScale = SIM_VISUAL_SPEED_DEFAULT_SCALE;
        try {
            const storedValue = window.localStorage.getItem(SIM_VISUAL_SPEED_STORAGE_KEY);
            if (storedValue != null) {
                initialScale = this.normalizeVisualSpeedScale(storedValue);
            }
        } catch (error) {
            initialScale = SIM_VISUAL_SPEED_DEFAULT_SCALE;
        }

        speedSlider.value = String(this.getVisualSpeedSliderValueFromScale(initialScale));
        this.updateSpeedSliderVisual(speedSlider);
        if (speedLabel) {
            speedLabel.textContent = this.formatVisualSpeedScaleLabel(initialScale);
        }

        this.visualSpeedScale = initialScale;

        const persistScale = () => {
            const normalizedScale = this.normalizeVisualSpeedScale(speedSlider.value);
            this.visualSpeedScale = normalizedScale;
            if (speedLabel) {
                speedLabel.textContent = this.formatVisualSpeedScaleLabel(normalizedScale);
            }
            try {
                window.localStorage.setItem(SIM_VISUAL_SPEED_STORAGE_KEY, String(normalizedScale));
            } catch (error) {
                // Ignore storage failures and continue runtime behavior.
            }
        };

        speedSlider.addEventListener('input', persistScale);
        speedSlider.addEventListener('change', persistScale);
    }

    resetVisualSpeedSliderToDefault() {
        this.applyVisualSpeedScale(SIM_VISUAL_SPEED_DEFAULT_SCALE);
    }

    resetSpeedSliderToDefault() {
        const speedSlider = document.getElementById('drive-speed-mps');
        const speedLabel = document.getElementById('drive-speed-mps-value');
        const speedInput = document.getElementById('drive-speed-mps-input');
        if (!speedSlider) {
            return;
        }

        speedSlider.value = SIM_SPEED_DEFAULT_MPS.toFixed(1);
        this.updateSpeedSliderVisual(speedSlider);
        if (speedInput) {
            speedInput.value = SIM_SPEED_DEFAULT_MPS.toFixed(1);
        }

        if (speedLabel) {
            speedLabel.textContent = `${SIM_SPEED_DEFAULT_MPS.toFixed(1)} m/s`;
        }

        this.applyDriveSpeedCommandMps(SIM_SPEED_DEFAULT_MPS);

        try {
            window.localStorage.setItem(SIM_SPEED_STORAGE_KEY, String(SIM_SPEED_DEFAULT_MPS));
        } catch (error) {
            // Ignore storage failures and continue runtime behavior.
        }
    }

    addGroundCollider() {
        if (!this.world || !this.rapier || !this.initialPosition || !this.vehicleHalfExtents) {
            return;
        }

        const groundHalfThickness = 0.2;
        const holeFloorHalfThickness = 0.03;
        const minGroundPatchHalfExtent = 0.02;
        const linkMap = this.viewer?.robotModel?.links || {};
        const groundLink = this.findLinkByName(linkMap, 'ground')
            || this.findLinkByName(linkMap, 'ground_link')
            || this.findLinkByName(linkMap, 'ground_patch')
            || null;
        let groundBounds = null;

        if (groundLink) {
            groundLink.updateWorldMatrix(true, true);
            groundBounds = this.computeGroundBoundsPreferCollision(groundLink, linkMap);
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

        const fallbackGroundSize = 60;
        const groundMinX = (groundBounds && !groundBounds.isEmpty()) ? groundBounds.min.x : -fallbackGroundSize * 0.5;
        const groundMaxX = (groundBounds && !groundBounds.isEmpty()) ? groundBounds.max.x : fallbackGroundSize * 0.5;
        const groundMinY = (groundBounds && !groundBounds.isEmpty()) ? groundBounds.min.y : -fallbackGroundSize * 0.5;
        const groundMaxY = (groundBounds && !groundBounds.isEmpty()) ? groundBounds.max.y : fallbackGroundSize * 0.5;

        const holeLinkNames = Object.keys(linkMap).filter((name) => /hole|pothole/i.test(name));
        const holeRegions = [];
        holeLinkNames.forEach((holeLinkName) => {
            const holeLink = linkMap[holeLinkName];
            if (!holeLink) {
                return;
            }

            holeLink.updateWorldMatrix(true, true);
            const holeBounds = new THREE.Box3().setFromObject(holeLink);
            if (holeBounds.isEmpty()) {
                return;
            }

            const clampedMinX = Math.max(holeBounds.min.x, groundMinX);
            const clampedMaxX = Math.min(holeBounds.max.x, groundMaxX);
            const clampedMinY = Math.max(holeBounds.min.y, groundMinY);
            const clampedMaxY = Math.min(holeBounds.max.y, groundMaxY);

            if ((clampedMaxX - clampedMinX) <= 1e-4 || (clampedMaxY - clampedMinY) <= 1e-4) {
                return;
            }

            holeRegions.push({
                minX: clampedMinX,
                maxX: clampedMaxX,
                minY: clampedMinY,
                maxY: clampedMaxY,
                floorZ: holeBounds.min.z
            });
        });

        this.holeRegions = holeRegions;

        const subtractRect = (rect, cutRect) => {
            const overlapMinX = Math.max(rect.minX, cutRect.minX);
            const overlapMaxX = Math.min(rect.maxX, cutRect.maxX);
            const overlapMinY = Math.max(rect.minY, cutRect.minY);
            const overlapMaxY = Math.min(rect.maxY, cutRect.maxY);

            if (overlapMinX >= overlapMaxX || overlapMinY >= overlapMaxY) {
                return [rect];
            }

            const out = [];
            if (rect.minX < overlapMinX) {
                out.push({ minX: rect.minX, maxX: overlapMinX, minY: rect.minY, maxY: rect.maxY });
            }
            if (overlapMaxX < rect.maxX) {
                out.push({ minX: overlapMaxX, maxX: rect.maxX, minY: rect.minY, maxY: rect.maxY });
            }
            if (rect.minY < overlapMinY) {
                out.push({ minX: overlapMinX, maxX: overlapMaxX, minY: rect.minY, maxY: overlapMinY });
            }
            if (overlapMaxY < rect.maxY) {
                out.push({ minX: overlapMinX, maxX: overlapMaxX, minY: overlapMaxY, maxY: rect.maxY });
            }

            return out;
        };

        let groundPatches = [{ minX: groundMinX, maxX: groundMaxX, minY: groundMinY, maxY: groundMaxY }];
        holeRegions.forEach((holeRegion) => {
            const nextPatches = [];
            groundPatches.forEach((patch) => {
                nextPatches.push(...subtractRect(patch, holeRegion));
            });
            groundPatches = nextPatches;
        });

        const createFixedCuboidCollider = (centerX, centerY, centerZ, halfX, halfY, halfZ, friction = 0.25) => {
            const groundBodyDesc = this.rapier.RigidBodyDesc.fixed().setTranslation(centerX, centerY, centerZ);
            const groundBody = this.world.createRigidBody(groundBodyDesc);
            const groundColliderDesc = this.rapier.ColliderDesc.cuboid(halfX, halfY, halfZ)
                .setFriction(friction)
                .setRestitution(0.0);
            this.world.createCollider(groundColliderDesc, groundBody);
        };

        const groundCenterZ = this.groundZ - groundHalfThickness;
        groundPatches.forEach((patch) => {
            const width = patch.maxX - patch.minX;
            const depth = patch.maxY - patch.minY;
            const halfX = width * 0.5;
            const halfY = depth * 0.5;
            if (halfX < minGroundPatchHalfExtent || halfY < minGroundPatchHalfExtent) {
                return;
            }

            const centerX = (patch.minX + patch.maxX) * 0.5;
            const centerY = (patch.minY + patch.maxY) * 0.5;
            createFixedCuboidCollider(centerX, centerY, groundCenterZ, halfX, halfY, groundHalfThickness, 0.25);
        });

        holeRegions.forEach((holeRegion) => {
            const holeHalfX = (holeRegion.maxX - holeRegion.minX) * 0.5;
            const holeHalfY = (holeRegion.maxY - holeRegion.minY) * 0.5;
            if (holeHalfX < minGroundPatchHalfExtent || holeHalfY < minGroundPatchHalfExtent) {
                return;
            }

            const holeCenterX = (holeRegion.minX + holeRegion.maxX) * 0.5;
            const holeCenterY = (holeRegion.minY + holeRegion.maxY) * 0.5;
            const holeFloorCenterZ = holeRegion.floorZ - holeFloorHalfThickness;
            createFixedCuboidCollider(holeCenterX, holeCenterY, holeFloorCenterZ, holeHalfX, holeHalfY, holeFloorHalfThickness, 0.5);
        });
    }

    isVehicleOverHoleRegion() {
        if (!this.body || !Array.isArray(this.holeRegions) || this.holeRegions.length === 0) {
            return false;
        }

        const translation = this.body.translation();
        const halfX = Number.isFinite(this.vehicleColliderHalfExtents?.x)
            ? this.vehicleColliderHalfExtents.x
            : Math.max(Number(this.vehicleHalfExtents?.x) || 0.2, 0.05);
        const halfY = Number.isFinite(this.vehicleColliderHalfExtents?.y)
            ? this.vehicleColliderHalfExtents.y
            : Math.max(Number(this.vehicleHalfExtents?.y) || 0.2, 0.05);

        const vehicleMinX = translation.x - halfX;
        const vehicleMaxX = translation.x + halfX;
        const vehicleMinY = translation.y - halfY;
        const vehicleMaxY = translation.y + halfY;

        return this.holeRegions.some((holeRegion) => {
            if (!holeRegion) {
                return false;
            }

            const overlapX = vehicleMaxX >= holeRegion.minX && vehicleMinX <= holeRegion.maxX;
            const overlapY = vehicleMaxY >= holeRegion.minY && vehicleMinY <= holeRegion.maxY;
            return overlapX && overlapY;
        });
    }

    logWheelGroundDiagnosticsOnce(linkMap, stage = 'runtime') {
        if (this.hasLoggedGroundDiagnostics) {
            return;
        }

        if (!this.body || !Number.isFinite(this.groundZ)) {
            return;
        }

        const wheelMinZ = this.getWheelWorldMinZ(linkMap);
        if (!Number.isFinite(wheelMinZ)) {
            console.warn('[URDF][Simulation] wheel-ground diagnostics skipped: wheel bounds unavailable');
            this.hasLoggedGroundDiagnostics = true;
            return;
        }

        const bodyZ = this.body.translation().z;
        const gap = wheelMinZ - this.groundZ;
        console.log('[URDF][Simulation] wheel-ground diagnostics', {
            stage,
            groundZ: Number(this.groundZ.toFixed(6)),
            wheelMinZ: Number(wheelMinZ.toFixed(6)),
            wheelGroundGap: Number(gap.toFixed(6)),
            bodyZ: Number(bodyZ.toFixed(6)),
            groundContactLocalMinZ: Number.isFinite(this.groundContactLocalMinZ)
                ? Number(this.groundContactLocalMinZ.toFixed(6))
                : null
        });
        this.hasLoggedGroundDiagnostics = true;
    }

    addObstacleColliderFromUrdf() {
        if (!this.world || !this.rapier || !this.viewer?.robotModel || !this.carFrame) {
            return;
        }

        const linkMap = this.viewer.robotModel.links || {};
        const wheelLateralBands = this.getWheelLateralContactBands(linkMap);
        const obstacleLinkNames = this.getObstacleLinkNamesFromMap(linkMap);
        if (obstacleLinkNames.length === 0) {
            console.warn('[URDF][Simulation] URDF obstacle link not found. Expected one of:', this.urdfObstacleLinkNames);
            return;
        }

        this.obstacleColliders = [];
        this.obstacleColliderInfos = [];

        obstacleLinkNames.forEach((obstacleLinkName) => {
            const obstacleLink = linkMap[obstacleLinkName];
            obstacleLink.updateWorldMatrix(true, true);

            const fallbackBounds = new THREE.Box3().setFromObject(obstacleLink);
            const actualBounds = this.computeLinkOwnBounds(obstacleLink, linkMap) || fallbackBounds;
            const center = actualBounds.getCenter(new THREE.Vector3());
            const size = actualBounds.getSize(new THREE.Vector3());
            const halfX = Math.max(size.x * 0.5 + 0.08, 0.12);
            const halfY = Math.max(size.y * 0.5 + 0.08, 0.12);
            const halfZ = Math.max(size.z * 0.5 + 0.08, 0.12);
            const normalizedObstacleName = this.normalizeLinkName(obstacleLinkName);
            const isOriginObject = /(^|[_-])origin($|[_-])/i.test(obstacleLinkName) || /(^|[_-])origin($|[_-])/i.test(normalizedObstacleName);
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

            const obstacleTopZ = clampedCenterZ + halfZ;
            const wheelContactPlaneZ = this.getWheelContactPlaneZ();
            const passThroughClearance = Math.max(Number(this.underbodyPassThroughClearanceMeters) || 0, 0);
            const obstacleMinY = center.y - halfY;
            const obstacleMaxY = center.y + halfY;
            const overlapsWheelBand = wheelLateralBands.some((band) => {
                if (!band) {
                    return false;
                }

                return obstacleMaxY >= band.minY && obstacleMinY <= band.maxY;
            });

            // Do not auto-convert low obstacles to sensors.
            // Automatic conversion can disable wheel collision and cause visual penetration.
            const isUnderbodyPassThroughByHeight = false;
            const isUnderbodyPassThrough = false;

            // Only explicitly tagged links are sensors; generic obstacles must physically collide.
            if (isPassUnderTagged && typeof obstacleColliderDesc.setSensor === 'function') {
                obstacleColliderDesc.setSensor(true);
                console.log('[URDF][Simulation] obstacle treated as pass-under sensor:', {
                    obstacleLinkName,
                    isPassUnderTagged,
                    isUnderbodyPassThroughByHeight,
                    overlapsWheelBand,
                    obstacleTopZ: Number(obstacleTopZ.toFixed(4)),
                    wheelContactPlaneZ: Number.isFinite(wheelContactPlaneZ) ? Number(wheelContactPlaneZ.toFixed(4)) : null,
                    passThroughClearance: Number(passThroughClearance.toFixed(4))
                });
            }

            if (isOriginObject) {
                return;
            }

            const obstacleCollider = this.world.createCollider(obstacleColliderDesc, obstacleBody);
            this.obstacleColliders.push(obstacleCollider);
            this.obstacleColliderInfos.push({
                collider: obstacleCollider,
                center: new THREE.Vector3(center.x, center.y, clampedCenterZ),
                halfExtents: { x: halfX, y: halfY, z: halfZ },
                linkName: obstacleLinkName,
                normalizedLinkName: normalizedObstacleName,
                isSensor: Boolean(isPassUnderTagged),
                linkObject: obstacleLink,
                worldBounds: actualBounds.clone()
            });
            console.log(`[URDF][Simulation] obstacle collider created from URDF link: ${obstacleLinkName}`);
        });
    }

    getWheelLateralContactBands(linkMap) {
        if (!linkMap) {
            return [];
        }

        const wheelLinkNames = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
        const bands = [];

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

            const wheelCenter = wheelBounds.getCenter(new THREE.Vector3());
            const wheelSize = wheelBounds.getSize(new THREE.Vector3());
            const wheelRadius = Math.max(wheelSize.x * 0.5, wheelSize.z * 0.5, 0.05);
            bands.push({
                minY: wheelCenter.y - wheelRadius,
                maxY: wheelCenter.y + wheelRadius
            });
        });

        return bands;
    }

    getObstacleWorldBounds(obstacleInfo, linkMap = null) {
        if (!obstacleInfo) {
            return null;
        }

        if (obstacleInfo.worldBounds && !obstacleInfo.worldBounds.isEmpty()) {
            return obstacleInfo.worldBounds;
        }

        const effectiveLinkMap = linkMap || this.viewer?.robotModel?.links || null;
        const obstacleLink = obstacleInfo.linkObject
            || (effectiveLinkMap ? this.findLinkByName(effectiveLinkMap, obstacleInfo.linkName) : null)
            || null;

        if (!obstacleLink) {
            return null;
        }

        const bounds = this.computeLinkOwnBounds(obstacleLink, effectiveLinkMap);
        if (!bounds || bounds.isEmpty()) {
            return null;
        }

        obstacleInfo.worldBounds = bounds.clone();
        return obstacleInfo.worldBounds;
    }

    getVehicleCollisionBounds(linkMap = null) {
        const effectiveLinkMap = linkMap || this.viewer?.robotModel?.links || null;
        const boundsList = [];

        if (!effectiveLinkMap) {
            return boundsList;
        }

        if (this.carFrame) {
            const chassisBounds = this.computeChassisBounds(this.carFrame, effectiveLinkMap);
            if (chassisBounds && !chassisBounds.isEmpty()) {
                boundsList.push(chassisBounds.clone());
            }

            ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].forEach((wheelName) => {
                const wheelLink = this.findLinkByName(effectiveLinkMap, wheelName);
                if (!wheelLink) {
                    return;
                }

                const wheelBounds = this.computeLinkOwnBounds(wheelLink, effectiveLinkMap);
                if (wheelBounds && !wheelBounds.isEmpty()) {
                    boundsList.push(wheelBounds.clone());
                }
            });
        }

        if (boundsList.length === 0 && this.body) {
            const fallbackCenter = this.getVehicleColliderWorldCenter();
            const fallbackHalfExtents = this.getVehicleColliderWorldAabbHalfExtents();
            if (fallbackCenter && fallbackHalfExtents) {
                const fallbackBounds = new THREE.Box3(
                    new THREE.Vector3(
                        fallbackCenter.x - fallbackHalfExtents.x,
                        fallbackCenter.y - fallbackHalfExtents.y,
                        fallbackCenter.z - fallbackHalfExtents.z
                    ),
                    new THREE.Vector3(
                        fallbackCenter.x + fallbackHalfExtents.x,
                        fallbackCenter.y + fallbackHalfExtents.y,
                        fallbackCenter.z + fallbackHalfExtents.z
                    )
                );
                boundsList.push(fallbackBounds);
            }
        }

        return boundsList;
    }

    getWorldObbForObject(object3D) {
        if (!object3D) {
            return null;
        }

        object3D.updateWorldMatrix(true, true);
        const worldBounds = new THREE.Box3().setFromObject(object3D);
        if (!worldBounds || worldBounds.isEmpty()) {
            return null;
        }

        const center = worldBounds.getCenter(new THREE.Vector3());
        const size = worldBounds.getSize(new THREE.Vector3());
        const halfExtents = new THREE.Vector3(size.x * 0.5, size.y * 0.5, size.z * 0.5);
        const quaternion = new THREE.Quaternion();
        object3D.getWorldQuaternion(quaternion);
        const rotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(quaternion);
        const e = rotationMatrix.elements;

        const axisX = new THREE.Vector3(e[0], e[1], e[2]).normalize();
        const axisY = new THREE.Vector3(e[4], e[5], e[6]).normalize();
        const axisZ = new THREE.Vector3(e[8], e[9], e[10]).normalize();

        return {
            center,
            halfExtents,
            axes: [axisX, axisY, axisZ]
        };
    }

    getVehicleCollisionObbs(linkMap = null) {
        const effectiveLinkMap = linkMap || this.viewer?.robotModel?.links || null;
        const obbs = [];

        if (!effectiveLinkMap) {
            return obbs;
        }

        if (this.carFrame) {
            const chassisBounds = this.computeChassisBounds(this.carFrame, effectiveLinkMap);
            if (chassisBounds && !chassisBounds.isEmpty()) {
                const chassisObb = this.getWorldObbForObject(this.carFrame);
                if (chassisObb) {
                    chassisObb.center.copy(chassisBounds.getCenter(new THREE.Vector3()));
                    chassisObb.halfExtents.copy(chassisBounds.getSize(new THREE.Vector3()).multiplyScalar(0.5));
                    obbs.push(chassisObb);
                }
            }

            ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].forEach((wheelName) => {
                const wheelLink = this.findLinkByName(effectiveLinkMap, wheelName);
                if (!wheelLink) {
                    return;
                }

                const wheelObb = this.getWorldObbForObject(wheelLink);
                if (wheelObb) {
                    obbs.push(wheelObb);
                }
            });
        }

        return obbs;
    }

    getObstacleCollisionObb(obstacleInfo, linkMap = null) {
        if (!obstacleInfo) {
            return null;
        }

        const effectiveLinkMap = linkMap || this.viewer?.robotModel?.links || null;
        const obstacleObject = obstacleInfo.linkObject
            || (effectiveLinkMap ? this.findLinkByName(effectiveLinkMap, obstacleInfo.linkName) : null)
            || null;

        if (obstacleObject) {
            return this.getWorldObbForObject(obstacleObject);
        }

        if (obstacleInfo.center && obstacleInfo.halfExtents) {
            return {
                center: obstacleInfo.center.clone(),
                halfExtents: new THREE.Vector3(obstacleInfo.halfExtents.x, obstacleInfo.halfExtents.y, obstacleInfo.halfExtents.z),
                axes: [
                    new THREE.Vector3(1, 0, 0),
                    new THREE.Vector3(0, 1, 0),
                    new THREE.Vector3(0, 0, 1)
                ]
            };
        }

        return null;
    }

    obbIntersects(obbA, obbB, contactMarginMeters = 0) {
        if (!obbA || !obbB) {
            return false;
        }

        const margin = Math.max(Number(contactMarginMeters) || 0, 0);
        const centerOffset = obbB.center.clone().sub(obbA.center);
        const axesToTest = [];

        obbA.axes.forEach((axisA) => {
            obbB.axes.forEach((axisB) => {
                const crossAxis = axisA.clone().cross(axisB);
                if (crossAxis.lengthSq() > 1e-8) {
                    crossAxis.normalize();
                    axesToTest.push(crossAxis);
                }
            });
        });

        [...obbA.axes, ...obbB.axes].forEach((axis) => {
            if (axis && axis.lengthSq() > 1e-8) {
                const normalizedAxis = axis.clone().normalize();
                axesToTest.push(normalizedAxis);
            }
        });

        for (let i = 0; i < axesToTest.length; i += 1) {
            const axis = axesToTest[i];
            if (!axis || axis.lengthSq() <= 1e-8) {
                continue;
            }

            const radiusA = obbA.halfExtents.x * Math.abs(axis.dot(obbA.axes[0]))
                + obbA.halfExtents.y * Math.abs(axis.dot(obbA.axes[1]))
                + obbA.halfExtents.z * Math.abs(axis.dot(obbA.axes[2]));
            const radiusB = obbB.halfExtents.x * Math.abs(axis.dot(obbB.axes[0]))
                + obbB.halfExtents.y * Math.abs(axis.dot(obbB.axes[1]))
                + obbB.halfExtents.z * Math.abs(axis.dot(obbB.axes[2]));
            const projectedCenterOffset = Math.abs(centerOffset.dot(axis));

            if (projectedCenterOffset > (radiusA + radiusB + margin)) {
                return false;
            }
        }

        return true;
    }

    getVehicleColliderWorldCenter() {
        if (!this.body) {
            return null;
        }

        const bodyPosition = this.body.translation();
        const bodyRotation = this.body.rotation();
        const bodyQuat = new THREE.Quaternion(
            bodyRotation.x,
            bodyRotation.y,
            bodyRotation.z,
            bodyRotation.w
        ).normalize();
        const centerOffset = this.vehicleColliderLocalCenter.clone().applyQuaternion(bodyQuat);

        return new THREE.Vector3(
            bodyPosition.x + centerOffset.x,
            bodyPosition.y + centerOffset.y,
            bodyPosition.z + centerOffset.z
        );
    }

    getVehicleObstacleSeparationBounds() {
        const vehicleCenter = this.getVehicleColliderWorldCenter();
        if (!vehicleCenter) {
            return null;
        }

        const baseHalfExtents = this.getVehicleColliderWorldAabbHalfExtents() || { x: 0, y: 0, z: 0 };
        const wheelRadiusBuffer = Math.max(
            (Number(this.wheelEffectiveRadiusMeters) || 0.16) + (Number(this.wheelColliderInflationMeters) || 0.012),
            0.12
        );

        return {
            center: vehicleCenter,
            halfExtents: {
                x: (Number(baseHalfExtents.x) || 0) + wheelRadiusBuffer * 0.65,
                y: (Number(baseHalfExtents.y) || 0) + wheelRadiusBuffer * 0.65,
                z: (Number(baseHalfExtents.z) || 0) + Math.max(wheelRadiusBuffer * 0.35, 0.04)
            }
        };
    }

    getVehicleColliderWorldAabbHalfExtents() {
        if (!this.body || !this.vehicleColliderHalfExtents) {
            return null;
        }

        const bodyRotation = this.body.rotation();
        const bodyQuat = new THREE.Quaternion(
            bodyRotation.x,
            bodyRotation.y,
            bodyRotation.z,
            bodyRotation.w
        ).normalize();
        const rotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(bodyQuat);
        const e = rotationMatrix.elements;

        const hx = Number(this.vehicleColliderHalfExtents.x) || 0;
        const hy = Number(this.vehicleColliderHalfExtents.y) || 0;
        const hz = Number(this.vehicleColliderHalfExtents.z) || 0;

        // Convert oriented box half extents to conservative world-axis-aligned half extents.
        const halfX = (Math.abs(e[0]) * hx) + (Math.abs(e[4]) * hy) + (Math.abs(e[8]) * hz);
        const halfY = (Math.abs(e[1]) * hx) + (Math.abs(e[5]) * hy) + (Math.abs(e[9]) * hz);
        const halfZ = (Math.abs(e[2]) * hx) + (Math.abs(e[6]) * hy) + (Math.abs(e[10]) * hz);

        return { x: halfX, y: halfY, z: halfZ };
    }

    isVehicleAabbTouchingObstacle(obstacleInfo, linkMap = null) {
        const vehicleObbs = this.getVehicleCollisionObbs(linkMap);
        if (vehicleObbs.length === 0) {
            return false;
        }

        const obstacleObb = this.getObstacleCollisionObb(obstacleInfo, linkMap);
        if (!obstacleObb) {
            return false;
        }

        return vehicleObbs.some((vehicleObb) => this.obbIntersects(vehicleObb, obstacleObb, 0.002));
    }

    isVehicleNearObstacleSurface(obstacleInfo, linkMap = null) {
        const vehicleObbs = this.getVehicleCollisionObbs(linkMap);
        if (vehicleObbs.length === 0) {
            return false;
        }

        const obstacleObb = this.getObstacleCollisionObb(obstacleInfo, linkMap);
        if (!obstacleObb) {
            return false;
        }

        return vehicleObbs.some((vehicleObb) => {
            const verticalGap = Math.abs(obstacleObb.center.z - vehicleObb.center.z)
                - (obstacleObb.halfExtents.z + vehicleObb.halfExtents.z);
            const horizontalSeparation = Math.max(
                Math.abs(obstacleObb.center.x - vehicleObb.center.x) - (obstacleObb.halfExtents.x + vehicleObb.halfExtents.x),
                Math.abs(obstacleObb.center.y - vehicleObb.center.y) - (obstacleObb.halfExtents.y + vehicleObb.halfExtents.y)
            );
            const nearSurface = verticalGap <= 0.02 && horizontalSeparation <= 0.02;
            return nearSurface || this.obbIntersects(vehicleObb, obstacleObb, 0.004);
        });
    }

    resolveVehicleObstacleInterpenetration() {
        if (!this.body || !this.rapier || !Array.isArray(this.obstacleColliderInfos) || this.obstacleColliderInfos.length === 0) {
            return false;
        }

        const epsilon = Math.max(Number(this.obstacleDepenetrationEpsilonMeters) || 0, 0);
        const maxIterations = Math.max(Math.floor(Number(this.obstacleDepenetrationMaxIterations) || 0), 1);
        let adjusted = false;

        for (let iteration = 0; iteration < maxIterations; iteration += 1) {
            const separationBounds = this.getVehicleObstacleSeparationBounds();
            const vehicleCenter = separationBounds?.center;
            const vehicleHalfExtents = separationBounds?.halfExtents;
            if (!vehicleCenter || !vehicleHalfExtents) {
                break;
            }

            let separatedInThisIteration = false;

            for (let i = 0; i < this.obstacleColliderInfos.length; i += 1) {
                const obstacleInfo = this.obstacleColliderInfos[i];
                if (!obstacleInfo || obstacleInfo.isSensor || !obstacleInfo.center || !obstacleInfo.halfExtents) {
                    continue;
                }

                const deltaX = vehicleCenter.x - obstacleInfo.center.x;
                const deltaY = vehicleCenter.y - obstacleInfo.center.y;
                const deltaZ = vehicleCenter.z - obstacleInfo.center.z;

                const penetrationX = (vehicleHalfExtents.x + obstacleInfo.halfExtents.x) - Math.abs(deltaX);
                const penetrationY = (vehicleHalfExtents.y + obstacleInfo.halfExtents.y) - Math.abs(deltaY);
                const penetrationZ = (vehicleHalfExtents.z + obstacleInfo.halfExtents.z) - Math.abs(deltaZ);

                if (penetrationX <= 0 || penetrationY <= 0 || penetrationZ <= 0) {
                    continue;
                }

                let axis = 'x';
                let pushDistance = Math.min(penetrationX, penetrationY, penetrationZ);
                if (penetrationY < pushDistance) {
                    axis = 'y';
                    pushDistance = penetrationY;
                }
                if (penetrationZ < pushDistance) {
                    axis = 'z';
                    pushDistance = penetrationZ;
                }

                const currentTranslation = this.body.translation();
                const currentVelocity = this.body.linvel();
                let nextX = currentTranslation.x;
                let nextY = currentTranslation.y;
                let nextZ = currentTranslation.z;
                let nextVelX = currentVelocity.x;
                let nextVelY = currentVelocity.y;
                let nextVelZ = currentVelocity.z;

                const pushAmount = Math.max(pushDistance + epsilon + 0.01, 0.01);

                if (axis === 'x') {
                    const direction = deltaX >= 0 ? 1 : -1;
                    nextX += direction * pushAmount;
                    nextVelX = 0;
                } else if (axis === 'y') {
                    const direction = deltaY >= 0 ? 1 : -1;
                    nextY += direction * pushAmount;
                    nextVelY = 0;
                } else {
                    const direction = deltaZ >= 0 ? 1 : -1;
                    nextZ += direction * pushAmount;
                    nextVelZ = direction > 0 ? Math.max(0, nextVelZ) : Math.min(0, nextVelZ);
                }

                this.body.setTranslation(new this.rapier.Vector3(nextX, nextY, nextZ), true);
                this.body.setLinvel(new this.rapier.Vector3(nextVelX, nextVelY, nextVelZ), true);

                adjusted = true;
                separatedInThisIteration = true;
                break;
            }

            if (!separatedInThisIteration) {
                break;
            }
        }

        return adjusted;
    }

    getObstacleApproachInfo() {
        if (!this.body || !Array.isArray(this.obstacleColliderInfos)) {
            return null;
        }

        const obstacleContactInfo = this.obstacleColliderInfos.find((obstacleInfo) => {
            if (!obstacleInfo || obstacleInfo.isSensor || !this.world?.contactPair || !this.body) {
                return false;
            }

            let isContacting = false;
            this.vehicleColliders.forEach((vehicleCollider) => {
                if (isContacting) {
                    return;
                }
                this.world.contactPair(vehicleCollider, obstacleInfo.collider, () => {
                    isContacting = true;
                });
            });
            return isContacting;
        });

        if (obstacleContactInfo) {
            return { obstacleInfo: obstacleContactInfo };
        }

        const vehicleCenter = this.getVehicleColliderWorldCenter();
        const vehicleHalfExtents = this.getVehicleColliderWorldAabbHalfExtents();
        if (!vehicleCenter || !vehicleHalfExtents) {
            return null;
        }

        let bestInfo = null;
        let bestScore = Number.POSITIVE_INFINITY;
        this.obstacleColliderInfos.forEach((obstacleInfo) => {
            if (!obstacleInfo || obstacleInfo.isSensor || !obstacleInfo.center || !obstacleInfo.halfExtents) {
                return;
            }

            const gapX = Math.abs(vehicleCenter.x - obstacleInfo.center.x) - (vehicleHalfExtents.x + obstacleInfo.halfExtents.x);
            const gapY = Math.abs(vehicleCenter.y - obstacleInfo.center.y) - (vehicleHalfExtents.y + obstacleInfo.halfExtents.y);
            const obstacleTopZ = obstacleInfo.center.z + obstacleInfo.halfExtents.z;
            const verticalGap = obstacleTopZ - vehicleCenter.z;
            const isRelevant = gapX <= 0.02 && gapY <= 0.02 && verticalGap >= -0.01 && verticalGap <= 0.025;
            if (!isRelevant) {
                return;
            }

            const score = (Math.max(gapX, 0) * 1.5) + (Math.max(gapY, 0) * 1.5) + Math.max(Math.abs(verticalGap), 0.0);
            if (score < bestScore) {
                bestScore = score;
                bestInfo = obstacleInfo;
            }
        });

        return bestInfo ? { obstacleInfo: bestInfo } : null;
    }

    getObstacleClimbTargetZ(obstacleInfo = null) {
        if (!this.body || !Number.isFinite(this.wheelLocalMinZ) || !Array.isArray(this.obstacleColliderInfos)) {
            return null;
        }

        const translation = this.body.translation();
        const targetObstacle = obstacleInfo || null;
        if (!targetObstacle?.center || !targetObstacle?.halfExtents) {
            return null;
        }

        const obstacleTopZ = targetObstacle.center.z + targetObstacle.halfExtents.z;
        const wheelBottomZ = obstacleTopZ - (Number.isFinite(this.wheelLocalMinZ) ? this.wheelLocalMinZ : 0);
        const verticalGap = wheelBottomZ - translation.z;
        if (verticalGap <= 0) {
            return null;
        }

        return wheelBottomZ + 0.01;
    }

    applyObstacleClimbLift(hasObstacleContactNow, effectiveDeltaSec, obstacleInfo = null) {
        if (!this.body || !this.rapier || !hasObstacleContactNow) {
            return;
        }

        const climbTargetZ = this.getObstacleClimbTargetZ(obstacleInfo);
        if (!Number.isFinite(climbTargetZ)) {
            return;
        }

        const translation = this.body.translation();
        const velocity = this.body.linvel();
        const targetGap = climbTargetZ - translation.z;
        if (targetGap <= 0.003) {
            return;
        }

        const liftAmount = Math.min(Math.max(targetGap * 0.18, 0.0), 0.006 + (effectiveDeltaSec * 0.002));
        if (liftAmount <= 1e-6) {
            return;
        }

        const nextZ = Math.min(translation.z + liftAmount, climbTargetZ);
        this.body.setTranslation(new this.rapier.Vector3(translation.x, translation.y, nextZ), true);
        this.body.setLinvel(new this.rapier.Vector3(velocity.x, velocity.y, Math.max(velocity.z, 0.2)), true);
    }

    isVehicleNearObstacleSupportZone() {
        const vehicleCenter = this.getVehicleColliderWorldCenter();
        const wheelContactPlaneZ = this.getWheelContactPlaneZ();
        if (!vehicleCenter || !Number.isFinite(wheelContactPlaneZ) || !Array.isArray(this.obstacleColliderInfos)) {
            return false;
        }

        const vehicleHalfExtents = this.getVehicleColliderWorldAabbHalfExtents();
        if (!vehicleHalfExtents) {
            return false;
        }

        const vx = vehicleHalfExtents.x;
        const vy = vehicleHalfExtents.y;
        const approachMargin = Math.max(Number(this.obstacleApproachDisableSnapDistanceMeters) || 0, 0);
        const verticalTolerance = Math.max(Number(this.obstacleContactSurfaceToleranceMeters) || 0, 0);

        return this.obstacleColliderInfos.some((obstacleInfo) => {
            if (!obstacleInfo?.center || !obstacleInfo?.halfExtents || obstacleInfo.isSensor) {
                return false;
            }

            const obstacleTopZ = obstacleInfo.center.z + obstacleInfo.halfExtents.z;
            if (obstacleTopZ < (wheelContactPlaneZ - verticalTolerance)) {
                return false;
            }

            const gapX = Math.abs(vehicleCenter.x - obstacleInfo.center.x) - (vx + obstacleInfo.halfExtents.x);
            const gapY = Math.abs(vehicleCenter.y - obstacleInfo.center.y) - (vy + obstacleInfo.halfExtents.y);
            return gapX <= approachMargin && gapY <= approachMargin;
        });
    }

    isObstacleBelowWheelContactPlane(obstacleInfo) {
        if (!this.body || !obstacleInfo?.center || !obstacleInfo?.halfExtents) {
            return false;
        }

        if (!Number.isFinite(this.wheelLocalMinZ)) {
            return false;
        }

        const bodyPosition = this.body.translation();
        const wheelContactPlaneZ = bodyPosition.z + this.wheelLocalMinZ;
        const obstacleTopZ = obstacleInfo.center.z + obstacleInfo.halfExtents.z;
        const clearance = Math.max(Number(this.underbodyPassThroughClearanceMeters) || 0, 0);

        return obstacleTopZ < (wheelContactPlaneZ - clearance);
    }

    getWheelContactPlaneZ() {
        if (!this.body || !Number.isFinite(this.wheelLocalMinZ)) {
            return null;
        }

        return this.body.translation().z + this.wheelLocalMinZ;
    }

    getObstacleTopZByName(targetName) {
        const target = this.normalizeLinkName(targetName);
        const info = this.obstacleColliderInfos.find((item) => {
            if (!item) {
                return false;
            }

            const normalizedName = String(item.normalizedLinkName || this.normalizeLinkName(item.linkName || ''));
            return normalizedName === target;
        });

        if (!info?.center || !info?.halfExtents) {
            return null;
        }

        return info.center.z + info.halfExtents.z;
    }

    clampVehicleAboveGround() {
        if (!this.body || !Number.isFinite(this.groundZ) || !Number.isFinite(this.groundContactLocalMinZ)) {
            return;
        }

        const translation = this.body.translation();
        const velocity = this.body.linvel();
        const isOverHole = this.isVehicleOverHoleRegion();
        const groundBasedMinZ = this.groundZ - this.groundContactLocalMinZ - this.groundContactBiasMeters;
        const minAllowedZ = groundBasedMinZ - this.groundPenetrationToleranceMeters;
        const baseReferenceZ = Number.isFinite(this.initialPosition?.z)
            ? Math.max(this.initialPosition.z, groundBasedMinZ)
            : groundBasedMinZ;
        const maxLiftMeters = this.isVehicleObstacleContact
            ? this.maxLiftWithObstacleMeters
            : this.maxLiftWithoutObstacleMeters;
        const maxAllowedZ = baseReferenceZ + Math.max(maxLiftMeters, 0);

        const clampActivationMargin = Math.max(Number(this.bodyGroundClampActivationMarginMeters) || 0, 0);
        if (!isOverHole && translation.z < (minAllowedZ - clampActivationMargin)) {
            this.body.setTranslation(new this.rapier.Vector3(translation.x, translation.y, minAllowedZ), true);
            this.body.setLinvel(new this.rapier.Vector3(velocity.x, velocity.y, 0), true);
            return;
        }

        if (translation.z > maxAllowedZ) {
            this.body.setTranslation(new this.rapier.Vector3(translation.x, translation.y, maxAllowedZ), true);
            this.body.setLinvel(new this.rapier.Vector3(velocity.x, velocity.y, 0), true);
        }
    }

    isBodyNearFlatGroundSupport() {
        if (!this.body || !Number.isFinite(this.groundZ) || !Number.isFinite(this.groundContactLocalMinZ)) {
            return false;
        }

        if (this.isVehicleObstacleContact || this.isVehicleOverHoleRegion() || this.isVehicleNearObstacleSupportZone()) {
            return false;
        }

        const translation = this.body.translation();
        const groundBasedMinZ = this.groundZ - this.groundContactLocalMinZ - this.groundContactBiasMeters;
        const snapDistance = Math.max(Number(this.flatGroundSnapDistanceMeters) || 0, 0);
        return Math.abs(translation.z - groundBasedMinZ) <= snapDistance;
    }

    stabilizeFlatGroundVerticalMotion() {
        if (!this.body || !this.rapier) {
            return;
        }

        if (!this.isBodyNearFlatGroundSupport()) {
            return;
        }

        const velocity = this.body.linvel();
        const angularVelocity = this.body.angvel();
        const threshold = Math.max(Number(this.flatGroundVerticalVelocitySnapThresholdMps) || 0, 0);

        if (Math.abs(velocity.z) <= threshold) {
            this.body.setLinvel(new this.rapier.Vector3(velocity.x, velocity.y, 0), true);
        }

        // Reduce small roll/pitch oscillations while preserving steering yaw.
        this.body.setAngvel(new this.rapier.Vector3(angularVelocity.x * 0.75, angularVelocity.y * 0.75, angularVelocity.z), true);
    }

    enforceFlatGroundRideHeight() {
        if (!this.body || !this.rapier) {
            return;
        }

        if (this.isVehicleObstacleContact || this.isVehicleOverHoleRegion()) {
            return;
        }

        if (!this.isBodyNearFlatGroundSupport()) {
            return;
        }

        const targetZ = this.getGroundContactTargetZ();
        if (!Number.isFinite(targetZ)) {
            return;
        }

        const translation = this.body.translation();
        if (Math.abs(targetZ - translation.z) < 1e-6) {
            return;
        }

        // Hard-lock vertical ride height on flat road to suppress persistent jitter.
        this.body.setTranslation(new this.rapier.Vector3(translation.x, translation.y, targetZ), true);

        const velocity = this.body.linvel();
        this.body.setLinvel(new this.rapier.Vector3(velocity.x, velocity.y, 0), true);
    }

    enforceMeasuredWheelGroundLimit(linkMap) {
        if (!this.body || !this.rapier || !linkMap || !Number.isFinite(this.groundZ)) {
            return false;
        }

        if (!this.isVehicleObstacleContact && !this.isVehicleOverHoleRegion()) {
            return false;
        }

        if (this.isVehicleOverHoleRegion()) {
            return false;
        }

        const measuredWheelMinZ = this.getWheelWorldMinZ(linkMap);
        if (!Number.isFinite(measuredWheelMinZ)) {
            return false;
        }

        const minAllowedWheelZ = this.groundZ - Math.max(Number(this.groundPenetrationToleranceMeters) || 0, 0);
        const penetrationDepth = minAllowedWheelZ - measuredWheelMinZ;
        const activationMargin = Math.max(Number(this.wheelGroundClampActivationMarginMeters) || 0, 0);
        if (penetrationDepth <= activationMargin) {
            return false;
        }

        const liftAmount = penetrationDepth + Math.max(Number(this.wheelGroundHardClampOffsetMeters) || 0, 0);
        const translation = this.body.translation();
        const velocity = this.body.linvel();
        this.body.setTranslation(new this.rapier.Vector3(translation.x, translation.y, translation.z + liftAmount), true);
        this.body.setLinvel(new this.rapier.Vector3(velocity.x, velocity.y, 0), true);
        return true;
    }

    settleVehicleToGroundAfterObstacle(linkMap) {
        if (!this.body || !this.rapier || !linkMap || !Number.isFinite(this.groundZ)) {
            return false;
        }

        if (this.isVehicleObstacleContact || this.isVehicleOverHoleRegion()) {
            return false;
        }

        const measuredWheelMinZ = this.getWheelWorldMinZ(linkMap);
        if (!Number.isFinite(measuredWheelMinZ)) {
            return false;
        }

        const translation = this.body.translation();
        const velocity = this.body.linvel();
        const wheelGroundGap = measuredWheelMinZ - this.groundZ;
        const tolerance = Math.max(Number(this.postObstacleGroundReattachToleranceMeters) || 0, 0);

        // Keep reattaching for a short period after obstacle contact ends.
        const inRecoverWindow = (Number(this.postObstacleGroundRecoverRemainingSec) || 0) > 0;
        if (wheelGroundGap <= tolerance && !inRecoverWindow) {
            return false;
        }

        if (!inRecoverWindow && this.isVehicleNearObstacleSupportZone()) {
            return false;
        }

        const maxDropPerStep = 0.06;
        const blend = THREE.MathUtils.clamp(Number(this.postObstacleGroundReattachBlend) || 0, 0.1, 1);
        const desiredDrop = Math.max(wheelGroundGap * blend, 0);
        const appliedDrop = Math.min(desiredDrop, maxDropPerStep);
        if (appliedDrop <= 1e-6) {
            return false;
        }

        const nextZ = translation.z - appliedDrop;
        this.body.setTranslation(new this.rapier.Vector3(translation.x, translation.y, nextZ), true);
        this.body.setLinvel(new this.rapier.Vector3(velocity.x, velocity.y, Math.min(0, velocity.z)), true);
        return true;
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
            const inflation = Math.max(Number(this.wheelColliderInflationMeters) || 0, 0);
            const approxRadius = Math.max(size.x * 0.5, size.z * 0.5, 0.05) + inflation;
            const localCenter = carFrame.worldToLocal(centerWorld.clone());

            const wheelColliderDesc = this.rapier.ColliderDesc.ball(approxRadius)
                .setTranslation(localCenter.x, localCenter.y, localCenter.z)
                .setFriction(1.6)
                .setRestitution(0.0);

            const wheelCollider = this.world.createCollider(wheelColliderDesc, body);
            this.vehicleColliders.push(wheelCollider);
            createdWheelColliderCount += 1;
        });

        if (createdWheelColliderCount === 0) {
            console.warn('[URDF][Simulation] Wheel colliders were not created. Check wheel link names in URDF.');
        }
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

    getWheelWorldMinZ(linkMap) {
        if (!linkMap) {
            return null;
        }

        const wheelLinkNames = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
        let minWheelWorldZ = Number.POSITIVE_INFINITY;

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

            minWheelWorldZ = Math.min(minWheelWorldZ, wheelBounds.min.z);
        });

        return Number.isFinite(minWheelWorldZ) ? minWheelWorldZ : null;
    }

    estimateWheelEffectiveRadiusMeters(carFrame, linkMap) {
        if (!carFrame || !linkMap) {
            return;
        }

        const wheelLinkNames = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
        const radii = [];

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

            const size = wheelBounds.getSize(new THREE.Vector3());
            const radius = Math.max(size.x * 0.5, size.z * 0.5, 0.05);
            radii.push(radius);
        });

        if (radii.length === 0) {
            return;
        }

        const avgRadius = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
        this.wheelEffectiveRadiusMeters = Math.max(avgRadius, 0.05);
    }

    getAverageSignedWheelRpm() {
        const viewer = this.getDriveSourceViewer();
        return this.getAverageSignedWheelRpmForViewer(viewer);
    }

    getAverageSignedWheelRpmForViewer(viewer) {
        if (!viewer) {
            return null;
        }

        const wheelKeys = ['fl', 'fr', 'rl', 'rr'];
        const signedRpms = [];

        wheelKeys.forEach((key) => {
            let signedRpm = null;
            if (typeof viewer.getSignedWheelRpm === 'function') {
                const value = Number(viewer.getSignedWheelRpm(key));
                if (Number.isFinite(value)) {
                    signedRpm = value;
                }
            }

            if (!Number.isFinite(signedRpm)) {
                const rpm = Number(viewer?.wheelSpeedRpmByKey?.[key]);
                const sign = Number(viewer?.wheelDirectionSignByKey?.[key]);
                if (Number.isFinite(rpm)) {
                    signedRpm = rpm * (Number.isFinite(sign) ? sign : 1);
                }
            }

            if (Number.isFinite(signedRpm)) {
                signedRpms.push(signedRpm);
            }
        });

        if (signedRpms.length === 0) {
            return null;
        }

        const rpmSum = signedRpms.reduce((sum, rpm) => sum + rpm, 0);
        return rpmSum / signedRpms.length;
    }

    getViewerActivityScore(viewer) {
        if (!viewer) {
            return -1;
        }

        const mode = String(viewer?.driveMode || '').toLowerCase();
        const avgRpm = this.getAverageSignedWheelRpmForViewer(viewer);
        const speedKmh = Math.max(Number(viewer?.driveSpeedKmh) || 0, 0);

        let score = 0;
        if (mode && mode !== 'stop') {
            score += 100;
        }
        if (Number.isFinite(avgRpm)) {
            score += Math.min(Math.abs(avgRpm), 200);
        }
        score += Math.min(speedKmh, 50);

        return score;
    }

    getWheelSideSignedRpm() {
        const viewer = this.getDriveSourceViewer();
        if (!viewer) {
            return null;
        }

        const wheelGroups = {
            left: ['fl', 'rl'],
            right: ['fr', 'rr']
        };

        const readSignedRpm = (key) => {
            if (typeof viewer.getSignedWheelRpm === 'function') {
                const value = Number(viewer.getSignedWheelRpm(key));
                if (Number.isFinite(value)) {
                    return value;
                }
            }

            const rpm = Number(viewer?.wheelSpeedRpmByKey?.[key]);
            const sign = Number(viewer?.wheelDirectionSignByKey?.[key]);
            if (Number.isFinite(rpm)) {
                return rpm * (Number.isFinite(sign) ? sign : 1);
            }

            return null;
        };

        const avgGroup = (keys) => {
            const values = keys
                .map((key) => readSignedRpm(key))
                .filter((value) => Number.isFinite(value));
            if (values.length === 0) {
                return null;
            }
            return values.reduce((sum, value) => sum + value, 0) / values.length;
        };

        const left = avgGroup(wheelGroups.left);
        const right = avgGroup(wheelGroups.right);
        if (!Number.isFinite(left) || !Number.isFinite(right)) {
            return null;
        }

        return { left, right };
    }

    getDriveSourceViewer() {
        if (this.viewer) {
            return this.viewer;
        }

        const byId = window.urdfViewersById?.['robot-container-1'] || null;
        if (byId) {
            return byId;
        }

        return window.activeURDFViewer
            || window.urdfViewersById?.['vehicle-urdf-viewer']
            || null;
    }

    getCommandedDriveSpeedMps() {
        const fallbackByHook = Math.max(Number(this.commandedSpeedMps) || 0, 0);
        const driveViewer = this.getDriveSourceViewer();
        const avgSignedWheelRpm = this.getAverageSignedWheelRpmForViewer(driveViewer);
        const speedBySlider = Math.max(Number(driveViewer?.driveSpeedKmh) || 0, 0) / 3.6;

        if (Number.isFinite(avgSignedWheelRpm) && Math.abs(avgSignedWheelRpm) > 0.1) {
            const wheelAngularSpeedRadPerSec = Math.abs(avgSignedWheelRpm) * (Math.PI * 2 / 60);
            const speedByWheel = wheelAngularSpeedRadPerSec * Math.max(this.wheelEffectiveRadiusMeters, 0.05);
            return Math.max(speedByWheel, speedBySlider, fallbackByHook);
        }

        return Math.max(speedBySlider, fallbackByHook);
    }

    calibrateGroundContactLocalMinZ(linkMap) {
        if (!this.body || !Number.isFinite(this.groundZ)) {
            return;
        }

        const measuredWheelWorldMinZ = this.getWheelWorldMinZ(linkMap);
        if (!Number.isFinite(measuredWheelWorldMinZ)) {
            return;
        }

        const translation = this.body.translation();
        this.groundContactLocalMinZ = measuredWheelWorldMinZ - translation.z;
        this.wheelLocalMinZ = this.groundContactLocalMinZ;
    }

    getGroundContactTargetZ() {
        if (!Number.isFinite(this.groundZ) || !Number.isFinite(this.groundContactLocalMinZ)) {
            return null;
        }

        return this.groundZ - this.groundContactLocalMinZ - this.groundContactBiasMeters;
    }

    alignVehicleWheelContactToGround() {
        if (!this.body || !Number.isFinite(this.groundZ) || !Number.isFinite(this.groundContactLocalMinZ)) {
            return;
        }

        const translation = this.body.translation();
        const targetZ = this.getGroundContactTargetZ();
        if (!Number.isFinite(targetZ)) {
            return;
        }
        this.body.setTranslation(new this.rapier.Vector3(translation.x, translation.y, targetZ), true);
    }

    alignVehicleToGroundByWheelGap(linkMap, toleranceMeters = 0.001) {
        if (!this.body || !this.rapier || !linkMap || !Number.isFinite(this.groundZ)) {
            return;
        }

        const measuredWheelWorldMinZ = this.getWheelWorldMinZ(linkMap);
        if (!Number.isFinite(measuredWheelWorldMinZ)) {
            return;
        }

        const wheelGroundGap = measuredWheelWorldMinZ - this.groundZ;
        if (Math.abs(wheelGroundGap) <= toleranceMeters) {
            return;
        }

        const translation = this.body.translation();
        const alignedZ = translation.z - wheelGroundGap;
        this.body.setTranslation(new this.rapier.Vector3(translation.x, translation.y, alignedZ), true);

        // Keep local contact baseline in sync after explicit correction.
        this.groundContactLocalMinZ = measuredWheelWorldMinZ - wheelGroundGap - alignedZ;
        this.wheelLocalMinZ = this.groundContactLocalMinZ;

        const velocity = this.body.linvel();
        this.body.setLinvel(new this.rapier.Vector3(velocity.x, velocity.y, Math.min(0, velocity.z)), true);
    }

    syncCarFrameFromBody() {
        if (!this.body || !this.carFrame) {
            return;
        }

        const position = this.body.translation();
        const rotation = this.body.rotation();

        this.carFrame.position.set(position.x, position.y, position.z);
        this.carFrame.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w).normalize();
        this.carFrame.updateMatrixWorld(true);
    }

    enforceWheelGroundContactAtLoad(linkMap) {
        if (!this.body || !this.rapier) {
            return;
        }

        if (linkMap) {
            this.calibrateGroundContactLocalMinZ(linkMap);
        }

        // Respect URDF-authored initial pose; keep startup pose identical to viewer page.
        this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
        this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
        this.syncCarFrameFromBody();
        this.logWheelGroundDiagnosticsOnce(linkMap, 'enforceWheelGroundContactAtLoad');
    }

    updateObstacleContactState() {
        if (!this.world || this.vehicleColliders.length === 0 || this.obstacleColliders.length === 0) {
            return false;
        }

        let hasContact = false;
        const obstacleInfoByCollider = new Map();
        this.obstacleColliderInfos.forEach((info) => {
            if (info?.collider) {
                obstacleInfoByCollider.set(info.collider, info);
            }
        });

        if (typeof this.world.contactPair === 'function') {
            this.vehicleColliders.forEach((vehicleCollider) => {
                if (hasContact) {
                    return;
                }

                this.obstacleColliders.forEach((obstacleCollider) => {
                    if (hasContact) {
                        return;
                    }

                    const obstacleInfo = obstacleInfoByCollider.get(obstacleCollider) || null;
                    if (!obstacleInfo || obstacleInfo.isSensor) {
                        return;
                    }

                    if (this.isObstacleBelowWheelContactPlane(obstacleInfo)) {
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

    setUprightRotationLockEnabled(isEnabled) {
        if (!this.body) {
            return;
        }

        if (this.isUprightRotationLockActive === isEnabled) {
            return;
        }

        if (typeof this.body.setEnabledRotations === 'function') {
            this.body.setEnabledRotations(!isEnabled, !isEnabled, true, true);
            this.isUprightRotationLockActive = isEnabled;
            return;
        }

        if (typeof this.body.restrictRotations === 'function') {
            this.body.restrictRotations(!isEnabled, !isEnabled, true, true);
            this.isUprightRotationLockActive = isEnabled;
            return;
        }

        // Some Rapier builds expose only lockRotations(lockAll), which cannot keep yaw free.
        // In that case, skip runtime upright-lock toggling to preserve steering rotation.
        this.isUprightRotationLockActive = false;
    }

    maybeLogRuntimeDiagnostics(deltaSec, driveViewer, clampedSpeed, throttleSign, steerSign, hasObstacleContact) {
        if (!this.enableRuntimeDiagnostics || !this.body) {
            return;
        }

        this.runtimeDiagnosticsElapsedSec += Math.max(deltaSec, 0);
        if (this.runtimeDiagnosticsElapsedSec < this.runtimeDiagnosticsIntervalSec) {
            return;
        }
        this.runtimeDiagnosticsElapsedSec = 0;

        const bodyPos = this.body.translation();
        const bodyVel = this.body.linvel();
        const avgRpm = this.getAverageSignedWheelRpmForViewer(driveViewer);
        const driveMode = String(driveViewer?.driveMode || 'n/a');
        const driveSpeedKmh = Number(driveViewer?.driveSpeedKmh);
        const sourceId = String(driveViewer?.container?.id || 'unknown');
        console.log('[URDF][Simulation][diag]', {
            sourceId,
            driveMode,
            driveSpeedKmh: Number.isFinite(driveSpeedKmh) ? Number(driveSpeedKmh.toFixed(3)) : null,
            avgSignedWheelRpm: Number.isFinite(avgRpm) ? Number(avgRpm.toFixed(3)) : null,
            clampedSpeedMps: Number(clampedSpeed.toFixed(4)),
            throttleSign,
            steerSign,
            hasObstacleContact,
            pos: {
                x: Number(bodyPos.x.toFixed(4)),
                y: Number(bodyPos.y.toFixed(4)),
                z: Number(bodyPos.z.toFixed(4))
            },
            vel: {
                x: Number(bodyVel.x.toFixed(4)),
                y: Number(bodyVel.y.toFixed(4)),
                z: Number(bodyVel.z.toFixed(4))
            },
            groundZ: Number.isFinite(this.groundZ) ? Number(this.groundZ.toFixed(4)) : null
        });
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
                .setLinearDamping(3.8)
                .setAngularDamping(6.0)
                .setCcdEnabled(true);

            const body = world.createRigidBody(rigidBodyDesc);

            // Keep the vehicle upright with API-compatible fallbacks across Rapier versions.
            let hasSelectiveRotationLock = false;
            if (typeof body.setEnabledRotations === 'function') {
                body.setEnabledRotations(false, false, true, true);
                hasSelectiveRotationLock = true;
            } else if (typeof body.restrictRotations === 'function') {
                body.restrictRotations(false, false, true, true);
                hasSelectiveRotationLock = true;
            } else {
                console.warn('[URDF][Simulation] selective rotation lock API unavailable; steering yaw kept enabled.');
            }
            this.isUprightRotationLockActive = hasSelectiveRotationLock;

            const bbox = this.computeChassisBounds(carFrame, linkMap);
            const size = bbox.getSize(new THREE.Vector3());
            const worldCenter = bbox.getCenter(new THREE.Vector3());
            const localCenter = carFrame.worldToLocal(worldCenter.clone());
            const chassisMarginX = 0.04;
            const chassisMarginY = 0.03;
            const chassisMarginZ = 0.01;
            const halfX = Math.max((size.x || 0.6) * 0.5 - chassisMarginX, 0.16);
            const halfY = Math.max((size.y || 0.4) * 0.5 - chassisMarginY, 0.14);

            const halfZBase = Math.max((size.z || 0.25) * 0.5 - chassisMarginZ, 0.06);
            const rawBboxMinLocalZ = localCenter.z - halfZBase;
            const rawBboxMaxLocalZ = localCenter.z + halfZBase;
            this.vehicleLocalMinZ = rawBboxMinLocalZ;
            this.estimateWheelEffectiveRadiusMeters(carFrame, linkMap);
            this.wheelLocalMinZ = this.getWheelLocalMinZ(carFrame, linkMap);
            if (Number.isFinite(this.wheelLocalMinZ)) {
                this.groundContactLocalMinZ = this.wheelLocalMinZ;
            } else if (Number.isFinite(this.vehicleLocalMinZ)) {
                this.groundContactLocalMinZ = this.vehicleLocalMinZ;
            } else {
                this.groundContactLocalMinZ = null;
            }

            // Allow low obstacles to pass under the body by trimming the lower part of chassis collider.
            let colliderMinLocalZ = rawBboxMinLocalZ;
            let colliderMaxLocalZ = rawBboxMaxLocalZ;
            if (Number.isFinite(this.wheelLocalMinZ)) {
                const minPassThroughZ = this.wheelLocalMinZ + Math.max(Number(this.underbodyPassThroughClearanceMeters) || 0, 0);
                colliderMinLocalZ = Math.max(colliderMinLocalZ, minPassThroughZ);
            }
            if ((colliderMaxLocalZ - colliderMinLocalZ) < 0.04) {
                colliderMaxLocalZ = colliderMinLocalZ + 0.04;
            }

            const halfZ = Math.max((colliderMaxLocalZ - colliderMinLocalZ) * 0.5, 0.04);
            const adjustedCenterZ = (colliderMaxLocalZ + colliderMinLocalZ) * 0.5;

            const colliderDesc = RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
                .setTranslation(localCenter.x, localCenter.y, adjustedCenterZ)
                .setFriction(0.15)
                .setRestitution(0.0);
            this.vehicleCollider = world.createCollider(colliderDesc, body);
            this.vehicleColliderLocalCenter.set(localCenter.x, localCenter.y, adjustedCenterZ);
            this.vehicleColliderHalfExtents = { x: halfX, y: halfY, z: halfZ };
            this.vehicleColliders = [this.vehicleCollider];
            if (this.enableWheelPhysicsColliders) {
                this.addWheelCollidersFromUrdf(body, carFrame, linkMap);
            }

            this.rapier = RAPIER;
            this.world = world;
            this.body = body;
            this.carFrame = carFrame;
            this.initialPosition = initialPosition.clone();
            this.initialQuaternion = initialQuaternion.clone();
            this.vehicleHalfExtents = { x: halfX, y: halfY, z: halfZ };
            this.addGroundCollider();
            this.enforceWheelGroundContactAtLoad(linkMap);
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
        if (this.isPaused) {
            this.lastStepTimeMs = now;
            return;
        }

        if (String(this.commandedDriveMode || '').toLowerCase() === 'stop') {
            this.stopSimulationMotion();
            this.lastStepTimeMs = now;
            return;
        }

        if (!this.lastStepTimeMs) {
            this.lastStepTimeMs = now;
        }

        const deltaSec = Math.min((now - this.lastStepTimeMs) / 1000, 0.1);
        this.lastStepTimeMs = now;
        const effectiveDeltaSec = Math.min(deltaSec * this.visualSpeedScale, 0.25);

        const keyboardState = this.getKeyboardDriveState();
        const driveViewer = this.getDriveSourceViewer();

        let throttleSign = 0;
        let steerSign = 0;
        let keyboardMoveX = 0;
        let keyboardMoveY = 0;
        if (keyboardState.isActive) {
            keyboardMoveX = keyboardState.moveX;
            keyboardMoveY = keyboardState.moveY;
        } else {
            const driveMode = String(
                this.commandedDriveMode
                || driveViewer?.driveMode
                || this.viewer?.driveMode
                || 'stop'
            );
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
            } else {
                const wheelSides = this.getWheelSideSignedRpm();
                if (wheelSides) {
                    const avgSignedRpm = (wheelSides.left + wheelSides.right) * 0.5;
                    const rpmDiff = wheelSides.right - wheelSides.left;
                    if (Math.abs(avgSignedRpm) > 0.2) {
                        throttleSign = avgSignedRpm > 0 ? 1 : -1;
                    }
                    if (Math.abs(rpmDiff) > 0.2) {
                        steerSign = rpmDiff > 0 ? 1 : -1;
                    }
                }
            }
        }

        const speedMps = this.getCommandedDriveSpeedMps();
        const clampedSpeed = Math.min(speedMps, this.maxSpeedMps);
        const effectiveSteerSign = clampedSpeed > 1e-3 ? steerSign : 0;
        const hasDriveCommand = keyboardState.isActive || throttleSign !== 0 || steerSign !== 0;
        if (hasDriveCommand) {
            this.hasActivatedSimulationMotion = true;
        }

        if (!this.hasActivatedSimulationMotion) {
            this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
            this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
            this.syncCarFrameFromBody();
            return;
        }

        if (hasDriveCommand) {
            this.hasActivatedDynamicGroundClamp = true;
        }
        const wasObstacleContact = this.updateObstacleContactState();
        const obstacleApproach = this.getObstacleApproachInfo();
        this.isVehicleObstacleContact = Boolean(wasObstacleContact);
        let commandedVelocityX = 0;
        let commandedVelocityY = 0;
        const isNearFlatGroundSupport = this.isBodyNearFlatGroundSupport();

        if (this.keepUprightOnFlatGround) {
            // Keep roll/pitch locked on flat-road driving; only unlock near obstacles or holes.
            const shouldKeepUpright = isNearFlatGroundSupport;
            this.setUprightRotationLockEnabled(shouldKeepUpright);
        }

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
        const currentAngularVelocity = this.body.angvel();
        let lockedRotation = null;
        if (keyboardState.isActive) {
            lockedRotation = this.body.rotation();
            const velocitySmoothingAlpha = 1 - Math.exp(-12 * effectiveDeltaSec);
            const targetVelocityX = keyboardMoveX * clampedSpeed;
            const targetVelocityY = keyboardMoveY * clampedSpeed;
            const velocityX = currentLinearVelocity.x + ((targetVelocityX - currentLinearVelocity.x) * velocitySmoothingAlpha);
            const velocityY = currentLinearVelocity.y + ((targetVelocityY - currentLinearVelocity.y) * velocitySmoothingAlpha);
            commandedVelocityX = targetVelocityX;
            commandedVelocityY = targetVelocityY;

            const nextVelocityZ = wasObstacleContact
                ? currentLinearVelocity.z
                : (isNearFlatGroundSupport ? 0 : currentLinearVelocity.z);
            this.body.setLinvel(new this.rapier.Vector3(velocityX, velocityY, nextVelocityZ), true);
            this.body.setAngvel(new this.rapier.Vector3(
                isNearFlatGroundSupport ? 0 : currentAngularVelocity.x,
                isNearFlatGroundSupport ? 0 : currentAngularVelocity.y,
                0
            ), true);
        } else {
            const bodyRotation = this.body.rotation();
            const yaw = this.extractYawFromQuaternion(bodyRotation);
            const velocityX = Math.cos(yaw) * clampedSpeed * throttleSign;
            const velocityY = Math.sin(yaw) * clampedSpeed * throttleSign;
            commandedVelocityX = velocityX;
            commandedVelocityY = velocityY;

            const nextVelocityZ = wasObstacleContact
                ? currentLinearVelocity.z
                : (isNearFlatGroundSupport ? 0 : currentLinearVelocity.z);
            this.body.setLinvel(new this.rapier.Vector3(velocityX, velocityY, nextVelocityZ), true);
            this.body.setAngvel(new this.rapier.Vector3(currentAngularVelocity.x, currentAngularVelocity.y, this.maxYawRateRad * effectiveSteerSign), true);
        }

        // Follow the fixed-step update style from three.js Rapier vehicle controller example.
        this.physicsAccumulatorSec = Math.min(this.physicsAccumulatorSec + effectiveDeltaSec, this.physicsFixedTimeStepSec * this.maxPhysicsCatchupSteps);
        const linkMap = this.viewer?.robotModel?.links || null;
        let stepIndex = 0;
        while (this.physicsAccumulatorSec >= this.physicsFixedTimeStepSec && stepIndex < this.maxPhysicsCatchupSteps) {
            this.world.timestep = this.physicsFixedTimeStepSec;
            this.world.step();
            let hasObstacleContactNow = this.updateObstacleContactState();
            if (hasObstacleContactNow) {
                this.postObstacleGroundRecoverRemainingSec = Math.max(Number(this.postObstacleGroundRecoverDurationSec) || 0, 0);
            } else {
                this.postObstacleGroundRecoverRemainingSec = Math.max(
                    0,
                    (Number(this.postObstacleGroundRecoverRemainingSec) || 0) - this.physicsFixedTimeStepSec
                );
            }
            const resolvedInterpenetration = this.resolveVehicleObstacleInterpenetration();
            if (resolvedInterpenetration) {
                hasObstacleContactNow = this.updateObstacleContactState();
            }
            if (hasObstacleContactNow) {
                this.applyObstacleClimbLift(true, effectiveDeltaSec, obstacleApproach?.obstacleInfo);
            } else {
                const velocity = this.body.linvel();
                const approachSpeed = Math.hypot(velocity.x, velocity.y);
                if (approachSpeed > 0.02) {
                    this.body.setLinvel(new this.rapier.Vector3(velocity.x * 0.92, velocity.y * 0.92, velocity.z), true);
                }
            }
            if (hasObstacleContactNow) {
                const velocity = this.body.linvel();
                const dampingFactor = 0.6;
                this.body.setLinvel(new this.rapier.Vector3(velocity.x * dampingFactor, velocity.y * dampingFactor, velocity.z), true);
            }
            if (this.hasActivatedDynamicGroundClamp) {
                this.clampVehicleAboveGround();
            }
            this.syncCarFrameFromBody();
            const adjustedByWheelClamp = hasObstacleContactNow
                ? this.enforceMeasuredWheelGroundLimit(linkMap)
                : false;
            if (adjustedByWheelClamp) {
                this.syncCarFrameFromBody();
            }
            const adjustedByGroundReattach = this.settleVehicleToGroundAfterObstacle(linkMap);
            if (adjustedByGroundReattach) {
                this.syncCarFrameFromBody();
            }
            this.stabilizeFlatGroundVerticalMotion();
            this.enforceFlatGroundRideHeight();
            this.syncCarFrameFromBody();
            if (hasDriveCommand) {
                this.wheelZChartElapsedSec += this.physicsFixedTimeStepSec;
                this.sampleWheelCenterZForChart(this.wheelZChartElapsedSec);
            }
            this.physicsAccumulatorSec -= this.physicsFixedTimeStepSec;
            stepIndex += 1;
        }

        if (keyboardState.isActive && lockedRotation && this.isBodyNearFlatGroundSupport()) {
            this.body.setRotation(lockedRotation, true);
            this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
        }

        const hasObstacleContact = this.updateObstacleContactState();
        this.isVehicleObstacleContact = hasObstacleContact;
        if (this.keepUprightOnFlatGround) {
            const shouldKeepUpright = this.isBodyNearFlatGroundSupport();
            this.setUprightRotationLockEnabled(shouldKeepUpright);
        }

        this.maybeLogRuntimeDiagnostics(
            effectiveDeltaSec,
            driveViewer,
            clampedSpeed,
            throttleSign,
            steerSign,
            hasObstacleContact
        );

        const hasMoveCommand = keyboardState.isActive || throttleSign !== 0;
        const shouldBlockByObstacle = hasObstacleContact;
        if (hasMoveCommand && !shouldBlockByObstacle) {
            const currentVelocity = this.body.linvel();
            const keepZVelocity = this.isBodyNearFlatGroundSupport() ? 0 : currentVelocity.z;
            this.body.setLinvel(new this.rapier.Vector3(commandedVelocityX, commandedVelocityY, keepZVelocity), true);
        } else {
            const currentVelocity = this.body.linvel();
            const stopVelocity = Math.abs(currentVelocity.x) < 0.01 && Math.abs(currentVelocity.y) < 0.01;
            this.body.setLinvel(new this.rapier.Vector3(
                stopVelocity ? 0 : currentVelocity.x * 0.05,
                stopVelocity ? 0 : currentVelocity.y * 0.05,
                currentVelocity.z
            ), true);
        }

        const isMoveCommandActive = keyboardState.isActive || throttleSign !== 0;
        if (this.blockMotionOnObstacleContact && hasObstacleContact && isMoveCommandActive) {
            const currentVelocity = this.body.linvel();
            this.body.setLinvel(new this.rapier.Vector3(0, 0, currentVelocity.z), true);
            this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
        }

        const nextPosition = this.body.translation();
        const nextRotation = this.body.rotation();

        this.carFrame.position.set(nextPosition.x, nextPosition.y, nextPosition.z);
        this.carFrame.quaternion.set(nextRotation.x, nextRotation.y, nextRotation.z, nextRotation.w).normalize();
    }

    async runLoop() {
        // If command APIs are bound after this module starts, retry hook installation.
        this.installDriveCommandHooks();

        if (!this.viewer) {
            this.viewer = this.findSimulationViewer();
        }

        if (this.viewer) {
            this.ensureWheelZChartOverlay();
        }

        if (this.viewer && !this.isReady && !this.hasFailed) {
            await this.ensureRapierInitialized();
        }

        this.stepSimulation();

        const nowMs = typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : null;
        const shouldRenderWheelChart = this.wheelZChartLastRenderTimeMs === null
            || (nowMs !== null && (nowMs - this.wheelZChartLastRenderTimeMs) >= (this.wheelZChartRenderIntervalSec * 1000));
        if (shouldRenderWheelChart) {
            this.renderWheelZChart(this.wheelZChartElapsedSec);
            if (nowMs !== null) {
                this.wheelZChartLastRenderTimeMs = nowMs;
            }
        }

        this.updateDebugPanel(this.physicsFixedTimeStepSec);
        requestAnimationFrame(() => this.runLoop());
    }

    start() {
        this.initDebugPanel();
        this.initializeSpeedSliderPreference();
        this.initializeVisualSpeedSliderPreference();
        this.attachKeyboardControls();
        this.installDriveCommandHooks();
        this.syncInitialDriveStateFromUi();
        this.updateDebugPanel(this.debugStatusUpdateIntervalSec);
        requestAnimationFrame(() => this.runLoop());
    }

    resetUiStates() {
        this.togglePause(false);

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

        Object.keys(this.wheelZChartHistoryByKey).forEach((key) => {
            this.wheelZChartHistoryByKey[key] = [];
        });
        this.wheelZChartElapsedSec = 0;
        Object.keys(this.wheelRadiusMetersByKey).forEach((key) => {
            this.wheelRadiusMetersByKey[key] = null;
        });

        this.hasLoggedGroundDiagnostics = false;

        this.body.setTranslation(
            new this.rapier.Vector3(this.initialPosition.x, this.initialPosition.y, this.initialPosition.z),
            true
        );
        this.body.setRotation(this.initialQuaternion, true);
        this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
        this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
        this.isVehicleObstacleContact = false;
        this.hasActivatedSimulationMotion = false;
        this.hasActivatedDynamicGroundClamp = false;

        // On reset, always return to the URDF-authored pose without extra ground alignment offsets.
        this.syncCarFrameFromBody();
    }

    async reset() {
        this.resetUiStates();
        this.lastStepTimeMs = 0;
        this.physicsAccumulatorSec = 0;

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

globalThis.resetSimulationVisualSpeed = function() {
    rapierDriveSimulation.resetVisualSpeedSliderToDefault();
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

globalThis.setSimulationDriveMode = function(mode) {
    rapierDriveSimulation.applyDriveModeCommand(mode);
};

globalThis.setSimulationDriveSpeedMps = function(mps) {
    rapierDriveSimulation.applyDriveSpeedCommandMps(mps);
};

globalThis.setSimulationDriveSpeedKmh = function(kmh) {
    rapierDriveSimulation.applyDriveSpeedCommandKmh(kmh);
};

globalThis.setSimulationVisualSpeed = function(scale) {
    rapierDriveSimulation.applyVisualSpeedScale(scale);
};
