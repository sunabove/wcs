import * as THREE from "three";

const RAPIER_CDN = "https://cdn.skypack.dev/@dimforge/rapier3d-compat@0.11.2";
const SIM_SPEED_STORAGE_KEY = "wcs.simulation.driveSpeedMps";
const SIM_SPEED_LEGACY_STORAGE_KEY = "wcs.simulation.driveSpeedKmh";
const SIM_SPEED_DEFAULT_MPS = 0.1;
const SIM_SPEED_MAX_MPS = 2.0;
const SIM_VISUAL_SPEED_STORAGE_KEY = "wcs.simulation.visualSpeedScale";
const SIM_VISUAL_SPEED_DEFAULT_SCALE = 0.5;
const SIM_VISUAL_SPEED_MIN_SCALE = 1 / 4;
const SIM_VISUAL_SPEED_MAX_SCALE = 4;
const SIM_VISUAL_SPEED_SCALES = [1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4];
const WHEEL_Z_CHART_INITIAL_HALF_RANGE_CM = 4;
const WHEEL_Z_CHART_HALF_RANGE_STEP_CM = 2;
const COLLISION_GROUP_GROUND = 0x00010002;
const COLLISION_GROUP_WHEEL = 0x00020005;
const COLLISION_GROUP_OBSTACLE = 0x0004000a;
const COLLISION_GROUP_CHASSIS = 0x00080004;

class VehicleModel {
  constructor(runtime) {
    this.runtime = runtime;
  }

  get viewer() {
    return this.runtime.viewer;
  }

  get robotModel() {
    return this.viewer?.robotModel || null;
  }

  get links() {
    return this.robotModel?.links || {};
  }

  get carFrame() {
    return this.runtime.carFrame;
  }

  syncFromPhysics() {
    this.runtime.syncCarFrameFromBody();
  }
}

class PhysicsEngine {
  constructor(runtime) {
    this.runtime = runtime;
  }

  get world() {
    return this.runtime.world;
  }

  get body() {
    return this.runtime.body;
  }

  step(fixedTimeStepSec) {
    if (!this.world) {
      return;
    }

    this.world.timestep = fixedTimeStepSec;
    this.world.step();
  }
}

class WheelController {
  constructor(runtime) {
    this.runtime = runtime;
  }

  updateGroundContactState() {
    return this.runtime.updateWheelGroundContactState();
  }

  getSideSignedRpm() {
    return this.runtime.getWheelSideSignedRpm();
  }
}

class ContactSolver {
  constructor(runtime) {
    this.runtime = runtime;
  }

  updateVehicleObstacleContact() {
    return this.runtime.updateObstacleContactState();
  }

  getApproachInfo() {
    return this.runtime.getObstacleApproachInfo();
  }

  isClimbApproach(obstacleInfo) {
    return this.runtime.isObstacleInFrontForClimb(obstacleInfo);
  }

  isObstacleTraversalActive() {
    return this.runtime.isObstacleTraversalActive();
  }

  applyClimbLift(obstacleInfo, fixedTimeStepSec) {
    this.runtime.applyObstacleClimbLift(true, fixedTimeStepSec, obstacleInfo);
  }

  preserveHeading(yaw = null) {
    this.runtime.preserveObstacleHeading(yaw);
  }
}

class VehicleController {
  constructor(runtime) {
    this.runtime = runtime;
  }

  getKeyboardState() {
    return this.runtime.getKeyboardDriveState();
  }

  getDriveSource() {
    return this.runtime.getDriveSourceViewer();
  }

  getSpeedMps() {
    return this.runtime.getCommandedDriveSpeedMps();
  }
}

class Renderer {
  constructor(runtime) {
    this.runtime = runtime;
  }

  syncVehicle() {
    this.runtime.syncCarFrameFromBody();
  }
}

class SimulationLoop {
  constructor(runtime) {
    this.runtime = runtime;
  }

  schedule() {
    requestAnimationFrame(() => this.runtime.runLoop());
  }
}

class RapierDriveSimulation {
  constructor() {
    this.vehicleModel = new VehicleModel(this);
    this.physicsEngine = new PhysicsEngine(this);
    this.wheelController = new WheelController(this);
    this.contactSolver = new ContactSolver(this);
    this.vehicleController = new VehicleController(this);
    this.renderer = new Renderer(this);
    this.simulationLoop = new SimulationLoop(this);
    this.viewer = null;
    this.rapier = null;
    this.world = null;
    this.body = null;
    this.vehicleCollider = null;
    this.vehicleColliders = [];
    this.wheelColliders = [];
    this.wheelCollidersByKey = {
      fl: null,
      fr: null,
      rl: null,
      rr: null,
    };
    this.wheelBodiesByKey = {
      fl: null,
      fr: null,
      rl: null,
      rr: null,
    };
    this.wheelJointsByKey = {
      fl: null,
      fr: null,
      rl: null,
      rr: null,
    };
    this.wheelGroundContactState = {
      fl: false,
      fr: false,
      rl: false,
      rr: false,
    };
    this.previousWheelColliderPositionByKey = {};
    this.groundColliders = [];
    this.vehicleColliderLocalCenter = new THREE.Vector3(0, 0, 0);
    this.vehicleColliderHalfExtents = { x: 0.1, y: 0.1, z: 0.1 };
    this.obstacleColliders = [];
    this.obstacleColliderInfos = [];
    this.activeObstacleTraversalPath = null;
    this.obstacleContactSurfaceToleranceMeters = 0.012;
    this.obstacleApproachDisableSnapDistanceMeters = 0.05;
    this.obstacleDepenetrationEpsilonMeters = 0.015;
    this.obstacleGeometryContactMarginMeters = 0.06;
    this.obstacleDepenetrationMaxIterations = 8;
    this.isVehicleObstacleContact = false;
    this.carFrame = null;
    this.vehicleDirectionArrowGroup = null;
    this.vehicleYawIndicatorGroup = null;
    this.vehicleYawArcLine = null;
    this.vehicleYawRadiusLine = null;
    this.vehicleYawArcArrowHead = null;
    this.vehicleInitialYawRad = null;
    this.initialPosition = null;
    this.initialQuaternion = null;
    this.vehicleHalfExtents = null;
    this.vehicleLocalMinZ = null;
    this.wheelLocalMinZ = null;
    this.wheelEffectiveRadiusMeters = 0.16;
    this.wheelColliderInflationMeters = 0.0;
    this.groundContactLocalMinZ = null;
    this.groundContactBiasMeters = 0;
    this.groundZ = 0;
    this.groundGrid = null;
    this.holeRegions = [];
    this.underbodyPassThroughClearanceMeters = 0.02;
    this.urdfObstacleLinkPrefix = "obstacle_";
    this.passUnderObstacleNamePatterns = [/pass_under/i, /underbody/i];
    this.maxSpeedMps = 100 / 3.6;
    this.maxYawRateRad = THREE.MathUtils.degToRad(25);
    this.centerTurnYawRateScale = 0.15;
    this.enableWheelPhysicsColliders = false;
    this.blockMotionOnObstacleContact = true;
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
    this.lastVelocitySnapshot = null;
    this.contactStrengthMetric = 0;
    this.accelerationMetric = 0;
    this.maxPhysicsCatchupSteps = 6;
    this.hasLoggedGroundDiagnostics = false;
    this.lastVelocitySnapshot = null;
    this.contactStrengthMetric = 0;
    this.accelerationMetric = 0;
    this.runtimeDiagnosticsElapsedSec = 0;
    this.debugStatusElapsedSec = 0;
    this.postObstacleGroundRecoverRemainingSec = 0;
    this.isUprightRotationLockActive = false;
    this.enableRuntimeDiagnostics = true;
    this.runtimeDiagnosticsIntervalSec = 1;
    this.runtimeDiagnosticsElapsedSec = 0;
    this.isKeyboardControlEnabled = true;
    this.keyHoldState = {
      ArrowUp: 0,
      ArrowDown: 0,
      ArrowLeft: 0,
      ArrowRight: 0,
    };
    this.commandedDriveMode = "stop";
    this.commandedSpeedMps = SIM_SPEED_DEFAULT_MPS;
    this.centerTurnPivotWorld = null;
    this.centerTurnPivotLocal = null;
    this.isPaused = false;
    this.pauseStateSnapshot = null;
    this.hasInstalledDriveCommandHooks = false;
    this.hasActivatedSimulationMotion = false;
    this.hasActivatedDynamicGroundClamp = false;
    this.visualSpeedScale = SIM_VISUAL_SPEED_DEFAULT_SCALE;
    this.lowSpeedPositionAssistDistanceMeters = 0;
    this.lowSpeedKinematicPosition = null;
    this.straightDriveReferencePose = null;
    this.straightDriveWarmupSteps = 0;
    this.predictedObstacleBlockActive = false;
    this.lastPredictedObstacleName = null;
    this.lastDriveCommandState = {
      throttleSign: 0,
      steerSign: 0,
      hasMoveCommand: false,
    };
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
    this.wheelZChartWindowSec = 10;
    this.simulationElapsedSec = 0;
    this.wheelZChartInitialHalfRangeCm = WHEEL_Z_CHART_INITIAL_HALF_RANGE_CM;
    this.wheelZChartHalfRangeCm = WHEEL_Z_CHART_INITIAL_HALF_RANGE_CM;
    this.wheelZChartObstacleContactEvents = [];
    this.isWheelZChartObstacleContactActive = false;
    this.wheelZChartLastSampleTimeMs = null;
    this.wheelZChartLastRenderTimeMs = null;
    this.wheelZChartVisibleStorageKey = "wcs.simulation.wheelZChartVisible";
    this.isWheelZChartVisible = this.loadWheelZChartVisibleState();
    this.wheelZChartHistoryByKey = {
      fl: [],
      fr: [],
      rl: [],
      rr: [],
    };
    this.wheelChartColorByKey = {
      fl: "#0d6efd",
      fr: "#dc3545",
      rl: "#198754",
      rr: "#fd7e14",
    };
    this.wheelDotColorByKey = {
      fl: "#7fb3ff",
      fr: "#ff8d9a",
      rl: "#63c78d",
      rr: "#ffb36b",
    };
    this.wheelLinkNameByKey = {
      fl: "wheel_fl",
      fr: "wheel_fr",
      rl: "wheel_rl",
      rr: "wheel_rr",
    };
    this.wheelRadiusMetersByKey = {
      fl: null,
      fr: null,
      rl: null,
      rr: null,
    };
    this.wheelChartBaselineCenterZByKey = {
      fl: null,
      fr: null,
      rl: null,
      rr: null,
    };
    this.wheelColliderInflationMeters = 0;
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
    const clamped = Math.max(
      SIM_SPEED_DEFAULT_MPS,
      Math.min(SIM_SPEED_MAX_MPS, base),
    );
    return Math.round(clamped * 10) / 10;
  }

  initDebugPanel() {
    this.debugPanelElement = document.getElementById("simulation-debug-panel");
    this.debugTextElement = document.getElementById("simulation-debug-text");
    if (!this.debugPanelElement || !this.debugTextElement) {
      return;
    }

    this.debugPanelElement.style.display = "block";
    this.debugTextElement.textContent = "초기화 중...";
  }

  ensureWheelZChartOverlay() {
    if (
      this.wheelZChartOverlayElement &&
      this.wheelZChartCanvasElement &&
      this.wheelZChartContext
    ) {
      return;
    }

    const container = this.viewer?.container || null;
    if (!container) {
      return;
    }

    const containerStyle = window.getComputedStyle(container);
    if (containerStyle.position === "static") {
      container.style.position = "relative";
    }

    const overlay = document.createElement("div");
    overlay.id = "wheel-z-chart-overlay";
    overlay.className = "position-absolute";
    overlay.style.right = "12px";
    overlay.style.bottom = "12px";
    overlay.style.width = "min(360px, 84vw)";
    overlay.style.minHeight = "32px";
    overlay.style.overflow = "visible";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "15";

    const buttonDock = document.createElement("div");
    buttonDock.style.position = "absolute";
    buttonDock.style.top = "8px";
    buttonDock.style.right = "8px";
    buttonDock.style.width = "28px";
    buttonDock.style.height = "28px";
    buttonDock.style.pointerEvents = "none";
    buttonDock.style.zIndex = "16";

    const panel = document.createElement("div");
    panel.className = "border border-primary-subtle rounded-3 shadow-sm";
    panel.style.width = "100%";
    panel.style.minHeight = "48px";
    panel.style.background = "rgba(255, 255, 255, 0.92)";
    panel.style.backdropFilter = "blur(2px)";
    panel.style.pointerEvents = "auto";
    panel.style.padding = "8px 8px 6px 8px";
    panel.style.position = "relative";
    panel.style.touchAction = "none";

    const titleRow = document.createElement("div");
    titleRow.className =
      "d-flex align-items-center justify-content-center gap-2";
    titleRow.style.marginBottom = "4px";
    titleRow.style.position = "relative";
    titleRow.style.minHeight = "20px";
    titleRow.style.padding = "0 36px 0 8px";
    titleRow.style.width = "100%";
    titleRow.style.zIndex = "3";

    const title = document.createElement("div");
    title.className = "small fw-semibold text-primary";
    title.style.lineHeight = "1.1";
    title.style.textAlign = "center";
    title.style.width = "100%";
    title.textContent = "Wheel Z Position";

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "btn btn-sm btn-outline-primary shadow-sm";
    toggleButton.style.flex = "0 0 auto";
    toggleButton.style.width = "28px";
    toggleButton.style.height = "28px";
    toggleButton.style.padding = "0";
    toggleButton.style.display = "inline-flex";
    toggleButton.style.alignItems = "center";
    toggleButton.style.justifyContent = "center";
    toggleButton.style.position = "absolute";
    toggleButton.style.right = "0";
    toggleButton.style.top = "50%";
    toggleButton.style.transform = "translateY(-50%)";
    toggleButton.style.pointerEvents = "auto";
    toggleButton.style.whiteSpace = "nowrap";
    toggleButton.style.borderRadius = "999px";
    toggleButton.style.borderWidth = "1px";
    toggleButton.style.lineHeight = "1";
    toggleButton.style.overflow = "hidden";
    toggleButton.innerHTML = this.getWheelZChartToggleButtonIconSvg(
      this.isWheelZChartVisible,
    );

    const canvas = document.createElement("canvas");
    canvas.width = 344;
    canvas.height = 154;
    canvas.style.width = "100%";
    canvas.style.height = "154px";
    canvas.style.display = "block";

    const body = document.createElement("div");
    body.style.display = "block";
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

    [
      "pointerdown",
      "pointermove",
      "pointerup",
      "mousedown",
      "mousemove",
      "mouseup",
      "click",
      "dblclick",
      "wheel",
      "touchstart",
      "touchmove",
      "touchend",
    ].forEach((eventName) => {
      overlay.addEventListener(eventName, blockViewerInteraction, {
        passive: false,
      });
      canvas.addEventListener(eventName, blockViewerInteraction, {
        passive: false,
      });
    });

    container.appendChild(overlay);

    this.wheelZChartOverlayElement = overlay;
    this.wheelZChartPanelElement = panel;
    this.wheelZChartBodyElement = body;
    this.wheelZChartTitleRowElement = titleRow;
    this.wheelZChartTitleElement = title;
    this.wheelZChartToggleButtonElement = toggleButton;
    this.wheelZChartCanvasElement = canvas;
    this.wheelZChartContext = canvas.getContext("2d");
    toggleButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleWheelZChartVisible();
    });

    this.updateWheelZChartVisibility();
  }

  loadWheelZChartVisibleState() {
    try {
      if (typeof window.localStorage === "undefined") {
        return true;
      }

      const savedValue = window.localStorage.getItem(
        this.wheelZChartVisibleStorageKey,
      );
      if (savedValue == null) {
        return true;
      }

      return savedValue === "1" || savedValue === "true";
    } catch (error) {
      return true;
    }
  }

  saveWheelZChartVisibleState() {
    try {
      if (typeof window.localStorage === "undefined") {
        return;
      }

      window.localStorage.setItem(
        this.wheelZChartVisibleStorageKey,
        this.isWheelZChartVisible ? "1" : "0",
      );
    } catch (error) {
      // Ignore storage failures in restricted browser modes.
    }
  }

  updateWheelZChartToggleButtonState() {
    if (!this.wheelZChartToggleButtonElement) {
      return;
    }

    const isVisible = this.isWheelZChartVisible;
    this.wheelZChartToggleButtonElement.innerHTML =
      this.getWheelZChartToggleButtonIconSvg(isVisible);
    this.wheelZChartToggleButtonElement.setAttribute(
      "aria-pressed",
      isVisible ? "true" : "false",
    );
    this.wheelZChartToggleButtonElement.setAttribute(
      "aria-label",
      isVisible ? "휠 차트 숨기기" : "휠 차트 표시",
    );
    this.wheelZChartToggleButtonElement.title = isVisible
      ? "휠 차트 숨기기"
      : "휠 차트 표시";
  }

  updateWheelZChartVisibility() {
    const isVisible = this.isWheelZChartVisible;

    if (this.wheelZChartToggleButtonElement) {
      this.wheelZChartToggleButtonElement.style.top = isVisible ? "50%" : "0";
      this.wheelZChartToggleButtonElement.style.transform = isVisible
        ? "translateY(-50%)"
        : "translateY(0)";
      this.wheelZChartToggleButtonElement.style.right = isVisible ? "0" : "0";
    }

    if (this.wheelZChartTitleRowElement) {
      this.wheelZChartTitleRowElement.style.marginBottom = isVisible
        ? "4px"
        : "0";
      this.wheelZChartTitleRowElement.style.justifyContent = "center";
      this.wheelZChartTitleRowElement.style.minHeight = isVisible
        ? "28px"
        : "0";
      this.wheelZChartTitleRowElement.style.paddingRight = "0";
    }

    if (this.wheelZChartTitleElement) {
      this.wheelZChartTitleElement.style.display = isVisible ? "block" : "none";
    }

    if (this.wheelZChartBodyElement) {
      this.wheelZChartBodyElement.style.display = isVisible ? "block" : "none";
    }

    if (this.wheelZChartPanelElement) {
      this.wheelZChartPanelElement.style.display = isVisible ? "block" : "none";
      this.wheelZChartPanelElement.style.opacity = "1";
    }

    this.updateWheelZChartToggleButtonState();
  }

  toggleWheelZChartVisible(forceVisible = null) {
    this.isWheelZChartVisible =
      typeof forceVisible === "boolean"
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

    this.wheelZChartObstacleContactEvents =
      this.wheelZChartObstacleContactEvents.filter(
        (event) => event.t >= minTimeSec,
      );
  }

  recordWheelZChartObstacleContactEvent(isContacting, timeSec) {
    const isActive = Boolean(isContacting);
    if (
      !Number.isFinite(timeSec) ||
      isActive === this.isWheelZChartObstacleContactActive
    ) {
      return;
    }

    this.isWheelZChartObstacleContactActive = isActive;
    this.wheelZChartObstacleContactEvents.push({
      t: timeSec,
      type: isActive ? "start" : "end",
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

      const geometryType = String(node.geometry.type || "");
      const geometryParams = node.geometry.parameters || {};
      const hasCylinderRadius =
        Number.isFinite(geometryParams.radiusTop) &&
        Number.isFinite(geometryParams.radiusBottom);
      if (!geometryType.includes("Cylinder") || !hasCylinderRadius) {
        return;
      }

      const worldScale = new THREE.Vector3(1, 1, 1);
      node.getWorldScale(worldScale);
      const maxScale = Math.max(
        Math.abs(worldScale.x),
        Math.abs(worldScale.y),
        Math.abs(worldScale.z),
        1e-6,
      );
      const candidateRadius =
        Math.max(geometryParams.radiusTop, geometryParams.radiusBottom) *
        maxScale;
      if (!Number.isFinite(candidateRadius) || candidateRadius <= 0) {
        return;
      }

      detectedRadiusMeters = Math.max(
        detectedRadiusMeters || 0,
        candidateRadius,
      );
    });

    return Number.isFinite(detectedRadiusMeters) ? detectedRadiusMeters : null;
  }

  sampleWheelCenterZForChart(nowSec) {
    if (!this.viewer?.robotModel?.links) {
      return;
    }

    const linkMap = this.vehicleModel.links;
    Object.entries(this.wheelLinkNameByKey).forEach(
      ([wheelKey, wheelLinkName]) => {
        const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
        if (!wheelLink) {
          return;
        }

        if (!Number.isFinite(this.wheelRadiusMetersByKey[wheelKey])) {
          const extractedRadius =
            this.extractWheelRadiusMetersFromLink(wheelLink);
          if (Number.isFinite(extractedRadius)) {
            this.wheelRadiusMetersByKey[wheelKey] = extractedRadius;
          }
        }

        const wheelRadiusMeters = Number.isFinite(
          this.wheelRadiusMetersByKey[wheelKey],
        )
          ? this.wheelRadiusMetersByKey[wheelKey]
          : Math.max(Number(this.wheelEffectiveRadiusMeters) || 0.16, 0.05);

        const centerWorld = new THREE.Vector3();
        const wheelCollider = this.wheelCollidersByKey?.[wheelKey] || null;
        if (wheelCollider && typeof wheelCollider.translation === "function") {
          const colliderPosition = wheelCollider.translation();
          centerWorld.set(
            colliderPosition.x,
            colliderPosition.y,
            colliderPosition.z,
          );
        } else {
          wheelLink.updateWorldMatrix(true, true);
          wheelLink.getWorldPosition(centerWorld);
        }

        if (!Number.isFinite(this.wheelChartBaselineCenterZByKey[wheelKey])) {
          this.wheelChartBaselineCenterZByKey[wheelKey] = centerWorld.z;
        }

        let chartCenterWorldZ = centerWorld.z;
        const traversalPath = this.activeObstacleTraversalPath;
        if (traversalPath && this.isObstacleTraversalActive()) {
          const bodyPosition = this.body?.translation();
          if (bodyPosition) {
            const bodyYaw = this.extractYawFromQuaternion(this.body.rotation());
            const wheelOffsetX = centerWorld.x - bodyPosition.x;
            const wheelOffsetY = centerWorld.y - bodyPosition.y;
            const wheelForwardOffset =
              wheelOffsetX * Math.cos(bodyYaw) +
              wheelOffsetY * Math.sin(bodyYaw);
            const wheelTargetBodyZ = this.getObstacleTraversalTargetZ(
              traversalPath,
              wheelForwardOffset,
            );
            if (Number.isFinite(wheelTargetBodyZ)) {
              chartCenterWorldZ =
                wheelTargetBodyZ + (centerWorld.z - bodyPosition.z);
            }
          }
        }

        const wheelCenterHeightDelta =
          chartCenterWorldZ - this.wheelChartBaselineCenterZByKey[wheelKey];
        if (!Number.isFinite(wheelCenterHeightDelta)) {
          return;
        }

        this.wheelZChartHistoryByKey[wheelKey].push({
          t: nowSec,
          z: wheelCenterHeightDelta,
        });
      },
    );

    this.trimWheelZChartHistory(nowSec);
  }

  initializeWheelZChartRangeFromObstacles(linkMap) {
    if (!linkMap || this.obstacleColliderInfos.length === 0) {
      return;
    }

    const wheelCenterZs = Object.values(this.wheelLinkNameByKey)
      .map((wheelLinkName) => {
        const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
        if (!wheelLink) {
          return null;
        }

        wheelLink.updateWorldMatrix(true, true);
        return wheelLink.getWorldPosition(new THREE.Vector3()).z;
      })
      .filter(Number.isFinite);
    if (wheelCenterZs.length === 0) {
      return;
    }

    const obstacleHeights = this.obstacleColliderInfos
      .filter(
        (obstacleInfo) =>
          obstacleInfo?.center && Number.isFinite(obstacleInfo?.halfExtents?.z),
      )
      .flatMap((obstacleInfo) => [
        obstacleInfo.center.z - obstacleInfo.halfExtents.z,
        obstacleInfo.center.z + obstacleInfo.halfExtents.z,
      ]);
    if (obstacleHeights.length === 0) {
      return;
    }

    const minWheelCenterZ = Math.min(...wheelCenterZs);
    const maxWheelCenterZ = Math.max(...wheelCenterZs);
    const minObstacleZ = Math.min(...obstacleHeights);
    const maxObstacleZ = Math.max(...obstacleHeights);
    const requiredHalfRangeCm = Math.max(
      WHEEL_Z_CHART_INITIAL_HALF_RANGE_CM,
      Math.abs(minObstacleZ - maxWheelCenterZ) * 100 * 1.12,
      Math.abs(maxObstacleZ - minWheelCenterZ) * 100 * 1.12,
    );
    const initialHalfRangeCm =
      Math.ceil(requiredHalfRangeCm / WHEEL_Z_CHART_HALF_RANGE_STEP_CM) *
      WHEEL_Z_CHART_HALF_RANGE_STEP_CM;

    this.wheelZChartInitialHalfRangeCm = initialHalfRangeCm;
    this.wheelZChartHalfRangeCm = Math.max(
      this.wheelZChartHalfRangeCm,
      initialHalfRangeCm,
    );
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

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const rawSamples = [];
    Object.keys(this.wheelZChartHistoryByKey).forEach((wheelKey) => {
      const samples = this.wheelZChartHistoryByKey[wheelKey] || [];
      rawSamples.push(...samples);
    });

    const uniqueSampleTimesSec = Array.from(
      new Set(rawSamples.map((sample) => sample.t)),
    ).sort((a, b) => a - b);
    const hasSamples = uniqueSampleTimesSec.length > 0;
    const firstSampleTimeSec = hasSamples ? uniqueSampleTimesSec[0] : 0;
    const minTimeSec = Math.max(
      nowSec - this.wheelZChartWindowSec,
      firstSampleTimeSec,
    );
    const windowEndSec = minTimeSec + this.wheelZChartWindowSec;
    const effectiveWindowSec = this.wheelZChartWindowSec;

    const visibleSamples = rawSamples.filter(
      (sample) => sample.t >= minTimeSec && sample.t <= windowEndSec,
    );

    const hasVisibleSamples = visibleSamples.length > 0;
    let minZ = hasVisibleSamples
      ? Math.min(...visibleSamples.map((sample) => sample.z))
      : Number.POSITIVE_INFINITY;
    let maxZ = hasVisibleSamples
      ? Math.max(...visibleSamples.map((sample) => sample.z))
      : Number.NEGATIVE_INFINITY;

    const maxHoleDepthMeters = (
      Array.isArray(this.holeRegions) ? this.holeRegions : []
    ).reduce((maxDepth, holeRegion) => {
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
        maxZ = Number.isFinite(this.groundZ)
          ? this.groundZ
          : Math.max(maxZ, holeMinZ + 0.05);
      }
    }

    if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
      minZ = 0;
      maxZ = 0.05;
    }

    minZ = Math.min(minZ, 0);
    maxZ = Math.max(maxZ, 0);

    if (maxZ - minZ < 0.001) {
      maxZ += 0.0005;
      minZ -= 0.0005;
    }
    // Keep a stable zero-centered range; expand only when the data needs it.
    const intervalCount = 4;
    const observedHalfRangeCm = Math.max(
      Math.abs(minZ * 100),
      Math.abs(maxZ * 100),
    );
    const requiredHalfRangeCm = Math.max(
      this.wheelZChartInitialHalfRangeCm,
      observedHalfRangeCm * 1.12,
    );
    const alignedHalfRangeCm =
      Math.ceil(requiredHalfRangeCm / WHEEL_Z_CHART_HALF_RANGE_STEP_CM) *
      WHEEL_Z_CHART_HALF_RANGE_STEP_CM;
    this.wheelZChartHalfRangeCm = Math.max(
      this.wheelZChartHalfRangeCm,
      alignedHalfRangeCm,
    );
    minZ = -this.wheelZChartHalfRangeCm / 100;
    maxZ = this.wheelZChartHalfRangeCm / 100;

    const toX = (t) =>
      margin.left + ((t - minTimeSec) / effectiveWindowSec) * plotWidth;
    const toY = (z) => margin.top + ((maxZ - z) / (maxZ - minZ)) * plotHeight;

    const xTickValuesSec = [];
    for (
      let tickOffsetSec = 0;
      tickOffsetSec <= this.wheelZChartWindowSec;
      tickOffsetSec += 1
    ) {
      xTickValuesSec.push(minTimeSec + tickOffsetSec);
    }

    const formatXAxisTimeLabel = (timeSec) => `${Math.round(timeSec)}s`;

    ctx.strokeStyle = "#d6deea";
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

    ctx.strokeStyle = "#495057";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + plotHeight);
    ctx.lineTo(margin.left + plotWidth, margin.top + plotHeight);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, margin.top + plotHeight);
    ctx.stroke();

    ctx.fillStyle = "#5f6b7a";
    ctx.font = "11px Segoe UI";
    xTickValuesSec.forEach((tickTimeSec, tickIndex) => {
      if (tickIndex === 0) {
        return;
      }

      const labelX = toX(tickTimeSec);
      const label = formatXAxisTimeLabel(tickTimeSec);
      ctx.fillText(label, labelX - 12, margin.top + plotHeight + 16);
    });

    const zTicks = intervalCount;
    ctx.fillText("cm", 8, 10);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= zTicks; i += 1) {
      const ratio = i / zTicks;
      const z = maxZ - (maxZ - minZ) * ratio;
      const y = margin.top + plotHeight * ratio;
      ctx.fillText(String(Math.round(z * 100)), margin.left - 4, y);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    const chartWheelKeys = ["fl", "fr", "rl", "rr"];
    const visibleSamplesByWheelKey = Object.fromEntries(
      chartWheelKeys.map((wheelKey) => [
        wheelKey,
        (this.wheelZChartHistoryByKey[wheelKey] || []).filter(
          (sample) => sample.t >= minTimeSec && sample.t <= windowEndSec,
        ),
      ]),
    );

    chartWheelKeys.forEach((wheelKey, wheelIndex) => {
      const samples = visibleSamplesByWheelKey[wheelKey];
      if (samples.length < 2) {
        return;
      }

      const seriesColor = this.wheelChartColorByKey[wheelKey] || "#222";
      ctx.strokeStyle = seriesColor;
      ctx.lineWidth = 1.7;
      ctx.setLineDash([4, 12]);
      ctx.lineDashOffset = wheelIndex * 4;
      ctx.beginPath();
      samples.forEach((sample, index) => {
        const x = toX(sample.t);
        const y = toY(sample.z);
        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    this.wheelZChartObstacleContactEvents
      .filter((event) => event.t >= minTimeSec && event.t <= windowEndSec)
      .forEach((event) => {
        const eventX = toX(event.t);
        ctx.strokeStyle = event.type === "start" ? "#dc3545" : "#198754";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(eventX, margin.top);
        ctx.lineTo(eventX, margin.top + plotHeight);
        ctx.stroke();
      });
    ctx.setLineDash([]);

    const legendKeys = ["fl", "fr", "rl", "rr"];
    const legendX = margin.left + plotWidth - 50;
    const legendStartY = margin.top + 14;
    const legendRowHeight = 18;
    ctx.font = "13px Segoe UI";
    ctx.textBaseline = "middle";
    legendKeys.forEach((wheelKey, index) => {
      const legendY = legendStartY + legendRowHeight * index;
      ctx.fillStyle = this.wheelChartColorByKey[wheelKey] || "#222";
      ctx.fillRect(legendX, legendY - 4, 14, 6);
      ctx.fillStyle = "#334155";
      ctx.fillText(wheelKey.toUpperCase(), legendX + 19, legendY);
    });
    ctx.textBaseline = "alphabetic";
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

    const activeViewerId = String(
      window.activeURDFViewer?.container?.id || "null",
    );
    const simulationViewerId = String(this.viewer?.container?.id || "null");
    const driveViewer = this.getDriveSourceViewer();
    const driveViewerId = String(driveViewer?.container?.id || "null");
    const driveMode = String(
      this.commandedDriveMode ||
        driveViewer?.driveMode ||
        this.viewer?.driveMode ||
        "stop",
    );
    const speedMpsInput = Number(this.commandedSpeedMps);
    const speedKmhInput = this.mpsToKmh(speedMpsInput);
    const speedMps = this.getCommandedDriveSpeedMps();
    const visualSpeedScale = Number(this.visualSpeedScale);
    const isReady = this.isReady ? "Y" : "N";
    const isFailed = this.hasFailed ? "Y" : "N";
    const isPaused = this.isPaused ? "Y" : "N";
    const hookState = this.hasInstalledDriveCommandHooks ? "Y" : "N";

    let bodySummary = "body=unavailable";
    let obstacleSummary = "wheelPlaneZ=n/a rock01TopZ=n/a underbodyGap=n/a";
    let wheelGroundSummary = "wheelGround=n/a";
    let metricsSummary = "metrics: contact=0 accel=0";
    if (this.body) {
      const pos = this.body.translation();
      const vel = this.body.linvel();
      bodySummary = `pos=(${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)}) vel=(${vel.x.toFixed(3)}, ${vel.y.toFixed(3)}, ${vel.z.toFixed(3)})`;

      const wheelContactPlaneZ = this.getWheelContactPlaneZ();
      const obstacleRock01TopZ = this.getObstacleTopZByName("obstacle_rock_01");
      const approachObstacle =
        this.getObstacleApproachInfo()?.obstacleInfo || null;
      const climbTargetZ = this.getObstacleClimbTargetZ(approachObstacle);
      const traversalPathActive = this.isObstacleTraversalActive();
      const traversalTargetZ = this.getObstacleTraversalTargetZ(
        this.activeObstacleTraversalPath,
      );
      const traversalPathName =
        this.activeObstacleTraversalPath?.obstacleInfo?.linkName || "n/a";
      const contactedObstacle = this.obstacleColliderInfos.find(
        (obstacleInfo) =>
          (Array.isArray(obstacleInfo?.contactedWheelKeys) &&
            obstacleInfo.contactedWheelKeys.length > 0) ||
          obstacleInfo?.hasChassisContact === true,
      );
      const contactedWheelKeys =
        contactedObstacle?.contactedWheelKeys?.join(",") || "n/a";
      const hasChassisContact = contactedObstacle?.hasChassisContact === true;
      const predictedObstacleName = this.lastPredictedObstacleName || "n/a";
      const gap =
        Number.isFinite(wheelContactPlaneZ) &&
        Number.isFinite(obstacleRock01TopZ)
          ? wheelContactPlaneZ - obstacleRock01TopZ
          : null;

      obstacleSummary = `wheelPlaneZ=${Number.isFinite(wheelContactPlaneZ) ? wheelContactPlaneZ.toFixed(3) : "n/a"} rock01TopZ=${Number.isFinite(obstacleRock01TopZ) ? obstacleRock01TopZ.toFixed(3) : "n/a"} climb=${approachObstacle?.linkName || "n/a"} targetZ=${Number.isFinite(climbTargetZ) ? climbTargetZ.toFixed(3) : "n/a"} contactObstacle=${contactedObstacle?.linkName || "n/a"} predictedObstacle=${predictedObstacleName} contactWheels=${contactedWheelKeys} contactChassis=${hasChassisContact ? "Y" : "N"} path=${traversalPathActive ? "Y" : "N"} pathName=${traversalPathName} pathZ=${Number.isFinite(traversalTargetZ) ? traversalTargetZ.toFixed(3) : "n/a"} underbodyGap=${Number.isFinite(gap) ? gap.toFixed(3) : "n/a"}`;
      const wheelState = Object.entries(this.wheelGroundContactState || {})
        .map(([key, isContacting]) => `${key}${isContacting ? "Y" : "N"}`)
        .join(" ");
      wheelGroundSummary = `wheelGround=${wheelState}`;

      const groundContactCount = Object.values(
        this.wheelGroundContactState || {},
      ).filter(Boolean).length;
      const obstacleContactStrength = this.isVehicleObstacleContact ? 1 : 0;
      const contactStrengthMetric = Math.min(
        1,
        obstacleContactStrength + groundContactCount / 4,
      );
      this.contactStrengthMetric = contactStrengthMetric;

      const currentVelocity = this.body.linvel();
      if (!this.hasActivatedSimulationMotion) {
        this.accelerationMetric = 0;
      } else if (this.lastVelocitySnapshot) {
        const deltaVx = currentVelocity.x - this.lastVelocitySnapshot.x;
        const deltaVy = currentVelocity.y - this.lastVelocitySnapshot.y;
        const deltaVz = currentVelocity.z - this.lastVelocitySnapshot.z;
        const accelMagnitude =
          Math.hypot(deltaVx, deltaVy, deltaVz) /
          Math.max(Number(deltaSec) || 0.016, 0.001);
        this.accelerationMetric = Math.min(4, accelMagnitude);
      }
      this.lastVelocitySnapshot = {
        x: currentVelocity.x,
        y: currentVelocity.y,
        z: currentVelocity.z,
      };

      metricsSummary = `metrics: contact=${contactStrengthMetric.toFixed(2)} accel=${this.accelerationMetric.toFixed(2)} lowAssist=${this.lowSpeedPositionAssistDistanceMeters.toFixed(5)}m throttle=${this.lastDriveCommandState.throttleSign} steer=${this.lastDriveCommandState.steerSign} move=${this.lastDriveCommandState.hasMoveCommand ? "Y" : "N"}`;
    }

    const statusLine = `status: ready=${isReady} failed=${isFailed} paused=${isPaused} hooks=${hookState}`;
    const viewerLine = `viewer: active=${activeViewerId} sim=${simulationViewerId} drive=${driveViewerId}`;
    const driveLine = `drive: mode=${driveMode} input=${Number.isFinite(speedMpsInput) ? `${speedMpsInput.toFixed(1)} m/s` : "NaN"} (${Number.isFinite(speedKmhInput) ? `${speedKmhInput.toFixed(1)} km/h` : "NaN"}) speed=${Number.isFinite(speedMps) ? `${speedMps.toFixed(3)} m/s` : "NaN"}`;
    const visualLine = `visual: ${Number.isFinite(visualSpeedScale) ? this.formatVisualSpeedScaleLabel(visualSpeedScale) : "NaN"}`;

    this.debugTextElement.textContent = [
      statusLine,
      viewerLine,
      driveLine,
      visualLine,
      bodySummary,
      obstacleSummary,
      wheelGroundSummary,
      metricsSummary,
      `contact: obstacle=${this.isVehicleObstacleContact ? "Y" : "N"}`,
    ].join("\n");
  }

  installDriveCommandHooks() {
    if (this.hasInstalledDriveCommandHooks) {
      return;
    }

    let hasHookedAnyCommand = false;

    const originalSetDriveMode = globalThis.setDriveMode;
    if (typeof originalSetDriveMode === "function") {
      globalThis.setDriveMode = (mode) => {
        this.commandedDriveMode = String(mode || "stop");
        return originalSetDriveMode(mode);
      };
      hasHookedAnyCommand = true;
    }

    const originalSetDriveSpeedKmh = globalThis.setDriveSpeedKmh;
    if (typeof originalSetDriveSpeedKmh === "function") {
      globalThis.setDriveSpeedKmh = (kmh) => {
        const numericKmh = Number.parseFloat(kmh);
        if (Number.isFinite(numericKmh)) {
          this.commandedSpeedMps = this.normalizeDriveSpeedMps(
            this.kmhToMps(numericKmh),
            SIM_SPEED_DEFAULT_MPS,
          );
        }
        return originalSetDriveSpeedKmh(kmh);
      };
      hasHookedAnyCommand = true;
    }

    // Keep retrying on later frames until command functions are available and wrapped.
    this.hasInstalledDriveCommandHooks = hasHookedAnyCommand;
  }

  syncInitialDriveStateFromUi() {
    const speedInput = document.getElementById("drive-speed-mps");
    const initialSpeedMps = speedInput
      ? Number.parseFloat(speedInput.value)
      : SIM_SPEED_DEFAULT_MPS;

    this.commandedDriveMode = "stop";
    this.commandedSpeedMps = this.normalizeDriveSpeedMps(
      initialSpeedMps,
      SIM_SPEED_DEFAULT_MPS,
    );

    if (typeof globalThis.setDriveSpeedKmh === "function") {
      globalThis.setDriveSpeedKmh(this.mpsToKmh(this.commandedSpeedMps));
    }

    if (typeof globalThis.setDriveMode === "function") {
      globalThis.setDriveMode("stop");
    }
  }

  stopSimulationMotion() {
    if (this.body && this.rapier) {
      const translation = this.body.translation();
      const rotation = this.body.rotation();
      this.body.setTranslation(
        new this.rapier.Vector3(translation.x, translation.y, translation.z),
        true,
      );
      this.body.setRotation(
        { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
        true,
      );
      this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
      this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
      Object.values(this.wheelBodiesByKey).forEach((wheelBody) => {
        if (!wheelBody) {
          return;
        }
        wheelBody.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
        wheelBody.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
      });
    }

    ["fl", "fr", "rl", "rr"].forEach((key) => {
      if (typeof globalThis.setWheelAnimationByKey === "function") {
        globalThis.setWheelAnimationByKey(key, 0);
      }
    });

    this.hasActivatedSimulationMotion = false;
    this.hasActivatedDynamicGroundClamp = false;
    this.clearCenterTurnPivot();
    this.wheelZChartLastSampleTimeMs = null;

    if (this.carFrame) {
      this.syncCarFrameFromBody();
    }
  }

  applyDriveModeCommand(mode) {
    const normalizedMode = String(mode || "stop");
    const hasDriveModeChanged = this.commandedDriveMode !== normalizedMode;
    this.commandedDriveMode = normalizedMode;
    if (hasDriveModeChanged) {
      this.lowSpeedKinematicPosition = null;
      this.lastStepTimeMs = 0;
      if (
        (normalizedMode === "forward" || normalizedMode === "backward") &&
        this.body
      ) {
        const position = this.body.translation();
        this.straightDriveReferencePose = {
          y: position.y,
          z: position.z,
          yaw: this.extractYawFromQuaternion(this.body.rotation()),
        };
        this.straightDriveWarmupSteps = 6;
      } else {
        this.straightDriveReferencePose = null;
        this.straightDriveWarmupSteps = 0;
      }
    }
    const isCenterTurn =
      normalizedMode === "left" || normalizedMode === "right";

    if (isCenterTurn) {
      this.captureCenterTurnPivot();
    } else {
      this.clearCenterTurnPivot();
    }

    if (normalizedMode === "stop") {
      this.stopSimulationMotion();
    }

    if (typeof globalThis.setDriveMode === "function") {
      globalThis.setDriveMode(normalizedMode);
    }

    const viewer = this.getDriveSourceViewer() || this.viewer;
    if (viewer && typeof viewer.applyDriveMode === "function") {
      const speedKmh = Math.max(this.mpsToKmh(this.commandedSpeedMps), 0);
      viewer.applyDriveMode(normalizedMode, speedKmh);
    }
  }

  clearCenterTurnPivot() {
    this.centerTurnPivotWorld = null;
    this.centerTurnPivotLocal = null;
  }

  captureCenterTurnPivot() {
    if (!this.carFrame || !this.body) {
      this.clearCenterTurnPivot();
      return;
    }

    const linkMap = this.viewer?.robotModel?.links || null;
    const wheelCenters = Object.values(this.wheelLinkNameByKey)
      .map((wheelLinkName) => this.findLinkByName(linkMap, wheelLinkName))
      .filter(Boolean)
      .map((wheelLink) => {
        wheelLink.updateWorldMatrix(true, false);
        return wheelLink.getWorldPosition(new THREE.Vector3());
      });

    if (wheelCenters.length !== 4) {
      this.clearCenterTurnPivot();
      return;
    }

    const centerTurnPivotWorld = wheelCenters
      .reduce((sum, wheelCenter) => sum.add(wheelCenter), new THREE.Vector3())
      .multiplyScalar(1 / wheelCenters.length);

    const bodyPosition = this.body.translation();
    const bodyRotation = this.body.rotation();
    const bodyQuaternion = new THREE.Quaternion(
      bodyRotation.x,
      bodyRotation.y,
      bodyRotation.z,
      bodyRotation.w,
    ).normalize();
    this.carFrame.updateWorldMatrix(true, false);
    this.centerTurnPivotLocal = this.carFrame.worldToLocal(
      centerTurnPivotWorld.clone(),
    );
    this.centerTurnPivotWorld = this.centerTurnPivotLocal
      .clone()
      .applyQuaternion(bodyQuaternion)
      .add(new THREE.Vector3(bodyPosition.x, bodyPosition.y, bodyPosition.z));
  }

  constrainCenterTurnPivot() {
    const isCenterTurn =
      this.commandedDriveMode === "left" || this.commandedDriveMode === "right";
    if (
      isCenterTurn &&
      (!this.centerTurnPivotWorld || !this.centerTurnPivotLocal)
    ) {
      this.captureCenterTurnPivot();
    }
    if (
      !isCenterTurn ||
      !this.body ||
      !this.rapier ||
      !this.centerTurnPivotWorld ||
      !this.centerTurnPivotLocal
    ) {
      return;
    }

    const rotation = this.body.rotation();
    const bodyQuaternion = new THREE.Quaternion(
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    ).normalize();
    const localPivotOffset = this.centerTurnPivotLocal
      .clone()
      .applyQuaternion(bodyQuaternion);
    const nextPosition = this.centerTurnPivotWorld
      .clone()
      .sub(localPivotOffset);
    const velocity = this.body.linvel();

    this.body.setTranslation(
      new this.rapier.Vector3(nextPosition.x, nextPosition.y, nextPosition.z),
      true,
    );
    this.body.setLinvel(new this.rapier.Vector3(0, 0, velocity.z), true);
  }

  applyDriveSpeedCommandMps(mps) {
    const normalizedMps = this.normalizeDriveSpeedMps(mps, 0);
    const hasSpeedChanged = this.commandedSpeedMps !== normalizedMps;
    this.commandedSpeedMps = normalizedMps;
    if (hasSpeedChanged) {
      this.lowSpeedKinematicPosition = null;
      this.physicsAccumulatorSec = 0;
      this.lastStepTimeMs = 0;
    }
    const normalizedKmh = this.mpsToKmh(normalizedMps);

    if (typeof globalThis.setDriveSpeedKmh === "function") {
      globalThis.setDriveSpeedKmh(normalizedKmh);
    }

    const viewer = this.getDriveSourceViewer() || this.viewer;
    if (!viewer) {
      return;
    }

    const driveMode = String(this.commandedDriveMode || "stop");
    if (driveMode !== "stop" && typeof viewer.applyDriveMode === "function") {
      viewer.applyDriveMode(driveMode, normalizedKmh);
      return;
    }

    viewer.driveSpeedKmh = normalizedKmh;
  }

  applyDriveSpeedCommandKmh(kmh) {
    this.applyDriveSpeedCommandMps(this.kmhToMps(kmh));
  }

  findSimulationViewer() {
    const viewerById = window.urdfViewersById?.["robot-container-1"] || null;
    if (viewerById) {
      return viewerById;
    }

    if (Array.isArray(window.urdfViewers)) {
      const matched = window.urdfViewers.find((viewer) => {
        const urdfPath = String(viewer?.urdfPath || "");
        return urdfPath.includes("/model/vehicle/vehicle.urdf");
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
      1 - 2 * (quaternion.y * quaternion.y + quaternion.z * quaternion.z),
    );
  }

  getVehicleForwardVector(yaw) {
    return {
      x: Math.cos(yaw),
      y: Math.sin(yaw),
    };
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

    const otherLinkRoots = Object.values(linkMap || {}).filter(
      (root) =>
        root &&
        root !== linkObject &&
        this.isDescendantObject3D(root, linkObject),
    );
    const bounds = new THREE.Box3();
    let hasMesh = false;

    linkObject.updateWorldMatrix(true, true);

    linkObject.traverse((node) => {
      if (!node || !node.isMesh || !node.geometry) {
        return;
      }

      if (typeof meshFilter === "function" && !meshFilter(node)) {
        return;
      }

      const belongsToOtherLink = otherLinkRoots.some(
        (root) => node === root || this.isDescendantObject3D(node, root),
      );
      if (belongsToOtherLink) {
        return;
      }

      if (!node.geometry.boundingBox) {
        node.geometry.computeBoundingBox();
      }

      if (!node.geometry.boundingBox) {
        return;
      }

      const meshBounds = node.geometry.boundingBox
        .clone()
        .applyMatrix4(node.matrixWorld);
      bounds.union(meshBounds);
      hasMesh = true;
    });

    return hasMesh ? bounds : null;
  }

  computeGroundBoundsPreferCollision(linkObject, linkMap) {
    if (!linkObject) {
      return null;
    }

    const collisionBounds = this.computeLinkOwnBoundsWithMeshFilter(
      linkObject,
      linkMap,
      (node) => {
        const nodeName = String(node?.name || "").toLowerCase();
        const parentName = String(node?.parent?.name || "").toLowerCase();
        const userDataType = String(node?.userData?.type || "").toLowerCase();
        const userDataTag = String(node?.userData?.urdfTag || "").toLowerCase();
        const hint = `${nodeName} ${parentName} ${userDataType} ${userDataTag}`;
        return hint.includes("collision");
      },
    );

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
    const obstacleRoots = obstacleLinkNames
      .map((name) => linkMap[name])
      .filter(Boolean);
    const excludedRoots = [...obstacleRoots].filter(Boolean);
    const ignoredChassisLinkNames = [
      "wheel_fl",
      "wheel_fr",
      "wheel_rl",
      "wheel_rr",
      "gear_fl",
      "gear_fr",
      "gear_rl",
      "gear_rr",
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

      const isExcluded = excludedRoots.some(
        (root) => node === root || this.isDescendantObject3D(node, root),
      );
      if (isExcluded) {
        return;
      }

      if (!node.geometry.boundingBox) {
        node.geometry.computeBoundingBox();
      }

      if (!node.geometry.boundingBox) {
        return;
      }

      const meshBounds = node.geometry.boundingBox
        .clone()
        .applyMatrix4(node.matrixWorld);
      bounds.union(meshBounds);
      hasMesh = true;
    });

    return hasMesh ? bounds : fallbackBounds;
  }

  normalizeLinkName(linkName) {
    if (!linkName) {
      return "";
    }

    return String(linkName).split(/[:/]/).filter(Boolean).pop().toLowerCase();
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
    const obstaclePrefix = String(
      this.urdfObstacleLinkPrefix || "obstacle_",
    ).toLowerCase();

    Object.keys(linkMap).forEach((name) => {
      const normalizedName = this.normalizeLinkName(name);
      const isOriginObject =
        /(^|[_-])origin($|[_-])/i.test(name) ||
        /(^|[_-])origin($|[_-])/i.test(normalizedName);
      const isVehicleStructure =
        /(^|[_-])(car_frame|base_link|wheel|gear|swing|inner_wheel|inner_gear|chassis)(_|$)/i.test(
          name,
        ) ||
        /(^|[_-])(car_frame|base_link|wheel|gear|swing|inner_wheel|inner_gear|chassis)(_|$)/i.test(
          normalizedName,
        );
      if (isOriginObject || isVehicleStructure) {
        return;
      }

      if (normalizedName.startsWith(obstaclePrefix)) {
        names.add(name);
      }
    });

    return Array.from(names);
  }

  isTextInputElement(targetElement) {
    if (!targetElement || typeof targetElement !== "object") {
      return false;
    }

    const tagName = String(targetElement.tagName || "").toLowerCase();
    return (
      tagName === "input" ||
      tagName === "textarea" ||
      tagName === "select" ||
      Boolean(targetElement.isContentEditable)
    );
  }

  getSignedWheelRpmSnapshotByKey(viewer) {
    if (!viewer) {
      return null;
    }

    const wheelKeys = ["fl", "fr", "rl", "rr"];
    const snapshot = {};
    wheelKeys.forEach((key) => {
      let signedRpm = null;
      if (typeof viewer.getSignedWheelRpm === "function") {
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
    const nextPausedState =
      typeof forcePaused === "boolean" ? forcePaused : !this.isPaused;

    if (this.isPaused === nextPausedState) {
      return;
    }

    this.isPaused = nextPausedState;
    this.lastStepTimeMs = 0;

    if (this.isPaused) {
      const driveViewer = this.getDriveSourceViewer();
      const snapshotDriveMode = String(
        this.commandedDriveMode ||
          driveViewer?.driveMode ||
          this.viewer?.driveMode ||
          "stop",
      );
      const snapshotSpeedMps = this.normalizeDriveSpeedMps(
        Number.isFinite(Number(this.commandedSpeedMps))
          ? this.commandedSpeedMps
          : this.kmhToMps(Number(driveViewer?.driveSpeedKmh) || 0),
        SIM_SPEED_DEFAULT_MPS,
      );
      this.pauseStateSnapshot = {
        driveMode: snapshotDriveMode,
        speedMps: snapshotSpeedMps,
        wheelSignedRpmByKey: this.getSignedWheelRpmSnapshotByKey(driveViewer),
      };

      this.keyHoldState.ArrowUp = 0;
      this.keyHoldState.ArrowDown = 0;
      this.keyHoldState.ArrowLeft = 0;
      this.keyHoldState.ArrowRight = 0;

      // Pause mode should freeze visual wheel rotation as well.
      this.applyDriveModeCommand("stop");
      ["fl", "fr", "rl", "rr"].forEach((key) => {
        if (typeof globalThis.setWheelAnimationByKey === "function") {
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

      if (snapshot.driveMode === "stop" && snapshot.wheelSignedRpmByKey) {
        Object.entries(snapshot.wheelSignedRpmByKey).forEach(
          ([key, signedRpm]) => {
            if (typeof globalThis.setWheelAnimationByKey === "function") {
              globalThis.setWheelAnimationByKey(key, signedRpm);
            }
          },
        );
      }

      this.pauseStateSnapshot = null;
    }

    this.updateDebugPanel(this.debugStatusUpdateIntervalSec);
    console.log(`[URDF][Simulation] ${this.isPaused ? "Paused" : "Resumed"}`);
  }

  attachKeyboardControls() {
    if (!this.isKeyboardControlEnabled) {
      return;
    }

    const handledKeys = new Set([
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
    ]);
    const driveModeByArrowKey = {
      ArrowUp: "forward",
      ArrowDown: "backward",
      ArrowLeft: "left",
      ArrowRight: "right",
    };

    window.addEventListener(
      "keydown",
      (event) => {
        if (this.isTextInputElement(event.target)) {
          return;
        }

        const isSpaceKey =
          event.code === "Space" ||
          event.key === " " ||
          event.key === "Spacebar";
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

        const nextDriveMode = driveModeByArrowKey[event.key] || null;
        if (nextDriveMode) {
          if (this.isPaused) {
            this.togglePause(false);
          }
          this.applyDriveModeCommand(nextDriveMode);
          event.preventDefault();
          return;
        }
      },
      { passive: false },
    );

    window.addEventListener(
      "keyup",
      (event) => {
        if (!handledKeys.has(event.key)) {
          return;
        }

        this.keyHoldState[event.key] = 0;
        event.preventDefault();
      },
      { passive: false },
    );

    window.addEventListener("blur", () => {
      this.keyHoldState.ArrowUp = 0;
      this.keyHoldState.ArrowDown = 0;
      this.keyHoldState.ArrowLeft = 0;
      this.keyHoldState.ArrowRight = 0;
    });
  }

  isFrontFacingViewActive() {
    const faceKey = String(
      this.viewer?.viewCubeActiveFaceKey || "",
    ).toLowerCase();
    if (faceKey) {
      return faceKey === "front";
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
      moveY,
    };
  }

  getKeyboardNudgeDistance() {
    const halfWidth = Number(this.vehicleHalfExtents?.y);
    const fullWidth =
      Number.isFinite(halfWidth) && halfWidth > 0 ? halfWidth * 2 : 0.5;
    return fullWidth / 10;
  }

  updateSpeedSliderVisual(sliderElement) {
    if (!sliderElement) {
      return;
    }

    const minValue = Number.parseFloat(sliderElement.min);
    const maxValue = Number.parseFloat(sliderElement.max);
    const currentValue = Number.parseFloat(sliderElement.value);

    if (
      !Number.isFinite(minValue) ||
      !Number.isFinite(maxValue) ||
      maxValue <= minValue ||
      !Number.isFinite(currentValue)
    ) {
      sliderElement.style.setProperty("--slider-percent", "0%");
      return;
    }

    const clampedValue = Math.max(minValue, Math.min(maxValue, currentValue));
    const percent = ((clampedValue - minValue) / (maxValue - minValue)) * 100;
    sliderElement.style.setProperty("--slider-percent", `${percent}%`);
  }

  initializeSpeedSliderPreference() {
    const speedSlider = document.getElementById("drive-speed-mps");
    const speedLabel = document.getElementById("drive-speed-mps-value");
    const speedInput = document.getElementById("drive-speed-mps-input");
    if (!speedSlider) {
      return;
    }

    const sliderMin = Number.parseFloat(speedSlider.min);
    const sliderMax = Number.parseFloat(speedSlider.max);
    const effectiveMin = Number.isFinite(sliderMin) ? sliderMin : 0;
    const effectiveMax =
      Number.isFinite(sliderMax) && sliderMax >= effectiveMin
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
        const legacyKmhValue = window.localStorage.getItem(
          SIM_SPEED_LEGACY_STORAGE_KEY,
        );
        if (legacyKmhValue != null) {
          initialSpeed = parseSpeed(
            this.kmhToMps(legacyKmhValue),
            SIM_SPEED_DEFAULT_MPS,
          );
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
      speedLabel.textContent = "m/s";
    }

    this.applyDriveSpeedCommandMps(initialSpeed);

    const persistSpeed = () => {
      const normalizedSpeed = parseSpeed(
        speedSlider.value,
        SIM_SPEED_DEFAULT_MPS,
      );
      speedSlider.value = normalizedSpeed.toFixed(1);
      if (speedInput) {
        speedInput.value = normalizedSpeed.toFixed(1);
      }
      if (speedLabel) {
        speedLabel.textContent = "m/s";
      }
      this.applyDriveSpeedCommandMps(normalizedSpeed);
      try {
        window.localStorage.setItem(
          SIM_SPEED_STORAGE_KEY,
          String(normalizedSpeed),
        );
      } catch (error) {
        // Ignore storage failures and continue runtime behavior.
      }
    };

    speedSlider.addEventListener("input", persistSpeed);
    speedSlider.addEventListener("change", persistSpeed);
    if (speedInput) {
      speedInput.addEventListener("input", () => {
        const normalizedSpeed = parseSpeed(
          speedInput.value,
          SIM_SPEED_DEFAULT_MPS,
        );
        speedSlider.value = normalizedSpeed.toFixed(1);
        this.updateSpeedSliderVisual(speedSlider);
        if (speedLabel) {
          speedLabel.textContent = "m/s";
        }
        this.applyDriveSpeedCommandMps(normalizedSpeed);
        try {
          window.localStorage.setItem(
            SIM_SPEED_STORAGE_KEY,
            String(normalizedSpeed),
          );
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

    const clampedValue = Math.max(
      SIM_VISUAL_SPEED_MIN_SCALE,
      Math.min(SIM_VISUAL_SPEED_MAX_SCALE, numericValue),
    );
    return SIM_VISUAL_SPEED_SCALES.reduce((closestScale, scale) =>
      Math.abs(scale - clampedValue) < Math.abs(closestScale - clampedValue)
        ? scale
        : closestScale,
    );
  }

  normalizeVisualSpeedSliderValue(rawValue) {
    const numericValue = Number.parseFloat(rawValue);
    if (!Number.isFinite(numericValue)) {
      return this.getVisualSpeedSliderValueFromScale(
        SIM_VISUAL_SPEED_DEFAULT_SCALE,
      );
    }

    return Math.max(
      1,
      Math.min(SIM_VISUAL_SPEED_SCALES.length, Math.round(numericValue)),
    );
  }

  getVisualSpeedScaleFromSliderValue(value) {
    const sliderValue = this.normalizeVisualSpeedSliderValue(value);
    return SIM_VISUAL_SPEED_SCALES[sliderValue - 1];
  }

  getVisualSpeedSliderValueFromScale(scale) {
    const normalizedScale = this.normalizeVisualSpeedScale(scale);
    return SIM_VISUAL_SPEED_SCALES.indexOf(normalizedScale) + 1;
  }

  formatVisualSpeedScaleLabel(scale) {
    return `${this.formatVisualSpeedScaleInput(scale)}x`;
  }

  formatVisualSpeedScaleInput(scale) {
    const sliderValue = this.getVisualSpeedSliderValueFromScale(scale);
    if (sliderValue < 4) {
      return `1/${5 - sliderValue}`;
    }
    return String(SIM_VISUAL_SPEED_SCALES[sliderValue - 1]);
  }

  applyVisualSpeedScale(value) {
    const normalizedScale = this.normalizeVisualSpeedScale(value);
    this.visualSpeedScale = normalizedScale;
    this.configureWheelVisualKinematics();

    const speedSlider = document.getElementById(
      "simulation-visual-speed-scale",
    );
    const speedLabel = document.getElementById(
      "simulation-visual-speed-scale-value",
    );
    const speedInput = document.getElementById(
      "simulation-visual-speed-scale-input",
    );
    if (speedSlider) {
      speedSlider.value = String(
        this.getVisualSpeedSliderValueFromScale(normalizedScale),
      );
      this.updateSpeedSliderVisual(speedSlider);
    }
    if (speedInput) {
      speedInput.value = this.formatVisualSpeedScaleInput(normalizedScale);
    }
    if (speedLabel) {
      speedLabel.textContent = "x";
    }

    try {
      window.localStorage.setItem(
        SIM_VISUAL_SPEED_STORAGE_KEY,
        String(normalizedScale),
      );
    } catch (error) {
      // Ignore storage failures and continue runtime behavior.
    }
  }

  initializeVisualSpeedSliderPreference() {
    const speedSlider = document.getElementById(
      "simulation-visual-speed-scale",
    );
    const speedLabel = document.getElementById(
      "simulation-visual-speed-scale-value",
    );
    const speedInput = document.getElementById(
      "simulation-visual-speed-scale-input",
    );
    if (!speedSlider) {
      return;
    }

    let initialScale = SIM_VISUAL_SPEED_DEFAULT_SCALE;
    try {
      const storedValue = window.localStorage.getItem(
        SIM_VISUAL_SPEED_STORAGE_KEY,
      );
      if (storedValue != null) {
        initialScale = this.normalizeVisualSpeedScale(storedValue);
      }
    } catch (error) {
      initialScale = SIM_VISUAL_SPEED_DEFAULT_SCALE;
    }

    speedSlider.value = String(
      this.getVisualSpeedSliderValueFromScale(initialScale),
    );
    this.updateSpeedSliderVisual(speedSlider);
    if (speedInput) {
      speedInput.value = this.formatVisualSpeedScaleInput(initialScale);
    }
    if (speedLabel) {
      speedLabel.textContent = "x";
    }

    this.visualSpeedScale = initialScale;

    const persistScale = () => {
      const normalizedScale = this.getVisualSpeedScaleFromSliderValue(
        speedSlider.value,
      );
      this.visualSpeedScale = normalizedScale;
      this.configureWheelVisualKinematics();
      const sliderValue =
        this.getVisualSpeedSliderValueFromScale(normalizedScale);
      speedSlider.value = String(sliderValue);
      this.updateSpeedSliderVisual(speedSlider);
      if (speedInput) {
        speedInput.value = this.formatVisualSpeedScaleInput(normalizedScale);
      }
      if (speedLabel) {
        speedLabel.textContent = "x";
      }
      try {
        window.localStorage.setItem(
          SIM_VISUAL_SPEED_STORAGE_KEY,
          String(normalizedScale),
        );
      } catch (error) {
        // Ignore storage failures and continue runtime behavior.
      }
    };

    speedSlider.addEventListener("input", persistScale);
    speedSlider.addEventListener("change", persistScale);
  }

  resetVisualSpeedSliderToDefault() {
    this.applyVisualSpeedScale(SIM_VISUAL_SPEED_DEFAULT_SCALE);
  }

  resetSpeedSliderToDefault() {
    const speedSlider = document.getElementById("drive-speed-mps");
    const speedLabel = document.getElementById("drive-speed-mps-value");
    const speedInput = document.getElementById("drive-speed-mps-input");
    if (!speedSlider) {
      return;
    }

    speedSlider.value = SIM_SPEED_DEFAULT_MPS.toFixed(1);
    this.updateSpeedSliderVisual(speedSlider);
    if (speedInput) {
      speedInput.value = SIM_SPEED_DEFAULT_MPS.toFixed(1);
    }

    if (speedLabel) {
      speedLabel.textContent = "m/s";
    }

    this.applyDriveSpeedCommandMps(SIM_SPEED_DEFAULT_MPS);

    try {
      window.localStorage.setItem(
        SIM_SPEED_STORAGE_KEY,
        String(SIM_SPEED_DEFAULT_MPS),
      );
    } catch (error) {
      // Ignore storage failures and continue runtime behavior.
    }
  }

  addGroundCollider() {
    if (
      !this.world ||
      !this.rapier ||
      !this.initialPosition ||
      !this.vehicleHalfExtents
    ) {
      return;
    }

    const groundHalfThickness = 0.2;
    const holeFloorHalfThickness = 0.03;
    const minGroundPatchHalfExtent = 0.02;
    const linkMap = this.viewer?.robotModel?.links || {};
    const groundLink =
      this.findLinkByName(linkMap, "ground") ||
      this.findLinkByName(linkMap, "ground_link") ||
      this.findLinkByName(linkMap, "ground_patch") ||
      null;
    let groundBounds = null;

    if (groundLink) {
      groundLink.updateWorldMatrix(true, true);
      groundBounds = this.computeGroundBoundsPreferCollision(
        groundLink,
        linkMap,
      );
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
    const groundMinX =
      groundBounds && !groundBounds.isEmpty()
        ? groundBounds.min.x
        : -fallbackGroundSize * 0.5;
    const groundMaxX =
      groundBounds && !groundBounds.isEmpty()
        ? groundBounds.max.x
        : fallbackGroundSize * 0.5;
    const groundMinY =
      groundBounds && !groundBounds.isEmpty()
        ? groundBounds.min.y
        : -fallbackGroundSize * 0.5;
    const groundMaxY =
      groundBounds && !groundBounds.isEmpty()
        ? groundBounds.max.y
        : fallbackGroundSize * 0.5;

    const holeLinkNames = Object.keys(linkMap).filter((name) =>
      /hole|pothole/i.test(name),
    );
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

      if (
        clampedMaxX - clampedMinX <= 1e-4 ||
        clampedMaxY - clampedMinY <= 1e-4
      ) {
        return;
      }

      holeRegions.push({
        minX: clampedMinX,
        maxX: clampedMaxX,
        minY: clampedMinY,
        maxY: clampedMaxY,
        floorZ: holeBounds.min.z,
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
        out.push({
          minX: rect.minX,
          maxX: overlapMinX,
          minY: rect.minY,
          maxY: rect.maxY,
        });
      }
      if (overlapMaxX < rect.maxX) {
        out.push({
          minX: overlapMaxX,
          maxX: rect.maxX,
          minY: rect.minY,
          maxY: rect.maxY,
        });
      }
      if (rect.minY < overlapMinY) {
        out.push({
          minX: overlapMinX,
          maxX: overlapMaxX,
          minY: rect.minY,
          maxY: overlapMinY,
        });
      }
      if (overlapMaxY < rect.maxY) {
        out.push({
          minX: overlapMinX,
          maxX: overlapMaxX,
          minY: overlapMaxY,
          maxY: rect.maxY,
        });
      }

      return out;
    };

    let groundPatches = [
      {
        minX: groundMinX,
        maxX: groundMaxX,
        minY: groundMinY,
        maxY: groundMaxY,
      },
    ];
    holeRegions.forEach((holeRegion) => {
      const nextPatches = [];
      groundPatches.forEach((patch) => {
        nextPatches.push(...subtractRect(patch, holeRegion));
      });
      groundPatches = nextPatches;
    });

    const createFixedCuboidCollider = (
      centerX,
      centerY,
      centerZ,
      halfX,
      halfY,
      halfZ,
      friction = 0.25,
    ) => {
      const groundBodyDesc = this.rapier.RigidBodyDesc.fixed().setTranslation(
        centerX,
        centerY,
        centerZ,
      );
      const groundBody = this.world.createRigidBody(groundBodyDesc);
      const groundColliderDesc = this.rapier.ColliderDesc.cuboid(
        halfX,
        halfY,
        halfZ,
      )
        .setFriction(0.0)
        .setCollisionGroups(COLLISION_GROUP_GROUND)
        .setRestitution(0.0);
      const groundCollider = this.world.createCollider(
        groundColliderDesc,
        groundBody,
      );
      this.groundColliders.push(groundCollider);
    };

    const groundCenterZ = this.groundZ - groundHalfThickness;
    groundPatches.forEach((patch) => {
      const width = patch.maxX - patch.minX;
      const depth = patch.maxY - patch.minY;
      const halfX = width * 0.5;
      const halfY = depth * 0.5;
      if (
        halfX < minGroundPatchHalfExtent ||
        halfY < minGroundPatchHalfExtent
      ) {
        return;
      }

      const centerX = (patch.minX + patch.maxX) * 0.5;
      const centerY = (patch.minY + patch.maxY) * 0.5;
      createFixedCuboidCollider(
        centerX,
        centerY,
        groundCenterZ,
        halfX,
        halfY,
        groundHalfThickness,
        0.25,
      );
    });

    holeRegions.forEach((holeRegion) => {
      const holeHalfX = (holeRegion.maxX - holeRegion.minX) * 0.5;
      const holeHalfY = (holeRegion.maxY - holeRegion.minY) * 0.5;
      if (
        holeHalfX < minGroundPatchHalfExtent ||
        holeHalfY < minGroundPatchHalfExtent
      ) {
        return;
      }

      const holeCenterX = (holeRegion.minX + holeRegion.maxX) * 0.5;
      const holeCenterY = (holeRegion.minY + holeRegion.maxY) * 0.5;
      const holeFloorCenterZ = holeRegion.floorZ - holeFloorHalfThickness;
      createFixedCuboidCollider(
        holeCenterX,
        holeCenterY,
        holeFloorCenterZ,
        holeHalfX,
        holeHalfY,
        holeFloorHalfThickness,
        0.5,
      );
    });

    this.addGroundSurfaceGrid(groundPatches);
  }

  addGroundSurfaceGrid(groundPatches) {
    if (!this.viewer?.scene || !Array.isArray(groundPatches)) {
      return;
    }

    if (this.groundGrid) {
      this.viewer.scene.remove(this.groundGrid);
      this.groundGrid.geometry.dispose();
      this.groundGrid.material.dispose();
    }

    const gridSpacingMeters = 0.1;
    const gridZ = this.groundZ + 0.001;
    const vertices = [];
    const colors = [];
    const verticalLineColor = new THREE.Color(0x00d9ff);
    const horizontalLineColor = new THREE.Color(0xf8f9fa);
    const appendLine = (x1, y1, x2, y2, isVertical) => {
      vertices.push(x1, y1, gridZ, x2, y2, gridZ);
      const color = isVertical ? verticalLineColor : horizontalLineColor;
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    };

    groundPatches.forEach((patch) => {
      const minX =
        Math.ceil(patch.minX / gridSpacingMeters) * gridSpacingMeters;
      const maxX =
        Math.floor(patch.maxX / gridSpacingMeters) * gridSpacingMeters;
      const minY =
        Math.ceil(patch.minY / gridSpacingMeters) * gridSpacingMeters;
      const maxY =
        Math.floor(patch.maxY / gridSpacingMeters) * gridSpacingMeters;

      for (let x = minX; x <= maxX + 1e-8; x += gridSpacingMeters) {
        appendLine(x, patch.minY, x, patch.maxY, true);
      }
      for (let y = minY; y <= maxY + 1e-8; y += gridSpacingMeters) {
        appendLine(patch.minX, y, patch.maxX, y, false);
      }
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });

    this.groundGrid = new THREE.LineSegments(geometry, material);
    this.groundGrid.name = "simulation-ground-grid";
    this.groundGrid.renderOrder = 1;
    this.viewer.scene.add(this.groundGrid);
  }

  isVehicleOverHoleRegion() {
    if (
      !this.body ||
      !Array.isArray(this.holeRegions) ||
      this.holeRegions.length === 0
    ) {
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

      const overlapX =
        vehicleMaxX >= holeRegion.minX && vehicleMinX <= holeRegion.maxX;
      const overlapY =
        vehicleMaxY >= holeRegion.minY && vehicleMinY <= holeRegion.maxY;
      return overlapX && overlapY;
    });
  }

  logWheelGroundDiagnosticsOnce(linkMap, stage = "runtime") {
    if (this.hasLoggedGroundDiagnostics) {
      return;
    }

    if (!this.body || !Number.isFinite(this.groundZ)) {
      return;
    }

    const wheelMinZ = this.getWheelWorldMinZ(linkMap);
    if (!Number.isFinite(wheelMinZ)) {
      console.warn(
        "[URDF][Simulation] wheel-ground diagnostics skipped: wheel bounds unavailable",
      );
      this.hasLoggedGroundDiagnostics = true;
      return;
    }

    const bodyZ = this.body.translation().z;
    const gap = wheelMinZ - this.groundZ;
    console.log("[URDF][Simulation] wheel-ground diagnostics", {
      stage,
      groundZ: Number(this.groundZ.toFixed(6)),
      wheelMinZ: Number(wheelMinZ.toFixed(6)),
      wheelGroundGap: Number(gap.toFixed(6)),
      bodyZ: Number(bodyZ.toFixed(6)),
      groundContactLocalMinZ: Number.isFinite(this.groundContactLocalMinZ)
        ? Number(this.groundContactLocalMinZ.toFixed(6))
        : null,
    });
    this.hasLoggedGroundDiagnostics = true;
  }

  getObstaclePhysicsProfile(
    obstacleLinkName,
    normalizedObstacleName,
    halfX,
    halfY,
    halfZ,
  ) {
    const name = String(obstacleLinkName || normalizedObstacleName || "");
    const normalizedName = String(
      normalizedObstacleName || this.normalizeLinkName(name) || "",
    ).toLowerCase();
    const isObstacleFamily =
      /^obstacle_/i.test(name) || /^obstacle_/i.test(normalizedName);

    const isPotholeObstacle =
      /^pothole/i.test(name) || /^pothole/i.test(normalizedName);
    const isRockLike = /rock|stone|boulder|block/i.test(normalizedName);
    const isHemisphereLike = /hemisphere|sphere|ball/i.test(normalizedName);
    const isBarLike = /bar|beam|pole|stick|wood/i.test(normalizedName);

    let effectiveHalfX = Math.max(halfX, 0.001);
    let effectiveHalfY = Math.max(halfY, 0.001);
    let effectiveHalfZ = Math.max(halfZ, 0.005);
    let friction = 1.4;
    let restitution = 0.02;

    if (!isObstacleFamily) {
      return {
        effectiveHalfX,
        effectiveHalfY,
        effectiveHalfZ,
        friction,
        restitution,
        isPotholeObstacle,
        isRockLike,
        isHemisphereLike,
        isBarLike,
      };
    }

    if (isRockLike) {
      effectiveHalfX = Math.max(effectiveHalfX, 0.07);
      effectiveHalfY = Math.max(effectiveHalfY, 0.08);
      effectiveHalfZ = Math.max(effectiveHalfZ, 0.025);
      friction = 0.18;
      restitution = 0.0;
    } else if (isHemisphereLike) {
      effectiveHalfX = Math.max(effectiveHalfX, 0.06);
      effectiveHalfY = Math.max(effectiveHalfY, 0.06);
      effectiveHalfZ = Math.max(effectiveHalfZ, 0.02);
      friction = 0.25;
      restitution = 0.0;
    } else if (isBarLike) {
      effectiveHalfX = Math.max(effectiveHalfX, 0.04);
      effectiveHalfY = Math.max(effectiveHalfY, 0.75);
      effectiveHalfZ = Math.max(effectiveHalfZ, 0.015);
      friction = 0.35;
      restitution = 0.0;
    } else {
      const maxExtent = Math.max(
        effectiveHalfX,
        effectiveHalfY,
        effectiveHalfZ,
      );
      if (maxExtent > 0.25) {
        friction = 0.6;
        restitution = 0.0;
      } else if (maxExtent < 0.08) {
        effectiveHalfZ = Math.max(effectiveHalfZ, 0.008);
        friction = 0.4;
        restitution = 0.0;
      }
    }

    return {
      effectiveHalfX,
      effectiveHalfY,
      effectiveHalfZ,
      friction,
      restitution,
      isPotholeObstacle,
      isRockLike,
      isHemisphereLike,
      isBarLike,
    };
  }

  addObstacleColliderFromUrdf() {
    if (
      !this.world ||
      !this.rapier ||
      !this.viewer?.robotModel ||
      !this.carFrame
    ) {
      return;
    }

    const linkMap = this.vehicleModel.links;
    const wheelLateralBands = this.getWheelLateralContactBands(linkMap);
    const obstacleLinkNames = this.getObstacleLinkNamesFromMap(linkMap);
    if (obstacleLinkNames.length === 0) {
      console.warn(
        `[URDF][Simulation] URDF obstacle link not found. Expected prefix: ${this.urdfObstacleLinkPrefix}*`,
      );
      return;
    }

    this.obstacleColliders = [];
    this.obstacleColliderInfos = [];

    obstacleLinkNames.forEach((obstacleLinkName) => {
      const obstacleLink = linkMap[obstacleLinkName];
      obstacleLink.updateWorldMatrix(true, true);

      const fallbackBounds = new THREE.Box3().setFromObject(obstacleLink);
      const actualBounds =
        this.computeLinkOwnBounds(obstacleLink, linkMap) || fallbackBounds;
      if (actualBounds.isEmpty()) {
        return;
      }

      const center = actualBounds.getCenter(new THREE.Vector3());
      const size = actualBounds.getSize(new THREE.Vector3());
      const halfX = Math.max(size.x * 0.5, 0.001);
      const halfY = Math.max(size.y * 0.5, 0.001);
      const halfZ = Math.max(size.z * 0.5, 0.001);
      const normalizedObstacleName = this.normalizeLinkName(obstacleLinkName);
      const isOriginObject =
        /(^|[_-])origin($|[_-])/i.test(obstacleLinkName) ||
        /(^|[_-])origin($|[_-])/i.test(normalizedObstacleName);
      const isPassUnderTagged = this.passUnderObstacleNamePatterns.some(
        (pattern) =>
          pattern.test(obstacleLinkName) ||
          pattern.test(normalizedObstacleName),
      );
      const obstacleProfile = this.getObstaclePhysicsProfile(
        obstacleLinkName,
        normalizedObstacleName,
        halfX,
        halfY,
        halfZ,
      );
      // Fix: Keep obstacle surface friction low (0.05) so asymmetric contact glides smoothly over instead of locking one side and spinning
      obstacleProfile.friction = 0.05;

      const obstacleBodyDesc = this.rapier.RigidBodyDesc.fixed().setTranslation(
        center.x,
        center.y,
        center.z,
      );
      const obstacleBody = this.world.createRigidBody(obstacleBodyDesc);
      const obstacleColliderDesc = this.rapier.ColliderDesc.cuboid(
        obstacleProfile.effectiveHalfX,
        obstacleProfile.effectiveHalfY,
        obstacleProfile.effectiveHalfZ,
      )
        .setFriction(obstacleProfile.friction)
        .setCollisionGroups(COLLISION_GROUP_OBSTACLE)
        .setRestitution(obstacleProfile.restitution);

      const obstacleTopZ = center.z + obstacleProfile.effectiveHalfZ;
      const wheelContactPlaneZ = this.getWheelContactPlaneZ();
      const passThroughClearance = Math.max(
        Number(this.underbodyPassThroughClearanceMeters) || 0,
        0,
      );
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

      // Pass-through obstacles and potholes are sensors. The ground-hole
      // colliders model pothole physics; all other obstacles remain solid.
      if (typeof obstacleColliderDesc.setSensor === "function") {
        obstacleColliderDesc.setSensor(
          isPassUnderTagged || obstacleProfile.isPotholeObstacle,
        );
      }
      if (isPassUnderTagged) {
        console.log(
          "[URDF][Simulation] obstacle treated as pass-under sensor:",
          {
            obstacleLinkName,
            isPassUnderTagged,
            isUnderbodyPassThroughByHeight,
            overlapsWheelBand,
            obstacleTopZ: Number(obstacleTopZ.toFixed(4)),
            wheelContactPlaneZ: Number.isFinite(wheelContactPlaneZ)
              ? Number(wheelContactPlaneZ.toFixed(4))
              : null,
            passThroughClearance: Number(passThroughClearance.toFixed(4)),
          },
        );
      }

      if (isOriginObject) {
        return;
      }

      const obstacleCollider = this.world.createCollider(
        obstacleColliderDesc,
        obstacleBody,
      );
      this.obstacleColliders.push(obstacleCollider);
      this.obstacleColliderInfos.push({
        collider: obstacleCollider,
        center: new THREE.Vector3(center.x, center.y, center.z),
        halfExtents: {
          x: obstacleProfile.effectiveHalfX,
          y: obstacleProfile.effectiveHalfY,
          z: obstacleProfile.effectiveHalfZ,
        },
        linkName: obstacleLinkName,
        normalizedLinkName: normalizedObstacleName,
        isSensor: Boolean(
          isPassUnderTagged || obstacleProfile.isPotholeObstacle,
        ),
        isSpatiallyOverlapping: false,
        linkObject: obstacleLink,
        worldBounds: actualBounds.clone(),
      });
      console.log(
        `[URDF][Simulation] obstacle collider created from URDF link: ${obstacleLinkName}`,
      );
    });
  }

  getWheelLateralContactBands(linkMap) {
    if (!linkMap) {
      return [];
    }

    const wheelLinkNames = ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"];
    const bands = [];

    wheelLinkNames.forEach((wheelLinkName) => {
      const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
      if (!wheelLink) {
        return;
      }

      wheelLink.updateWorldMatrix(true, true);
      const wheelBounds =
        this.computeLinkOwnBounds(wheelLink, linkMap) || new THREE.Box3();
      if (wheelBounds.isEmpty()) {
        return;
      }

      const wheelCenter = wheelBounds.getCenter(new THREE.Vector3());
      const wheelSize = wheelBounds.getSize(new THREE.Vector3());
      const wheelRadius = Math.max(wheelSize.x * 0.5, wheelSize.z * 0.5, 0.05);
      bands.push({
        minY: wheelCenter.y - wheelRadius,
        maxY: wheelCenter.y + wheelRadius,
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
    const obstacleLink =
      obstacleInfo.linkObject ||
      (effectiveLinkMap
        ? this.findLinkByName(effectiveLinkMap, obstacleInfo.linkName)
        : null) ||
      null;

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
      const chassisBounds = this.computeChassisBounds(
        this.carFrame,
        effectiveLinkMap,
      );
      if (chassisBounds && !chassisBounds.isEmpty()) {
        boundsList.push(chassisBounds.clone());
      }

      ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"].forEach((wheelName) => {
        const wheelLink = this.findLinkByName(effectiveLinkMap, wheelName);
        if (!wheelLink) {
          return;
        }

        const wheelBounds = this.computeLinkOwnBounds(
          wheelLink,
          effectiveLinkMap,
        );
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
            fallbackCenter.z - fallbackHalfExtents.z,
          ),
          new THREE.Vector3(
            fallbackCenter.x + fallbackHalfExtents.x,
            fallbackCenter.y + fallbackHalfExtents.y,
            fallbackCenter.z + fallbackHalfExtents.z,
          ),
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
    const halfExtents = new THREE.Vector3(
      size.x * 0.5,
      size.y * 0.5,
      size.z * 0.5,
    );
    const quaternion = new THREE.Quaternion();
    object3D.getWorldQuaternion(quaternion);
    const rotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(
      quaternion,
    );
    const e = rotationMatrix.elements;

    const axisX = new THREE.Vector3(e[0], e[1], e[2]).normalize();
    const axisY = new THREE.Vector3(e[4], e[5], e[6]).normalize();
    const axisZ = new THREE.Vector3(e[8], e[9], e[10]).normalize();

    return {
      center,
      halfExtents,
      axes: [axisX, axisY, axisZ],
    };
  }

  getVehicleCollisionObbs(linkMap = null) {
    const effectiveLinkMap = linkMap || this.viewer?.robotModel?.links || null;
    const obbs = [];

    if (!effectiveLinkMap) {
      return obbs;
    }

    if (this.carFrame) {
      const chassisBounds = this.computeChassisBounds(
        this.carFrame,
        effectiveLinkMap,
      );
      if (chassisBounds && !chassisBounds.isEmpty()) {
        const chassisObb = this.getWorldObbForObject(this.carFrame);
        if (chassisObb) {
          chassisObb.center.copy(chassisBounds.getCenter(new THREE.Vector3()));
          chassisObb.halfExtents.copy(
            chassisBounds.getSize(new THREE.Vector3()).multiplyScalar(0.5),
          );
          obbs.push(chassisObb);
        }
      }

      ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"].forEach((wheelName) => {
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
    const obstacleObject =
      obstacleInfo.linkObject ||
      (effectiveLinkMap
        ? this.findLinkByName(effectiveLinkMap, obstacleInfo.linkName)
        : null) ||
      null;

    if (obstacleObject) {
      return this.getWorldObbForObject(obstacleObject);
    }

    if (obstacleInfo.center && obstacleInfo.halfExtents) {
      return {
        center: obstacleInfo.center.clone(),
        halfExtents: new THREE.Vector3(
          obstacleInfo.halfExtents.x,
          obstacleInfo.halfExtents.y,
          obstacleInfo.halfExtents.z,
        ),
        axes: [
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1),
        ],
      };
    }

    return null;
  }

  obbIntersects(obbA, obbB, contactMarginMeters = 0) {
    if (!obbA || !obbB) {
      return false;
    }

    const margin = Math.max(Number(contactMarginMeters) || 0, 0.001);
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

      const radiusA =
        obbA.halfExtents.x * Math.abs(axis.dot(obbA.axes[0])) +
        obbA.halfExtents.y * Math.abs(axis.dot(obbA.axes[1])) +
        obbA.halfExtents.z * Math.abs(axis.dot(obbA.axes[2]));
      const radiusB =
        obbB.halfExtents.x * Math.abs(axis.dot(obbB.axes[0])) +
        obbB.halfExtents.y * Math.abs(axis.dot(obbB.axes[1])) +
        obbB.halfExtents.z * Math.abs(axis.dot(obbB.axes[2]));
      const projectedCenterOffset = Math.abs(centerOffset.dot(axis));

      if (projectedCenterOffset > radiusA + radiusB + margin) {
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
      bodyRotation.w,
    ).normalize();
    const centerOffset = this.vehicleColliderLocalCenter
      .clone()
      .applyQuaternion(bodyQuat);

    return new THREE.Vector3(
      bodyPosition.x + centerOffset.x,
      bodyPosition.y + centerOffset.y,
      bodyPosition.z + centerOffset.z,
    );
  }

  getVehicleObstacleSeparationBounds() {
    const vehicleCenter = this.getVehicleColliderWorldCenter();
    if (!vehicleCenter) {
      return null;
    }

    const baseHalfExtents = this.getVehicleColliderWorldAabbHalfExtents() || {
      x: 0,
      y: 0,
      z: 0,
    };

    return {
      center: vehicleCenter,
      halfExtents: {
        x: Number(baseHalfExtents.x) || 0,
        y: Number(baseHalfExtents.y) || 0,
        z: Number(baseHalfExtents.z) || 0,
      },
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
      bodyRotation.w,
    ).normalize();
    const rotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(
      bodyQuat,
    );
    const e = rotationMatrix.elements;

    const hx = Number(this.vehicleColliderHalfExtents.x) || 0;
    const hy = Number(this.vehicleColliderHalfExtents.y) || 0;
    const hz = Number(this.vehicleColliderHalfExtents.z) || 0;

    // Convert oriented box half extents to conservative world-axis-aligned half extents.
    const halfX =
      Math.abs(e[0]) * hx + Math.abs(e[4]) * hy + Math.abs(e[8]) * hz;
    const halfY =
      Math.abs(e[1]) * hx + Math.abs(e[5]) * hy + Math.abs(e[9]) * hz;
    const halfZ =
      Math.abs(e[2]) * hx + Math.abs(e[6]) * hy + Math.abs(e[10]) * hz;

    return { x: halfX, y: halfY, z: halfZ };
  }

  isVehicleAabbTouchingObstacle(obstacleInfo, linkMap = null) {
    const vehicleBounds = this.getVehicleCollisionBounds(linkMap);
    if (vehicleBounds.length === 0) {
      return false;
    }

    const obstacleBounds = this.getObstacleWorldBounds(obstacleInfo, linkMap);
    if (!obstacleBounds || obstacleBounds.isEmpty()) {
      return false;
    }

    return vehicleBounds.some((bounds) => bounds.intersectsBox(obstacleBounds));
  }

  getObstacleContactedWheelKeys(obstacleInfo, linkMap = null) {
    if (!this.world || !obstacleInfo?.collider) {
      return [];
    }

    const physicsContactedWheelKeys = Object.entries(
      this.wheelCollidersByKey,
    ).flatMap(([wheelKey, wheelCollider]) => {
      if (!wheelCollider) {
        return [];
      }

      let isContacting = false;
      this.world.contactPair(wheelCollider, obstacleInfo.collider, () => {
        isContacting = true;
      });
      return isContacting ? [wheelKey] : [];
    });
    if (physicsContactedWheelKeys.length > 0) {
      return physicsContactedWheelKeys;
    }

    if (!obstacleInfo.center || !obstacleInfo.halfExtents) {
      return [];
    }

    return Object.entries(this.wheelCollidersByKey)
      .filter(([wheelKey, wheelCollider]) => {
        if (!wheelCollider || typeof wheelCollider.translation !== "function") {
          return false;
        }

        const wheelCenter = wheelCollider.translation();
        const wheelRadius = Math.max(
          Number(this.wheelRadiusMetersByKey[wheelKey]) ||
            Number(this.wheelEffectiveRadiusMeters) ||
            0,
          0.05,
        );
        const nearestX = THREE.MathUtils.clamp(
          wheelCenter.x,
          obstacleInfo.center.x - obstacleInfo.halfExtents.x,
          obstacleInfo.center.x + obstacleInfo.halfExtents.x,
        );
        const nearestY = THREE.MathUtils.clamp(
          wheelCenter.y,
          obstacleInfo.center.y - obstacleInfo.halfExtents.y,
          obstacleInfo.center.y + obstacleInfo.halfExtents.y,
        );
        const nearestZ = THREE.MathUtils.clamp(
          wheelCenter.z,
          obstacleInfo.center.z - obstacleInfo.halfExtents.z,
          obstacleInfo.center.z + obstacleInfo.halfExtents.z,
        );
        const distanceSquared =
          (wheelCenter.x - nearestX) ** 2 +
          (wheelCenter.y - nearestY) ** 2 +
          (wheelCenter.z - nearestZ) ** 2;
        return distanceSquared <= wheelRadius ** 2;
      })
      .map(([wheelKey]) => wheelKey);
  }

  isVehicleColliderContactingObstacle(obstacleInfo) {
    if (!this.world || !this.vehicleCollider || !obstacleInfo?.collider) {
      return false;
    }

    let isContacting = false;
    this.world.contactPair(this.vehicleCollider, obstacleInfo.collider, () => {
      isContacting = true;
    });
    return isContacting;
  }

  isVelocityMovingTowardObstacle(obstacleInfo, velocityX, velocityY) {
    if (!this.body || !obstacleInfo?.center) {
      return false;
    }

    const bodyPosition = this.body.translation();
    const obstacleOffsetX = obstacleInfo.center.x - bodyPosition.x;
    const obstacleOffsetY = obstacleInfo.center.y - bodyPosition.y;
    return velocityX * obstacleOffsetX + velocityY * obstacleOffsetY > 1e-5;
  }

  isVehiclePositionTouchingObstacle(position) {
    this.lastPredictedObstacleName = null;
    if (!this.body || !position) {
      return false;
    }

    const currentPosition = this.body.translation();
    const currentCenter = this.getVehicleColliderWorldCenter();
    const halfExtents = this.getVehicleColliderWorldAabbHalfExtents();
    if (!currentCenter || !halfExtents) {
      return false;
    }

    const nextCenter = new THREE.Vector3(
      currentCenter.x + position.x - currentPosition.x,
      currentCenter.y + position.y - currentPosition.y,
      currentCenter.z + position.z - currentPosition.z,
    );
    const translationDelta = new THREE.Vector3(
      position.x - currentPosition.x,
      position.y - currentPosition.y,
      position.z - currentPosition.z,
    );
    return this.obstacleColliderInfos.some((obstacleInfo) => {
      if (
        obstacleInfo?.isSensor ||
        !obstacleInfo?.center ||
        !obstacleInfo?.halfExtents
      ) {
        return false;
      }

      const chassisTouchesObstacle =
        Math.abs(nextCenter.x - obstacleInfo.center.x) <=
          halfExtents.x + obstacleInfo.halfExtents.x &&
        Math.abs(nextCenter.y - obstacleInfo.center.y) <=
          halfExtents.y + obstacleInfo.halfExtents.y &&
        Math.abs(nextCenter.z - obstacleInfo.center.z) <=
          halfExtents.z + obstacleInfo.halfExtents.z;
      if (chassisTouchesObstacle) {
        this.lastPredictedObstacleName = obstacleInfo.linkName || "unknown";
        return true;
      }

      const wheelTouchesObstacle = Object.entries(
        this.wheelCollidersByKey,
      ).some(([wheelKey, wheelCollider]) => {
        if (!wheelCollider || typeof wheelCollider.translation !== "function") {
          return false;
        }

        const wheelCenter = wheelCollider.translation();
        const nextWheelCenter = new THREE.Vector3(
          wheelCenter.x + translationDelta.x,
          wheelCenter.y + translationDelta.y,
          wheelCenter.z + translationDelta.z,
        );
        const wheelRadius = Math.max(
          Number(this.wheelRadiusMetersByKey[wheelKey]) ||
            Number(this.wheelEffectiveRadiusMeters) ||
            0,
          0.05,
        );
        const nearestX = THREE.MathUtils.clamp(
          nextWheelCenter.x,
          obstacleInfo.center.x - obstacleInfo.halfExtents.x,
          obstacleInfo.center.x + obstacleInfo.halfExtents.x,
        );
        const nearestY = THREE.MathUtils.clamp(
          nextWheelCenter.y,
          obstacleInfo.center.y - obstacleInfo.halfExtents.y,
          obstacleInfo.center.y + obstacleInfo.halfExtents.y,
        );
        const nearestZ = THREE.MathUtils.clamp(
          nextWheelCenter.z,
          obstacleInfo.center.z - obstacleInfo.halfExtents.z,
          obstacleInfo.center.z + obstacleInfo.halfExtents.z,
        );
        const distanceSquared =
          (nextWheelCenter.x - nearestX) ** 2 +
          (nextWheelCenter.y - nearestY) ** 2 +
          (nextWheelCenter.z - nearestZ) ** 2;
        return distanceSquared <= wheelRadius ** 2;
      });
      if (wheelTouchesObstacle) {
        this.lastPredictedObstacleName = obstacleInfo.linkName || "unknown";
      }
      return wheelTouchesObstacle;
    });
  }

  isVehiclePathTouchingObstacle(startPosition, endPosition) {
    if (!startPosition || !endPosition) {
      return false;
    }

    const distance = Math.hypot(
      endPosition.x - startPosition.x,
      endPosition.y - startPosition.y,
      endPosition.z - startPosition.z,
    );
    const stepCount = Math.max(1, Math.ceil(distance / 0.005));
    for (let stepIndex = 1; stepIndex <= stepCount; stepIndex += 1) {
      const progress = stepIndex / stepCount;
      const samplePosition = new THREE.Vector3(
        startPosition.x + (endPosition.x - startPosition.x) * progress,
        startPosition.y + (endPosition.y - startPosition.y) * progress,
        startPosition.z + (endPosition.z - startPosition.z) * progress,
      );
      if (this.isVehiclePositionTouchingObstacle(samplePosition)) {
        return true;
      }
    }

    return false;
  }

  getWheelKeysTouchingObstacleAtPosition(obstacleInfo, position) {
    if (
      !this.body ||
      !obstacleInfo?.center ||
      !obstacleInfo?.halfExtents ||
      !position
    ) {
      return [];
    }

    const currentPosition = this.body.translation();
    const translationDelta = new THREE.Vector3(
      position.x - currentPosition.x,
      position.y - currentPosition.y,
      position.z - currentPosition.z,
    );
    return Object.entries(this.wheelCollidersByKey)
      .filter(([wheelKey, wheelCollider]) => {
        if (!wheelCollider || typeof wheelCollider.translation !== "function") {
          return false;
        }

        const center = wheelCollider.translation();
        const wheelCenter = new THREE.Vector3(
          center.x + translationDelta.x,
          center.y + translationDelta.y,
          center.z + translationDelta.z,
        );
        const radius = Math.max(
          Number(this.wheelRadiusMetersByKey[wheelKey]) ||
            Number(this.wheelEffectiveRadiusMeters) ||
            0,
          0.05,
        );
        const nearestX = THREE.MathUtils.clamp(
          wheelCenter.x,
          obstacleInfo.center.x - obstacleInfo.halfExtents.x,
          obstacleInfo.center.x + obstacleInfo.halfExtents.x,
        );
        const nearestY = THREE.MathUtils.clamp(
          wheelCenter.y,
          obstacleInfo.center.y - obstacleInfo.halfExtents.y,
          obstacleInfo.center.y + obstacleInfo.halfExtents.y,
        );
        const nearestZ = THREE.MathUtils.clamp(
          wheelCenter.z,
          obstacleInfo.center.z - obstacleInfo.halfExtents.z,
          obstacleInfo.center.z + obstacleInfo.halfExtents.z,
        );
        return (
          (wheelCenter.x - nearestX) ** 2 +
            (wheelCenter.y - nearestY) ** 2 +
            (wheelCenter.z - nearestZ) ** 2 <=
          radius ** 2
        );
      })
      .map(([wheelKey]) => wheelKey);
  }

  syncObstacleColliderActivation(linkMap = null) {
    this.obstacleColliderInfos.forEach((obstacleInfo) => {
      if (!obstacleInfo?.collider || obstacleInfo.isSensor) {
        return;
      }

      const isSpatiallyOverlapping = this.isVehicleAabbTouchingObstacle(
        obstacleInfo,
        linkMap,
      );
      obstacleInfo.isSpatiallyOverlapping = isSpatiallyOverlapping;
    });
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
      const verticalGap =
        Math.abs(obstacleObb.center.z - vehicleObb.center.z) -
        (obstacleObb.halfExtents.z + vehicleObb.halfExtents.z);
      const horizontalSeparation = Math.max(
        Math.abs(obstacleObb.center.x - vehicleObb.center.x) -
          (obstacleObb.halfExtents.x + vehicleObb.halfExtents.x),
        Math.abs(obstacleObb.center.y - vehicleObb.center.y) -
          (obstacleObb.halfExtents.y + vehicleObb.halfExtents.y),
      );
      const nearSurface = verticalGap <= 0.002 && horizontalSeparation <= 0.002;
      return nearSurface || this.obbIntersects(vehicleObb, obstacleObb, 0.001);
    });
  }

  resolveVehicleObstacleInterpenetration() {
    // Disabled artificial position/velocity snapping.
    // Let Rapier's physics engine handle rigid body contacts naturally.
    return false;
  }

  getObstacleApproachInfo() {
    if (!this.body || !Array.isArray(this.obstacleColliderInfos)) {
      return null;
    }

    const obstacleContactInfo = this.obstacleColliderInfos.find(
      (obstacleInfo) => {
        if (!obstacleInfo || obstacleInfo.isSensor) {
          return false;
        }

        if (!this.isVehicleAabbTouchingObstacle(obstacleInfo)) {
          return false;
        }

        obstacleInfo.contactedWheelKeys =
          this.getObstacleContactedWheelKeys(obstacleInfo);
        return true;
      },
    );

    if (obstacleContactInfo) {
      return { obstacleInfo: obstacleContactInfo };
    }
    return null;
  }

  isObstacleInFrontForClimb(obstacleInfo = null) {
    if (!this.body || !obstacleInfo?.center) {
      return false;
    }

    const bodyPosition = this.body.translation();
    const bodyRotation = this.body.rotation();
    const yaw = this.extractYawFromQuaternion(bodyRotation);
    const { x: forwardX, y: forwardY } = this.getVehicleForwardVector(yaw);
    const dx = obstacleInfo.center.x - bodyPosition.x;
    const dy = obstacleInfo.center.y - bodyPosition.y;
    const alongForward = dx * forwardX + dy * forwardY;
    const distance = Math.hypot(dx, dy);
    const obstacleTopZ = obstacleInfo.center.z + obstacleInfo.halfExtents.z;
    const wheelPlaneZ =
      bodyPosition.z +
      (Number.isFinite(this.wheelLocalMinZ) ? this.wheelLocalMinZ : 0);
    const verticalGap = obstacleTopZ - wheelPlaneZ;
    const hasWheelContact =
      Array.isArray(obstacleInfo.contactedWheelKeys) &&
      obstacleInfo.contactedWheelKeys.length > 0;

    return (
      hasWheelContact &&
      alongForward > -0.1 &&
      distance < 0.6 &&
      verticalGap > 0.02
    );
  }

  getObstacleClimbTargetZ(obstacleInfo = null) {
    if (
      !this.body ||
      !Number.isFinite(this.wheelLocalMinZ) ||
      !Array.isArray(this.obstacleColliderInfos)
    ) {
      return null;
    }

    const translation = this.body.translation();
    const targetObstacle = obstacleInfo || null;
    if (!targetObstacle?.center || !targetObstacle?.halfExtents) {
      return null;
    }

    const obstacleTopZ = targetObstacle.center.z + targetObstacle.halfExtents.z;
    const wheelBottomWorldZ = obstacleTopZ;
    const targetBodyZ = wheelBottomWorldZ - this.wheelLocalMinZ;
    const verticalGap = targetBodyZ - translation.z;
    if (verticalGap <= 0.002) {
      return null;
    }

    return targetBodyZ;
  }

  getObstacleTraversalPath(obstacleInfo = null) {
    if (!this.body || !obstacleInfo?.center || !obstacleInfo?.halfExtents) {
      return null;
    }

    const bodyPosition = this.body.translation();
    const yaw = this.extractYawFromQuaternion(this.body.rotation());
    const { x: forwardX, y: forwardY } = this.getVehicleForwardVector(yaw);
    const dx = obstacleInfo.center.x - bodyPosition.x;
    const dy = obstacleInfo.center.y - bodyPosition.y;
    const centerAlongForward = dx * forwardX + dy * forwardY;
    const lateralOffset = Math.abs(dx * forwardY - dy * forwardX);
    const hasWheelContact =
      Array.isArray(obstacleInfo.contactedWheelKeys) &&
      obstacleInfo.contactedWheelKeys.length > 0;
    const halfForward =
      Math.abs(forwardX) * obstacleInfo.halfExtents.x +
      Math.abs(forwardY) * obstacleInfo.halfExtents.y;
    const obstacleFront = centerAlongForward - halfForward;
    const obstacleRear = centerAlongForward + halfForward;
    const rampLength = Math.max(0.32, Math.min(0.45, halfForward * 1.2));
    const measuredGroundTargetZ = this.getGroundContactTargetZ();
    const groundTargetZ = Number.isFinite(measuredGroundTargetZ)
      ? measuredGroundTargetZ
      : bodyPosition.z;
    const obstacleTargetZ = this.getObstacleClimbTargetZ(obstacleInfo);

    // A single contacted wheel should be allowed to climb via wheel contact and body pitch/roll.
    // Global body-height traversal is reserved for a shared axle/support contact.
    if (
      !hasWheelContact ||
      obstacleInfo.contactedWheelKeys.length < 2 ||
      !Number.isFinite(obstacleTargetZ) ||
      lateralOffset > 0.8 ||
      obstacleTargetZ <= groundTargetZ + 0.004
    ) {
      return null;
    }

    return {
      obstacleInfo,
      forwardX,
      forwardY,
      halfForward,
      rampLength,
      groundTargetZ,
      obstacleTargetZ,
    };
  }

  getObstacleTraversalDistances(path) {
    if (!path?.obstacleInfo?.center || !this.body) {
      return null;
    }

    const bodyPosition = this.body.translation();
    const dx = path.obstacleInfo.center.x - bodyPosition.x;
    const dy = path.obstacleInfo.center.y - bodyPosition.y;
    const distanceToCenter = dx * path.forwardX + dy * path.forwardY;
    return {
      front: distanceToCenter - path.halfForward,
      rear: distanceToCenter + path.halfForward,
    };
  }

  isObstacleTraversalActive() {
    const distances = this.getObstacleTraversalDistances(
      this.activeObstacleTraversalPath,
    );
    if (!distances || !Number.isFinite(distances.rear)) {
      return false;
    }

    return (
      distances.front < this.activeObstacleTraversalPath.rampLength &&
      distances.rear > -this.activeObstacleTraversalPath.rampLength
    );
  }

  getObstacleTraversalTargetZ(path, wheelForwardOffset = 0) {
    if (!path || !Number.isFinite(path.rampLength)) {
      return null;
    }

    const distances = this.getObstacleTraversalDistances(path);
    if (!distances) {
      return null;
    }

    const rampLength = path.rampLength;
    const wheelDistances = {
      front: distances.front - wheelForwardOffset,
      rear: distances.rear - wheelForwardOffset,
    };
    let progress = 0;

    if (wheelDistances.front > 0) {
      progress =
        1 - THREE.MathUtils.clamp(wheelDistances.front / rampLength, 0, 1);
    } else if (wheelDistances.rear >= 0) {
      progress = 1;
    } else {
      progress = THREE.MathUtils.clamp(
        (wheelDistances.rear + rampLength) / rampLength,
        0,
        1,
      );
    }

    const smoothProgress = progress * progress * (3 - 2 * progress);
    return (
      path.groundTargetZ +
      (path.obstacleTargetZ - path.groundTargetZ) * smoothProgress
    );
  }

  getObstacleTraversalPitch(path) {
    if (!path) {
      return 0;
    }

    const wheelbaseMeters = 0.64;
    const frontTargetZ = this.getObstacleTraversalTargetZ(
      path,
      wheelbaseMeters * 0.5,
    );
    const rearTargetZ = this.getObstacleTraversalTargetZ(
      path,
      -wheelbaseMeters * 0.5,
    );
    if (!Number.isFinite(frontTargetZ) || !Number.isFinite(rearTargetZ)) {
      return 0;
    }

    return THREE.MathUtils.clamp(
      -Math.atan2(frontTargetZ - rearTargetZ, wheelbaseMeters),
      THREE.MathUtils.degToRad(-22),
      THREE.MathUtils.degToRad(22),
    );
  }

  applyObstacleClimbLift(
    hasObstacleContactNow,
    effectiveDeltaSec,
    obstacleInfo = null,
  ) {
    return;
  }

  preserveObstacleHeading(yaw = null) {
    if (!this.body) {
      return;
    }

    const bodyRotation = this.body.rotation();
    const headingYaw = Number.isFinite(yaw)
      ? yaw
      : this.extractYawFromQuaternion(bodyRotation);
    this.body.setRotation(
      {
        x: 0,
        y: 0,
        z: Math.sin(headingYaw * 0.5),
        w: Math.cos(headingYaw * 0.5),
      },
      true,
    );
  }

  suppressObstacleLateralSlip() {
    if (!this.body) {
      return;
    }

    const bodyRotation = this.body.rotation();
    const yaw = this.extractYawFromQuaternion(bodyRotation);
    const { x: forwardX, y: forwardY } = this.getVehicleForwardVector(yaw);
    const velocity = this.body.linvel();
    const forwardSpeed = velocity.x * forwardX + velocity.y * forwardY;

    this.body.setLinvel(
      new this.rapier.Vector3(
        forwardX * forwardSpeed,
        forwardY * forwardSpeed,
        velocity.z,
      ),
      true,
    );
  }

  suppressObstacleLateralDrift(referencePosition, referenceYaw) {
    if (!this.body || !referencePosition || !Number.isFinite(referenceYaw)) {
      return;
    }

    const { x: forwardX, y: forwardY } =
      this.getVehicleForwardVector(referenceYaw);
    const currentPosition = this.body.translation();
    const deltaX = currentPosition.x - referencePosition.x;
    const deltaY = currentPosition.y - referencePosition.y;
    const forwardDistance = deltaX * forwardX + deltaY * forwardY;

    this.body.setTranslation(
      new this.rapier.Vector3(
        referencePosition.x + forwardX * forwardDistance,
        referencePosition.y + forwardY * forwardDistance,
        currentPosition.z,
      ),
      true,
    );
  }

  isVehicleNearObstacleSupportZone() {
    return false;
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
    const clearance = Math.max(
      Number(this.underbodyPassThroughClearanceMeters) || 0,
      0,
    );

    return obstacleTopZ < wheelContactPlaneZ - clearance;
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

      const normalizedName = String(
        item.normalizedLinkName || this.normalizeLinkName(item.linkName || ""),
      );
      return normalizedName === target;
    });

    if (!info?.center || !info?.halfExtents) {
      return null;
    }

    return info.center.z + info.halfExtents.z;
  }

  clampVehicleAboveGround() {
    if (
      !this.body ||
      !Number.isFinite(this.groundZ) ||
      !Number.isFinite(this.groundContactLocalMinZ)
    ) {
      return;
    }

    const translation = this.body.translation();
    const velocity = this.body.linvel();
    const isOverHole = this.isVehicleOverHoleRegion();
    const groundBasedMinZ =
      this.groundZ - this.groundContactLocalMinZ - this.groundContactBiasMeters;
    const minAllowedZ =
      groundBasedMinZ - Math.max(this.groundPenetrationToleranceMeters, 0.002);

    // Only clamp when sinking below ground to prevent vertical jitter
    if (!isOverHole && translation.z < minAllowedZ) {
      this.body.setTranslation(
        new this.rapier.Vector3(translation.x, translation.y, minAllowedZ),
        true,
      );
      this.body.setLinvel(
        new this.rapier.Vector3(
          velocity.x,
          velocity.y,
          Math.max(0, velocity.z),
        ),
        true,
      );
    }
  }

  isBodyNearFlatGroundSupport() {
    if (
      !this.body ||
      !Number.isFinite(this.groundZ) ||
      !Number.isFinite(this.groundContactLocalMinZ)
    ) {
      return false;
    }

    if (
      this.isVehicleObstacleContact ||
      this.isVehicleOverHoleRegion() ||
      this.isVehicleNearObstacleSupportZone()
    ) {
      return false;
    }

    const translation = this.body.translation();
    const groundBasedMinZ =
      this.groundZ - this.groundContactLocalMinZ - this.groundContactBiasMeters;
    const snapDistance = Math.max(
      Number(this.flatGroundSnapDistanceMeters) || 0,
      0,
    );
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
    const threshold = Math.max(
      Number(this.flatGroundVerticalVelocitySnapThresholdMps) || 0,
      0,
    );

    if (Math.abs(velocity.z) <= threshold) {
      this.body.setLinvel(
        new this.rapier.Vector3(velocity.x, velocity.y, 0),
        true,
      );
    }

    // Reduce small roll/pitch oscillations while preserving steering yaw.
    this.body.setAngvel(
      new this.rapier.Vector3(
        angularVelocity.x * 0.75,
        angularVelocity.y * 0.75,
        angularVelocity.z,
      ),
      true,
    );
  }

  enforceFlatGroundRideHeight() {
    if (!this.body || !this.rapier) {
      return;
    }

    if (this.isVehicleObstacleContact || this.isVehicleOverHoleRegion()) {
      return;
    }

    const targetZ = Number(this.initialPosition?.z);
    if (!Number.isFinite(targetZ)) {
      return;
    }

    const translation = this.body.translation();
    if (Math.abs(targetZ - translation.z) < 1e-6) {
      return;
    }

    // Hard-lock vertical ride height on flat road to suppress persistent jitter.
    this.body.setTranslation(
      new this.rapier.Vector3(translation.x, translation.y, targetZ),
      true,
    );

    const velocity = this.body.linvel();
    this.body.setLinvel(
      new this.rapier.Vector3(velocity.x, velocity.y, 0),
      true,
    );
  }

  enforceMeasuredWheelGroundLimit(linkMap) {
    // Disabled artificial teleportation to prevent jittering during obstacle passage.
    return false;
  }

  settleVehicleToGroundAfterObstacle(linkMap) {
    // Disabled artificial position snapping.
    return false;
  }

  addWheelCollidersFromUrdf(body, carFrame, linkMap) {
    if (!this.world || !this.rapier || !body || !carFrame || !linkMap) {
      return;
    }

    const wheelLinkNames = ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"];
    let createdWheelColliderCount = 0;

    wheelLinkNames.forEach((wheelLinkName) => {
      const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
      if (!wheelLink) {
        return;
      }

      wheelLink.updateWorldMatrix(true, true);

      const wheelBounds =
        this.computeLinkOwnBounds(wheelLink, linkMap) || new THREE.Box3();
      const centerWorld = wheelBounds.isEmpty()
        ? wheelLink.getWorldPosition(new THREE.Vector3())
        : wheelBounds.getCenter(new THREE.Vector3());
      const size = wheelBounds.isEmpty()
        ? new THREE.Vector3(
            this.wheelEffectiveRadiusMeters * 2,
            this.wheelEffectiveRadiusMeters * 2,
            this.wheelEffectiveRadiusMeters * 2,
          )
        : wheelBounds.getSize(new THREE.Vector3());
      const inflation = Math.max(
        Number(this.wheelColliderInflationMeters) || 0,
        0,
      );
      const approxRadius =
        Math.max(size.x * 0.5, size.z * 0.5, 0.05) + inflation;
      const localCenter = carFrame.worldToLocal(centerWorld.clone());

      const wheelBodyDesc = this.rapier.RigidBodyDesc.dynamic()
        .setTranslation(centerWorld.x, centerWorld.y, centerWorld.z)
        .setLinearDamping(1.5)
        .setAngularDamping(1.0)
        .setCcdEnabled(true);
      const wheelBody = this.world.createRigidBody(wheelBodyDesc);
      if (typeof wheelBody.setCanSleep === "function") {
        wheelBody.setCanSleep(false);
      }

      const wheelColliderDesc = this.rapier.ColliderDesc.ball(approxRadius)
        .setDensity(25.0)
        .setFriction(0.0)
        .setCollisionGroups(COLLISION_GROUP_WHEEL)
        .setRestitution(0.0);
      const wheelCollider = this.world.createCollider(
        wheelColliderDesc,
        wheelBody,
      );
      this.vehicleColliders.push(wheelCollider);
      this.wheelColliders.push(wheelCollider);
      const wheelKeyByLinkName = {
        wheel_fl: "fl",
        wheel_fr: "fr",
        wheel_rl: "rl",
        wheel_rr: "rr",
      };
      const wheelKey = wheelKeyByLinkName[wheelLinkName] || null;
      if (wheelKey) {
        this.wheelCollidersByKey[wheelKey] = wheelCollider;
        this.wheelBodiesByKey[wheelKey] = wheelBody;
        const jointData = this.rapier.JointData.revolute(
          new this.rapier.Vector3(localCenter.x, localCenter.y, localCenter.z),
          new this.rapier.Vector3(0, 0, 0),
          new this.rapier.Vector3(0, 1, 0),
        );
        this.wheelJointsByKey[wheelKey] = this.world.createImpulseJoint(
          jointData,
          body,
          wheelBody,
          true,
        );
      }
      createdWheelColliderCount += 1;
    });

    if (createdWheelColliderCount === 0) {
      console.warn(
        "[URDF][Simulation] Wheel colliders were not created. Check wheel link names in URDF.",
      );
    }
  }

  getWheelLocalMinZ(carFrame, linkMap) {
    if (!carFrame || !linkMap) {
      return null;
    }

    const wheelLinkNames = ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"];
    const minValues = [];

    wheelLinkNames.forEach((wheelLinkName) => {
      const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
      if (!wheelLink) {
        return;
      }

      wheelLink.updateWorldMatrix(true, true);
      const wheelBounds =
        this.computeLinkOwnBounds(wheelLink, linkMap) || new THREE.Box3();
      const centerWorld = wheelBounds.isEmpty()
        ? wheelLink.getWorldPosition(new THREE.Vector3())
        : wheelBounds.getCenter(new THREE.Vector3());
      const centerLocal = carFrame.worldToLocal(centerWorld.clone());
      const wheelSize = wheelBounds.isEmpty()
        ? new THREE.Vector3(
            this.wheelEffectiveRadiusMeters * 2,
            this.wheelEffectiveRadiusMeters * 2,
            this.wheelEffectiveRadiusMeters * 2,
          )
        : wheelBounds.getSize(new THREE.Vector3());
      const wheelRadius = wheelBounds.isEmpty()
        ? Math.max(this.wheelEffectiveRadiusMeters, 0.05)
        : Math.max(wheelSize.x * 0.5, wheelSize.z * 0.5, 0.05);
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

    const wheelLinkNames = ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"];
    let minWheelWorldZ = Number.POSITIVE_INFINITY;

    wheelLinkNames.forEach((wheelLinkName) => {
      const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
      if (!wheelLink) {
        return;
      }

      wheelLink.updateWorldMatrix(true, true);
      const wheelBounds =
        this.computeLinkOwnBounds(wheelLink, linkMap) || new THREE.Box3();
      if (wheelBounds.isEmpty()) {
        const wheelCenter = wheelLink.getWorldPosition(new THREE.Vector3());
        minWheelWorldZ = Math.min(
          minWheelWorldZ,
          wheelCenter.z - Math.max(this.wheelEffectiveRadiusMeters, 0.05),
        );
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

    const wheelRadiusMetersByKey = {};
    const radii = [];

    Object.entries(this.wheelLinkNameByKey).forEach(
      ([wheelKey, wheelLinkName]) => {
        const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
        if (!wheelLink) {
          return;
        }

        wheelLink.updateWorldMatrix(true, true);
        const wheelBounds =
          this.computeLinkOwnBounds(wheelLink, linkMap) || new THREE.Box3();
        if (wheelBounds.isEmpty()) {
          return;
        }

        const size = wheelBounds.getSize(new THREE.Vector3());
        const radius = Math.max(size.x * 0.5, size.z * 0.5, 0.05);
        this.wheelRadiusMetersByKey[wheelKey] = radius;
        wheelRadiusMetersByKey[wheelKey] = radius;
        radii.push(radius);
      },
    );

    if (radii.length === 0) {
      return;
    }

    const avgRadius =
      radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
    this.wheelEffectiveRadiusMeters = Math.max(avgRadius, 0.05);
    const viewer = this.getDriveSourceViewer();
    if (viewer) {
      viewer.kmhToRpmFactorByWheelKey = {};
    }
    this.configureWheelVisualKinematics();
  }

  configureWheelVisualKinematics() {
    const viewer = this.getDriveSourceViewer();
    const wheelRadiusMeters = Number(this.wheelEffectiveRadiusMeters);
    if (
      !viewer ||
      !Number.isFinite(wheelRadiusMeters) ||
      wheelRadiusMeters <= 0
    ) {
      return;
    }

    viewer.kmhToRpmFactor = 1000 / (60 * Math.PI * 2 * wheelRadiusMeters);
    if (typeof viewer.setWheelAnimationTimeScale === "function") {
      viewer.setWheelAnimationTimeScale(this.visualSpeedScale);
    }
    if (typeof viewer.setWheelVisualFilterEnabled === "function") {
      viewer.setWheelVisualFilterEnabled(false);
    }

    const driveMode = String(
      this.commandedDriveMode || viewer.driveMode || "stop",
    );
    if (typeof viewer.applyDriveMode === "function") {
      viewer.applyDriveMode(driveMode, this.mpsToKmh(this.commandedSpeedMps));
    }
  }

  resetWheelTravelTracking() {
    this.previousWheelColliderPositionByKey = {};
    const linkMap = this.viewer?.robotModel?.links || null;
    Object.entries(this.wheelLinkNameByKey).forEach(
      ([wheelKey, wheelLinkName]) => {
        const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
        if (!wheelLink) {
          return;
        }

        wheelLink.updateWorldMatrix(true, false);
        this.previousWheelColliderPositionByKey[wheelKey] =
          wheelLink.getWorldPosition(new THREE.Vector3());
      },
    );
  }

  resetWheelBodiesFromVisual() {
    const linkMap = this.viewer?.robotModel?.links || null;
    Object.entries(this.wheelLinkNameByKey).forEach(
      ([wheelKey, wheelLinkName]) => {
        const wheelBody = this.wheelBodiesByKey[wheelKey];
        const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
        if (!wheelBody || !wheelLink) {
          return;
        }

        wheelLink.updateWorldMatrix(true, false);
        const position = wheelLink.getWorldPosition(new THREE.Vector3());
        wheelBody.setTranslation(
          new this.rapier.Vector3(position.x, position.y, position.z),
          true,
        );
        wheelBody.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
        wheelBody.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
      },
    );
  }

  stabilizeWheelBodiesForStraightDrive(targetVelocityX, targetVelocityY) {
    if (!this.body || !this.rapier) {
      return;
    }

    const bodyPosition = this.body.translation();
    const bodyRotation = this.body.rotation();
    const bodyQuaternion = new THREE.Quaternion(
      bodyRotation.x,
      bodyRotation.y,
      bodyRotation.z,
      bodyRotation.w,
    ).normalize();

    Object.entries(this.wheelJointsByKey).forEach(([wheelKey, joint]) => {
      const wheelBody = this.wheelBodiesByKey[wheelKey];
      if (!joint || !wheelBody || typeof joint.anchor1 !== "function") {
        return;
      }

      const anchor = joint.anchor1();
      const localAnchor = new THREE.Vector3(anchor.x, anchor.y, anchor.z);
      const worldAnchor = localAnchor
        .applyQuaternion(bodyQuaternion)
        .add(new THREE.Vector3(bodyPosition.x, bodyPosition.y, bodyPosition.z));
      const wheelVelocity = wheelBody.linvel();
      wheelBody.setTranslation(
        new this.rapier.Vector3(worldAnchor.x, worldAnchor.y, worldAnchor.z),
        true,
      );
      wheelBody.setLinvel(
        new this.rapier.Vector3(
          targetVelocityX,
          targetVelocityY,
          wheelVelocity.z,
        ),
        true,
      );
    });
  }

  syncWheelChartBaselineFromPhysics() {
    Object.keys(this.wheelChartBaselineCenterZByKey).forEach((wheelKey) => {
      this.wheelChartBaselineCenterZByKey[wheelKey] = null;
    });
  }

  syncWheelRotationToBodyTravel() {
    const viewer = this.getDriveSourceViewer();
    if (
      !viewer ||
      typeof viewer.applyWheelTravelDistances !== "function" ||
      !this.body
    ) {
      return;
    }

    if (typeof viewer.setWheelRotationDrivenByTravel === "function") {
      viewer.setWheelRotationDrivenByTravel(true);
    }

    const yaw = this.extractYawFromQuaternion(this.body.rotation());
    const forwardVector = this.getVehicleForwardVector(yaw);
    const distanceMetersByKey = {};
    const radiusMetersByKey = {};
    const linkMap = this.viewer?.robotModel?.links || null;

    Object.entries(this.wheelLinkNameByKey).forEach(
      ([wheelKey, wheelLinkName]) => {
        const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
        if (!wheelLink) {
          return;
        }

        wheelLink.updateWorldMatrix(true, false);
        const currentPosition = wheelLink.getWorldPosition(new THREE.Vector3());
        const previousPosition =
          this.previousWheelColliderPositionByKey[wheelKey] || null;
        if (previousPosition) {
          const displacement = currentPosition.clone().sub(previousPosition);
          distanceMetersByKey[wheelKey] =
            displacement.x * forwardVector.x + displacement.y * forwardVector.y;
          radiusMetersByKey[wheelKey] = Math.max(
            Number(this.wheelEffectiveRadiusMeters) || 0,
            0.05,
          );
        }
        this.previousWheelColliderPositionByKey[wheelKey] = currentPosition;
      },
    );

    viewer.applyWheelTravelDistances(distanceMetersByKey, radiusMetersByKey);
  }

  getAverageSignedWheelRpm() {
    const viewer = this.getDriveSourceViewer();
    return this.getAverageSignedWheelRpmForViewer(viewer);
  }

  getAverageSignedWheelRpmForViewer(viewer) {
    if (!viewer) {
      return null;
    }

    const wheelKeys = ["fl", "fr", "rl", "rr"];
    const signedRpms = [];

    wheelKeys.forEach((key) => {
      let signedRpm = null;
      if (typeof viewer.getSignedWheelRpm === "function") {
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

    const mode = String(viewer?.driveMode || "").toLowerCase();
    const avgRpm = this.getAverageSignedWheelRpmForViewer(viewer);
    const speedKmh = Math.max(Number(viewer?.driveSpeedKmh) || 0, 0);

    let score = 0;
    if (mode && mode !== "stop") {
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
      left: ["fl", "rl"],
      right: ["fr", "rr"],
    };

    const readSignedRpm = (key) => {
      if (typeof viewer.getSignedWheelRpm === "function") {
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

  getWheelTrackWidthMeters() {
    const leftWheelKeys = ["fl", "rl"];
    const rightWheelKeys = ["fr", "rr"];
    const getAverageLateralPosition = (wheelKeys) => {
      const positions = wheelKeys
        .map((wheelKey) => this.wheelCollidersByKey[wheelKey])
        .filter(Boolean)
        .map((wheelCollider) => wheelCollider.translation())
        .map((position) => Number(position?.y))
        .filter(Number.isFinite);
      if (positions.length === 0) {
        return null;
      }
      return (
        positions.reduce((sum, position) => sum + position, 0) /
        positions.length
      );
    };

    const leftPosition = getAverageLateralPosition(leftWheelKeys);
    const rightPosition = getAverageLateralPosition(rightWheelKeys);
    const trackWidth = Math.abs(leftPosition - rightPosition);
    return Number.isFinite(trackWidth) && trackWidth > 1e-3 ? trackWidth : 0.64;
  }

  getCenterTurnYawRate() {
    const wheelSides = this.getWheelSideSignedRpm();
    if (!wheelSides) {
      return 0;
    }

    const wheelRadius = Math.max(
      Number(this.wheelEffectiveRadiusMeters) || 0,
      0.05,
    );
    const trackWidth = this.getWheelTrackWidthMeters();
    const rpmDifference = wheelSides.right - wheelSides.left;
    const yawRate =
      (rpmDifference * Math.PI * 2 * wheelRadius) / (60 * trackWidth);

    return THREE.MathUtils.clamp(
      yawRate * this.centerTurnYawRateScale,
      -this.maxYawRateRad,
      this.maxYawRateRad,
    );
  }

  getDriveSourceViewer() {
    if (this.viewer) {
      return this.viewer;
    }

    const byId = window.urdfViewersById?.["robot-container-1"] || null;
    if (byId) {
      return byId;
    }

    return (
      window.activeURDFViewer ||
      window.urdfViewersById?.["vehicle-urdf-viewer"] ||
      null
    );
  }

  getCommandedDriveSpeedMps() {
    const fallbackByHook = Math.max(Number(this.commandedSpeedMps) || 0, 0);
    const driveViewer = this.getDriveSourceViewer();
    const avgSignedWheelRpm =
      this.getAverageSignedWheelRpmForViewer(driveViewer);
    const speedBySlider =
      Math.max(Number(driveViewer?.driveSpeedKmh) || 0, 0) / 3.6;

    if (
      Number.isFinite(avgSignedWheelRpm) &&
      Math.abs(avgSignedWheelRpm) > 0.1
    ) {
      const wheelAngularSpeedRadPerSec =
        Math.abs(avgSignedWheelRpm) * ((Math.PI * 2) / 60);
      const speedByWheel =
        wheelAngularSpeedRadPerSec *
        Math.max(this.wheelEffectiveRadiusMeters, 0.05);
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
    const wheelGroundGap = measuredWheelWorldMinZ - this.groundZ;
    const minWheelGroundGap = Math.max(wheelGroundGap, 0.002);
    this.groundContactLocalMinZ =
      this.groundZ + minWheelGroundGap - translation.z;
    this.wheelLocalMinZ = this.groundContactLocalMinZ;
  }

  getGroundContactTargetZ() {
    if (
      !Number.isFinite(this.groundZ) ||
      !Number.isFinite(this.groundContactLocalMinZ)
    ) {
      return null;
    }

    return (
      this.groundZ - this.groundContactLocalMinZ - this.groundContactBiasMeters
    );
  }

  alignVehicleWheelContactToGround() {
    if (
      !this.body ||
      !Number.isFinite(this.groundZ) ||
      !Number.isFinite(this.groundContactLocalMinZ)
    ) {
      return;
    }

    const translation = this.body.translation();
    const targetZ = this.getGroundContactTargetZ();
    if (!Number.isFinite(targetZ)) {
      return;
    }
    this.body.setTranslation(
      new this.rapier.Vector3(translation.x, translation.y, targetZ),
      true,
    );
  }

  alignVehicleToGroundByWheelGap(linkMap, toleranceMeters = 0.001) {
    if (
      !this.body ||
      !this.rapier ||
      !linkMap ||
      !Number.isFinite(this.groundZ)
    ) {
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
    const alignedZ = translation.z - Math.max(wheelGroundGap, 0.002);
    this.body.setTranslation(
      new this.rapier.Vector3(translation.x, translation.y, alignedZ),
      true,
    );

    // Keep local contact baseline in sync after explicit correction.
    this.groundContactLocalMinZ = measuredWheelWorldMinZ - alignedZ;
    this.wheelLocalMinZ = this.groundContactLocalMinZ;

    const velocity = this.body.linvel();
    this.body.setLinvel(
      new this.rapier.Vector3(velocity.x, velocity.y, Math.min(0, velocity.z)),
      true,
    );
  }

  syncCarFrameFromBody() {
    if (!this.body || !this.carFrame) {
      return;
    }

    const position = this.body.translation();
    const rotation = this.body.rotation();
    this.carFrame.position.set(position.x, position.y, position.z);
    this.carFrame.quaternion
      .set(rotation.x, rotation.y, rotation.z, rotation.w)
      .normalize();
    this.carFrame.updateMatrixWorld(true);
    this.syncVehicleDirectionArrows();
    this.syncVehicleYawIndicator();
    this.syncWheelRotationToBodyTravel();
  }

  ensureVehicleDirectionArrows() {
    if (this.vehicleDirectionArrowGroup?.parent || !this.viewer?.scene) {
      return;
    }

    const halfX = Math.max(Number(this.vehicleHalfExtents?.x) || 0.3, 0.2);
    const arrowCenterX = Number(this.vehicleColliderLocalCenter.x) || 0;
    const arrowOriginX = arrowCenterX + halfX + 0.04;
    const arrowHeight = Number(this.vehicleColliderLocalCenter.z) || 0;
    const arrowShaftRadius = 0.012;
    const arrowHeadBaseRadius = 0.024;
    const arrowShaftLength = Math.max(halfX * 0.35, 0.105);
    const arrowHeadLength = Math.min(
      Math.max(arrowShaftLength * 0.45, 0.05),
      0.08,
    );
    const arrowMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      side: THREE.DoubleSide,
      vertexShader: `
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        void main() {
          gl_FragColor = vec4(0.0, 0.55, 1.0, 1.0);
        }
      `,
    });
    const arrowGroup = new THREE.Group();
    arrowGroup.name = "simulation-vehicle-direction-arrows";

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(
        arrowShaftRadius,
        arrowShaftRadius,
        arrowShaftLength,
        16,
      ),
      arrowMaterial,
    );
    shaft.position.set(arrowOriginX + arrowShaftLength * 0.5, 0, arrowHeight);
    shaft.rotation.z = -Math.PI / 2;
    shaft.renderOrder = 1000;
    arrowGroup.add(shaft);

    const arrowHead = new THREE.Mesh(
      new THREE.ConeGeometry(arrowHeadBaseRadius, arrowHeadLength, 16),
      arrowMaterial,
    );
    arrowHead.position.set(
      arrowOriginX + arrowShaftLength + arrowHeadLength * 0.5,
      0,
      arrowHeight,
    );
    arrowHead.rotation.z = -Math.PI / 2;
    arrowHead.renderOrder = 1000;
    arrowGroup.add(arrowHead);

    this.vehicleDirectionArrowGroup = arrowGroup;
    this.viewer.scene.add(arrowGroup);
    this.syncVehicleDirectionArrows();
  }

  syncVehicleDirectionArrows() {
    if (!this.vehicleDirectionArrowGroup || !this.carFrame) {
      return;
    }

    this.carFrame.updateWorldMatrix(true, false);
    this.carFrame.getWorldPosition(this.vehicleDirectionArrowGroup.position);
    this.carFrame.getWorldQuaternion(
      this.vehicleDirectionArrowGroup.quaternion,
    );
    this.vehicleDirectionArrowGroup.updateMatrixWorld(true);
  }

  ensureVehicleYawIndicator() {
    if (
      this.vehicleYawIndicatorGroup?.parent ||
      !this.viewer?.scene ||
      !this.initialQuaternion
    ) {
      return;
    }

    const halfX = Math.max(Number(this.vehicleHalfExtents?.x) || 0.3, 0.2);
    const halfY = Math.max(Number(this.vehicleHalfExtents?.y) || 0.2, 0.14);
    const arcRadius = Math.min(
      Math.max(Math.min(halfX, halfY) * 0.72, 0.12),
      0.22,
    );
    const arcSegments = 64;
    const arcGeometry = new THREE.BufferGeometry();
    arcGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array((arcSegments + 1) * 3), 3),
    );
    arcGeometry.setDrawRange(0, 0);

    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x00a8ff,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    const indicatorGroup = new THREE.Group();
    indicatorGroup.name = "simulation-vehicle-yaw-indicator";

    const arcLine = new THREE.Line(arcGeometry, lineMaterial);
    arcLine.renderOrder = 1000;
    indicatorGroup.add(arcLine);

    const radiusLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(arcRadius, 0, 0),
      ]),
      lineMaterial,
    );
    radiusLine.renderOrder = 1000;
    indicatorGroup.add(radiusLine);

    const startRadiusLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(arcRadius, 0, 0),
      ]),
      lineMaterial,
    );
    startRadiusLine.renderOrder = 1000;
    indicatorGroup.add(startRadiusLine);

    const arcArrowHead = new THREE.Mesh(
      new THREE.ConeGeometry(0.016, 0.04, 12),
      new THREE.MeshBasicMaterial({
        color: 0x00a8ff,
        depthTest: false,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    );
    arcArrowHead.visible = false;
    arcArrowHead.renderOrder = 1000;
    indicatorGroup.add(arcArrowHead);

    indicatorGroup.userData.arcRadius = arcRadius;
    indicatorGroup.userData.arcSegments = arcSegments;
    this.vehicleInitialYawRad = this.extractYawFromQuaternion(
      this.initialQuaternion,
    );
    this.vehicleYawIndicatorGroup = indicatorGroup;
    this.vehicleYawArcLine = arcLine;
    this.vehicleYawRadiusLine = radiusLine;
    this.vehicleYawArcArrowHead = arcArrowHead;
    this.viewer.scene.add(indicatorGroup);
    this.syncVehicleYawIndicator();
  }

  syncVehicleYawIndicator() {
    if (
      !this.vehicleYawIndicatorGroup ||
      !this.vehicleYawArcLine ||
      !this.vehicleYawRadiusLine ||
      !this.vehicleYawArcArrowHead ||
      !this.carFrame
    ) {
      return;
    }

    this.carFrame.updateWorldMatrix(true, false);
    const carPosition = this.carFrame.getWorldPosition(new THREE.Vector3());
    const carQuaternion = this.carFrame.getWorldQuaternion(
      new THREE.Quaternion(),
    );
    const halfZ = Math.max(Number(this.vehicleHalfExtents?.z) || 0.12, 0.06);
    const roofOffset = new THREE.Vector3(
      Number(this.vehicleColliderLocalCenter.x) || 0,
      Number(this.vehicleColliderLocalCenter.y) || 0,
      (Number(this.vehicleColliderLocalCenter.z) || 0) + halfZ + 0.06,
    ).applyQuaternion(carQuaternion);
    const initialYaw = Number.isFinite(this.vehicleInitialYawRad)
      ? this.vehicleInitialYawRad
      : this.extractYawFromQuaternion(carQuaternion);
    const currentYaw = this.extractYawFromQuaternion(carQuaternion);
    const yawDelta = Math.atan2(
      Math.sin(currentYaw - initialYaw),
      Math.cos(currentYaw - initialYaw),
    );
    const arcRadius = this.vehicleYawIndicatorGroup.userData.arcRadius;
    const arcSegments = this.vehicleYawIndicatorGroup.userData.arcSegments;

    this.vehicleYawIndicatorGroup.position.copy(carPosition).add(roofOffset);
    this.vehicleYawIndicatorGroup.quaternion.setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      initialYaw,
    );

    const segmentCount = Math.min(
      arcSegments,
      Math.ceil((Math.abs(yawDelta) / (Math.PI * 2)) * arcSegments),
    );
    const arcPositions = this.vehicleYawArcLine.geometry.attributes.position;
    for (let index = 0; index <= segmentCount; index += 1) {
      const angle = segmentCount > 0 ? (yawDelta * index) / segmentCount : 0;
      arcPositions.setXYZ(
        index,
        Math.cos(angle) * arcRadius,
        Math.sin(angle) * arcRadius,
        0,
      );
    }
    arcPositions.needsUpdate = true;
    this.vehicleYawArcLine.geometry.setDrawRange(
      0,
      segmentCount > 0 ? segmentCount + 1 : 0,
    );

    const radiusPositions =
      this.vehicleYawRadiusLine.geometry.attributes.position;
    radiusPositions.setXYZ(0, 0, 0, 0);
    radiusPositions.setXYZ(
      1,
      Math.cos(yawDelta) * arcRadius,
      Math.sin(yawDelta) * arcRadius,
      0,
    );
    radiusPositions.needsUpdate = true;

    const isTurning = Math.abs(yawDelta) > 1e-4;
    this.vehicleYawArcArrowHead.visible = isTurning;
    if (isTurning) {
      const rotationSign = Math.sign(yawDelta);
      const tangent = new THREE.Vector3(
        -Math.sin(yawDelta) * rotationSign,
        Math.cos(yawDelta) * rotationSign,
        0,
      );
      const arcEnd = new THREE.Vector3(
        Math.cos(yawDelta) * arcRadius,
        Math.sin(yawDelta) * arcRadius,
        0.003,
      );
      this.vehicleYawArcArrowHead.position
        .copy(arcEnd)
        .addScaledVector(tangent, 0.02);
      this.vehicleYawArcArrowHead.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        tangent,
      );
    }
    this.vehicleYawIndicatorGroup.updateMatrixWorld(true);
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
    this.logWheelGroundDiagnosticsOnce(
      linkMap,
      "enforceWheelGroundContactAtLoad",
    );
  }

  initializeObstacleContactVisual(obstacleInfo) {
    if (
      !obstacleInfo?.linkObject ||
      Array.isArray(obstacleInfo.contactMaterialStates)
    ) {
      return;
    }

    const materialStates = [];
    obstacleInfo.linkObject.traverse((node) => {
      if (!node?.isMesh || !node.material) {
        return;
      }

      if (Array.isArray(node.material)) {
        node.material = node.material.map(
          (material) => material?.clone?.() || material,
        );
      } else if (node.material?.clone) {
        node.material = node.material.clone();
      }

      const materials = Array.isArray(node.material)
        ? node.material
        : [node.material];
      materials.forEach((material) => {
        if (!material) {
          return;
        }

        materialStates.push({
          material,
          color: material.color?.clone?.() || null,
          emissive: material.emissive?.clone?.() || null,
          emissiveIntensity: Number.isFinite(material.emissiveIntensity)
            ? material.emissiveIntensity
            : null,
        });
      });
    });

    obstacleInfo.contactMaterialStates = materialStates;
    obstacleInfo.isContactHighlighted = false;
  }

  setObstacleContactHighlight(obstacleInfo, isContacting, forceClear = false) {
    this.initializeObstacleContactVisual(obstacleInfo);
    if (!Array.isArray(obstacleInfo?.contactMaterialStates)) {
      return;
    }

    if (obstacleInfo.isContactHighlighted === isContacting) {
      return;
    }

    const contactColor = new THREE.Color(0xff0000);
    const contactEmissive = new THREE.Color(0x660000);
    obstacleInfo.contactMaterialStates.forEach((state) => {
      if (state.material.color) {
        state.material.color.copy(isContacting ? contactColor : state.color);
      }
      if (state.material.emissive) {
        state.material.emissive.copy(
          isContacting ? contactEmissive : state.emissive,
        );
      }
      if (state.emissiveIntensity !== null) {
        state.material.emissiveIntensity = isContacting
          ? Math.max(state.emissiveIntensity, 0.8)
          : state.emissiveIntensity;
      }
      state.material.needsUpdate = true;
    });
    obstacleInfo.isContactHighlighted = isContacting;
  }

  updateObstacleContactState() {
    if (
      !this.world ||
      this.vehicleColliders.length === 0 ||
      this.obstacleColliders.length === 0
    ) {
      return false;
    }

    let hasContact = false;
    this.obstacleColliderInfos.forEach((obstacleInfo) => {
      let obstacleHasContact = false;
      if (!obstacleInfo?.collider || obstacleInfo.isSensor) {
        this.setObstacleContactHighlight(obstacleInfo, false);
        return;
      }

      obstacleInfo.contactedWheelKeys =
        this.getObstacleContactedWheelKeys(obstacleInfo);
      obstacleInfo.hasChassisContact =
        this.isVehicleColliderContactingObstacle(obstacleInfo);
      obstacleHasContact =
        obstacleInfo.contactedWheelKeys.length > 0 ||
        obstacleInfo.hasChassisContact;

      const isActiveTraversalObstacle =
        this.activeObstacleTraversalPath?.obstacleInfo === obstacleInfo;
      if (obstacleHasContact) {
        obstacleInfo.isContactHighlightLatched = true;
        obstacleInfo.contactHighlightPendingUntilMs = performance.now() + 600;
      } else if (
        !isActiveTraversalObstacle &&
        performance.now() >=
          (Number(obstacleInfo.contactHighlightPendingUntilMs) || 0)
      ) {
        obstacleInfo.isContactHighlightLatched = false;
      }

      this.setObstacleContactHighlight(obstacleInfo, obstacleHasContact);
      hasContact = hasContact || obstacleHasContact;
    });

    if (hasContact !== this.isVehicleObstacleContact) {
      this.isVehicleObstacleContact = hasContact;
      console.log(
        `[URDF][Simulation] vehicle-obstacle contact: ${hasContact ? "ON" : "OFF"}`,
      );
    }

    return hasContact;
  }

  rollbackToPreviousPose(previousPose) {
    if (!previousPose || !this.body || !this.rapier || !this.carFrame) {
      return;
    }

    this.body.setTranslation(
      new this.rapier.Vector3(previousPose.x, previousPose.y, previousPose.z),
      true,
    );
    this.body.setRotation(
      {
        x: previousPose.qx,
        y: previousPose.qy,
        z: previousPose.qz,
        w: previousPose.qw,
      },
      true,
    );
    this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
    this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);

    this.carFrame.position.set(previousPose.x, previousPose.y, previousPose.z);
    this.carFrame.quaternion
      .set(previousPose.qx, previousPose.qy, previousPose.qz, previousPose.qw)
      .normalize();
  }

  setUprightRotationLockEnabled(isEnabled) {
    if (!this.body) {
      return;
    }

    if (this.isUprightRotationLockActive === isEnabled) {
      return;
    }

    if (typeof this.body.setEnabledRotations === "function") {
      this.body.setEnabledRotations(!isEnabled, !isEnabled, true, true);
      this.isUprightRotationLockActive = isEnabled;
      return;
    }

    if (typeof this.body.restrictRotations === "function") {
      this.body.restrictRotations(!isEnabled, !isEnabled, true, true);
      this.isUprightRotationLockActive = isEnabled;
      return;
    }

    // Some Rapier builds expose only lockRotations(lockAll), which cannot keep yaw free.
    // In that case, skip runtime upright-lock toggling to preserve steering rotation.
    this.isUprightRotationLockActive = false;
  }

  maybeLogRuntimeDiagnostics(
    deltaSec,
    driveViewer,
    clampedSpeed,
    throttleSign,
    steerSign,
    hasObstacleContact,
  ) {
    if (!this.enableRuntimeDiagnostics || !this.body) {
      return;
    }

    this.runtimeDiagnosticsElapsedSec += Math.max(deltaSec, 0);
    if (
      this.runtimeDiagnosticsElapsedSec < this.runtimeDiagnosticsIntervalSec
    ) {
      return;
    }
    this.runtimeDiagnosticsElapsedSec = 0;

    const bodyPos = this.body.translation();
    const bodyVel = this.body.linvel();
    const avgRpm = this.getAverageSignedWheelRpmForViewer(driveViewer);
    const driveMode = String(driveViewer?.driveMode || "n/a");
    const driveSpeedKmh = Number(driveViewer?.driveSpeedKmh);
    const sourceId = String(driveViewer?.container?.id || "unknown");
    console.log("[URDF][Simulation][diag]", {
      sourceId,
      driveMode,
      driveSpeedKmh: Number.isFinite(driveSpeedKmh)
        ? Number(driveSpeedKmh.toFixed(3))
        : null,
      avgSignedWheelRpm: Number.isFinite(avgRpm)
        ? Number(avgRpm.toFixed(3))
        : null,
      clampedSpeedMps: Number(clampedSpeed.toFixed(4)),
      throttleSign,
      steerSign,
      hasObstacleContact,
      pos: {
        x: Number(bodyPos.x.toFixed(4)),
        y: Number(bodyPos.y.toFixed(4)),
        z: Number(bodyPos.z.toFixed(4)),
      },
      vel: {
        x: Number(bodyVel.x.toFixed(4)),
        y: Number(bodyVel.y.toFixed(4)),
        z: Number(bodyVel.z.toFixed(4)),
      },
      groundZ: Number.isFinite(this.groundZ)
        ? Number(this.groundZ.toFixed(4))
        : null,
    });
  }

  async ensureRapierInitialized() {
    if (this.isReady || this.isInitializing || this.hasFailed) {
      return;
    }

    if (!this.viewer?.robotModel) {
      return;
    }

    const linkMap = this.vehicleModel.links;
    const carFrame =
      this.findLinkByName(linkMap, "car_frame") ||
      this.findLinkByName(linkMap, "base_link") ||
      null;
    if (!carFrame) {
      return;
    }

    this.isInitializing = true;

    try {
      const rapierModule = await import(RAPIER_CDN);
      const RAPIER = rapierModule?.default || rapierModule;

      if (!RAPIER || typeof RAPIER.init !== "function") {
        throw new Error("RAPIER init function not found");
      }

      await RAPIER.init();

      const world = new RAPIER.World(new RAPIER.Vector3(0, 0, -9.81));
      const initialPosition = carFrame.position.clone();
      const initialQuaternion = carFrame.quaternion.clone();

      const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(initialPosition.x, initialPosition.y, initialPosition.z)
        .setRotation(initialQuaternion)
        .setLinearDamping(0.2)
        .setAngularDamping(6.0)
        .setCcdEnabled(true);

      const body = world.createRigidBody(rigidBodyDesc);

      if (typeof body.setCanSleep === "function") {
        body.setCanSleep(false);
      }

      // Keep roll/pitch available for obstacle contact; flat-ground stabilization locks them dynamically.
      if (typeof body.setEnabledRotations === "function") {
        body.setEnabledRotations(true, true, true, true);
      } else if (typeof body.restrictRotations === "function") {
        body.restrictRotations(true, true, true, true);
      }

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

      const halfZ = Math.max(halfZBase, 0.06);
      const adjustedCenterZ = localCenter.z;

      const colliderDesc = RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
        .setTranslation(localCenter.x, localCenter.y, adjustedCenterZ)
        .setFriction(0.15)
        .setCollisionGroups(COLLISION_GROUP_CHASSIS)
        .setRestitution(0.0);

      this.rapier = RAPIER;
      this.world = world;
      this.body = body;
      this.carFrame = carFrame;
      this.vehicleCollider = world.createCollider(colliderDesc, body);
      this.vehicleColliderLocalCenter.set(
        localCenter.x,
        localCenter.y,
        adjustedCenterZ,
      );
      this.vehicleColliderHalfExtents = { x: halfX, y: halfY, z: halfZ };
      this.vehicleColliders = [this.vehicleCollider];
      if (this.enableWheelPhysicsColliders) {
        this.addWheelCollidersFromUrdf(body, carFrame, linkMap);
      }

      this.initialPosition = initialPosition.clone();
      this.initialQuaternion = initialQuaternion.clone();
      this.vehicleHalfExtents = { x: halfX, y: halfY, z: halfZ };
      this.addGroundCollider();
      this.enforceWheelGroundContactAtLoad(linkMap);
      this.addObstacleColliderFromUrdf();
      this.initializeWheelZChartRangeFromObstacles(linkMap);
      this.ensureVehicleDirectionArrows();
      this.ensureVehicleYawIndicator();
      this.resetWheelTravelTracking();
      this.syncWheelChartBaselineFromPhysics();
      this.isReady = true;
      this.hasFailed = false;

      console.log(
        "[URDF][Simulation] Rapier direction control with URDF obstacle initialized",
      );
    } catch (error) {
      this.hasFailed = true;
      console.warn("[URDF][Simulation] Rapier initialization failed:", error);
    } finally {
      this.isInitializing = false;
    }
  }

  applyDriveForces(
    effectiveDeltaSec,
    targetVelocityX,
    targetVelocityY,
    throttleSign,
    steerSign,
    clampedSpeed,
    wheelGroundContactCount = 0,
  ) {
    if (!this.body || !this.rapier) {
      return;
    }

    const tractionScale = wheelGroundContactCount > 0 ? 1 : 0.35;
    const currentLinearVelocity = this.body.linvel();
    const currentAngularVelocity = this.body.angvel();
    const velocityErrorX = targetVelocityX - currentLinearVelocity.x;
    const velocityErrorY = targetVelocityY - currentLinearVelocity.y;
    const accelerationImpulseScale =
      Math.max(0.25 + Math.max(clampedSpeed, 0) * 0.08, 0.3) * tractionScale;
    const impulseX =
      velocityErrorX * accelerationImpulseScale * effectiveDeltaSec;
    const impulseY =
      velocityErrorY * accelerationImpulseScale * effectiveDeltaSec;

    this.body.applyImpulse(
      new this.rapier.Vector3(impulseX, impulseY, 0),
      true,
    );

    const currentSpeed = Math.hypot(
      currentLinearVelocity.x,
      currentLinearVelocity.y,
    );
    if (currentSpeed > 0.001) {
      const dragScale =
        Math.min(0.08 + currentSpeed * 0.08, 0.22) *
        tractionScale *
        effectiveDeltaSec;
      this.body.applyImpulse(
        new this.rapier.Vector3(
          -currentLinearVelocity.x * dragScale,
          -currentLinearVelocity.y * dragScale,
          0,
        ),
        true,
      );
    }

    if (Math.abs(throttleSign) < 1e-6 && Math.abs(steerSign) < 1e-6) {
      this.body.applyImpulse(
        new this.rapier.Vector3(
          -currentLinearVelocity.x * 0.04 * tractionScale * effectiveDeltaSec,
          -currentLinearVelocity.y * 0.04 * tractionScale * effectiveDeltaSec,
          0,
        ),
        true,
      );
    }

    const steeringTorque =
      (Number.isFinite(steerSign) ? steerSign : 0) *
      0.012 *
      tractionScale *
      effectiveDeltaSec;
    if (Math.abs(steeringTorque) > 1e-6) {
      this.body.applyTorqueImpulse(
        new this.rapier.Vector3(0, 0, steeringTorque),
        true,
      );
    }

    // Suppress unwanted rotation (yaw spin) caused by asymmetric wheel obstacle collision
    if (this.isVehicleObstacleContact && Math.abs(steerSign) < 1e-3) {
      this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
    } else if (
      Math.abs(currentAngularVelocity.z) > 0.001 &&
      Math.abs(steerSign) < 1e-6
    ) {
      const yawDampingTorque =
        -currentAngularVelocity.z * 0.06 * tractionScale * effectiveDeltaSec;
      this.body.applyTorqueImpulse(
        new this.rapier.Vector3(0, 0, yawDampingTorque),
        true,
      );
    }
  }

  applyGroundSupportForces(
    effectiveDeltaSec,
    wheelGroundContactCount = 0,
    suppressForObstacleContact = false,
  ) {
    if (
      !this.body ||
      !this.rapier ||
      !Number.isFinite(this.groundZ) ||
      !Number.isFinite(this.groundContactLocalMinZ)
    ) {
      return;
    }

    if (suppressForObstacleContact) {
      return;
    }

    const translation = this.body.translation();
    const targetZ = this.getGroundContactTargetZ();
    if (!Number.isFinite(targetZ)) {
      return;
    }

    const gap = targetZ - translation.z;
    const currentVelocityZ = this.body.linvel().z;
    const supportStrength = wheelGroundContactCount > 0 ? 1 : 0.25;
    if (gap > 0.002) {
      const supportImpulse =
        Math.min(gap * 1.8 + 0.04, 0.8) * supportStrength * effectiveDeltaSec;
      this.body.applyImpulse(
        new this.rapier.Vector3(0, 0, supportImpulse),
        true,
      );
    } else if (gap < -0.001) {
      const dampingImpulse =
        Math.min(Math.abs(gap) * 1.6, 0.4) *
        supportStrength *
        effectiveDeltaSec;
      this.body.applyImpulse(
        new this.rapier.Vector3(0, 0, -dampingImpulse),
        true,
      );
    }

    if (Math.abs(currentVelocityZ) > 0.01 && Math.abs(gap) < 0.01) {
      this.body.applyImpulse(
        new this.rapier.Vector3(
          0,
          0,
          -currentVelocityZ * 0.45 * supportStrength * effectiveDeltaSec,
        ),
        true,
      );
    }
  }

  applyObstacleContactImpulse(effectiveDeltaSec, obstacleInfo = null) {
    // Do not apply artificial push back impulse to allow smooth climbing
    return;
  }

  updateWheelGroundContactState() {
    if (!this.world || !this.body || !this.rapier) {
      return 0;
    }

    const wheelKeys = ["fl", "fr", "rl", "rr"];
    let contactCount = 0;
    wheelKeys.forEach((wheelKey) => {
      const wheelCollider = this.wheelCollidersByKey?.[wheelKey] || null;
      if (!wheelCollider) {
        this.wheelGroundContactState[wheelKey] = false;
        return;
      }

      let isContacting = false;
      this.groundColliders.forEach((groundCollider) => {
        if (isContacting) {
          return;
        }
        this.world.contactPair(wheelCollider, groundCollider, () => {
          isContacting = true;
        });
      });

      this.wheelGroundContactState[wheelKey] = isContacting;
      if (isContacting) {
        contactCount += 1;
      }
    });

    return contactCount;
  }

  stepSimulation() {
    if (!this.isReady) {
      return;
    }

    if (
      !this.viewer ||
      !this.rapier ||
      !this.world ||
      !this.body ||
      !this.carFrame
    ) {
      return;
    }

    const now = performance.now();
    if (this.isPaused) {
      this.lastStepTimeMs = now;
      return;
    }

    if (String(this.commandedDriveMode || "").toLowerCase() === "stop") {
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
    this.lowSpeedPositionAssistDistanceMeters = 0;
    this.predictedObstacleBlockActive = false;

    const keyboardState = this.vehicleController.getKeyboardState();
    const driveViewer = this.vehicleController.getDriveSource();

    let throttleSign = 0;
    let steerSign = 0;
    let keyboardMoveX = 0;
    let keyboardMoveY = 0;
    if (keyboardState.isActive) {
      keyboardMoveX = keyboardState.moveX;
      keyboardMoveY = keyboardState.moveY;
    } else {
      const driveMode = String(
        this.commandedDriveMode ||
          driveViewer?.driveMode ||
          this.viewer?.driveMode ||
          "stop",
      );
      if (driveMode === "forward") {
        throttleSign = 1;
      } else if (driveMode === "backward") {
        throttleSign = -1;
      } else if (driveMode === "left") {
        throttleSign = 0;
        steerSign = 1;
      } else if (driveMode === "right") {
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

    const speedMps = this.vehicleController.getSpeedMps();
    const clampedSpeed = Math.min(speedMps, this.maxSpeedMps);
    const effectiveSteerSign = clampedSpeed > 1e-3 ? steerSign : 0;
    const wheelGroundContactCount =
      this.wheelController.updateGroundContactState();
    const hasDriveCommand =
      keyboardState.isActive || throttleSign !== 0 || steerSign !== 0;
    this.lastDriveCommandState = {
      throttleSign,
      steerSign,
      hasMoveCommand: hasDriveCommand,
    };
    if (hasDriveCommand) {
      this.hasActivatedSimulationMotion = true;
    }

    if (!this.hasActivatedSimulationMotion) {
      this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
      this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
      this.renderer.syncVehicle();
      return;
    }

    if (hasDriveCommand) {
      this.hasActivatedDynamicGroundClamp = true;
    }
    const wasObstacleContact =
      this.contactSolver.updateVehicleObstacleContact();
    const obstacleApproach = this.contactSolver.getApproachInfo();
    const isObstacleApproachForClimb = this.contactSolver.isClimbApproach(
      obstacleApproach?.obstacleInfo || null,
    );
    this.isVehicleObstacleContact = Boolean(
      wasObstacleContact || isObstacleApproachForClimb,
    );
    let commandedVelocityX = 0;
    let commandedVelocityY = 0;
    const isNearFlatGroundSupport = this.isBodyNearFlatGroundSupport();

    if (this.keepUprightOnFlatGround) {
      this.setUprightRotationLockEnabled(
        isNearFlatGroundSupport && !this.isVehicleObstacleContact,
      );
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
      qw: previousRotation.w,
    };
    const frameStartPosition = this.body.translation();

    const currentLinearVelocity = this.body.linvel();
    const currentAngularVelocity = this.body.angvel();
    let lockedRotation = null;
    let targetVelocityX = 0;
    let targetVelocityY = 0;
    if (keyboardState.isActive) {
      lockedRotation = this.body.rotation();
      const velocitySmoothingAlpha = 1 - Math.exp(-12 * effectiveDeltaSec);
      targetVelocityX = keyboardMoveX * clampedSpeed;
      targetVelocityY = keyboardMoveY * clampedSpeed;
      const velocityX =
        currentLinearVelocity.x +
        (targetVelocityX - currentLinearVelocity.x) * velocitySmoothingAlpha;
      const velocityY =
        currentLinearVelocity.y +
        (targetVelocityY - currentLinearVelocity.y) * velocitySmoothingAlpha;
      commandedVelocityX = targetVelocityX;
      commandedVelocityY = targetVelocityY;

      const nextVelocityZ = wasObstacleContact
        ? currentLinearVelocity.z
        : isNearFlatGroundSupport
          ? 0
          : currentLinearVelocity.z;
      this.body.setLinvel(
        new this.rapier.Vector3(velocityX, velocityY, nextVelocityZ),
        true,
      );
      this.body.setAngvel(
        new this.rapier.Vector3(
          isNearFlatGroundSupport ? 0 : currentAngularVelocity.x,
          isNearFlatGroundSupport ? 0 : currentAngularVelocity.y,
          0,
        ),
        true,
      );
    } else {
      const bodyRotation = this.body.rotation();
      const yaw = this.extractYawFromQuaternion(bodyRotation);
      const forwardVector = this.getVehicleForwardVector(yaw);
      targetVelocityX = forwardVector.x * clampedSpeed * throttleSign;
      targetVelocityY = forwardVector.y * clampedSpeed * throttleSign;
      commandedVelocityX = targetVelocityX;
      commandedVelocityY = targetVelocityY;

      const nextVelocityZ = wasObstacleContact
        ? currentLinearVelocity.z
        : isNearFlatGroundSupport
          ? 0
          : currentLinearVelocity.z;
      this.body.setLinvel(
        new this.rapier.Vector3(
          currentLinearVelocity.x,
          currentLinearVelocity.y,
          nextVelocityZ,
        ),
        true,
      );
      this.body.setAngvel(
        new this.rapier.Vector3(
          currentAngularVelocity.x,
          currentAngularVelocity.y,
          effectiveSteerSign !== 0 ? this.getCenterTurnYawRate() : 0,
        ),
        true,
      );
    }

    // Follow the fixed-step update style from three.js Rapier vehicle controller example.
    this.physicsAccumulatorSec = Math.min(
      this.physicsAccumulatorSec + effectiveDeltaSec,
      this.physicsFixedTimeStepSec * this.maxPhysicsCatchupSteps,
    );
    const linkMap = this.viewer?.robotModel?.links || null;
    let stepIndex = 0;
    while (
      this.physicsAccumulatorSec >= this.physicsFixedTimeStepSec &&
      stepIndex < this.maxPhysicsCatchupSteps
    ) {
      const currentObstacleApproach = null;
      const currentClimbApproach = false;
      const obstacleHeadingYaw = this.extractYawFromQuaternion(
        this.body.rotation(),
      );
      const obstacleReferencePosition = this.body.translation();
      const obstaclePathControlActive = false;
      const predictedPosition = new THREE.Vector3(
        obstacleReferencePosition.x +
          targetVelocityX * this.physicsFixedTimeStepSec,
        obstacleReferencePosition.y +
          targetVelocityY * this.physicsFixedTimeStepSec,
        obstacleReferencePosition.z,
      );
      const willEnterObstacle =
        (keyboardState.isActive || throttleSign !== 0) &&
        this.isVehiclePathTouchingObstacle(
          obstacleReferencePosition,
          predictedPosition,
        );

      if (
        !willEnterObstacle &&
        (keyboardState.isActive || throttleSign !== 0)
      ) {
        const velocity = this.body.linvel();
        this.body.setLinvel(
          new this.rapier.Vector3(targetVelocityX, targetVelocityY, velocity.z),
          true,
        );
      }
      if (
        throttleSign !== 0 &&
        this.straightDriveWarmupSteps > 0 &&
        !this.isVehicleObstacleContact
      ) {
        Object.values(this.wheelBodiesByKey).forEach((wheelBody) => {
          if (!wheelBody) {
            return;
          }
          const velocity = wheelBody.linvel();
          wheelBody.setLinvel(
            new this.rapier.Vector3(
              targetVelocityX,
              targetVelocityY,
              velocity.z,
            ),
            true,
          );
        });
        this.straightDriveWarmupSteps -= 1;
      }

      if (
        throttleSign !== 0 &&
        Math.abs(effectiveSteerSign) < 1e-3 &&
        !this.isVehicleObstacleContact
      ) {
        this.stabilizeWheelBodiesForStraightDrive(
          targetVelocityX,
          targetVelocityY,
        );
      }

      if (!willEnterObstacle) {
        this.applyDriveForces(
          this.physicsFixedTimeStepSec,
          targetVelocityX,
          targetVelocityY,
          throttleSign,
          effectiveSteerSign,
          clampedSpeed,
          wheelGroundContactCount,
        );
      }
      this.applyGroundSupportForces(
        this.physicsFixedTimeStepSec,
        wheelGroundContactCount,
        willEnterObstacle,
      );
      this.syncObstacleColliderActivation(linkMap);

      this.physicsEngine.step(this.physicsFixedTimeStepSec);
      let hasObstacleContactNow =
        this.contactSolver.updateVehicleObstacleContact();
      const contactedObstacle =
        this.contactSolver.getApproachInfo()?.obstacleInfo || null;
      const isClimbingApproach =
        currentClimbApproach ||
        this.contactSolver.isClimbApproach(
          currentObstacleApproach?.obstacleInfo || null,
        );
      const obstacleInfoForClimb =
        this.contactSolver.getApproachInfo()?.obstacleInfo ||
        currentObstacleApproach?.obstacleInfo ||
        null;
      const isObstaclePathActive =
        this.contactSolver.isObstacleTraversalActive();
      this.isVehicleObstacleContact = Boolean(
        hasObstacleContactNow || isClimbingApproach || isObstaclePathActive,
      );
      if (Math.abs(effectiveSteerSign) < 1e-3) {
        this.preserveObstacleHeading(obstacleHeadingYaw);
        this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
        if (
          hasObstacleContactNow ||
          isClimbingApproach ||
          isObstaclePathActive
        ) {
          this.suppressObstacleLateralDrift(
            obstacleReferencePosition,
            obstacleHeadingYaw,
          );
          this.suppressObstacleLateralSlip();
        }
      }
      if (hasObstacleContactNow || isClimbingApproach || isObstaclePathActive) {
        this.postObstacleGroundRecoverRemainingSec = Math.max(
          Number(this.postObstacleGroundRecoverDurationSec) || 0,
          0,
        );
      } else {
        this.postObstacleGroundRecoverRemainingSec = Math.max(
          0,
          (Number(this.postObstacleGroundRecoverRemainingSec) || 0) -
            this.physicsFixedTimeStepSec,
        );
      }
      const resolvedInterpenetration =
        this.resolveVehicleObstacleInterpenetration();
      if (resolvedInterpenetration) {
        hasObstacleContactNow =
          this.contactSolver.updateVehicleObstacleContact();
      }
      if (hasObstacleContactNow && obstacleApproach?.obstacleInfo) {
        this.applyObstacleContactImpulse(
          this.physicsFixedTimeStepSec,
          obstacleApproach.obstacleInfo,
        );
      }
      if (hasObstacleContactNow || isClimbingApproach || isObstaclePathActive) {
        this.contactSolver.applyClimbLift(
          obstacleInfoForClimb,
          this.physicsFixedTimeStepSec,
        );
      } else {
        const velocity = this.body.linvel();
        const approachSpeed = Math.hypot(velocity.x, velocity.y);
        if (approachSpeed > 0.02) {
          this.body.setLinvel(
            new this.rapier.Vector3(
              velocity.x * 0.92,
              velocity.y * 0.92,
              velocity.z,
            ),
            true,
          );
        }
      }
      if (hasObstacleContactNow) {
        const velocity = this.body.linvel();
        const dampingFactor = 0.92;
        this.body.setLinvel(
          new this.rapier.Vector3(
            velocity.x * dampingFactor,
            velocity.y * dampingFactor,
            velocity.z,
          ),
          true,
        );
      }
      if (
        throttleSign !== 0 &&
        Math.abs(effectiveSteerSign) < 1e-3 &&
        !hasObstacleContactNow &&
        !isClimbingApproach &&
        !isObstaclePathActive
      ) {
        const velocity = this.body.linvel();
        this.preserveObstacleHeading(obstacleHeadingYaw);
        this.body.setLinvel(
          new this.rapier.Vector3(targetVelocityX, targetVelocityY, velocity.z),
          true,
        );
        this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
      }
      if (
        throttleSign !== 0 &&
        Math.abs(effectiveSteerSign) < 1e-3 &&
        !hasObstacleContactNow &&
        !isClimbingApproach &&
        !isObstaclePathActive &&
        this.straightDriveReferencePose
      ) {
        const position = this.body.translation();
        this.body.setTranslation(
          new this.rapier.Vector3(
            position.x,
            this.straightDriveReferencePose.y,
            this.straightDriveReferencePose.z,
          ),
          true,
        );
        this.preserveObstacleHeading(this.straightDriveReferencePose.yaw);
      }
      if (this.hasActivatedDynamicGroundClamp && !obstaclePathControlActive) {
        this.clampVehicleAboveGround();
      }
      this.renderer.syncVehicle();
      const adjustedByWheelClamp = hasObstacleContactNow
        ? this.enforceMeasuredWheelGroundLimit(linkMap)
        : false;
      if (adjustedByWheelClamp) {
        this.renderer.syncVehicle();
      }
      const adjustedByGroundReattach =
        this.settleVehicleToGroundAfterObstacle(linkMap);
      if (adjustedByGroundReattach) {
        this.renderer.syncVehicle();
      }
      const hasObstacleControlAfterStep = Boolean(
        hasObstacleContactNow ||
        isClimbingApproach ||
        isObstaclePathActive ||
        this.contactSolver.isObstacleTraversalActive(),
      );
      if (!hasObstacleControlAfterStep) {
        this.stabilizeFlatGroundVerticalMotion();
        this.enforceFlatGroundRideHeight();
      }
      this.renderer.syncVehicle();
      this.simulationElapsedSec += this.physicsFixedTimeStepSec;
      this.recordWheelZChartObstacleContactEvent(
        hasObstacleContactNow,
        this.simulationElapsedSec,
      );
      this.sampleWheelCenterZForChart(this.simulationElapsedSec);
      this.physicsAccumulatorSec -= this.physicsFixedTimeStepSec;
      stepIndex += 1;
    }

    const finalObstacleApproach = this.contactSolver.getApproachInfo();
    const finalObstacleContact =
      this.contactSolver.updateVehicleObstacleContact();
    if (
      finalObstacleContact ||
      this.contactSolver.isObstacleTraversalActive()
    ) {
      this.contactSolver.applyClimbLift(
        finalObstacleApproach?.obstacleInfo || null,
        this.physicsFixedTimeStepSec,
      );
    }

    if (
      keyboardState.isActive &&
      lockedRotation &&
      this.isBodyNearFlatGroundSupport()
    ) {
      this.body.setRotation(lockedRotation, true);
      this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
    }

    const hasObstacleContact =
      this.contactSolver.updateVehicleObstacleContact();
    const isClimbingApproachAfterStep = this.contactSolver.isClimbApproach(
      obstacleApproach?.obstacleInfo || null,
    );
    this.isVehicleObstacleContact = Boolean(
      hasObstacleContact || isClimbingApproachAfterStep,
    );
    if (this.isVehicleObstacleContact && Math.abs(effectiveSteerSign) < 1e-3) {
      this.preserveObstacleHeading();
      this.suppressObstacleLateralSlip();
      this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
    }
    if (this.keepUprightOnFlatGround) {
      this.setUprightRotationLockEnabled(!this.isVehicleObstacleContact);
    }

    this.maybeLogRuntimeDiagnostics(
      effectiveDeltaSec,
      driveViewer,
      clampedSpeed,
      throttleSign,
      steerSign,
      hasObstacleContact,
    );

    const hasMoveCommand = keyboardState.isActive || throttleSign !== 0;
    const contactedObstacle =
      this.contactSolver.getApproachInfo()?.obstacleInfo || null;
    const shouldBlockByObstacle =
      this.blockMotionOnObstacleContact &&
      hasObstacleContact &&
      this.isVelocityMovingTowardObstacle(
        contactedObstacle,
        commandedVelocityX,
        commandedVelocityY,
      );

    this.lowSpeedKinematicPosition = null;

    const isMoveCommandActive = keyboardState.isActive || throttleSign !== 0;
    if (isMoveCommandActive && shouldBlockByObstacle) {
      const currentVelocity = this.body.linvel();
      this.body.setLinvel(
        new this.rapier.Vector3(0, 0, currentVelocity.z),
        true,
      );
      this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
      ["fl", "fr", "rl", "rr"].forEach((wheelKey) => {
        if (typeof globalThis.setWheelAnimationByKey === "function") {
          globalThis.setWheelAnimationByKey(wheelKey, 0);
        }
      });
    }

    const shouldAssistLowSpeedForward =
      throttleSign !== 0 &&
      Math.abs(effectiveSteerSign) < 1e-3 &&
      clampedSpeed <= 0.2 &&
      !hasObstacleContact &&
      !isClimbingApproachAfterStep &&
      !this.contactSolver.isObstacleTraversalActive();
    if (shouldAssistLowSpeedForward) {
      const forwardX = targetVelocityX / Math.max(clampedSpeed, 1e-6);
      const forwardY = targetVelocityY / Math.max(clampedSpeed, 1e-6);
      const currentPosition = this.body.translation();
      const completedDistance =
        (currentPosition.x - frameStartPosition.x) * forwardX +
        (currentPosition.y - frameStartPosition.y) * forwardY;
      const targetDistance = clampedSpeed * effectiveDeltaSec;
      const remainingDistance = Math.max(
        targetDistance - Math.max(completedDistance, 0),
        0,
      );
      if (remainingDistance > 1e-6) {
        const assistedPosition = new THREE.Vector3(
          currentPosition.x + forwardX * remainingDistance,
          currentPosition.y + forwardY * remainingDistance,
          currentPosition.z,
        );
        if (
          !this.isVehiclePathTouchingObstacle(currentPosition, assistedPosition)
        ) {
          this.body.setTranslation(
            new this.rapier.Vector3(
              assistedPosition.x,
              assistedPosition.y,
              assistedPosition.z,
            ),
            true,
          );
          this.lowSpeedKinematicPosition = assistedPosition;
          this.lowSpeedPositionAssistDistanceMeters += remainingDistance;
        }
      }
    }

    this.constrainCenterTurnPivot();

    const nextPosition = this.body.translation();
    const nextRotation = this.body.rotation();

    this.carFrame.position.set(nextPosition.x, nextPosition.y, nextPosition.z);
    this.carFrame.quaternion
      .set(nextRotation.x, nextRotation.y, nextRotation.z, nextRotation.w)
      .normalize();
    if (this.activeObstacleTraversalPath && this.isObstacleTraversalActive()) {
      const traversalYaw = this.extractYawFromQuaternion(nextRotation);
      const traversalPitch = this.getObstacleTraversalPitch(
        this.activeObstacleTraversalPath,
      );
      const yawRotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        traversalYaw,
      );
      const pitchRotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        traversalPitch,
      );
      this.carFrame.quaternion
        .copy(yawRotation.multiply(pitchRotation))
        .normalize();
    }
    this.carFrame.updateMatrixWorld(true);
    this.syncVehicleYawIndicator();
    this.syncWheelRotationToBodyTravel();
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
    this.trimWheelZChartHistory(this.simulationElapsedSec);
    this.renderWheelZChart(this.simulationElapsedSec);

    this.updateDebugPanel(this.physicsFixedTimeStepSec);
    this.simulationLoop.schedule();
  }

  start() {
    this.initDebugPanel();
    this.initializeSpeedSliderPreference();
    this.initializeVisualSpeedSliderPreference();
    this.attachKeyboardControls();
    this.installDriveCommandHooks();
    this.syncInitialDriveStateFromUi();
    this.updateDebugPanel(this.debugStatusUpdateIntervalSec);
    this.simulationLoop.schedule();
  }

  resetUiStates() {
    this.togglePause(false);

    if (typeof window.setDriveMode === "function") {
      window.setDriveMode("stop");
    }

    this.resetRoadAttitude();

    const wheelKeys = ["fl", "fr", "rl", "rr"];
    wheelKeys.forEach((key) => {
      if (typeof window.setWheelAnimationByKey === "function") {
        window.setWheelAnimationByKey(key, 0);
      }
    });
  }

  resetRoadAttitude() {
    this.resetRoadRoll();
    this.resetRoadPitch();
  }

  resetRoadRoll() {
    if (typeof window.setRoadRollAngleDeg === "function") {
      window.setRoadRollAngleDeg(0);
    }

    const rollInput = document.getElementById("road-roll-angle-deg");
    if (rollInput) {
      rollInput.value = "0";
    }
  }

  resetRoadPitch() {
    if (typeof window.setRoadPitchAngleDeg === "function") {
      window.setRoadPitchAngleDeg(0);
    }

    const pitchInput = document.getElementById("road-pitch-angle-deg");
    if (pitchInput) {
      pitchInput.value = "0";
    }
  }

  resetPhysicalState() {
    if (
      !this.isReady ||
      !this.body ||
      !this.carFrame ||
      !this.rapier ||
      !this.initialPosition ||
      !this.initialQuaternion
    ) {
      return;
    }

    Object.keys(this.wheelZChartHistoryByKey).forEach((key) => {
      this.wheelZChartHistoryByKey[key] = [];
    });
    this.wheelZChartObstacleContactEvents = [];
    this.isWheelZChartObstacleContactActive = false;
    this.simulationElapsedSec = 0;
    this.wheelZChartHalfRangeCm = this.wheelZChartInitialHalfRangeCm;
    this.wheelZChartLastSampleTimeMs = null;
    Object.keys(this.wheelRadiusMetersByKey).forEach((key) => {
      this.wheelRadiusMetersByKey[key] = null;
    });
    Object.keys(this.wheelChartBaselineCenterZByKey).forEach((key) => {
      this.wheelChartBaselineCenterZByKey[key] = null;
    });

    this.hasLoggedGroundDiagnostics = false;

    this.body.setTranslation(
      new this.rapier.Vector3(
        this.initialPosition.x,
        this.initialPosition.y,
        this.initialPosition.z,
      ),
      true,
    );
    this.body.setRotation(this.initialQuaternion, true);
    this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
    this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
    this.isVehicleObstacleContact = false;
    this.obstacleColliderInfos.forEach((obstacleInfo) => {
      obstacleInfo.isContactHighlightLatched = false;
      obstacleInfo.contactHighlightPendingUntilMs = 0;
      this.setObstacleContactHighlight(obstacleInfo, false, true);
      if (
        obstacleInfo?.collider &&
        typeof obstacleInfo.collider.setSensor === "function"
      ) {
        obstacleInfo.collider.setSensor(Boolean(obstacleInfo.isSensor));
      }
      obstacleInfo.isSpatiallyOverlapping = false;
    });
    this.activeObstacleTraversalPath = null;
    this.hasActivatedSimulationMotion = false;
    this.hasActivatedDynamicGroundClamp = false;

    // On reset, always return to the URDF-authored pose without extra ground alignment offsets.
    this.renderer.syncVehicle();
    this.resetWheelBodiesFromVisual();
    this.resetWheelTravelTracking();
    this.syncWheelChartBaselineFromPhysics();
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

let rapierDriveSimulation = null;

const withSimulation = (action) => {
  if (!rapierDriveSimulation) {
    console.error("[URDF][Simulation] simulation is not initialized");
    return;
  }
  action(rapierDriveSimulation);
};

globalThis.resetSimulation = function () {
  withSimulation((simulation) => simulation.reset());
};

globalThis.resetSimulationSpeed = function () {
  withSimulation((simulation) => simulation.resetSpeedSliderToDefault());
};

globalThis.resetSimulationVisualSpeed = function () {
  withSimulation((simulation) => simulation.resetVisualSpeedSliderToDefault());
};

globalThis.resetSimulationAttitude = function () {
  withSimulation((simulation) => simulation.resetRoadAttitude());
};

globalThis.resetSimulationRoll = function () {
  withSimulation((simulation) => simulation.resetRoadRoll());
};

globalThis.resetSimulationPitch = function () {
  withSimulation((simulation) => simulation.resetRoadPitch());
};

globalThis.setSimulationDriveMode = function (mode) {
  withSimulation((simulation) => simulation.applyDriveModeCommand(mode));
};

globalThis.setSimulationDriveSpeedMps = function (mps) {
  withSimulation((simulation) => simulation.applyDriveSpeedCommandMps(mps));
};

globalThis.setSimulationDriveSpeedKmh = function (kmh) {
  withSimulation((simulation) => simulation.applyDriveSpeedCommandKmh(kmh));
};

globalThis.setSimulationVisualSpeed = function (scale) {
  withSimulation((simulation) =>
    simulation.applyVisualSpeedScale(
      simulation.getVisualSpeedScaleFromSliderValue(scale),
    ),
  );
};

try {
  rapierDriveSimulation = new RapierDriveSimulation();
  rapierDriveSimulation.start();
} catch (error) {
  console.error("[URDF][Simulation] startup failed:", error);
}
