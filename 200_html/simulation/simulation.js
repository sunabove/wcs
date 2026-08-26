import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";

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
// Chassis (0x0008) deliberately excludes ground (filter 0x0002); ground contact is handled by manual clamping.
const COLLISION_GROUP_GROUND = 0x00010002;
const COLLISION_GROUP_WHEEL = 0x00020005;
const COLLISION_GROUP_OBSTACLE = 0x0004000a;
const COLLISION_GROUP_CHASSIS = 0x00080004;

// Contacts are frictionless by design; drive/turn motion is imposed by velocity control, not tire friction.
const GROUND_COLLIDER_FRICTION = 0.0;
const WHEEL_COLLIDER_FRICTION = 0.0;
const OBSTACLE_COLLIDER_FRICTION = 0.05;

const VEHICLE_TRACK_WIDTH_FALLBACK_METERS = 0.64;
const OBSTACLE_RAMP_MIN_LENGTH_METERS = 0.45;
const OBSTACLE_RAMP_MAX_LENGTH_METERS = 0.65;
const OBSTACLE_RAMP_HALF_FORWARD_SCALE = 1.5;
const OBSTACLE_MAX_LATERAL_OFFSET_METERS = 0.8;
const OBSTACLE_MAX_TILT_DEG = 22;
const DYNAMIC_OBSTACLE_FORWARD_DISTANCE_METERS = 1;
const INITIAL_VEHICLE_CAMERA_OCCUPANCY = 0.8;
const SCENE_TREE_VISIBILITY_CHECK_INTERVAL_MS = 150;
// Safety cap on simultaneous trees so a degenerate camera/grid state can't spawn an
// unbounded row; normal on-screen counts stay far below this.
const SCENE_TREE_MAX_COUNT = 24;
// Single shared tone for the "COBOT SYSTEM" sign's plain faces (box edges/back) and its
// text texture's background, so the whole board reads as one uniform color.
const COBOT_SYSTEM_SIGN_BACKGROUND_COLOR = 0xf2ede2;
// Shared with the corner-screw placement below, so the screws can sit exactly between
// the texture's outer edge and its inner border rectangle instead of at an unrelated,
// hand-picked inset.
// "COBOT SYSTEM" at the texture's font measures ~369px wide / ~38px tall; text-to-border
// margin is (canvas - 2*borderMargin - text) / 2, so canvas = text/2 + borderMargin +
// oldCanvas/2 halves that margin while borderMargin (outer edge to border rect) is
// unchanged - 480x140 -> 440x105 per request.
const COBOT_SYSTEM_SIGN_TEXTURE_WIDTH_PX = 440;
const COBOT_SYSTEM_SIGN_TEXTURE_HEIGHT_PX = 105;
const COBOT_SYSTEM_SIGN_TEXTURE_BORDER_MARGIN_PX = 16;
// Half-width of the drivable ground built around the authored plate.
const GROUND_EXTENSION_HALF_SIZE_METERS = 100;
// Fog range - see addGroundSurfaceGrid() for why: the ground grid's lines converge
// toward the horizon over that 100m extension, and without fog to fade them out first,
// the perspective convergence stacks many semi-transparent lines into the same few
// screen pixels, reading as a bright hazy band instead of a horizon. The color must
// match the scene background urdfViewer.js sets (this.scene.background, currently
// 0x87ceeb) so faded-out geometry blends into it instead of fading to a visible tint.
const GROUND_FOG_COLOR = 0x87ceeb;
const GROUND_FOG_NEAR_METERS = 3;
const GROUND_FOG_FAR_METERS = 11;
// Carved pothole interior uses fixed contrasting colors so the pit shape stays readable.
// The floor (roughly horizontal, facing up into the cavity) and the walls (roughly
// vertical, the 4 faces bordering the undisturbed ground at the rim) get two distinct
// colors rather than one, so the cavity's shape reads clearly even head-on/top-down,
// where the walls barely catch any shading from lighting alone.
const GROUND_INTERIOR_FLOOR_COLOR = 0x243447;
const GROUND_INTERIOR_FLOOR_EMISSIVE = 0x0d141d;
const GROUND_INTERIOR_WALL_COLOR = 0x8a4a2e;
const GROUND_INTERIOR_WALL_EMISSIVE = 0x2a1509;
// Triangle normal |z| at/above this is classified as floor; below it, as wall.
const GROUND_INTERIOR_WALL_NORMAL_Z_THRESHOLD = 0.5;
// Cutter overshoot above the surface; coplanar faces make BSP CSG emit stray full-size polygons.
const CSG_CUTTER_OVERSHOOT_METERS = 0.01;
// How quickly the vehicle yaw-indicator pie's "start" reference heading catches up to
// the vehicle's actual current heading - see syncVehicleYawIndicator(). Smaller = the
// pie collapses to nothing faster once the vehicle stops turning; larger = it shows a
// longer "recent rotation" window.
const RECENT_YAW_INDICATOR_TIME_CONSTANT_SEC = 0.5;
// Lift below this is treated as flat ground.
const WHEEL_SUPPORT_MIN_LIFT_METERS = 0.0005;
// getWheelSupportProfile()'s 4-wheel ride-height plane fit is weighted by each sample's
// own lift (see there) so a climbing wheel pulls the plane toward itself instead of being
// averaged down by still-grounded wheels - a sharp-edged obstacle's flat top isn't
// reachable by an unweighted plane through points that include ground-level wheels, which
// left the climbing wheel visibly short of the obstacle surface. Weight per meter of lift;
// a wheel sitting on a ~0.06m step gets roughly triple a grounded wheel's pull.
const WHEEL_SUPPORT_LIFT_WEIGHT_PER_METER = 35;
// Obstacle-impact wheel flex: peak lateral kick applied to inner_wheel_*_joint the instant a wheel
// first touches an obstacle, eased back to 0 as the wheel climbs up onto it.
const WHEEL_OBSTACLE_FLEX_PEAK_RAD = THREE.MathUtils.degToRad(45);
const WHEEL_OBSTACLE_FLEX_SMOOTHING_HZ = 12;

const WHEEL_RPM_COMMAND_THRESHOLD = 0.2;
const STEER_SIGN_EPSILON = 1e-3;
const DRIVE_TRACTION_SCALE_AIRBORNE = 0.35;
const DRIVE_ACCEL_IMPULSE_BASE = 0.25;
const DRIVE_ACCEL_IMPULSE_SPEED_GAIN = 0.08;
const DRIVE_ACCEL_IMPULSE_MIN = 0.3;
const DRIVE_DRAG_BASE = 0.08;
const DRIVE_DRAG_SPEED_GAIN = 0.08;
const DRIVE_DRAG_MAX = 0.22;
const DRIVE_IDLE_DRAG_SCALE = 0.04;
const DRIVE_STEERING_TORQUE_SCALE = 0.012;
const DRIVE_YAW_DAMPING_SCALE = 0.06;
const DRIVE_FREE_ROLL_DECAY = 0.92;

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

  preserveHeading(yaw = null) {
    this.runtime.preserveObstacleHeading(yaw);
  }
}

class VehicleController {
  constructor(runtime) {
    this.runtime = runtime;
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
    // Steering-axis (vertical) joint on each wheel's swing knuckle; driven only for the
    // obstacle-impact flex effect below, not for actual steering.
    this.innerWheelJointNameByKey = {
      fl: "inner_wheel_fl_joint",
      fr: "inner_wheel_fr_joint",
      rl: "inner_wheel_rl_joint",
      rr: "inner_wheel_rr_joint",
    };
    this.wheelObstacleFlexAngleRadByKey = {
      fl: 0,
      fr: 0,
      rl: 0,
      rr: 0,
    };
    this.previousWheelColliderPositionByKey = {};
    this.groundColliders = [];
    this.vehicleColliderLocalCenter = new THREE.Vector3(0, 0, 0);
    this.vehicleColliderHalfExtents = { x: 0.1, y: 0.1, z: 0.1 };
    this.obstacleColliders = [];
    this.obstacleColliderInfos = [];
    this.activeObstacleTraversalPath = null;
    this.isVehicleObstacleContact = false;
    this.carFrame = null;
    this.vehicleDirectionArrowGroup = null;
    this.wheelGroundContactMarkerGroup = null;
    this.wheelGroundContactMarkerByKey = {};
    this.vehicleYawIndicatorGroup = null;
    this.vehicleYawPieMesh = null;
    // The pie's "start"/zero-angle reference heading - continuously chases the
    // vehicle's actual current heading (see syncVehicleYawIndicator()), rather than
    // staying pinned to wherever the vehicle started.
    this.vehicleYawTrailingRad = null;
    this.vehicleYawIndicatorLastSyncMs = null;
    this.cameraFollowPreviousVehiclePosition = null;
    this.hasFitInitialVehicleCamera = false;
    this.isInitialVehicleCameraFitScheduled = false;
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
    this.groundGridPatches = null;
    this.groundExtensionGroup = null;
    // Pool of trees currently on screen, keyed by their lattice X (fixed string key so
    // float rounding can't create duplicate slots). Reused/cloned from sceneTreeTemplate.
    this.sceneTreeGroupsByLatticeX = new Map();
    this.sceneTreeTemplate = null;
    // Snapshot of the ground grid's phase origin, taken once per addGroundSurfaceGrid()
    // call (load/reset) - see the comment there for why this must not track the vehicle.
    this.sceneTreeGridOriginX = null;
    this.sceneTreeGridOriginY = null;
    this.sceneTreeLastVisibilityCheckAtMs = 0;
    // Single static "COBOT SYSTEM" ground marker - see addGroundSurfaceGrid() /
    // ensureCobotSystemSign().
    this.cobotSystemSignGroup = null;
    this.cobotSystemSignPosition = null;
    this.extensionPotholeLinerGroup = null;
    this.dynamicPotholeRegion = null;
    this.isDynamicObstacleRemovalRequested = false;
    this.isRemovingPassedDynamicObstacles = false;
    this.authoredPotholeTemplate = null;
    this.groundVisualSourceByMesh = new Map();
    this.groundVisualMaterialSourceByMesh = new Map();
    this.groundExtensionMaterial = null;
    this.authoredGroundRect = null;
    this.groundInteriorMaterialBySource = null;
    this.hasCarvedGroundVisual = false;
    this.holeRegions = [];
    this.urdfObstacleLinkPrefix = "obstacle_";
    this.passUnderObstacleNamePatterns = [/pass_under/i, /underbody/i];
    this.maxSpeedMps = 100 / 3.6;
    this.maxYawRateRad = THREE.MathUtils.degToRad(25);
    this.centerTurnYawRateScale = 1;
    this.enableWheelPhysicsColliders = true;
    this.keepUprightOnFlatGround = true;
    this.isUprightRotationLockActive = false;
    this.groundPenetrationToleranceMeters = 0.003;
    this.flatGroundSnapDistanceMeters = 0.01;
    this.flatGroundVerticalVelocitySnapThresholdMps = 0.35;
    this.lastWheelSupportProfile = null;
    this.isInitializing = false;
    this.isReady = false;
    this.hasFailed = false;
    this.lastStepTimeMs = 0;
    this.physicsAccumulatorSec = 0;
    this.physicsFixedTimeStepSec = 1 / 90;
    this.lastVelocitySnapshot = null;
    this.contactStrengthMetric = 0;
    this.accelerationMetric = 0;
    this.maxPhysicsCatchupSteps = 12;
    this.hasLoggedGroundDiagnostics = false;
    this.enableRuntimeDiagnostics = true;
    this.runtimeDiagnosticsIntervalSec = 1;
    this.runtimeDiagnosticsElapsedSec = 0;
    this.debugStatusElapsedSec = 0;
    this.commandedDriveMode = "stop";
    this.commandedSpeedMps = SIM_SPEED_DEFAULT_MPS;
    this.hasInstalledCommandButtonFlash = false;
    this.centerTurnPivotWorld = null;
    this.centerTurnPivotLocal = null;
    this.isPaused = false;
    this.hasInstalledDriveCommandHooks = false;
    this.hasActivatedSimulationMotion = false;
    this.hasActivatedDynamicGroundClamp = false;
    this.visualSpeedScale = SIM_VISUAL_SPEED_DEFAULT_SCALE;
    this.wheelVisualRotationDirectionByKey = {
      fl: -1,
      fr: -1,
      rl: -1,
      rr: -1,
    };
    this.isWheelRotationStopped = false;
    this.isWheelRotationDrivenByCommand = false;
    // Snapshot of per-wheel visual RPM taken when pausing, restored on resume; see togglePause().
    this.pausedWheelSpeedRpmByKey = null;
    this.isDriveStartPreparationPending = false;
    this.straightDriveReferencePose = null;
    this.straightDriveWarmupSteps = 0;
    this.lastDriveCommandState = {
      throttleSign: 0,
      steerSign: 0,
      hasMoveCommand: false,
    };
    this.debugPanelElement = null;
    this.sliderTickTooltipElement = null;
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
    this.wheelZChartWindowSec = 5;
    this.simulationElapsedSec = 0;
    this.wheelZChartInitialHalfRangeCm = WHEEL_Z_CHART_INITIAL_HALF_RANGE_CM;
    this.wheelZChartHalfRangeCm = WHEEL_Z_CHART_INITIAL_HALF_RANGE_CM;
    this.wheelZChartObstacleContactEvents = [];
    this.isWheelZChartObstacleContactActive = false;
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
    title.textContent = "Wheel Bottom Height";

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
    // Steps/rocks get a scripted per-wheel ramp profile (activeObstacleTraversalPath,
    // built from obstacleColliderInfos below) that gives each wheel its own target Z
    // as a smooth function of how far *that wheel* is along the ramp - which is why the
    // 4-wheel chart visibly differs while crossing one (front and rear wheels are at
    // different points on the ramp at any given moment). getObstacleTraversalPath()
    // only ever builds that profile from obstacleColliderInfos (raised obstacles); holes
    // have no equivalent, so without this, the chart fell back to each wheel's raw
    // rigid-body position here - which barely differs between wheels, since the chassis
    // moves as one rigid body and a hole under only one or two wheels doesn't, on its
    // own, change just those wheels' *reported* world position. getWheelSupportProfile()
    // already computes each wheel's own pit-floor/edge support target independently
    // (supportZByKey) the same way the obstacle ramp does for steps - reuse it below so
    // a hole shows up as a per-wheel difference on the chart too.
    const wheelSupportProfile = this.isVehicleOverHoleRegion()
      ? this.getWheelSupportProfile()
      : null;

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
        } else if (wheelSupportProfile) {
          const wheelSupportZ =
            wheelSupportProfile.supportZByKey?.[wheelKey];
          // supportZByKey only ever moves a wheel *down* from groundZ (the hole branch
          // in getWheelSupportProfile() is a running Math.min against groundZ), so
          // "below groundZ" reliably means the hole logic actually engaged for this
          // particular wheel. Gate on that instead of applying it to every wheel
          // unconditionally: a wheel nowhere near the hole would otherwise get pinned to
          // a flat groundZ here and lose whatever real chassis tilt the physics body
          // actually has from the *other* wheel(s) that are in the hole.
          if (Number.isFinite(wheelSupportZ) && wheelSupportZ < this.groundZ) {
            // supportZByKey holds each wheel's own contact/floor target - i.e. wheel
            // *bottom* height, matching the obstacle-ramp branch above's convention -
            // so add the radius back to get a comparable wheel-center Z.
            chartCenterWorldZ = wheelSupportZ + wheelRadiusMeters;
          }
        }

        const measuredWheelBottomHeight =
          chartCenterWorldZ - wheelRadiusMeters - this.groundZ;
        const wheelBottomHeight = this.isVehicleOverHoleRegion()
          ? measuredWheelBottomHeight
          : Math.max(measuredWheelBottomHeight, 0);
        if (!Number.isFinite(wheelBottomHeight)) {
          return;
        }

        const wheelHistory = this.wheelZChartHistoryByKey[wheelKey];
        const latestSample = wheelHistory[wheelHistory.length - 1];
        const sample = {
          t: nowSec,
          z: wheelBottomHeight,
        };
        if (latestSample && Math.abs(latestSample.t - nowSec) < 1e-6) {
          wheelHistory[wheelHistory.length - 1] = sample;
        } else {
          wheelHistory.push(sample);
        }
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
      // Matches the actual URDF link name (obstacle_rock_1, no leading zero) - the old
      // "obstacle_rock_01" never matched anything, so this debug field always read n/a.
      const obstacleRock01TopZ = this.getObstacleTopZByName("obstacle_rock_1");
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
          obstacleInfo?.hasChassisProximity === true,
      );
      const contactedWheelKeys =
        contactedObstacle?.contactedWheelKeys?.join(",") || "n/a";
      const hasChassisProximity =
        contactedObstacle?.hasChassisProximity === true;
      const gap =
        Number.isFinite(wheelContactPlaneZ) &&
        Number.isFinite(obstacleRock01TopZ)
          ? wheelContactPlaneZ - obstacleRock01TopZ
          : null;

      obstacleSummary = `wheelPlaneZ=${Number.isFinite(wheelContactPlaneZ) ? wheelContactPlaneZ.toFixed(3) : "n/a"} rock01TopZ=${Number.isFinite(obstacleRock01TopZ) ? obstacleRock01TopZ.toFixed(3) : "n/a"} climb=${approachObstacle?.linkName || "n/a"} targetZ=${Number.isFinite(climbTargetZ) ? climbTargetZ.toFixed(3) : "n/a"} contactObstacle=${contactedObstacle?.linkName || "n/a"} contactWheels=${contactedWheelKeys} chassisProximity=${hasChassisProximity ? "Y" : "N"} path=${traversalPathActive ? "Y" : "N"} pathName=${traversalPathName} pathZ=${Number.isFinite(traversalTargetZ) ? traversalTargetZ.toFixed(3) : "n/a"} underbodyGap=${Number.isFinite(gap) ? gap.toFixed(3) : "n/a"}`;
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

      metricsSummary = `metrics: contact=${contactStrengthMetric.toFixed(2)} accel=${this.accelerationMetric.toFixed(2)} throttle=${this.lastDriveCommandState.throttleSign} steer=${this.lastDriveCommandState.steerSign} move=${this.lastDriveCommandState.hasMoveCommand ? "Y" : "N"}`;
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

    let hasHookedDriveMode = typeof globalThis.setDriveMode !== "function";
    let hasHookedDriveSpeed = typeof globalThis.setDriveSpeedKmh !== "function";

    const originalSetDriveMode = globalThis.setDriveMode;
    if (typeof originalSetDriveMode === "function") {
      globalThis.setDriveMode = (mode) => {
        this.commandedDriveMode = String(mode || "stop");
        return originalSetDriveMode(mode);
      };
      hasHookedDriveMode = true;
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
      hasHookedDriveSpeed = true;
    }

    // Keep retrying on later frames until every available command function is wrapped.
    this.hasInstalledDriveCommandHooks =
      hasHookedDriveMode && hasHookedDriveSpeed;
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

    if (this.carFrame) {
      this.syncCarFrameFromBody();
    }
    this.sampleWheelCenterZForChart(this.simulationElapsedSec);
  }

  stopWheelRotation() {
    this.isWheelRotationStopped = true;
    const viewer = this.getDriveSourceViewer();
    if (typeof viewer?.setWheelRotationDrivenByTravel === "function") {
      viewer.setWheelRotationDrivenByTravel(false);
    }
    ["fl", "fr", "rl", "rr"].forEach((key) => {
      if (typeof globalThis.setWheelAnimationByKey === "function") {
        globalThis.setWheelAnimationByKey(key, 0);
      }
    });
  }

  applyDriveModeCommand(mode) {
    const normalizedMode = String(mode || "stop");
    if (normalizedMode !== "stop" && this.isDriveStartPreparationPending) {
      this.isDriveStartPreparationPending = false;
      this.stopWheelRotation();
      this.resetWheelBodiesFromVisual();
      this.resetWheelTravelTracking();
      requestAnimationFrame(() => this.applyDriveModeCommand(normalizedMode));
      return;
    }
    if (normalizedMode !== "stop") {
      this.isWheelRotationStopped = false;
      // A drive command resumes a paused simulation instead of being swallowed by it.
      this.togglePause(false);
    }
    const hasDriveModeChanged = this.commandedDriveMode !== normalizedMode;
    this.commandedDriveMode = normalizedMode;
    if (hasDriveModeChanged) {
      this.lastStepTimeMs = 0;
      if (
        (normalizedMode === "forward" || normalizedMode === "backward") &&
        this.body
      ) {
        const position = this.body.translation();
        this.straightDriveReferencePose = {
          x: position.x,
          y: position.y,
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

    this.syncDriveModeButtonState();
  }

  syncDriveModeButtonState() {
    const buttonIdByMode = {
      forward: "drive-btn-forward",
      backward: "drive-btn-backward",
      left: "drive-btn-left",
      right: "drive-btn-right",
      stop: "drive-btn-stop",
    };
    const activeButtonId =
      buttonIdByMode[String(this.commandedDriveMode || "stop").toLowerCase()] ||
      null;

    Object.values(buttonIdByMode).forEach((buttonId) => {
      document
        .getElementById(buttonId)
        ?.classList.toggle("active", buttonId === activeButtonId);
    });
    document.getElementById("drive-btn-reset")?.classList.remove("active");
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
    const viewerById = window.urdfViewersById?.["vehicle-urdf-viewer"] || null;
    if (viewerById) {
      return viewerById;
    }

    if (Array.isArray(window.urdfViewers)) {
      const matched = window.urdfViewers.find((viewer) =>
        String(viewer?.urdfPath || "").includes("/urdf/model/"),
      );

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

  computeLinkLocalBounds(linkObject, linkMap) {
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
    const inverseLinkWorld = new THREE.Matrix4();
    let hasMesh = false;

    linkObject.updateWorldMatrix(true, true);
    inverseLinkWorld.copy(linkObject.matrixWorld).invert();

    linkObject.traverse((node) => {
      if (!node?.isMesh || !node.geometry) {
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

      const meshToLink = new THREE.Matrix4().multiplyMatrices(
        inverseLinkWorld,
        node.matrixWorld,
      );
      bounds.union(node.geometry.boundingBox.clone().applyMatrix4(meshToLink));
      hasMesh = true;
    });

    return hasMesh ? bounds : null;
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

  togglePause(forcePaused = null) {
    const nextPausedState =
      typeof forcePaused === "boolean" ? forcePaused : !this.isPaused;

    if (this.isPaused === nextPausedState) {
      return;
    }

    // Pause only freezes simulation time; the drive command is kept so resume continues it.
    this.isPaused = nextPausedState;
    this.lastStepTimeMs = 0;
    this.physicsAccumulatorSec = 0;

    // stepSimulation() (and the travel-driven wheel sync it triggers) is skipped while
    // paused, but the URDF viewer runs its own render loop and keeps spinning wheels from
    // their last commanded RPM every frame regardless. Freeze/restore that RPM explicitly
    // so the wheels actually stop when the simulation does.
    if (this.isPaused) {
      this.freezeWheelRotationForPause();
    } else {
      this.restoreWheelRotationAfterPause();
    }

    this.updateDebugPanel(this.debugStatusUpdateIntervalSec);
    this.syncPauseButtonState();
    console.log(`[URDF][Simulation] ${this.isPaused ? "Paused" : "Resumed"}`);
  }

  freezeWheelRotationForPause() {
    const viewer = this.getDriveSourceViewer();
    this.pausedWheelSpeedRpmByKey = viewer?.wheelSpeedRpmByKey
      ? { ...viewer.wheelSpeedRpmByKey }
      : null;

    ["fl", "fr", "rl", "rr"].forEach((key) => {
      if (typeof globalThis.setWheelAnimationByKey === "function") {
        globalThis.setWheelAnimationByKey(key, 0);
      }
    });
  }

  restoreWheelRotationAfterPause() {
    const savedRpmByKey = this.pausedWheelSpeedRpmByKey;
    this.pausedWheelSpeedRpmByKey = null;
    if (!savedRpmByKey) {
      return;
    }

    Object.entries(savedRpmByKey).forEach(([key, rpm]) => {
      if (typeof globalThis.setWheelAnimationByKey === "function") {
        globalThis.setWheelAnimationByKey(key, rpm);
      }
    });
  }

  handleSpaceShortcut() {
    const isDriveIdle =
      String(this.commandedDriveMode || "stop").toLowerCase() === "stop";
    if (!this.isPaused && isDriveIdle) {
      this.applyDriveModeCommand("forward");
      return;
    }

    this.togglePause();
  }

  syncPauseButtonState() {
    const pauseButton = document.getElementById("drive-btn-pause");
    if (!pauseButton) {
      return;
    }

    // Same length in both states so the button doesn't resize on toggle.
    pauseButton.textContent = this.isPaused ? "시뮬 재개" : "시뮬 정지";
    pauseButton.setAttribute("aria-pressed", this.isPaused ? "true" : "false");
    pauseButton.classList.toggle("active", this.isPaused);
  }

  // Reads the "controlKeyboard" attribute live (rather than caching it once) so keyboard
  // control reflects the container's current markup even if the viewer isn't ready yet
  // when the listener is first attached.
  isKeyboardControlEnabled() {
    const containerElement =
      this.viewer?.container || document.getElementById("vehicle-urdf-viewer");
    if (!containerElement) {
      return false;
    }

    return (
      String(containerElement.getAttribute("controlKeyboard") || "")
        .trim()
        .toLowerCase() === "true"
    );
  }

  attachKeyboardControls() {
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

        if (!this.isKeyboardControlEnabled()) {
          return;
        }

        const isSpaceKey =
          event.code === "Space" ||
          event.key === " " ||
          event.key === "Spacebar";
        if (isSpaceKey) {
          event.preventDefault();
          // Blur first so a focused control button cannot also activate on this key.
          if (
            typeof event.target?.blur === "function" &&
            event.target.closest?.("button")
          ) {
            event.target.blur();
          }
          if (event.ctrlKey) {
            this.reset();
          } else {
            this.handleSpaceShortcut();
          }
          return;
        }

        if (!handledKeys.has(event.key)) {
          return;
        }

        const nextDriveMode = driveModeByArrowKey[event.key] || null;
        if (nextDriveMode) {
          this.applyDriveModeCommand(nextDriveMode);
          event.preventDefault();
          return;
        }
      },
      { passive: false },
    );
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
    const authoredMinX =
      groundBounds && !groundBounds.isEmpty()
        ? groundBounds.min.x
        : -fallbackGroundSize * 0.5;
    const authoredMaxX =
      groundBounds && !groundBounds.isEmpty()
        ? groundBounds.max.x
        : fallbackGroundSize * 0.5;
    const authoredMinY =
      groundBounds && !groundBounds.isEmpty()
        ? groundBounds.min.y
        : -fallbackGroundSize * 0.5;
    const authoredMaxY =
      groundBounds && !groundBounds.isEmpty()
        ? groundBounds.max.y
        : fallbackGroundSize * 0.5;

    // Drivable area is extended far past the authored plate so edges never enter view.
    this.authoredGroundRect = {
      minX: authoredMinX,
      maxX: authoredMaxX,
      minY: authoredMinY,
      maxY: authoredMaxY,
    };
    const groundCenterX = (authoredMinX + authoredMaxX) * 0.5;
    const groundCenterY = (authoredMinY + authoredMaxY) * 0.5;
    const groundMinX = groundCenterX - GROUND_EXTENSION_HALF_SIZE_METERS;
    const groundMaxX = groundCenterX + GROUND_EXTENSION_HALF_SIZE_METERS;
    const groundMinY = groundCenterY - GROUND_EXTENSION_HALF_SIZE_METERS;
    const groundMaxY = groundCenterY + GROUND_EXTENSION_HALF_SIZE_METERS;

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

      // Engrave downward from the ground surface by the pothole's own height.
      const depthMeters = Math.max(holeBounds.max.z - holeBounds.min.z, 0.01);
      holeRegions.push({
        linkName: holeLinkName,
        minX: clampedMinX,
        maxX: clampedMaxX,
        minY: clampedMinY,
        maxY: clampedMaxY,
        depthMeters,
        floorZ: this.groundZ - depthMeters,
      });
    });

    this.authoredPotholeTemplate = holeRegions[0] || null;
    this.holeRegions = [];

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
    this.holeRegions.forEach((holeRegion) => {
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
        .setFriction(GROUND_COLLIDER_FRICTION)
        .setCollisionGroups(COLLISION_GROUP_GROUND)
        .setRestitution(0.0);
      // Ride height is imposed kinematically; solid ground walls would only stall the
      // vehicle against pothole edges at low speed.
      if (typeof groundColliderDesc.setSensor === "function") {
        groundColliderDesc.setSensor(true);
      }
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
      );
    });

    this.holeRegions.forEach((holeRegion) => {
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
      );
    });

    this.groundGridPatches = groundPatches;
    this.addGroundSurfaceExtension();
    void this.carveGroundVisualForHoles();
    this.addGroundSurfaceGrid(groundPatches);
  }

  addGroundSurfaceExtension() {
    const linkMap = this.viewer?.robotModel?.links || null;
    const groundLink =
      this.findLinkByName(linkMap, "ground") ||
      this.findLinkByName(linkMap, "ground_link") ||
      this.findLinkByName(linkMap, "ground_patch") ||
      null;
    const authoredRect = this.authoredGroundRect;
    if (!groundLink || !authoredRect) {
      return;
    }

    const authoredMesh = this.collectLinkOwnMeshes(groundLink, linkMap)[0];
    if (!authoredMesh) {
      return;
    }

    if (this.groundExtensionGroup?.parent) {
      this.groundExtensionGroup.parent.remove(this.groundExtensionGroup);
      this.groundExtensionGroup.geometry?.dispose();
    }

    // Single flat frame with the authored plate as a hole: no thickness, no overlap,
    // so there are no side faces or coplanar pairs to produce seams.
    const outerShape = new THREE.Shape();
    outerShape.moveTo(
      authoredRect.minX - GROUND_EXTENSION_HALF_SIZE_METERS,
      authoredRect.minY - GROUND_EXTENSION_HALF_SIZE_METERS,
    );
    outerShape.lineTo(
      authoredRect.maxX + GROUND_EXTENSION_HALF_SIZE_METERS,
      authoredRect.minY - GROUND_EXTENSION_HALF_SIZE_METERS,
    );
    outerShape.lineTo(
      authoredRect.maxX + GROUND_EXTENSION_HALF_SIZE_METERS,
      authoredRect.maxY + GROUND_EXTENSION_HALF_SIZE_METERS,
    );
    outerShape.lineTo(
      authoredRect.minX - GROUND_EXTENSION_HALF_SIZE_METERS,
      authoredRect.maxY + GROUND_EXTENSION_HALF_SIZE_METERS,
    );
    outerShape.closePath();

    const authoredHole = new THREE.Path();
    authoredHole.moveTo(authoredRect.minX, authoredRect.minY);
    authoredHole.lineTo(authoredRect.maxX, authoredRect.minY);
    authoredHole.lineTo(authoredRect.maxX, authoredRect.maxY);
    authoredHole.lineTo(authoredRect.minX, authoredRect.maxY);
    authoredHole.closePath();
    outerShape.holes.push(authoredHole);

    // Potholes outside the authored plate are cut straight into the frame.
    this.getHoleRegionsOutsideAuthoredPlate().forEach((holeRegion) => {
      const holePath = new THREE.Path();
      holePath.moveTo(holeRegion.minX, holeRegion.minY);
      holePath.lineTo(holeRegion.maxX, holeRegion.minY);
      holePath.lineTo(holeRegion.maxX, holeRegion.maxY);
      holePath.lineTo(holeRegion.minX, holeRegion.maxY);
      holePath.closePath();
      outerShape.holes.push(holePath);
    });

    const frameMesh = new THREE.Mesh(
      new THREE.ShapeGeometry(outerShape),
      this.getGroundExtensionMaterial(authoredMesh.material),
    );
    frameMesh.name = "simulation-ground-extension";
    frameMesh.position.copy(
      groundLink.worldToLocal(new THREE.Vector3(0, 0, this.groundZ)),
    );
    frameMesh.userData.isSimulationGeneratedGround = true;

    groundLink.add(frameMesh);
    this.groundExtensionGroup = frameMesh;
    this.rebuildExtensionPotholeLiners(groundLink, authoredMesh.material);
  }

  getHoleRegionsOutsideAuthoredPlate() {
    const authoredRect = this.authoredGroundRect;
    if (!authoredRect || !Array.isArray(this.holeRegions)) {
      return [];
    }

    return this.holeRegions.filter(
      (holeRegion) =>
        holeRegion.minX >= authoredRect.maxX ||
        holeRegion.maxX <= authoredRect.minX ||
        holeRegion.minY >= authoredRect.maxY ||
        holeRegion.maxY <= authoredRect.minY,
    );
  }

  rebuildExtensionPotholeLiners(groundLink, authoredMaterial) {
    if (this.extensionPotholeLinerGroup?.parent) {
      this.extensionPotholeLinerGroup.parent.remove(
        this.extensionPotholeLinerGroup,
      );
      this.extensionPotholeLinerGroup.traverse((node) =>
        node.geometry?.dispose(),
      );
    }

    const outsideRegions = this.getHoleRegionsOutsideAuthoredPlate();
    if (outsideRegions.length === 0) {
      this.extensionPotholeLinerGroup = null;
      return;
    }

    const floorMaterial = this.getGroundInteriorMaterial(authoredMaterial, "floor");
    const wallMaterial = this.getGroundInteriorMaterial(authoredMaterial, "wall");
    const linerGroup = new THREE.Group();
    linerGroup.name = "simulation-extension-pothole-liners";
    linerGroup.userData.isSimulationGeneratedGround = true;

    outsideRegions.forEach((holeRegion) => {
      const width = holeRegion.maxX - holeRegion.minX;
      const depth = holeRegion.maxY - holeRegion.minY;
      const pitDepth = Math.max(Number(holeRegion.depthMeters) || 0, 0.001);
      const centerX = (holeRegion.minX + holeRegion.maxX) * 0.5;
      const centerY = (holeRegion.minY + holeRegion.maxY) * 0.5;

      // Floor plus four walls; the frame already provides the opening at the top.
      const faces = [
        {
          size: [width, depth],
          position: [centerX, centerY, this.groundZ - pitDepth],
          rotateX: 0,
          rotateZ: 0,
          material: floorMaterial,
        },
        {
          size: [width, pitDepth],
          position: [centerX, holeRegion.minY, this.groundZ - pitDepth * 0.5],
          rotateX: Math.PI / 2,
          rotateZ: 0,
          material: wallMaterial,
        },
        {
          size: [width, pitDepth],
          position: [centerX, holeRegion.maxY, this.groundZ - pitDepth * 0.5],
          rotateX: Math.PI / 2,
          rotateZ: 0,
          material: wallMaterial,
        },
        {
          size: [depth, pitDepth],
          position: [holeRegion.minX, centerY, this.groundZ - pitDepth * 0.5],
          rotateX: Math.PI / 2,
          rotateZ: Math.PI / 2,
          material: wallMaterial,
        },
        {
          size: [depth, pitDepth],
          position: [holeRegion.maxX, centerY, this.groundZ - pitDepth * 0.5],
          rotateX: Math.PI / 2,
          rotateZ: Math.PI / 2,
          material: wallMaterial,
        },
      ];

      faces.forEach((face) => {
        const geometry = new THREE.PlaneGeometry(face.size[0], face.size[1]);
        geometry.rotateX(face.rotateX);
        geometry.rotateZ(face.rotateZ);
        const faceMesh = new THREE.Mesh(geometry, face.material);
        faceMesh.position.copy(
          groundLink.worldToLocal(new THREE.Vector3(...face.position)),
        );
        faceMesh.userData.isSimulationGeneratedGround = true;
        linerGroup.add(faceMesh);
      });
    });

    groundLink.add(linerGroup);
    this.extensionPotholeLinerGroup = linerGroup;
  }

  addPotholeRegion(centerX, centerY, sizeX, sizeY, depthMeters) {
    const halfX = Math.max(Number(sizeX) || 0, 0.01) * 0.5;
    const halfY = Math.max(Number(sizeY) || 0, 0.01) * 0.5;
    const depth = Math.max(Number(depthMeters) || 0, 0.01);
    if (!Array.isArray(this.holeRegions)) {
      this.holeRegions = [];
    }

    // Wheel support reads holeRegions every substep, so driving reacts immediately.
    this.holeRegions.push({
      linkName: null,
      minX: centerX - halfX,
      maxX: centerX + halfX,
      minY: centerY - halfY,
      maxY: centerY + halfY,
      depthMeters: depth,
      floorZ: this.groundZ - depth,
      isRecessed: true,
    });

    this.addGroundSurfaceExtension();
    return true;
  }

  getGroundExtensionMaterial(authoredMaterial) {
    if (this.groundExtensionMaterial) {
      return this.groundExtensionMaterial;
    }

    const material = authoredMaterial?.clone
      ? authoredMaterial.clone()
      : new THREE.MeshStandardMaterial();
    // Opaque so the far field reads as solid ground instead of showing the sky through it.
    material.transparent = false;
    material.opacity = 1;
    material.side = THREE.DoubleSide;
    material.name = "ground_extension_mat";

    this.groundExtensionMaterial = material;
    return material;
  }

  collectLinkOwnMeshes(linkObject, linkMap) {
    if (!linkObject) {
      return [];
    }

    const otherLinkRoots = Object.values(linkMap || {}).filter(
      (root) =>
        root &&
        root !== linkObject &&
        this.isDescendantObject3D(root, linkObject),
    );
    const meshes = [];
    linkObject.updateWorldMatrix(true, true);
    linkObject.traverse((node) => {
      if (!node?.isMesh || !node.geometry) {
        return;
      }

      // Meshes this class generated are not authored URDF geometry.
      if (node.userData?.isSimulationGeneratedGround) {
        return;
      }
      const belongsToOtherLink = otherLinkRoots.some(
        (root) => node === root || this.isDescendantObject3D(node, root),
      );
      if (!belongsToOtherLink) {
        meshes.push(node);
      }
    });

    return meshes;
  }

  // role: "floor" (default, roughly horizontal cavity bottom) or "wall" (the 4 roughly
  // vertical faces bordering the undisturbed ground at the rim) - each gets its own
  // fixed, distinct color so the pit's shape reads clearly even head-on/top-down.
  getGroundInteriorMaterial(surfaceMaterial, role = "floor") {
    if (!this.groundInteriorMaterialBySource) {
      this.groundInteriorMaterialBySource = new Map();
    }
    let byRole = this.groundInteriorMaterialBySource.get(surfaceMaterial);
    if (!byRole) {
      byRole = new Map();
      this.groundInteriorMaterialBySource.set(surfaceMaterial, byRole);
    }
    const cached = byRole.get(role);
    if (cached) {
      return cached;
    }

    const interiorMaterial = surfaceMaterial?.clone
      ? surfaceMaterial.clone()
      : new THREE.MeshStandardMaterial();
    const color =
      role === "wall" ? GROUND_INTERIOR_WALL_COLOR : GROUND_INTERIOR_FLOOR_COLOR;
    const emissive =
      role === "wall"
        ? GROUND_INTERIOR_WALL_EMISSIVE
        : GROUND_INTERIOR_FLOOR_EMISSIVE;
    if (interiorMaterial.color) {
      interiorMaterial.color.setHex(color);
    }
    if (interiorMaterial.emissive) {
      // Keeps the pit readable when it falls into shadow.
      interiorMaterial.emissive.setHex(emissive);
    }
    interiorMaterial.transparent = false;
    interiorMaterial.opacity = 1;
    // Cut walls are viewed from inside the slab, so both faces must render.
    interiorMaterial.side = THREE.DoubleSide;
    interiorMaterial.name = `ground_interior_${role}_mat`;

    byRole.set(role, interiorMaterial);
    return interiorMaterial;
  }

  /**
   * Returns a closed (watertight) copy of a hole/cutter geometry, built as the
   * convex hull of its own vertices. See the call site in
   * carveGroundVisualForHoles() for why an open source mesh isn't safe to feed
   * straight into a CSG boolean.
   */
  buildClosedCutterGeometry(sourceGeometry) {
    const positionAttribute = sourceGeometry.getAttribute("position");
    if (!positionAttribute || positionAttribute.count < 4) {
      return sourceGeometry.clone();
    }

    const points = [];
    const vertex = new THREE.Vector3();
    for (let i = 0; i < positionAttribute.count; i += 1) {
      vertex.fromBufferAttribute(positionAttribute, i);
      points.push(vertex.clone());
    }

    try {
      return new ConvexGeometry(points);
    } catch (error) {
      console.warn(
        "[URDF][Simulation] convex-hull cutter build failed; using the source hole geometry as-is (CSG result may be unreliable if it isn't watertight):",
        error,
      );
      return sourceGeometry.clone();
    }
  }

  extendCutterAboveSurface(cutterGeometry) {
    cutterGeometry.computeBoundingBox();
    const bounds = cutterGeometry.boundingBox;
    if (!bounds) {
      return;
    }

    const height = bounds.max.z - bounds.min.z;
    if (height <= 1e-6) {
      return;
    }

    // Grow only upward, keeping the pit floor exactly where the geometry defines it.
    const scaleZ = (height + CSG_CUTTER_OVERSHOOT_METERS) / height;
    // Snapshot into a primitive before touching the geometry: BufferGeometry.translate()/
    // .scale() both route through applyMatrix4(), which - once boundingBox has been computed
    // once (it just was, above) - silently recomputes `this.boundingBox` in place on every
    // call. `bounds` is a live reference to that same object, so reading `bounds.min.z` again
    // for the final translate (after the geometry has already been shifted and scaled) would
    // pick up the *new*, already-transformed floor position instead of the original one -
    // leaving the cutter mistranslated back to roughly its pre-extend position (floating at
    // the surface instead of embedded in the ground) and making the CSG subtract that follows
    // a near no-op, which is what let the whole ground keep rendering as one flat material.
    const minZ = bounds.min.z;
    cutterGeometry.translate(0, 0, -minZ);
    cutterGeometry.scale(1, 1, scaleZ);
    cutterGeometry.translate(0, 0, minZ);
  }

  /**
   * Splits a cutter geometry's own triangles into two groups by face normal - "wall"
   * (materialIndex 1, roughly vertical faces) and "floor" (materialIndex 2, roughly
   * horizontal ones) - so the cavity surface the CSG subtract in carveGroundVisualForHoles()
   * derives from this cutter keeps that same split instead of one flat interior color.
   * Mutates cutterGeometry in place (adds an index and .groups); safe to call on both the
   * STL-derived convex hull and a plain box cutter.
   */
  classifyCutterFacesByWallOrFloor(cutterGeometry) {
    const positionAttribute = cutterGeometry.getAttribute("position");
    if (!positionAttribute) {
      return;
    }

    // Work per-triangle-vertex, independent of whether the geometry is indexed, matching
    // how CSG.fromGeometry() itself walks the geometry.
    const sourceIndex = cutterGeometry.index
      ? cutterGeometry.index.array
      : null;
    const triangleCount = sourceIndex
      ? sourceIndex.length / 3
      : positionAttribute.count / 3;

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const wallIndices = [];
    const floorIndices = [];

    for (let t = 0; t < triangleCount; t += 1) {
      const i0 = sourceIndex ? sourceIndex[t * 3] : t * 3;
      const i1 = sourceIndex ? sourceIndex[t * 3 + 1] : t * 3 + 1;
      const i2 = sourceIndex ? sourceIndex[t * 3 + 2] : t * 3 + 2;
      a.fromBufferAttribute(positionAttribute, i0);
      b.fromBufferAttribute(positionAttribute, i1);
      c.fromBufferAttribute(positionAttribute, i2);
      const normalZ = b
        .clone()
        .sub(a)
        .cross(c.clone().sub(a))
        .normalize().z;
      const bucket =
        Math.abs(normalZ) >= GROUND_INTERIOR_WALL_NORMAL_Z_THRESHOLD
          ? floorIndices
          : wallIndices;
      bucket.push(i0, i1, i2);
    }

    cutterGeometry.setIndex(wallIndices.concat(floorIndices));
    cutterGeometry.clearGroups();
    cutterGeometry.addGroup(0, wallIndices.length, 1);
    cutterGeometry.addGroup(wallIndices.length, floorIndices.length, 2);
  }

  async carveGroundVisualForHoles(forceRebuild = false) {
    const linkMap = this.viewer?.robotModel?.links || null;
    const groundLink =
      this.findLinkByName(linkMap, "ground") ||
      this.findLinkByName(linkMap, "ground_link") ||
      this.findLinkByName(linkMap, "ground_patch") ||
      null;
    if (!groundLink || !Array.isArray(this.holeRegions)) {
      return;
    }

    const groundMeshes = this.collectLinkOwnMeshes(groundLink, linkMap);
    if (groundMeshes.length === 0) {
      return;
    }

    groundMeshes.forEach((groundMesh) => {
      if (!this.groundVisualSourceByMesh.has(groundMesh)) {
        this.groundVisualSourceByMesh.set(
          groundMesh,
          groundMesh.geometry.clone(),
        );
        this.groundVisualMaterialSourceByMesh.set(
          groundMesh,
          groundMesh.material,
        );
      }
      if (forceRebuild) {
        groundMesh.geometry.dispose();
        groundMesh.geometry = this.groundVisualSourceByMesh
          .get(groundMesh)
          .clone();
        groundMesh.material =
          this.groundVisualMaterialSourceByMesh.get(groundMesh);
      }
    });
    if (this.holeRegions.length === 0) {
      this.hasCarvedGroundVisual = false;
      return;
    }
    if (this.hasCarvedGroundVisual && !forceRebuild) {
      return;
    }

    // Recess first so the subtracted volume sits exactly where the pit should be.
    this.recessHoleObstacleVisuals(linkMap);

    try {
      const csgModule = await import("three-csg-ts");
      const CSG = csgModule?.CSG || csgModule?.default?.CSG || null;
      if (
        !CSG ||
        typeof CSG.fromMesh !== "function" ||
        typeof CSG.toMesh !== "function"
      ) {
        throw new Error("three-csg-ts CSG API not available");
      }

      const holeMeshesByRegion = this.holeRegions.map((holeRegion) => {
        const holeLink = holeRegion.linkName
          ? this.findLinkByName(linkMap, holeRegion.linkName)
          : null;
        return this.collectLinkOwnMeshes(holeLink, linkMap);
      });

      groundMeshes.forEach((groundMesh) => {
        const surfaceMaterial = Array.isArray(groundMesh.material)
          ? groundMesh.material[0]
          : groundMesh.material;
        const floorMaterial = this.getGroundInteriorMaterial(
          surfaceMaterial,
          "floor",
        );
        const wallMaterial = this.getGroundInteriorMaterial(
          surfaceMaterial,
          "wall",
        );

        groundMesh.updateWorldMatrix(true, false);
        const groundWorldInverse = new THREE.Matrix4()
          .copy(groundMesh.matrixWorld)
          .invert();
        let carvedGeometry = groundMesh.geometry.clone();
        // Tracks whether the next subtract is the very first one, explicitly - see the
        // baseObjectIndex comment below for why this can't be inferred from
        // carvedGeometry.groups.length.
        let isFirstSubtract = true;

        holeMeshesByRegion.forEach((holeMeshes) => {
          holeMeshes.forEach((holeMesh) => {
            holeMesh.updateWorldMatrix(true, false);
            // Both operands share the ground mesh's local frame so identity matrices are valid for CSG.
            const openHoleGeometry = holeMesh.geometry
              .clone()
              .applyMatrix4(
                new THREE.Matrix4().multiplyMatrices(
                  groundWorldInverse,
                  holeMesh.matrixWorld,
                ),
              );
            // An authored hole mesh isn't guaranteed to be a closed, watertight solid -
            // e.g. pothole.STL is only the 6 side walls of a hexagonal prism (12
            // triangles, exactly 2 per side, no top/bottom cap). An open shell isn't a
            // valid CSG operand: the BSP inside/outside classification the boolean
            // subtract relies on breaks down on it, and can misclassify most of the
            // *ground* itself as "inside" the cutter - which is what made the whole
            // ground render as interiorMaterial instead of just the pit. Using the
            // cutter's own convex hull guarantees a closed volume no matter how the
            // source mesh was modeled, and exactly reproduces the footprint for any
            // already-convex hole (a plain box hole, like vehicle.urdf's hole_01, is
            // unaffected - its own vertices' hull is the same box). A genuinely concave
            // hole shape would get filled out to its convex envelope; there's no such
            // shape among the current models.
            const holeGeometry = this.buildClosedCutterGeometry(openHoleGeometry);
            openHoleGeometry.dispose();
            this.extendCutterAboveSurface(holeGeometry);
            // Split the cutter's own faces into "wall" (material 1) vs "floor" (material 2)
            // by normal direction, so the newly-exposed cavity surface the CSG subtract below
            // derives from the cutter keeps that same split instead of one flat interior color.
            this.classifyCutterFacesByWallOrFloor(holeGeometry);
            const baseMesh = new THREE.Mesh(carvedGeometry, surfaceMaterial);
            // cutterMesh.material is never actually read by CSG.fromMesh()/toMesh() below
            // (only .geometry and .matrix are) - the wall/floor split comes purely from the
            // groups classifyCutterFacesByWallOrFloor() set on holeGeometry.
            const cutterMesh = new THREE.Mesh(holeGeometry, wallMaterial);
            baseMesh.updateMatrix();
            cutterMesh.updateMatrix();

            // Object index becomes the geometry group, so cut walls get their own material slot.
            // Forcing objectIndex 0 on the very first hole and undefined afterward matters for
            // two different reasons, so isFirstSubtract is tracked explicitly rather than
            // inferred from carvedGeometry.groups.length:
            //  - On the first hole, carvedGeometry is the *pristine* ground box. THREE.Box-
            //    Geometry always ships with 6 native per-face groups (materialIndex 0-5, one
            //    per face) even though it's a single material - groups.length is already > 0
            //    on a mesh nobody has CSG'd yet. Passing objectIndex=undefined here would make
            //    three-csg-ts read the box's own native face groups (0-5) instead of a single
            //    uniform tag, scattering the ground's polygons across 6 "shared" values when
            //    the material array only has slots 0-2 - faces that ended up on materialIndex
            //    3-5 (including the box's actual top/driving face) got no material at all.
            //    That's what showed up as a large dark, wrongly-shaded wedge across part of the
            //    ground even with only one small pothole.
            //  - On the second-and-later hole, objectIndex must be undefined instead: forcing 0
            //    would make three-csg-ts ignore the *real* CSG-assigned groups already on
            //    carvedGeometry and stamp every polygon back to 0 - including interior walls an
            //    earlier subtract just tagged with material index 1 or 2 - silently turning every
            //    hole but the last-carved one back into flat surfaceMaterial.
            // For the cutter, objectIndex is left undefined too, so three-csg-ts reads the
            // wall/floor groups classifyCutterFacesByWallOrFloor() just set, instead of
            // stamping every cutter polygon with one shared index.
            const baseObjectIndex = isFirstSubtract ? 0 : undefined;
            const resultMesh = CSG.toMesh(
              CSG.fromMesh(baseMesh, baseObjectIndex).subtract(
                CSG.fromMesh(cutterMesh, undefined),
              ),
              baseMesh.matrix,
              [surfaceMaterial, wallMaterial, floorMaterial],
            );
            carvedGeometry.dispose();
            holeGeometry.dispose();
            carvedGeometry = resultMesh.geometry;
            isFirstSubtract = false;
          });
        });

        groundMesh.geometry.dispose();
        groundMesh.geometry = carvedGeometry;
        groundMesh.material = [surfaceMaterial, wallMaterial, floorMaterial];
      });

      holeMeshesByRegion.forEach((holeMeshes) => {
        holeMeshes.forEach((holeMesh) => {
          holeMesh.visible = false;
        });
      });

      this.hasCarvedGroundVisual = true;
      console.log(
        "[URDF][Simulation] ground visual carved by pothole volume (CSG)",
      );
    } catch (error) {
      console.warn(
        "[URDF][Simulation] ground CSG carving unavailable; pothole stays as a surface recess:",
        error,
      );
    }
  }

  recessHoleObstacleVisuals(linkMap) {
    this.holeRegions.forEach((holeRegion) => {
      const holeLink = holeRegion.linkName
        ? this.findLinkByName(linkMap, holeRegion.linkName)
        : null;
      if (!holeLink || holeRegion.isRecessed) {
        return;
      }

      // Sink the volume so its top face is flush with the ground surface.
      holeLink.position.z -= Number(holeRegion.depthMeters) || 0;
      holeLink.updateWorldMatrix(true, true);
      holeRegion.isRecessed = true;
    });
  }

  getGroundGridOriginXY() {
    const linkMap = this.viewer?.robotModel?.links || null;
    const frontWheelPositions = ["fl", "fr"]
      .map((wheelKey) =>
        this.findLinkByName(linkMap, this.wheelLinkNameByKey[wheelKey]),
      )
      .filter(Boolean)
      .map((wheelLink) => {
        wheelLink.updateWorldMatrix(true, false);
        return wheelLink.getWorldPosition(new THREE.Vector3());
      });

    if (frontWheelPositions.length === 0) {
      return { x: 0, y: 0 };
    }

    const count = frontWheelPositions.length;
    return {
      x: frontWheelPositions.reduce((sum, p) => sum + p.x, 0) / count,
      y: frontWheelPositions.reduce((sum, p) => sum + p.y, 0) / count,
    };
  }

  addGroundSurfaceGrid(groundPatches) {
    if (!this.viewer?.scene || !Array.isArray(groundPatches)) {
      return;
    }

    if (!this.viewer.scene.fog) {
      this.viewer.scene.fog = new THREE.Fog(
        GROUND_FOG_COLOR,
        GROUND_FOG_NEAR_METERS,
        GROUND_FOG_FAR_METERS,
      );
    }

    if (this.groundGrid) {
      this.viewer.scene.remove(this.groundGrid);
      this.groundGrid.geometry.dispose();
      this.groundGrid.material.dispose();
    }

    // One cell equals one wheel revolution, so travel per rotation is readable on the ground.
    const gridSpacingMeters = this.getWheelCircumferenceMeters();
    // Phase the grid so a line falls on the front wheel contact point at load/reset.
    const gridOrigin = this.getGroundGridOriginXY();
    // Freeze this same origin for the scene trees: the grid itself is only rebuilt at
    // load/reset, so the tree lattice must snapshot the origin here too rather than
    // re-reading the (constantly moving, once driving starts) front-wheel position on
    // every tick - otherwise trees drift out of phase with this now-static grid as the
    // vehicle drives, i.e. they visually "follow" the vehicle instead of staying put.
    // Offset by 5 ground-grid cells so the tree lattice's first slot sits on the 5th grid
    // line instead of right on the origin line - the spacing between trees (10 grid
    // cells, see getSceneTreeXGridSpacingMeters) is unchanged, only the starting phase.
    this.sceneTreeGridOriginX = gridOrigin.x + gridSpacingMeters * 5;
    this.sceneTreeGridOriginY = gridOrigin.y;
    this.resetSceneTreePool();
    // Single static "COBOT SYSTEM" ground marker, centered on world X=0 (not the grid
    // origin - Y is grid-relative but X is a literal world coordinate here) and 3 grid
    // cells out on Y from the grid origin. Recomputed here alongside the tree origin so
    // it stays put on this now-static grid rather than drifting if the grid's phase
    // shifts on reset.
    this.cobotSystemSignPosition = new THREE.Vector2(
      0,
      gridOrigin.y + gridSpacingMeters * 3,
    );
    this.ensureCobotSystemSign();
    const snapUp = (value, origin) =>
      origin +
      Math.ceil((value - origin) / gridSpacingMeters) * gridSpacingMeters;
    const snapDown = (value, origin) =>
      origin +
      Math.floor((value - origin) / gridSpacingMeters) * gridSpacingMeters;
    const gridZ = this.groundZ + 0.001;
    const vertices = [];
    const colors = [];
    const verticalLineColor = new THREE.Color(0x22c55e);
    // A pale tint of the same green (rather than a plain white) so the two directions
    // read as one cohesive grid instead of two unrelated colors.
    const horizontalLineColor = new THREE.Color(0xbbf7d0);
    const appendLine = (x1, y1, x2, y2, isVertical) => {
      vertices.push(x1, y1, gridZ, x2, y2, gridZ);
      const color = isVertical ? verticalLineColor : horizontalLineColor;
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    };

    groundPatches.forEach((patch) => {
      const minX = snapUp(patch.minX, gridOrigin.x);
      const maxX = snapDown(patch.maxX, gridOrigin.x);
      const minY = snapUp(patch.minY, gridOrigin.y);
      const maxY = snapDown(patch.maxY, gridOrigin.y);

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

  isVehicleOverHoleRegion(targetHoleRegion = null) {
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

    const holeRegions = targetHoleRegion
      ? [targetHoleRegion]
      : this.holeRegions;
    return holeRegions.some((holeRegion) => {
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
    // Low uniform friction keeps asymmetric contact from locking one side and spinning the vehicle.
    const friction = OBSTACLE_COLLIDER_FRICTION;
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
      restitution = 0.0;
    } else if (isHemisphereLike) {
      effectiveHalfX = Math.max(effectiveHalfX, 0.06);
      effectiveHalfY = Math.max(effectiveHalfY, 0.06);
      effectiveHalfZ = Math.max(effectiveHalfZ, 0.02);
      restitution = 0.0;
    } else if (isBarLike) {
      effectiveHalfX = Math.max(effectiveHalfX, 0.04);
      effectiveHalfY = Math.max(effectiveHalfY, 0.75);
      effectiveHalfZ = Math.max(effectiveHalfZ, 0.015);
      restitution = 0.0;
    } else {
      const maxExtent = Math.max(
        effectiveHalfX,
        effectiveHalfY,
        effectiveHalfZ,
      );
      if (maxExtent > 0.25) {
        restitution = 0.0;
      } else if (maxExtent < 0.08) {
        effectiveHalfZ = Math.max(effectiveHalfZ, 0.008);
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

      // Obstacles never block motion: traversal height comes from wheel support geometry,
      // so solver pushback would only stall the vehicle at higher speeds.
      if (typeof obstacleColliderDesc.setSensor === "function") {
        obstacleColliderDesc.setSensor(true);
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
        body: obstacleBody,
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
        originalCenter: new THREE.Vector3(center.x, center.y, center.z),
        originalWorldBounds: actualBounds.clone(),
        isActive: false,
      });
      console.log(
        `[URDF][Simulation] obstacle collider created from URDF link: ${obstacleLinkName}`,
      );
    });

    this.hideDynamicSurfaceObstacles();
  }

  hideDynamicSurfaceObstacles() {
    this.obstacleColliderInfos.forEach((obstacleInfo) => {
      this.hideDynamicSurfaceObstacle(obstacleInfo);
    });
    this.lastWheelSupportProfile = null;
  }

  hideDynamicSurfaceObstacle(obstacleInfo) {
    if (!obstacleInfo) {
      return;
    }

    obstacleInfo.isActive = false;
    obstacleInfo.isDynamicSurfaceObstacle = false;
    obstacleInfo.hasDynamicVehicleContact = false;
    obstacleInfo.dynamicForward = null;
    if (obstacleInfo.linkObject) {
      obstacleInfo.linkObject.visible = false;
    }
    if (typeof obstacleInfo.collider?.setEnabled === "function") {
      obstacleInfo.collider.setEnabled(false);
    }
  }

  getDynamicObstaclePlacement(lateralWheelKeys = []) {
    if (!this.body || !this.carFrame) {
      return null;
    }

    const bodyPosition = this.body.translation();
    const yaw = this.extractYawFromQuaternion(this.body.rotation());
    const forward = this.getVehicleForwardVector(yaw);
    const left = { x: -forward.y, y: forward.x };
    const linkMap = this.viewer?.robotModel?.links || null;
    const wheelPositions = Object.entries(this.wheelLinkNameByKey)
      .map(([wheelKey, wheelLinkName]) => {
        const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
        if (!wheelLink) {
          return null;
        }
        wheelLink.updateWorldMatrix(true, false);
        return {
          wheelKey,
          position: wheelLink.getWorldPosition(new THREE.Vector3()),
        };
      })
      .filter(Boolean);
    const lateralWheels = wheelPositions.filter((wheel) =>
      lateralWheelKeys.includes(wheel.wheelKey),
    );
    const lateralOffset =
      lateralWheels.length > 0
        ? lateralWheels.reduce((sum, wheel) => {
            const dx = wheel.position.x - bodyPosition.x;
            const dy = wheel.position.y - bodyPosition.y;
            return sum + dx * left.x + dy * left.y;
          }, 0) / lateralWheels.length
        : 0;
    return {
      x:
        bodyPosition.x +
        forward.x * DYNAMIC_OBSTACLE_FORWARD_DISTANCE_METERS +
        left.x * lateralOffset,
      y:
        bodyPosition.y +
        forward.y * DYNAMIC_OBSTACLE_FORWARD_DISTANCE_METERS +
        left.y * lateralOffset,
      forwardX: forward.x,
      forwardY: forward.y,
    };
  }

  hasVehiclePassedDynamicObstacle(
    centerX,
    centerY,
    halfExtentX,
    halfExtentY,
    forwardX,
    forwardY,
  ) {
    if (
      !this.body ||
      !Number.isFinite(centerX) ||
      !Number.isFinite(centerY) ||
      !Number.isFinite(forwardX) ||
      !Number.isFinite(forwardY)
    ) {
      return false;
    }

    const obstacleHalfForward =
      Math.abs(forwardX) * Math.max(Number(halfExtentX) || 0, 0) +
      Math.abs(forwardY) * Math.max(Number(halfExtentY) || 0, 0);
    const obstacleForwardEdge =
      centerX * forwardX + centerY * forwardY + obstacleHalfForward;
    const vehicleBounds = this.getVehicleCollisionBounds();
    if (vehicleBounds.length === 0) {
      return false;
    }

    const vehicleRearEdge = vehicleBounds.reduce((rearEdge, bounds) => {
      const center = bounds.getCenter(new THREE.Vector3());
      const halfExtents = bounds
        .getSize(new THREE.Vector3())
        .multiplyScalar(0.5);
      const halfForward =
        Math.abs(forwardX) * halfExtents.x + Math.abs(forwardY) * halfExtents.y;
      return Math.min(
        rearEdge,
        center.x * forwardX + center.y * forwardY - halfForward,
      );
    }, Number.POSITIVE_INFINITY);
    return vehicleRearEdge > obstacleForwardEdge;
  }

  async removePassedDynamicSurfaceObstacles() {
    if (
      !this.isDynamicObstacleRemovalRequested ||
      this.isRemovingPassedDynamicObstacles
    ) {
      return false;
    }

    const passedObstacles = this.obstacleColliderInfos.filter(
      (obstacleInfo) =>
        obstacleInfo?.isActive &&
        obstacleInfo.isDynamicSurfaceObstacle &&
        obstacleInfo.hasDynamicVehicleContact &&
        this.hasVehiclePassedDynamicObstacle(
          obstacleInfo.center?.x,
          obstacleInfo.center?.y,
          obstacleInfo.halfExtents?.x,
          obstacleInfo.halfExtents?.y,
          obstacleInfo.dynamicForward?.x,
          obstacleInfo.dynamicForward?.y,
        ),
    );
    const potholeRegion = this.dynamicPotholeRegion;
    const potholeHalfX = potholeRegion
      ? (potholeRegion.maxX - potholeRegion.minX) * 0.5
      : 0;
    const potholeHalfY = potholeRegion
      ? (potholeRegion.maxY - potholeRegion.minY) * 0.5
      : 0;
    const hasPassedPothole = Boolean(
      potholeRegion?.hasDynamicVehicleContact &&
      this.hasVehiclePassedDynamicObstacle(
        (potholeRegion.minX + potholeRegion.maxX) * 0.5,
        (potholeRegion.minY + potholeRegion.maxY) * 0.5,
        potholeHalfX,
        potholeHalfY,
        potholeRegion.forwardX,
        potholeRegion.forwardY,
      ),
    );

    if (passedObstacles.length === 0 && !hasPassedPothole) {
      return false;
    }

    this.isRemovingPassedDynamicObstacles = true;
    try {
      passedObstacles.forEach((obstacleInfo) =>
        this.hideDynamicSurfaceObstacle(obstacleInfo),
      );

      if (hasPassedPothole) {
        this.holeRegions = this.holeRegions.filter(
          (holeRegion) => holeRegion !== potholeRegion,
        );
        this.dynamicPotholeRegion = null;
        const potholeObstacle = this.obstacleColliderInfos.find(
          (obstacleInfo) => /pothole/i.test(obstacleInfo.normalizedLinkName),
        );
        this.hideDynamicSurfaceObstacle(potholeObstacle);
        this.addGroundSurfaceExtension();
        await this.carveGroundVisualForHoles(true);
      }

      const hasRemainingDynamicObstacle = this.obstacleColliderInfos.some(
        (obstacleInfo) =>
          obstacleInfo?.isActive && obstacleInfo.isDynamicSurfaceObstacle,
      );
      if (!hasRemainingDynamicObstacle && !this.dynamicPotholeRegion) {
        this.isDynamicObstacleRemovalRequested = false;
      }
      this.lastWheelSupportProfile = null;
      return true;
    } finally {
      this.isRemovingPassedDynamicObstacles = false;
    }
  }

  moveObstacleInfoTo(obstacleInfo, centerX, centerY, centerZ = null) {
    if (!obstacleInfo?.center || !obstacleInfo?.halfExtents) {
      return false;
    }

    const targetCenter = new THREE.Vector3(
      centerX,
      centerY,
      Number.isFinite(centerZ)
        ? centerZ
        : this.groundZ + obstacleInfo.halfExtents.z,
    );
    const delta = targetCenter.clone().sub(obstacleInfo.center);
    const linkObject = obstacleInfo.linkObject;
    if (linkObject?.parent) {
      linkObject.updateWorldMatrix(true, false);
      const linkWorldPosition = linkObject.getWorldPosition(
        new THREE.Vector3(),
      );
      linkObject.position.copy(
        linkObject.parent.worldToLocal(linkWorldPosition.add(delta)),
      );
      linkObject.updateWorldMatrix(true, true);
      linkObject.visible = true;
    }
    obstacleInfo.body?.setTranslation(
      { x: targetCenter.x, y: targetCenter.y, z: targetCenter.z },
      true,
    );
    obstacleInfo.collider?.setEnabled?.(true);
    obstacleInfo.center.copy(targetCenter);
    obstacleInfo.worldBounds = obstacleInfo.originalWorldBounds
      .clone()
      .translate(targetCenter.clone().sub(obstacleInfo.originalCenter));
    obstacleInfo.isActive = true;
    return true;
  }

  hasUnfinishedDynamicSurfaceObstacle(obstacleValue) {
    if (obstacleValue === 1) {
      return this.obstacleColliderInfos.some(
        (obstacleInfo) =>
          obstacleInfo?.isActive &&
          obstacleInfo.isDynamicSurfaceObstacle &&
          !(
            obstacleInfo.hasDynamicVehicleContact &&
            this.hasVehiclePassedDynamicObstacle(
              obstacleInfo.center?.x,
              obstacleInfo.center?.y,
              obstacleInfo.halfExtents?.x,
              obstacleInfo.halfExtents?.y,
              obstacleInfo.dynamicForward?.x,
              obstacleInfo.dynamicForward?.y,
            )
          ),
      );
    }

    if (obstacleValue === 2 && this.dynamicPotholeRegion) {
      const potholeRegion = this.dynamicPotholeRegion;
      return !(
        potholeRegion.hasDynamicVehicleContact &&
        this.hasVehiclePassedDynamicObstacle(
          (potholeRegion.minX + potholeRegion.maxX) * 0.5,
          (potholeRegion.minY + potholeRegion.maxY) * 0.5,
          (potholeRegion.maxX - potholeRegion.minX) * 0.5,
          (potholeRegion.maxY - potholeRegion.minY) * 0.5,
          potholeRegion.forwardX,
          potholeRegion.forwardY,
        )
      );
    }

    return false;
  }

  async applyDynamicSurfaceObstacle(obstacleValue) {
    const normalizedValue = Number(obstacleValue);
    if (
      !Number.isInteger(normalizedValue) ||
      normalizedValue < 0 ||
      normalizedValue > 2
    ) {
      return false;
    }

    if (normalizedValue === 0) {
      this.isDynamicObstacleRemovalRequested = true;
      await this.removePassedDynamicSurfaceObstacles();
      return true;
    }

    if (this.hasUnfinishedDynamicSurfaceObstacle(normalizedValue)) {
      return true;
    }

    this.isDynamicObstacleRemovalRequested = false;
    this.hideDynamicSurfaceObstacles();
    if (this.dynamicPotholeRegion) {
      this.holeRegions = this.holeRegions.filter(
        (holeRegion) => holeRegion !== this.dynamicPotholeRegion,
      );
      this.dynamicPotholeRegion = null;
    }

    if (normalizedValue === 1) {
      const placement = this.getDynamicObstaclePlacement();
      const stepObstacle = this.obstacleColliderInfos.find((obstacleInfo) =>
        /wood|bar/i.test(obstacleInfo.normalizedLinkName),
      );
      if (placement && stepObstacle) {
        this.moveObstacleInfoTo(stepObstacle, placement.x, placement.y);
        stepObstacle.isDynamicSurfaceObstacle = true;
        stepObstacle.hasDynamicVehicleContact = false;
        stepObstacle.dynamicForward = {
          x: placement.forwardX,
          y: placement.forwardY,
        };
      }
    } else if (normalizedValue === 2) {
      const placement = this.getDynamicObstaclePlacement(["fl", "rl"]);
      const template = this.authoredPotholeTemplate;
      if (placement && template) {
        const width = template.maxX - template.minX;
        const height = template.maxY - template.minY;
        this.dynamicPotholeRegion = {
          linkName: template.linkName,
          minX: placement.x - width * 0.5,
          maxX: placement.x + width * 0.5,
          minY: placement.y - height * 0.5,
          maxY: placement.y + height * 0.5,
          depthMeters: template.depthMeters,
          floorZ: this.groundZ - template.depthMeters,
          isRecessed: true,
          hasDynamicVehicleContact: false,
          forwardX: placement.forwardX,
          forwardY: placement.forwardY,
        };
        this.holeRegions.push(this.dynamicPotholeRegion);
        const potholeObstacle = this.obstacleColliderInfos.find(
          (obstacleInfo) => /pothole/i.test(obstacleInfo.normalizedLinkName),
        );
        if (potholeObstacle) {
          this.moveObstacleInfoTo(
            potholeObstacle,
            placement.x,
            placement.y,
            this.groundZ - potholeObstacle.halfExtents.z,
          );
          potholeObstacle.isActive = false;
          potholeObstacle.collider?.setEnabled?.(false);
        }
      }
    }

    this.lastWheelSupportProfile = null;
    this.addGroundSurfaceExtension();
    await this.carveGroundVisualForHoles(true);
    return true;
  }

  getObstacleWorldBounds(obstacleInfo, linkMap = null) {
    if (!obstacleInfo?.isActive) {
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
    if (!obstacleInfo) {
      return [];
    }

    const supportProfile =
      this.lastWheelSupportProfile ||
      (this.lastWheelSupportProfile = this.getWheelSupportProfile());
    if (!supportProfile?.supportObstacleByKey) {
      return [];
    }

    return Object.entries(supportProfile.supportObstacleByKey)
      .filter(([, supportObstacle]) => supportObstacle === obstacleInfo)
      .map(([wheelKey]) => wheelKey);
  }

  isVehicleColliderContactingObstacle(obstacleInfo) {
    return this.isVehicleAabbTouchingObstacle(obstacleInfo);
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

  getObstacleTraversalApproachInfo() {
    if (!this.body || !Array.isArray(this.obstacleColliderInfos)) {
      return null;
    }

    const bodyPosition = this.body.translation();
    const yaw = this.extractYawFromQuaternion(this.body.rotation());
    const { x: forwardX, y: forwardY } = this.getVehicleForwardVector(yaw);

    const candidates = this.obstacleColliderInfos
      .filter(
        (obstacleInfo) =>
          obstacleInfo &&
          obstacleInfo.isActive &&
          !obstacleInfo.isSensor &&
          obstacleInfo.center &&
          obstacleInfo.halfExtents,
      )
      .map((obstacleInfo) => {
        const dx = obstacleInfo.center.x - bodyPosition.x;
        const dy = obstacleInfo.center.y - bodyPosition.y;
        const alongForward = dx * forwardX + dy * forwardY;
        const lateralOffset = Math.abs(dx * forwardY - dy * forwardX);
        const halfForward =
          Math.abs(forwardX) * obstacleInfo.halfExtents.x +
          Math.abs(forwardY) * obstacleInfo.halfExtents.y;
        const obstacleFront = alongForward - halfForward;
        const obstacleRear = alongForward + halfForward;
        const rampLength = Math.max(
          OBSTACLE_RAMP_MIN_LENGTH_METERS,
          Math.min(
            OBSTACLE_RAMP_MAX_LENGTH_METERS,
            halfForward * OBSTACLE_RAMP_HALF_FORWARD_SCALE,
          ),
        );
        const targetZ = this.getObstacleClimbTargetZ(obstacleInfo);
        return {
          obstacleInfo,
          obstacleFront,
          obstacleRear,
          lateralOffset,
          rampLength,
          targetZ,
        };
      })
      .filter(
        (candidate) =>
          Number.isFinite(candidate.targetZ) &&
          candidate.lateralOffset <= OBSTACLE_MAX_LATERAL_OFFSET_METERS &&
          candidate.obstacleFront <= candidate.rampLength &&
          candidate.obstacleRear >= -candidate.rampLength,
      )
      .sort((left, right) => left.obstacleFront - right.obstacleFront);

    return candidates.length > 0
      ? { obstacleInfo: candidates[0].obstacleInfo }
      : null;
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
    const lateralOffset = Math.abs(dx * forwardY - dy * forwardX);
    const halfForward =
      Math.abs(forwardX) * obstacleInfo.halfExtents.x +
      Math.abs(forwardY) * obstacleInfo.halfExtents.y;
    const rampLength = Math.max(
      OBSTACLE_RAMP_MIN_LENGTH_METERS,
      Math.min(
        OBSTACLE_RAMP_MAX_LENGTH_METERS,
        halfForward * OBSTACLE_RAMP_HALF_FORWARD_SCALE,
      ),
    );
    const measuredGroundTargetZ = this.getGroundContactTargetZ();
    const groundTargetZ = Number.isFinite(measuredGroundTargetZ)
      ? measuredGroundTargetZ
      : bodyPosition.z;
    const obstacleTargetZ = this.getObstacleClimbTargetZ(obstacleInfo);

    // Traversal can start from the forward approach zone; red highlighting
    // remains exclusively driven by real Rapier collider contacts.
    if (
      !Number.isFinite(obstacleTargetZ) ||
      lateralOffset > OBSTACLE_MAX_LATERAL_OFFSET_METERS ||
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
    if (!this.activeObstacleTraversalPath?.obstacleInfo?.isActive) {
      return false;
    }

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

  getWheelSupportProfile() {
    const linkMap = this.viewer?.robotModel?.links || null;
    if (!linkMap || !this.carFrame || !Number.isFinite(this.groundZ)) {
      return null;
    }

    const wheelRadius = Math.max(
      Number(this.wheelEffectiveRadiusMeters) || 0,
      0.05,
    );
    const liftByKey = {};
    const supportZByKey = {};
    const supportObstacleByKey = {};
    const samples = [];

    this.carFrame.updateWorldMatrix(true, false);

    Object.entries(this.wheelLinkNameByKey).forEach(
      ([wheelKey, wheelLinkName]) => {
        liftByKey[wheelKey] = 0;
        supportZByKey[wheelKey] = this.groundZ;
        supportObstacleByKey[wheelKey] = null;

        const wheelLink = this.findLinkByName(linkMap, wheelLinkName);
        if (!wheelLink) {
          return;
        }

        wheelLink.updateWorldMatrix(true, false);
        const wheelPosition = wheelLink.getWorldPosition(new THREE.Vector3());
        let supportZ = this.groundZ;
        let supportObstacle = null;

        this.obstacleColliderInfos.forEach((obstacleInfo) => {
          if (
            !obstacleInfo ||
            !obstacleInfo.isActive ||
            !obstacleInfo.center ||
            !obstacleInfo.halfExtents
          ) {
            return;
          }

          const gapX = Math.max(
            Math.abs(wheelPosition.x - obstacleInfo.center.x) -
              obstacleInfo.halfExtents.x,
            0,
          );
          const gapY = Math.max(
            Math.abs(wheelPosition.y - obstacleInfo.center.y) -
              obstacleInfo.halfExtents.y,
            0,
          );
          const horizontalGap = Math.hypot(gapX, gapY);
          if (horizontalGap >= wheelRadius) {
            return;
          }

          // Wheel rim riding the top edge: center stays on a circle of radius r around the corner.
          const obstacleTopZ =
            obstacleInfo.center.z + obstacleInfo.halfExtents.z;
          const cornerSupportZ =
            obstacleTopZ +
            Math.sqrt(
              Math.max(
                wheelRadius * wheelRadius - horizontalGap * horizontalGap,
                0,
              ),
            ) -
            wheelRadius;
          if (cornerSupportZ <= supportZ) {
            return;
          }
          supportZ = cornerSupportZ;
          supportObstacle = obstacleInfo;
        });

        if (!supportObstacle) {
          (this.holeRegions || []).forEach((holeRegion) => {
            const insideDistance = Math.min(
              wheelPosition.x - holeRegion.minX,
              holeRegion.maxX - wheelPosition.x,
              wheelPosition.y - holeRegion.minY,
              holeRegion.maxY - wheelPosition.y,
            );
            if (insideDistance <= 0) {
              return;
            }

            // Mirror of the climb case: the rim rides the near edge until the hole is wide enough to swallow it.
            const reach = Math.min(insideDistance, wheelRadius);
            const edgeDrop =
              wheelRadius -
              Math.sqrt(Math.max(wheelRadius * wheelRadius - reach * reach, 0));
            const depthMeters = Math.max(
              Number(holeRegion.depthMeters) || 0,
              0,
            );
            supportZ = Math.min(
              supportZ,
              this.groundZ - Math.min(depthMeters, edgeDrop),
            );
          });
        }

        const lift = supportZ - this.groundZ;
        liftByKey[wheelKey] = lift;
        supportZByKey[wheelKey] = supportZ;
        supportObstacleByKey[wheelKey] =
          lift > WHEEL_SUPPORT_MIN_LIFT_METERS ? supportObstacle : null;

        // Chassis-local offsets keep the tilt fit independent of URDF axis conventions.
        const localOffset = this.carFrame.worldToLocal(wheelPosition.clone());
        samples.push({ x: localOffset.x, y: localOffset.y, lift });
      },
    );

    if (samples.length === 0) {
      return null;
    }

    const count = samples.length;
    // Climbing wheels (higher lift) pull the fit toward themselves - see
    // WHEEL_SUPPORT_LIFT_WEIGHT_PER_METER. A flat-ground wheel (lift 0) still keeps
    // weight 1 so an all-flat frame fits a sensible, non-degenerate plane.
    const weights = samples.map(
      (s) => 1 + WHEEL_SUPPORT_LIFT_WEIGHT_PER_METER * Math.max(s.lift, 0),
    );
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const meanX =
      samples.reduce((sum, s, i) => sum + weights[i] * s.x, 0) / totalWeight;
    const meanY =
      samples.reduce((sum, s, i) => sum + weights[i] * s.y, 0) / totalWeight;
    const meanLift =
      samples.reduce((sum, s, i) => sum + weights[i] * s.lift, 0) /
      totalWeight;

    // Fewer than three contact points cannot define a plane; keep the lift, drop the tilt.
    if (count < 3) {
      return {
        liftByKey,
        supportZByKey,
        supportObstacleByKey,
        averageLift: Math.max(meanLift, 0),
        pitchRad: 0,
        rollRad: 0,
      };
    }

    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    let sumXL = 0;
    let sumYL = 0;
    samples.forEach((sample, i) => {
      const weight = weights[i];
      const dx = sample.x - meanX;
      const dy = sample.y - meanY;
      const dl = sample.lift - meanLift;
      sumXX += weight * dx * dx;
      sumYY += weight * dy * dy;
      sumXY += weight * dx * dy;
      sumXL += weight * dx * dl;
      sumYL += weight * dy * dl;
    });

    // Least-squares support plane through the wheel contact points: lift = gradX*x + gradY*y + liftAtOrigin.
    const determinant = sumXX * sumYY - sumXY * sumXY;
    const gradX =
      Math.abs(determinant) > 1e-9
        ? (sumYY * sumXL - sumXY * sumYL) / determinant
        : 0;
    const gradY =
      Math.abs(determinant) > 1e-9
        ? (sumXX * sumYL - sumXY * sumXL) / determinant
        : 0;
    const liftAtOrigin = meanLift - gradX * meanX - gradY * meanY;
    const maxTiltRad = THREE.MathUtils.degToRad(OBSTACLE_MAX_TILT_DEG);

    return {
      liftByKey,
      supportZByKey,
      supportObstacleByKey,
      // Signed: positive on obstacles, negative inside potholes.
      averageLift: liftAtOrigin,
      pitchRad: THREE.MathUtils.clamp(
        -Math.atan(gradX),
        -maxTiltRad,
        maxTiltRad,
      ),
      rollRad: THREE.MathUtils.clamp(Math.atan(gradY), -maxTiltRad, maxTiltRad),
    };
  }

  // Visual-only: on the frame a wheel first contacts an obstacle it snaps toward a lateral flex
  // angle on inner_wheel_{key}_joint (the vertical swing-knuckle axis), then eases back to 0 as
  // climbProgress (lift / obstacle height) rises — i.e. as the wheel settles on top of it.
  updateWheelObstacleFlex(supportProfile, deltaSec) {
    const jointMap = this.viewer?.robotModel?.joints;
    if (!jointMap) {
      return;
    }

    const alpha =
      WHEEL_OBSTACLE_FLEX_SMOOTHING_HZ > 0
        ? 1 -
          Math.exp(-WHEEL_OBSTACLE_FLEX_SMOOTHING_HZ * Math.max(deltaSec, 0))
        : 1;

    Object.keys(this.innerWheelJointNameByKey).forEach((wheelKey) => {
      const supportObstacle =
        supportProfile?.supportObstacleByKey?.[wheelKey] || null;
      let targetAngleRad = 0;

      if (supportObstacle?.center && supportObstacle?.halfExtents) {
        const obstacleHeightMeters = Math.max(
          supportObstacle.center.z +
            supportObstacle.halfExtents.z -
            this.groundZ,
          0.01,
        );
        const liftMeters = Number(supportProfile.liftByKey?.[wheelKey]) || 0;
        const climbProgress = THREE.MathUtils.clamp(
          liftMeters / obstacleHeightMeters,
          0,
          1,
        );
        // Peak right as contact begins (climbProgress ~ 0), restored once fully climbed on (~ 1).
        targetAngleRad = WHEEL_OBSTACLE_FLEX_PEAK_RAD * (1 - climbProgress);
      }

      const currentAngleRad =
        Number(this.wheelObstacleFlexAngleRadByKey[wheelKey]) || 0;
      const nextAngleRad =
        currentAngleRad + (targetAngleRad - currentAngleRad) * alpha;
      this.wheelObstacleFlexAngleRadByKey[wheelKey] = nextAngleRad;

      const joint = jointMap[this.innerWheelJointNameByKey[wheelKey]];
      if (joint && typeof joint.setJointValue === "function") {
        joint.setJointValue(nextAngleRad);
      }
    });
  }

  applyWheelSupportRideHeight(supportProfile) {
    if (!this.body || !this.rapier || !supportProfile) {
      return false;
    }

    const measuredFlatZ = this.getGroundContactTargetZ();
    const flatZ = Number.isFinite(Number(this.initialPosition?.z))
      ? Number(this.initialPosition.z)
      : measuredFlatZ;
    if (!Number.isFinite(flatZ)) {
      return false;
    }

    const targetZ = flatZ + supportProfile.averageLift;
    const translation = this.body.translation();
    if (Math.abs(targetZ - translation.z) < 1e-6) {
      return true;
    }

    // Ride height tracks wheel support geometry exactly, so climbing never depends on speed.
    this.body.setTranslation(
      new this.rapier.Vector3(translation.x, translation.y, targetZ),
      true,
    );
    const velocity = this.body.linvel();
    this.body.setLinvel(
      new this.rapier.Vector3(velocity.x, velocity.y, 0),
      true,
    );
    return true;
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

    if (this.isVehicleObstacleContact || this.isVehicleOverHoleRegion()) {
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
      const wheelDimensions = [size.x, size.y, size.z].sort(
        (left, right) => left - right,
      );
      const wheelHalfWidth = Math.max(wheelDimensions[0] * 0.5, 0.01);
      // Prefer the wheel-local-frame radius (matches the ground grid and visual
      // rotation speed). The world-AABB estimate below is only a fallback: the
      // wheel's spin axis is not world-axis-aligned once the swing/steering
      // joint chain is applied, so its world AABB understates the true radius
      // and previously made the physics wheel roll a shorter distance per
      // rotation than the grid (and visual spin) assumed.
      const wheelKeyByLinkName = {
        wheel_fl: "fl",
        wheel_fr: "fr",
        wheel_rl: "rl",
        wheel_rr: "rr",
      };
      const wheelKey = wheelKeyByLinkName[wheelLinkName] || null;
      const localFrameRadius = wheelKey
        ? Number(this.wheelRadiusMetersByKey?.[wheelKey])
        : NaN;
      const worldAabbRadius =
        Math.max(wheelDimensions[1], wheelDimensions[2]) * 0.5;
      const wheelRadius =
        (Number.isFinite(localFrameRadius) && localFrameRadius > 0
          ? localFrameRadius
          : worldAabbRadius) + inflation;
      const localCenter = carFrame.worldToLocal(centerWorld.clone());
      const wheelQuaternion = wheelLink.getWorldQuaternion(
        new THREE.Quaternion(),
      );

      const wheelBodyDesc = this.rapier.RigidBodyDesc.dynamic()
        .setTranslation(centerWorld.x, centerWorld.y, centerWorld.z)
        .setRotation(wheelQuaternion)
        .setLinearDamping(1.5)
        .setAngularDamping(1.0)
        .setCcdEnabled(true);
      const wheelBody = this.world.createRigidBody(wheelBodyDesc);
      if (typeof wheelBody.setCanSleep === "function") {
        wheelBody.setCanSleep(false);
      }

      const wheelColliderDesc = this.rapier.ColliderDesc.cylinder(
        wheelHalfWidth,
        Math.max(wheelRadius, 0.05),
      )
        .setDensity(25.0)
        .setFriction(WHEEL_COLLIDER_FRICTION)
        .setCollisionGroups(COLLISION_GROUP_WHEEL)
        .setRestitution(0.0);
      const wheelCollider = this.world.createCollider(
        wheelColliderDesc,
        wheelBody,
      );
      this.vehicleColliders.push(wheelCollider);
      this.wheelColliders.push(wheelCollider);
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

        const wheelBounds =
          this.computeLinkLocalBounds(wheelLink, linkMap) || new THREE.Box3();
        if (wheelBounds.isEmpty()) {
          return;
        }

        const dimensions = wheelBounds
          .getSize(new THREE.Vector3())
          .toArray()
          .sort((left, right) => left - right);
        const radius = Math.max((dimensions[1] + dimensions[2]) * 0.25, 0.05);
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

    if (typeof globalThis.publishSimulationWheelRadii === "function") {
      globalThis.publishSimulationWheelRadii(wheelRadiusMetersByKey);
    }
  }

  getWheelCircumferenceMeters() {
    const wheelRadius = Math.max(
      Number(this.wheelEffectiveRadiusMeters) || 0,
      0.05,
    );
    return Math.PI * 2 * wheelRadius;
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
    // Playback scale belongs to simulation time only; scaling here too would double-apply it.
    if (typeof viewer.setWheelAnimationTimeScale === "function") {
      viewer.setWheelAnimationTimeScale(1);
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
        const quaternion = wheelLink.getWorldQuaternion(new THREE.Quaternion());
        wheelBody.setTranslation(
          new this.rapier.Vector3(position.x, position.y, position.z),
          true,
        );
        wheelBody.setRotation(quaternion, true);
        wheelBody.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
        wheelBody.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
      },
    );
  }

  settlePhysicsAfterReset() {
    if (!this.world || !this.body || !this.rapier) {
      return;
    }

    this.physicsEngine.step(this.physicsFixedTimeStepSec);
    this.renderer.syncVehicle();
    this.resetWheelBodiesFromVisual();
    this.physicsEngine.step(this.physicsFixedTimeStepSec);

    this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
    this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
    this.renderer.syncVehicle();
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

    if (this.isWheelRotationStopped || this.isWheelRotationDrivenByCommand) {
      if (typeof viewer.setWheelRotationDrivenByTravel === "function") {
        viewer.setWheelRotationDrivenByTravel(false);
      }
      this.resetWheelTravelTracking();
      return;
    }

    // Rolling without slip: angle comes from measured travel, never from an animation clock.
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

    const previousWheelAngles = { ...viewer.wheelAngles };
    viewer.applyWheelTravelDistances(distanceMetersByKey, radiusMetersByKey);
    Object.keys(this.wheelVisualRotationDirectionByKey).forEach((wheelKey) => {
      const angleDelta =
        Number(viewer.wheelAngles?.[wheelKey]) -
        Number(previousWheelAngles[wheelKey]);
      if (Number.isFinite(angleDelta) && Math.abs(angleDelta) > 1e-8) {
        this.wheelVisualRotationDirectionByKey[wheelKey] =
          Math.sign(angleDelta);
      }
    });
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
    return Number.isFinite(trackWidth) && trackWidth > 1e-3
      ? trackWidth
      : VEHICLE_TRACK_WIDTH_FALLBACK_METERS;
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

    const byId = window.urdfViewersById?.["vehicle-urdf-viewer"] || null;
    if (byId) {
      return byId;
    }

    return window.activeURDFViewer || null;
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
      // Vehicle travel follows wheel rotation whenever the wheels are actually turning.
      return (
        wheelAngularSpeedRadPerSec *
        Math.max(this.wheelEffectiveRadiusMeters, 0.05)
      );
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
    const alignedZ = translation.z - wheelGroundGap;
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
    this.syncCameraToVehicleTranslation(position);
    this.syncVehicleDirectionArrows();
    this.syncWheelGroundContactMarkers();
    this.syncVehicleYawIndicator();
    this.syncWheelRotationToBodyTravel();
  }

  syncCameraToVehicleTranslation(position) {
    const currentVehiclePosition = new THREE.Vector3(
      position.x,
      position.y,
      position.z,
    );
    if (!this.cameraFollowPreviousVehiclePosition) {
      this.cameraFollowPreviousVehiclePosition = currentVehiclePosition;
      return;
    }

    const translationDelta = currentVehiclePosition
      .clone()
      .sub(this.cameraFollowPreviousVehiclePosition);
    this.cameraFollowPreviousVehiclePosition.copy(currentVehiclePosition);
    if (!this.isReady || translationDelta.lengthSq() <= 1e-12) {
      return;
    }

    const camera = this.viewer?.camera || null;
    const controls = this.viewer?.controls || null;
    if (!camera || !controls) {
      return;
    }

    camera.position.add(translationDelta);
    controls.target.add(translationDelta);
    if (this.viewer.goalTarget?.isVector3) {
      this.viewer.goalTarget.add(translationDelta);
    }
    controls.update();
  }

  getCameraProjectedBoundsOccupancy(bounds) {
    const camera = this.viewer?.camera || null;
    if (!camera || !bounds || bounds.isEmpty()) {
      return 0;
    }

    camera.updateMatrixWorld(true);
    const projectedCorners = [];
    [bounds.min.x, bounds.max.x].forEach((x) => {
      [bounds.min.y, bounds.max.y].forEach((y) => {
        [bounds.min.z, bounds.max.z].forEach((z) => {
          projectedCorners.push(new THREE.Vector3(x, y, z).project(camera));
        });
      });
    });
    const minX = Math.min(...projectedCorners.map((corner) => corner.x));
    const maxX = Math.max(...projectedCorners.map((corner) => corner.x));
    const minY = Math.min(...projectedCorners.map((corner) => corner.y));
    const maxY = Math.max(...projectedCorners.map((corner) => corner.y));
    return Math.max((maxX - minX) * 0.5, (maxY - minY) * 0.5);
  }

  isBoundsOutsideCameraView(bounds) {
    const camera = this.viewer?.camera || null;
    if (!camera || !bounds || bounds.isEmpty()) {
      return false;
    }

    camera.updateMatrixWorld(true);
    const projectedCorners = [];
    let hasCornerInFrontOfCamera = false;
    [bounds.min.x, bounds.max.x].forEach((x) => {
      [bounds.min.y, bounds.max.y].forEach((y) => {
        [bounds.min.z, bounds.max.z].forEach((z) => {
          const corner = new THREE.Vector3(x, y, z);
          const cameraSpaceCorner = corner
            .clone()
            .applyMatrix4(camera.matrixWorldInverse);
          hasCornerInFrontOfCamera ||= cameraSpaceCorner.z < -camera.near;
          projectedCorners.push(corner.project(camera));
        });
      });
    });

    if (!hasCornerInFrontOfCamera) {
      return true;
    }

    const minX = Math.min(...projectedCorners.map((corner) => corner.x));
    const maxX = Math.max(...projectedCorners.map((corner) => corner.x));
    const minY = Math.min(...projectedCorners.map((corner) => corner.y));
    const maxY = Math.max(...projectedCorners.map((corner) => corner.y));
    return maxX < -1 || minX > 1 || maxY < -1 || minY > 1;
  }

  centerCameraOnBounds(bounds) {
    const camera = this.viewer?.camera || null;
    const controls = this.viewer?.controls || null;
    if (!camera || !controls || !bounds || bounds.isEmpty()) {
      return;
    }

    const centerOffset = bounds
      .getCenter(new THREE.Vector3())
      .sub(controls.target);
    camera.position.add(centerOffset);
    controls.target.add(centerOffset);
    if (this.viewer.goalTarget?.isVector3) {
      this.viewer.goalTarget.add(centerOffset);
    }
    controls.update();
  }

  fitInitialCameraToVehicle() {
    if (
      this.hasFitInitialVehicleCamera ||
      !this.viewer?.isInitialCameraPoseReady ||
      !this.viewer.camera ||
      !this.viewer.controls ||
      !this.carFrame
    ) {
      return false;
    }

    const bounds = this.computeChassisBounds(
      this.carFrame,
      this.viewer.robotModel?.links || null,
    );
    if (!bounds || bounds.isEmpty()) {
      return false;
    }

    if (this.viewer.hasStoredCameraPose) {
      if (this.isBoundsOutsideCameraView(bounds)) {
        this.centerCameraOnBounds(bounds);
      }
      this.viewer.snapshotInitialCameraPose?.();
      this.hasFitInitialVehicleCamera = true;
      return true;
    }

    const camera = this.viewer.camera;
    const controls = this.viewer.controls;
    const center = bounds.getCenter(new THREE.Vector3());
    const cameraDirection = camera.position.clone().sub(controls.target);
    if (cameraDirection.lengthSq() <= 1e-8) {
      cameraDirection.set(1, 0, 0);
    }
    cameraDirection.normalize();

    const viewDirection = cameraDirection.clone().negate();
    const cameraRight = new THREE.Vector3().crossVectors(
      viewDirection,
      camera.up,
    );
    if (cameraRight.lengthSq() <= 1e-8) {
      cameraRight.crossVectors(viewDirection, new THREE.Vector3(0, 1, 0));
    }
    if (cameraRight.lengthSq() <= 1e-8) {
      cameraRight.crossVectors(viewDirection, new THREE.Vector3(1, 0, 0));
    }
    cameraRight.normalize();
    const cameraUp = new THREE.Vector3()
      .crossVectors(cameraRight, viewDirection)
      .normalize();
    const halfVerticalFovTangent = Math.tan(
      THREE.MathUtils.degToRad(camera.fov) * 0.5,
    );
    const halfHorizontalFovTangent = halfVerticalFovTangent * camera.aspect;
    let cameraDistance = 0.01;

    [bounds.min.x, bounds.max.x].forEach((x) => {
      [bounds.min.y, bounds.max.y].forEach((y) => {
        [bounds.min.z, bounds.max.z].forEach((z) => {
          const cornerOffset = new THREE.Vector3(x, y, z).sub(center);
          const distanceAlongCameraDirection =
            cornerOffset.dot(cameraDirection);
          const horizontalDistance =
            distanceAlongCameraDirection +
            Math.abs(cornerOffset.dot(cameraRight)) /
              (INITIAL_VEHICLE_CAMERA_OCCUPANCY * halfHorizontalFovTangent);
          const verticalDistance =
            distanceAlongCameraDirection +
            Math.abs(cornerOffset.dot(cameraUp)) /
              (INITIAL_VEHICLE_CAMERA_OCCUPANCY * halfVerticalFovTangent);
          cameraDistance = Math.max(
            cameraDistance,
            horizontalDistance,
            verticalDistance,
          );
        });
      });
    });

    controls.target.copy(center);
    this.viewer.goalTarget?.copy(center);
    controls.minDistance = cameraDistance * 0.2;
    controls.maxDistance = cameraDistance * 8;
    camera.position
      .copy(center)
      .addScaledVector(cameraDirection, cameraDistance);
    controls.update();

    camera.near = Math.max(cameraDistance / 100, 0.01);
    camera.far = Math.max(cameraDistance * 100, 10);
    camera.updateProjectionMatrix();
    this.viewer.resetDirectionalLight?.(
      controls.target,
      Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.001),
    );
    this.viewer.snapshotInitialCameraPose?.();
    this.viewer.logCameraInfos?.(true);
    this.hasFitInitialVehicleCamera = true;
    return true;
  }

  // Builds one tree's geometry/materials from scratch. Called once to make the shared
  // template (see getSceneTreeTemplate); every on-screen tree after that is a .clone(),
  // which shares the template's geometry/material buffers instead of allocating its own.
  buildSceneTreeMesh(treeHeight) {
    const treeGroup = new THREE.Group();
    treeGroup.name = "simulation-scene-tree";
    const trunkMaterial = new THREE.MeshStandardMaterial({
      color: 0x70442b,
      roughness: 1,
    });
    const branchUp = new THREE.Vector3(0, 1, 0);
    const addWoodSegment = (start, end, startRadius, endRadius) => {
      const direction = end.clone().sub(start);
      const segmentLength = direction.length();
      const segment = new THREE.Mesh(
        new THREE.CylinderGeometry(endRadius, startRadius, segmentLength, 9),
        trunkMaterial,
      );
      segment.position.copy(start).add(end).multiplyScalar(0.5);
      segment.quaternion.setFromUnitVectors(branchUp, direction.normalize());
      treeGroup.add(segment);
    };

    [
      [[0, 0, 0], [0.015, 0, 0.3], 0.058, 0.047],
      [[0.015, 0, 0.3], [-0.012, 0.008, 0.55], 0.047, 0.036],
      [[-0.012, 0.008, 0.55], [0.035, -0.004, 0.76], 0.036, 0.027],
      [[0.035, -0.004, 0.76], [0.018, 0.012, 0.94], 0.027, 0.014],
    ].forEach(([start, end, startRadius, endRadius]) => {
      addWoodSegment(
        new THREE.Vector3(...start).multiplyScalar(treeHeight),
        new THREE.Vector3(...end).multiplyScalar(treeHeight),
        treeHeight * startRadius,
        treeHeight * endRadius,
      );
    });

    const branchDefinitions = [
      [[-0.005, 0.005, 0.48], [-0.3, 0.035, 0.56], 0.026],
      [[-0.012, 0.008, 0.57], [0.29, -0.045, 0.65], 0.024],
      [[0.022, 0, 0.67], [-0.22, -0.15, 0.75], 0.021],
      [[0.035, -0.004, 0.74], [0.2, 0.14, 0.82], 0.018],
      [[0.02, 0.008, 0.84], [-0.12, 0.1, 0.9], 0.014],
    ];
    branchDefinitions.forEach(([start, end, radius]) => {
      const startPoint = new THREE.Vector3(...start).multiplyScalar(treeHeight);
      const endPoint = new THREE.Vector3(...end).multiplyScalar(treeHeight);
      addWoodSegment(
        startPoint,
        endPoint,
        treeHeight * radius,
        treeHeight * radius * 0.42,
      );
      const twigDirection = endPoint
        .clone()
        .sub(startPoint)
        .multiplyScalar(0.32);
      const twigEnd = endPoint
        .clone()
        .add(twigDirection)
        .add(new THREE.Vector3(0, 0, treeHeight * 0.035));
      addWoodSegment(
        endPoint,
        twigEnd,
        treeHeight * radius * 0.42,
        treeHeight * radius * 0.18,
      );
    });

    const needleMaterials = [0x1d5631, 0x28683a, 0x347846].map(
      (color) =>
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.97,
        }),
    );
    [
      [-0.38, 0.045, 0.59, 1.35, 0.7, 0.42, 0],
      [-0.27, -0.015, 0.61, 1.0, 0.66, 0.38, 1],
      [0.38, -0.065, 0.68, 1.35, 0.72, 0.4, 1],
      [0.27, 0.02, 0.7, 0.9, 0.65, 0.36, 2],
      [-0.28, -0.2, 0.78, 1.18, 0.78, 0.4, 0],
      [-0.12, -0.09, 0.8, 0.9, 0.66, 0.36, 1],
      [0.27, 0.19, 0.85, 1.05, 0.72, 0.38, 2],
      [-0.13, 0.13, 0.92, 0.88, 0.68, 0.4, 1],
      [0.02, 0.02, 0.96, 0.82, 0.7, 0.44, 0],
    ].forEach(([x, y, z, scaleX, scaleY, scaleZ, materialIndex]) => {
      const needleCluster = new THREE.Mesh(
        new THREE.IcosahedronGeometry(treeHeight * 0.115, 1),
        needleMaterials[materialIndex],
      );
      needleCluster.position.set(
        treeHeight * x,
        treeHeight * y,
        treeHeight * z,
      );
      needleCluster.scale.set(scaleX, scaleY, scaleZ);
      needleCluster.rotation.z = (x - y) * 1.8;
      treeGroup.add(needleCluster);
    });

    return treeGroup;
  }

  // Draws "COBOT SYSTEM" onto a canvas and wraps it as a texture for the sign panel below.
  // Sized with generous blank margin around the text on every side (unlike a tight,
  // edge-to-edge label) to read like an engraved milestone plaque rather than a road
  // sign. Built once and reused for the life of the single sign instance (see
  // buildCobotSystemSignMesh / ensureCobotSystemSign).
  createCobotSystemSignTexture() {
    const canvas = document.createElement("canvas");
    // Top/bottom margin is (canvas.height - text height) / 2; halving canvas.height's
    // slack over the text (220 -> 140) halves that margin while leaving the font size
    // and left/right margin (canvas.width, unchanged) alone.
    canvas.width = COBOT_SYSTEM_SIGN_TEXTURE_WIDTH_PX;
    canvas.height = COBOT_SYSTEM_SIGN_TEXTURE_HEIGHT_PX;
    const context = canvas.getContext("2d");
    context.fillStyle = `#${COBOT_SYSTEM_SIGN_BACKGROUND_COLOR.toString(16).padStart(6, "0")}`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const borderMargin = COBOT_SYSTEM_SIGN_TEXTURE_BORDER_MARGIN_PX;
    context.lineWidth = 6;
    context.strokeStyle = "#5c5346";
    context.strokeRect(
      borderMargin,
      borderMargin,
      canvas.width - borderMargin * 2,
      canvas.height - borderMargin * 2,
    );
    context.fillStyle = "#3a3428";
    context.font = "bold 52px 'Trebuchet MS', 'Segoe UI', sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("COBOT SYSTEM", canvas.width / 2, canvas.height / 2 + 2);

    const texture = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) {
      texture.colorSpace = THREE.SRGBColorSpace;
    }
    return texture;
  }

  // Builds the single static "COBOT SYSTEM" marker: just the text plaque itself (no
  // post/milestone body), standing upright with its bottom edge planted at the group's
  // local origin (so ensureCobotSystemSign can position that origin on the ground).
  // Unlike scene trees there's only ever one instance, so this is called once and reused
  // (see ensureCobotSystemSign). Sized off signHeightMeters (see ensureCobotSystemSign -
  // derived from the same vehicle-relative height as scene trees) rather than a fixed
  // real-world size, so it stays in scale with the vehicle/trees.
  buildCobotSystemSignMesh(signHeightMeters) {
    const signGroup = new THREE.Group();
    signGroup.name = "simulation-cobot-system-sign";

    // Matches the sign texture's aspect ratio so the plaque doesn't stretch it. Halved
    // from the original vehicle-relative size per request.
    const panelWidthMeters = signHeightMeters * 0.5;
    const panelHeightMeters =
      panelWidthMeters *
      (COBOT_SYSTEM_SIGN_TEXTURE_HEIGHT_PX / COBOT_SYSTEM_SIGN_TEXTURE_WIDTH_PX);
    // A physical plaque, not a paper-thin plane - a modest board thickness.
    const panelThicknessMeters = panelWidthMeters * 0.06;

    // BoxGeometry face material order is [+X, -X, +Y, -Y, +Z, -Z] (local axes, before the
    // rotation below is applied). The text goes on local +Z (the face that ends up
    // pointing world +Y, readable head-on from +Y - see the rotation comment); every
    // other face (the 4 edge faces plus the back) shares the same plain color as the
    // texture's own background (see COBOT_SYSTEM_SIGN_BACKGROUND_COLOR) so the whole
    // board reads as one uniform color instead of a two-tone frame.
    const plainMaterial = new THREE.MeshStandardMaterial({
      color: COBOT_SYSTEM_SIGN_BACKGROUND_COLOR,
      roughness: 0.85,
    });
    const frontMaterial = new THREE.MeshBasicMaterial({
      map: this.createCobotSystemSignTexture(),
    });
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(
        panelWidthMeters,
        panelHeightMeters,
        panelThicknessMeters,
      ),
      [
        plainMaterial,
        plainMaterial,
        plainMaterial,
        plainMaterial,
        frontMaterial,
        plainMaterial,
      ],
    );
    // Four corner "mounting screw" heads on the front face, like a plaque bolted to its
    // post - plain flat circles (a thin disc, not a raised button), centered in the band
    // between the box's outer edge and the texture's inner border rectangle. Both
    // margins work out equal in world units: the border is the same 16px on both canvas
    // axes, and the panel's aspect ratio matches the canvas's, so 16px maps to the same
    // physical distance on X and Y. Added as children of panel (in the box's own local,
    // pre-rotation frame) so they ride along with panel's rotation/position below.
    const borderMarginMeters =
      panelWidthMeters *
      (COBOT_SYSTEM_SIGN_TEXTURE_BORDER_MARGIN_PX / COBOT_SYSTEM_SIGN_TEXTURE_WIDTH_PX);
    const screwInsetMeters = borderMarginMeters / 2;
    const screwRadiusMeters = borderMarginMeters * 0.4 * (2 / 3);
    const screwDepthMeters = screwRadiusMeters * 0.3;
    const screwGeometry = new THREE.CylinderGeometry(
      screwRadiusMeters,
      screwRadiusMeters,
      screwDepthMeters,
      24,
    );
    const screwMaterial = new THREE.MeshStandardMaterial({
      color: 0x4b4f56,
      roughness: 0.4,
      metalness: 0.7,
    });
    [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ].forEach(([signX, signY]) => {
      const screw = new THREE.Mesh(screwGeometry, screwMaterial);
      // CylinderGeometry's axis is local Y by default; rotate it onto local Z so it
      // stands proud of the front face (local +Z, same face the text texture is on).
      screw.rotation.x = Math.PI / 2;
      screw.position.set(
        signX * (panelWidthMeters / 2 - screwInsetMeters),
        signY * (panelHeightMeters / 2 - screwInsetMeters),
        panelThicknessMeters / 2 + screwDepthMeters / 2 - 0.0005,
      );
      panel.add(screw);
    });

    // A flat plane's local +Z is its normal (front face); rotation.x alone would stand it
    // up facing -Y; adding rotation.y = PI spins it 180 deg around its own vertical axis
    // first, so the text face (local +Z) ends up facing +Y instead - readable head-on
    // from +Y, per request - while "up" still maps to world Z (text stays right-side up).
    panel.rotation.set(Math.PI / 2, Math.PI, 0);
    panel.position.z = panelHeightMeters / 2;
    signGroup.add(panel);

    return signGroup;
  }

  // The grid (and this sign's position) is only rebuilt at load/reset - see
  // addGroundSurfaceGrid(), which snapshots cobotSystemSignPosition there. Falls back to
  // a live read only if the sign is asked for before the grid has ever been built once.
  getCobotSystemSignPosition() {
    if (this.cobotSystemSignPosition) {
      return this.cobotSystemSignPosition;
    }
    const gridOrigin = this.getGroundGridOriginXY();
    return new THREE.Vector2(
      0,
      gridOrigin.y + this.getWheelCircumferenceMeters() * 5,
    );
  }

  // Lazily builds (once) and (re)positions the single "COBOT SYSTEM" signpost at
  // getCobotSystemSignPosition() (frozen alongside the tree/grid origin in
  // addGroundSurfaceGrid() - see there for why this must not track the vehicle).
  ensureCobotSystemSign() {
    if (!this.viewer?.scene) {
      return;
    }

    if (!this.cobotSystemSignGroup) {
      // Same vehicle-relative height scene trees use (see getSceneTreeHeightMeters) -
      // returns null until the vehicle's chassis bounds are measurable, in which case
      // building is retried from scheduleInitialVehicleCameraFit()'s success callback
      // (same as ensureSceneTree()).
      const treeHeight = this.getSceneTreeHeightMeters();
      if (!treeHeight) {
        return;
      }
      this.cobotSystemSignGroup = this.buildCobotSystemSignMesh(treeHeight * 0.95);
    }
    if (!this.cobotSystemSignGroup.parent) {
      this.viewer.scene.add(this.cobotSystemSignGroup);
    }

    const position = this.getCobotSystemSignPosition();
    this.cobotSystemSignGroup.position.set(
      position.x,
      position.y,
      this.groundZ + 0.002,
    );
    this.cobotSystemSignGroup.updateMatrixWorld(true);
  }

  getSceneTreeHeightMeters() {
    const vehicleBounds = this.computeChassisBounds(
      this.carFrame,
      this.viewer?.robotModel?.links || null,
    );
    if (!vehicleBounds || vehicleBounds.isEmpty()) {
      return null;
    }

    const vehicleHeight = vehicleBounds.getSize(new THREE.Vector3()).z;
    return THREE.MathUtils.clamp(vehicleHeight * 1.2, 0.45, 1.1);
  }

  // Lazily built once and reused via .clone() for every tree instance thereafter (vehicle
  // size, and so tree height, doesn't change during a session).
  getSceneTreeTemplate() {
    if (this.sceneTreeTemplate) {
      return this.sceneTreeTemplate;
    }

    const treeHeight = this.getSceneTreeHeightMeters();
    if (!treeHeight) {
      return null;
    }

    this.sceneTreeTemplate = this.buildSceneTreeMesh(treeHeight);
    return this.sceneTreeTemplate;
  }

  ensureSceneTree() {
    // Historic entry point (called once the initial camera fit completes); just forces an
    // immediate row population instead of waiting for the next throttled tick.
    this.updateSceneTreePlacement(performance.now(), true);
  }

  getGroundPositionAtCameraView(viewPosition) {
    const camera = this.viewer?.camera || null;
    if (!camera || !viewPosition) {
      return null;
    }

    camera.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(viewPosition, camera);
    return raycaster.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.groundZ),
      new THREE.Vector3(),
    );
  }

  // Trees recycle onto a fixed world-X lattice spaced 10 ground-grid cells apart (the grid
  // cell itself already tracks the wheel circumference dynamically), so the same tree mesh
  // can be repositioned onto whichever lattice slot is due, instead of allocating one tree
  // per slot up front.
  getSceneTreeXGridSpacingMeters() {
    return Math.max(this.getWheelCircumferenceMeters() * 10, 0.5);
  }

  // The grid (and the tree lattice phased from it) is only rebuilt at load/reset - see
  // addGroundSurfaceGrid(), which snapshots sceneTreeGridOriginX/Y there (with the same
  // +5-grid-cell phase offset applied). Falls back to a live read only if trees are asked
  // for before the grid has ever been built once.
  getSceneTreeGridOriginX() {
    if (this.sceneTreeGridOriginX != null) {
      return this.sceneTreeGridOriginX;
    }
    return (
      this.getGroundGridOriginXY().x + this.getWheelCircumferenceMeters() * 5
    );
  }

  getSceneTreeGridOriginY() {
    return this.sceneTreeGridOriginY ?? this.getGroundGridOriginXY().y;
  }

  // Removes every pooled tree so the next update() rebuilds from scratch against the
  // current (just-frozen) lattice origin - needed after a reset, where the grid's phase
  // may have shifted, so old trees would otherwise sit off the new grid lines forever.
  resetSceneTreePool() {
    if (this.viewer?.scene) {
      this.sceneTreeGroupsByLatticeX.forEach((treeGroup) => {
        this.viewer.scene.remove(treeGroup);
      });
    }
    this.sceneTreeGroupsByLatticeX.clear();
  }

  // Snaps onto the SAME lattice the rendered ground grid uses: addGroundSurfaceGrid()
  // phases its lines from getGroundGridOriginXY() (the front-wheel contact point at
  // load/reset), not world X=0, so trees must snap from that same origin or they drift
  // out of phase with the visible grid lines instead of sitting on every 10th one.
  snapWorldXToSceneTreeGrid(worldX) {
    const xSpacingMeters = this.getSceneTreeXGridSpacingMeters();
    const originX = this.getSceneTreeGridOriginX();
    return (
      originX +
      Math.round((worldX - originX) / xSpacingMeters) * xSpacingMeters
    );
  }

  isSceneTreeSlotVisible(x, y, treeHeight, halfSlotMeters) {
    const bounds = new THREE.Box3(
      new THREE.Vector3(x - halfSlotMeters, y - halfSlotMeters, this.groundZ),
      new THREE.Vector3(
        x + halfSlotMeters,
        y + halfSlotMeters,
        this.groundZ + treeHeight,
      ),
    );
    return !this.isBoundsOutsideCameraView(bounds);
  }

  // Walks outward from the vehicle's own lattice column at a given shared Y, collecting
  // every column that's actually on screen there (stopping each direction after 2 misses
  // in a row), capped at SCENE_TREE_MAX_COUNT.
  collectVisibleSceneTreeColumnsAtY(y, startX, xSpacingMeters, treeHeight) {
    const halfSlotMeters = xSpacingMeters * 0.25;
    const xs = [];
    if (this.isSceneTreeSlotVisible(startX, y, treeHeight, halfSlotMeters)) {
      xs.push(startX);
    }
    [1, -1].forEach((direction) => {
      let consecutiveMisses = 0;
      for (
        let step = 1;
        consecutiveMisses < 2 && xs.length < SCENE_TREE_MAX_COUNT;
        step += 1
      ) {
        const x = startX + direction * step * xSpacingMeters;
        if (this.isSceneTreeSlotVisible(x, y, treeHeight, halfSlotMeters)) {
          xs.push(x);
          consecutiveMisses = 0;
        } else {
          consecutiveMisses += 1;
        }
      }
    });
    return xs;
  }

  // Deterministic and constant for the whole session (until the next load/reset): exactly
  // 10 grid cells behind the frozen grid origin on Y, the same way tree X snaps to every
  // 10th cell from that origin. No per-frame camera probing, so every tree - now and
  // later - sits on this exact same Y.
  getSceneTreeRowY() {
    return this.getSceneTreeGridOriginY() - this.getSceneTreeXGridSpacingMeters();
  }

  // Determines which lattice columns should show a tree right now, all on the one fixed
  // row Y (see getSceneTreeRowY).
  getVisibleSceneTreeRowPlacement() {
    if (!this.carFrame) {
      return null;
    }

    this.carFrame.updateWorldMatrix(true, false);
    const vehiclePosition = this.carFrame.getWorldPosition(new THREE.Vector3());
    const treeHeight = this.getSceneTreeHeightMeters();
    if (!treeHeight) {
      return null;
    }

    const xSpacingMeters = this.getSceneTreeXGridSpacingMeters();
    const startX = this.snapWorldXToSceneTreeGrid(vehiclePosition.x);
    const rowY = this.getSceneTreeRowY();

    const xs = this.collectVisibleSceneTreeColumnsAtY(
      rowY,
      startX,
      xSpacingMeters,
      treeHeight,
    );
    return xs.length > 0 ? { y: rowY, xs } : null;
  }

  updateSceneTreePlacement(nowMs = performance.now(), forceUpdate = false) {
    if (!this.viewer?.scene) {
      return;
    }
    if (
      !forceUpdate &&
      nowMs - this.sceneTreeLastVisibilityCheckAtMs <
        SCENE_TREE_VISIBILITY_CHECK_INTERVAL_MS
    ) {
      return;
    }
    this.sceneTreeLastVisibilityCheckAtMs = nowMs;

    const template = this.getSceneTreeTemplate();
    const placement = this.getVisibleSceneTreeRowPlacement();
    if (!template || !placement) {
      return;
    }

    const treeZ = this.groundZ + 0.002;
    const desiredKeys = new Set();
    placement.xs.forEach((x) => {
      const key = x.toFixed(3);
      desiredKeys.add(key);

      // A tree's position is set once, at creation, and never touched again - an already
      // visible tree must not drift/slide as the vehicle moves, only newly spawned ones
      // get placed.
      if (this.sceneTreeGroupsByLatticeX.has(key)) {
        return;
      }

      const treeGroup = template.clone();
      treeGroup.position.set(x, placement.y, treeZ);
      treeGroup.updateMatrixWorld(true);
      this.viewer.scene.add(treeGroup);
      this.sceneTreeGroupsByLatticeX.set(key, treeGroup);
    });

    // Prune slots that scrolled out of view so the pool tracks what's on screen rather than
    // growing without bound. Geometry/materials are shared with the template, so removing
    // from the scene (no dispose) is enough to free this instance.
    Array.from(this.sceneTreeGroupsByLatticeX.keys()).forEach((key) => {
      if (desiredKeys.has(key)) {
        return;
      }
      const staleTreeGroup = this.sceneTreeGroupsByLatticeX.get(key);
      this.viewer.scene.remove(staleTreeGroup);
      this.sceneTreeGroupsByLatticeX.delete(key);
    });
  }

  scheduleInitialVehicleCameraFit() {
    if (
      this.hasFitInitialVehicleCamera ||
      this.isInitialVehicleCameraFitScheduled
    ) {
      return;
    }

    this.isInitialVehicleCameraFitScheduled = true;
    const attemptFit = () => {
      if (this.fitInitialCameraToVehicle()) {
        this.isInitialVehicleCameraFitScheduled = false;
        this.ensureSceneTree();
        this.ensureCobotSystemSign();
        return;
      }
      requestAnimationFrame(attemptFit);
    };
    requestAnimationFrame(attemptFit);
  }

  ensureVehicleDirectionArrows() {
    if (this.vehicleDirectionArrowGroup?.parent || !this.viewer?.scene) {
      return;
    }

    const halfX = Math.max(Number(this.vehicleHalfExtents?.x) || 0.3, 0.2);
    const halfZ = Math.max(Number(this.vehicleHalfExtents?.z) || 0.2, 0.1);
    const arrowCenterX = Number(this.vehicleColliderLocalCenter.x) || 0;
    const arrowOriginX = arrowCenterX + halfX + 0.04;
    const arrowHeight =
      (Number(this.vehicleColliderLocalCenter.z) || 0) + halfZ * 0.75;
    const arrowShaftRadius = 0.012;
    const arrowHeadBaseRadius = 0.024;
    const arrowShaftLength = Math.max(halfX * 0.35, 0.105);
    const arrowHeadLength = Math.min(
      Math.max(arrowShaftLength * 0.45, 0.05),
      0.08,
    );
    const arrowMaterial = new THREE.ShaderMaterial({
      fog: false,
      toneMapped: false,
      side: THREE.DoubleSide,
      // Normal depth test/write: the arrow is scene geometry sitting just in front of
      // the vehicle, not a screen-space gizmo, so it's expected to be occluded by the
      // body when actually behind it from the current viewing angle (e.g. side-on).
      // depthTest: false was tried to keep it visible from near-front angles, but it
      // read as the arrow going translucent instead of fixing anything, so it's been
      // dropped - the front-angle disappearing case, if it recurs, needs a different fix
      // (e.g. moving the arrow further out, or accepting foreshortening from head-on).
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

  ensureWheelGroundContactMarkers() {
    if (this.wheelGroundContactMarkerGroup?.parent || !this.viewer?.scene) {
      return;
    }

    const markerGroup = new THREE.Group();
    markerGroup.name = "simulation-wheel-ground-contact-markers";
    const markerGeometry = new THREE.CircleGeometry(1, 32);
    ["fl", "fr", "rl", "rr"].forEach((wheelKey) => {
      const marker = new THREE.Mesh(
        markerGeometry,
        new THREE.MeshBasicMaterial({
          color: 0xfacc15,
          depthTest: true,
          depthWrite: false,
          transparent: true,
          opacity: 0.42,
        }),
      );
      marker.name = `simulation-wheel-ground-contact-${wheelKey}`;
      marker.renderOrder = 10;
      markerGroup.add(marker);
      this.wheelGroundContactMarkerByKey[wheelKey] = marker;
    });

    this.wheelGroundContactMarkerGroup = markerGroup;
    this.viewer.scene.add(markerGroup);
    this.syncWheelGroundContactMarkers();
  }

  syncWheelGroundContactMarkers() {
    if (!this.wheelGroundContactMarkerGroup) {
      return;
    }

    const supportProfile =
      this.lastWheelSupportProfile || this.getWheelSupportProfile();

    Object.entries(this.wheelGroundContactMarkerByKey).forEach(
      ([wheelKey, marker]) => {
        const wheelCollider = this.wheelCollidersByKey?.[wheelKey] || null;
        const wheelLink = this.findLinkByName(
          this.vehicleModel.links,
          this.wheelLinkNameByKey[wheelKey],
        );
        if (!marker || (!wheelCollider && !wheelLink)) {
          if (marker) {
            marker.visible = false;
          }
          return;
        }

        const wheelBounds = wheelLink
          ? this.computeLinkOwnBounds(wheelLink, this.vehicleModel.links)
          : null;
        const wheelPosition = wheelBounds?.isEmpty()
          ? null
          : wheelBounds?.getCenter(new THREE.Vector3());
        const fallbackWheelPosition = wheelCollider?.translation() || null;
        const shadowX = wheelPosition?.x ?? fallbackWheelPosition?.x;
        const shadowY = wheelPosition?.y ?? fallbackWheelPosition?.y;
        if (!Number.isFinite(shadowX) || !Number.isFinite(shadowY)) {
          marker.visible = false;
          return;
        }
        const yaw = this.body
          ? this.extractYawFromQuaternion(this.body.rotation())
          : 0;
        const supportZ = Number(supportProfile?.supportZByKey?.[wheelKey]);
        const markerZ = Number.isFinite(supportZ)
          ? supportZ + 0.003
          : this.groundZ + 0.003;
        const isGroundContact =
          Math.abs(Number(supportProfile?.liftByKey?.[wheelKey]) || 0) <=
          WHEEL_SUPPORT_MIN_LIFT_METERS;
        marker.position.set(shadowX, shadowY, markerZ);
        marker.rotation.z = yaw;
        marker.scale.set(
          isGroundContact ? 0.12 : 0.09,
          isGroundContact ? 0.06 : 0.045,
          1,
        );
        marker.material.color.set(isGroundContact ? 0xfacc15 : 0x6c757d);
        marker.material.opacity = isGroundContact ? 0.42 : 0.62;
        marker.visible = true;
      },
    );
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

    // A filled pie slice from angle 0 (initial heading) to the current accumulated
    // yawDelta: one shared center vertex plus arcSegments+1 rim vertices, all
    // preallocated - how much of the pie is actually drawn is controlled by
    // setDrawRange() each frame in syncVehicleYawIndicator(), the same way the old arc
    // line's visible length was.
    const pieVertexCount = arcSegments + 2;
    const pieGeometry = new THREE.BufferGeometry();
    pieGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(pieVertexCount * 3), 3),
    );
    const pieIndex = new Uint16Array(arcSegments * 3);
    for (let segmentIndex = 0; segmentIndex < arcSegments; segmentIndex += 1) {
      pieIndex[segmentIndex * 3] = 0;
      pieIndex[segmentIndex * 3 + 1] = segmentIndex + 1;
      pieIndex[segmentIndex * 3 + 2] = segmentIndex + 2;
    }
    pieGeometry.setIndex(new THREE.BufferAttribute(pieIndex, 1));
    pieGeometry.setDrawRange(0, 0);

    const pieMesh = new THREE.Mesh(
      pieGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x00a8ff,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        fog: false,
        toneMapped: false,
      }),
    );

    const indicatorGroup = new THREE.Group();
    indicatorGroup.name = "simulation-vehicle-yaw-indicator";
    indicatorGroup.add(pieMesh);

    indicatorGroup.userData.arcRadius = arcRadius;
    indicatorGroup.userData.arcSegments = arcSegments;
    this.vehicleYawTrailingRad = this.extractYawFromQuaternion(
      this.initialQuaternion,
    );
    this.vehicleYawIndicatorLastSyncMs = null;
    this.vehicleYawIndicatorGroup = indicatorGroup;
    this.vehicleYawPieMesh = pieMesh;
    this.viewer.scene.add(indicatorGroup);
    this.syncVehicleYawIndicator();
  }

  syncVehicleYawIndicator() {
    if (
      !this.vehicleYawIndicatorGroup ||
      !this.vehicleYawPieMesh ||
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
      (Number(this.vehicleColliderLocalCenter.z) || 0) + halfZ + 0.01,
    ).applyQuaternion(carQuaternion);
    const currentYaw = this.extractYawFromQuaternion(carQuaternion);

    // The pie's "start" (zero-angle) reference continuously chases the vehicle's own
    // current heading instead of staying pinned to wherever the vehicle started, so the
    // indicator reads as "how much have you been turning lately" rather than "total
    // rotation since load". RECENT_YAW_INDICATOR_TIME_CONSTANT_SEC sets how fast it
    // catches up: actively turning keeps the reference lagging behind (a visible pie
    // slice); holding a heading lets it fully catch up (the pie collapses to nothing).
    const nowMs = performance.now();
    if (!Number.isFinite(this.vehicleYawTrailingRad)) {
      this.vehicleYawTrailingRad = currentYaw;
    } else if (Number.isFinite(this.vehicleYawIndicatorLastSyncMs)) {
      const dtSec = THREE.MathUtils.clamp(
        (nowMs - this.vehicleYawIndicatorLastSyncMs) / 1000,
        0,
        0.2,
      );
      const catchUpAlpha =
        1 - Math.exp(-dtSec / RECENT_YAW_INDICATOR_TIME_CONSTANT_SEC);
      const gapFromTrailing = Math.atan2(
        Math.sin(currentYaw - this.vehicleYawTrailingRad),
        Math.cos(currentYaw - this.vehicleYawTrailingRad),
      );
      this.vehicleYawTrailingRad += gapFromTrailing * catchUpAlpha;
    }
    this.vehicleYawIndicatorLastSyncMs = nowMs;

    const trailingYaw = this.vehicleYawTrailingRad;
    // Small by construction (the trailing reference never lags far behind), so wrapping
    // to (-pi, pi] here is safe and doesn't need the unwrap-and-accumulate treatment a
    // *cumulative-since-start* version of this angle would.
    const yawDelta = Math.atan2(
      Math.sin(currentYaw - trailingYaw),
      Math.cos(currentYaw - trailingYaw),
    );
    const arcRadius = this.vehicleYawIndicatorGroup.userData.arcRadius;
    const arcSegments = this.vehicleYawIndicatorGroup.userData.arcSegments;

    this.vehicleYawIndicatorGroup.position.copy(carPosition).add(roofOffset);
    // Copy the roof's actual current orientation directly - same pattern as
    // syncVehicleDirectionArrows() - rather than trying to cancel currentYaw out of
    // carQuaternion and reapply trailingYaw in its place: that RotZ(-currentYaw) *
    // carQuaternion trick only exactly cancels the yaw component when yaw and the
    // roll/pitch tilt are the *only* rotation and don't interact, which isn't true in
    // general for a combined tilt+yaw orientation - it left the disc's own "yaw=0"
    // direction (and therefore the whole pie) very slightly misaligned from the
    // vehicle's actual current forward centerline whenever there was any roof tilt.
    // Copying carQuaternion exactly removes that approximation entirely: local +X below
    // is now, always, exactly the vehicle's current forward direction.
    this.vehicleYawIndicatorGroup.quaternion.copy(carQuaternion);

    // Fill a pie slice from the trailing reference to the vehicle's current heading -
    // vertex 0 is the shared center, vertices 1..segmentCount+1 trace the rim; the index
    // buffer built in ensureVehicleYawIndicator() fans triangles out from the center to
    // each consecutive rim pair, so only drawing the first segmentCount*3 indices shows
    // exactly that much of the pie. Local angle 0 is now the group's own +X axis (the
    // vehicle's current forward direction, per the quaternion copy above), so the sweep
    // runs from -sweepDelta (the trailing reference) up to exactly 0 (current) instead
    // of 0..yawDelta the way it did when local +X was pinned to the trailing direction
    // instead.
    const sweepDelta = -yawDelta;
    const segmentCount = Math.min(
      arcSegments,
      Math.ceil((Math.abs(sweepDelta) / (Math.PI * 2)) * arcSegments),
    );
    const piePositions = this.vehicleYawPieMesh.geometry.attributes.position;
    piePositions.setXYZ(0, 0, 0, 0);
    for (let index = 0; index <= segmentCount; index += 1) {
      const t = segmentCount > 0 ? index / segmentCount : 0;
      const angle = sweepDelta * (t - 1);
      piePositions.setXYZ(
        index + 1,
        Math.cos(angle) * arcRadius,
        Math.sin(angle) * arcRadius,
        0,
      );
    }
    piePositions.needsUpdate = true;
    this.vehicleYawPieMesh.geometry.setDrawRange(0, segmentCount * 3);

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
      if (!obstacleInfo?.collider || obstacleInfo.isSensor) {
        this.setObstacleContactHighlight(obstacleInfo, false);
        return;
      }

      obstacleInfo.contactedWheelKeys =
        this.getObstacleContactedWheelKeys(obstacleInfo);
      const hasWheelSupport = obstacleInfo.contactedWheelKeys.length > 0;
      if (obstacleInfo.isDynamicSurfaceObstacle && hasWheelSupport) {
        obstacleInfo.hasDynamicVehicleContact = true;
      }
      // AABB overlap is intentionally retained as proximity for motion control, not UI contact.
      obstacleInfo.hasChassisProximity =
        this.isVehicleColliderContactingObstacle(obstacleInfo);

      // Red means a wheel is physically supported by this obstacle's top surface.
      // It never represents an AABB approach or an anticipated collision.
      this.setObstacleContactHighlight(obstacleInfo, hasWheelSupport);
      hasContact =
        hasContact || hasWheelSupport || obstacleInfo.hasChassisProximity;
    });

    if (
      this.dynamicPotholeRegion &&
      this.isVehicleOverHoleRegion(this.dynamicPotholeRegion)
    ) {
      this.dynamicPotholeRegion.hasDynamicVehicleContact = true;
    }
    if (this.isDynamicObstacleRemovalRequested) {
      void this.removePassedDynamicSurfaceObstacles();
    }

    if (hasContact !== this.isVehicleObstacleContact) {
      this.isVehicleObstacleContact = hasContact;
      console.log(
        `[URDF][Simulation] vehicle-obstacle contact: ${hasContact ? "ON" : "OFF"}`,
      );
    }

    return hasContact;
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
      this.alignVehicleToGroundByWheelGap(linkMap, 0);
      this.renderer.syncVehicle();
      this.resetWheelBodiesFromVisual();
      const groundedPosition = this.body.translation();
      const groundedRotation = this.body.rotation();
      this.initialPosition = new THREE.Vector3(
        groundedPosition.x,
        groundedPosition.y,
        groundedPosition.z,
      );
      this.initialQuaternion = new THREE.Quaternion(
        groundedRotation.x,
        groundedRotation.y,
        groundedRotation.z,
        groundedRotation.w,
      );
      this.addObstacleColliderFromUrdf();
      this.initializeWheelZChartRangeFromObstacles(linkMap);
      this.ensureVehicleDirectionArrows();
      this.ensureWheelGroundContactMarkers();
      this.ensureVehicleYawIndicator();
      this.resetWheelBodiesFromVisual();
      this.updateWheelGroundContactState();
      this.syncWheelGroundContactMarkers();
      this.resetWheelTravelTracking();
      this.syncWheelChartBaselineFromPhysics();
      this.isReady = true;
      this.hasFailed = false;
      this.lastStepTimeMs = 0;
      this.physicsAccumulatorSec = 0;
      this.resetPhysicalState();
      this.scheduleInitialVehicleCameraFit();
      void this.applyDynamicSurfaceObstacle(
        globalThis.latestSimulationSurfaceObstacle ?? 0,
      );

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

    const tractionScale =
      wheelGroundContactCount > 0 ? 1 : DRIVE_TRACTION_SCALE_AIRBORNE;
    const currentLinearVelocity = this.body.linvel();
    const currentAngularVelocity = this.body.angvel();
    const velocityErrorX = targetVelocityX - currentLinearVelocity.x;
    const velocityErrorY = targetVelocityY - currentLinearVelocity.y;
    const accelerationImpulseScale =
      Math.max(
        DRIVE_ACCEL_IMPULSE_BASE +
          Math.max(clampedSpeed, 0) * DRIVE_ACCEL_IMPULSE_SPEED_GAIN,
        DRIVE_ACCEL_IMPULSE_MIN,
      ) * tractionScale;
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
        Math.min(
          DRIVE_DRAG_BASE + currentSpeed * DRIVE_DRAG_SPEED_GAIN,
          DRIVE_DRAG_MAX,
        ) *
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
      const idleDragScale =
        DRIVE_IDLE_DRAG_SCALE * tractionScale * effectiveDeltaSec;
      this.body.applyImpulse(
        new this.rapier.Vector3(
          -currentLinearVelocity.x * idleDragScale,
          -currentLinearVelocity.y * idleDragScale,
          0,
        ),
        true,
      );
    }

    const steeringTorque =
      (Number.isFinite(steerSign) ? steerSign : 0) *
      DRIVE_STEERING_TORQUE_SCALE *
      tractionScale *
      effectiveDeltaSec;
    if (Math.abs(steeringTorque) > 1e-6) {
      this.body.applyTorqueImpulse(
        new this.rapier.Vector3(0, 0, steeringTorque),
        true,
      );
    }

    // Suppress unwanted rotation (yaw spin) caused by asymmetric wheel obstacle collision
    if (
      this.isVehicleObstacleContact &&
      Math.abs(steerSign) < STEER_SIGN_EPSILON
    ) {
      this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
    } else if (
      Math.abs(currentAngularVelocity.z) > 0.001 &&
      Math.abs(steerSign) < 1e-6
    ) {
      const yawDampingTorque =
        -currentAngularVelocity.z *
        DRIVE_YAW_DAMPING_SCALE *
        tractionScale *
        effectiveDeltaSec;
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

  updateWheelGroundContactState() {
    const supportProfile =
      this.lastWheelSupportProfile ||
      (this.lastWheelSupportProfile = this.getWheelSupportProfile());
    let contactCount = 0;

    // Rapier contact events toggle frame to frame on frictionless wheels; support height is stable.
    ["fl", "fr", "rl", "rr"].forEach((wheelKey) => {
      const lift = Number(supportProfile?.liftByKey?.[wheelKey]) || 0;
      const isContacting = lift <= WHEEL_SUPPORT_MIN_LIFT_METERS;
      this.wheelGroundContactState[wheelKey] = isContacting;
      if (isContacting) {
        contactCount += 1;
      }
    });

    return contactCount;
  }

  resolveDriveSigns(driveViewer) {
    const driveMode = String(
      this.commandedDriveMode ||
        driveViewer?.driveMode ||
        this.viewer?.driveMode ||
        "stop",
    );

    if (driveMode === "forward") {
      return { throttleSign: 1, steerSign: 0 };
    }
    if (driveMode === "backward") {
      return { throttleSign: -1, steerSign: 0 };
    }
    if (driveMode === "left") {
      return { throttleSign: 0, steerSign: 1 };
    }
    if (driveMode === "right") {
      return { throttleSign: 0, steerSign: -1 };
    }

    // No explicit mode: infer intent from the visual wheel rotation state.
    const wheelSides = this.getWheelSideSignedRpm();
    if (!wheelSides) {
      return { throttleSign: 0, steerSign: 0 };
    }

    const avgSignedRpm = (wheelSides.left + wheelSides.right) * 0.5;
    const rpmDifference = wheelSides.right - wheelSides.left;
    return {
      throttleSign:
        Math.abs(avgSignedRpm) > WHEEL_RPM_COMMAND_THRESHOLD
          ? Math.sign(avgSignedRpm)
          : 0,
      steerSign:
        Math.abs(rpmDifference) > WHEEL_RPM_COMMAND_THRESHOLD
          ? Math.sign(rpmDifference)
          : 0,
    };
  }

  refreshObstacleContactState() {
    const hasColliderContact =
      this.contactSolver.updateVehicleObstacleContact();
    const approachInfo = this.contactSolver.getApproachInfo();
    const isClimbApproach = this.contactSolver.isClimbApproach(
      approachInfo?.obstacleInfo || null,
    );

    this.isVehicleObstacleContact = Boolean(
      hasColliderContact || isClimbApproach,
    );
    return { hasColliderContact, approachInfo, isClimbApproach };
  }

  setBodyPlanarVelocity(targetVelocityX, targetVelocityY) {
    const velocity = this.body.linvel();
    this.body.setLinvel(
      new this.rapier.Vector3(targetVelocityX, targetVelocityY, velocity.z),
      true,
    );
  }

  applyCommandedBodyMotion(
    context,
    hasObstacleContact,
    isNearFlatGroundSupport,
  ) {
    const currentLinearVelocity = this.body.linvel();
    const currentAngularVelocity = this.body.angvel();
    const yaw = this.extractYawFromQuaternion(this.body.rotation());
    const forwardVector = this.getVehicleForwardVector(yaw);

    context.targetVelocityX =
      forwardVector.x * context.clampedSpeed * context.throttleSign;
    context.targetVelocityY =
      forwardVector.y * context.clampedSpeed * context.throttleSign;

    const nextVelocityZ =
      !hasObstacleContact && isNearFlatGroundSupport
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
        context.effectiveSteerSign !== 0 ? this.getCenterTurnYawRate() : 0,
      ),
      true,
    );
  }

  runPhysicsSubstep(context) {
    const fixedStepSec = this.physicsFixedTimeStepSec;
    const {
      throttleSign,
      effectiveSteerSign,
      targetVelocityX,
      targetVelocityY,
    } = context;
    const isStraightDrive =
      throttleSign !== 0 && Math.abs(effectiveSteerSign) < STEER_SIGN_EPSILON;

    const preStepApproach = this.contactSolver.getApproachInfo();
    const preStepClimbApproach = this.contactSolver.isClimbApproach(
      preStepApproach?.obstacleInfo || null,
    );
    const headingYaw = this.extractYawFromQuaternion(this.body.rotation());
    const referencePosition = this.body.translation();

    const preStepTraversalApproach =
      this.getObstacleTraversalApproachInfo()?.obstacleInfo || null;
    const preStepTraversalPath =
      this.activeObstacleTraversalPath ||
      (preStepTraversalApproach
        ? this.getObstacleTraversalPath(preStepTraversalApproach)
        : null);
    if (preStepTraversalPath) {
      this.activeObstacleTraversalPath = preStepTraversalPath;
    }

    const isTraversalControlActive = this.isObstacleTraversalActive();
    if (isTraversalControlActive || throttleSign !== 0) {
      this.setBodyPlanarVelocity(targetVelocityX, targetVelocityY);
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
          new this.rapier.Vector3(targetVelocityX, targetVelocityY, velocity.z),
          true,
        );
      });
      this.straightDriveWarmupSteps -= 1;
    }

    if (isStraightDrive) {
      this.stabilizeWheelBodiesForStraightDrive(
        targetVelocityX,
        targetVelocityY,
      );
    }

    if (!isTraversalControlActive) {
      this.applyDriveForces(
        fixedStepSec,
        targetVelocityX,
        targetVelocityY,
        throttleSign,
        effectiveSteerSign,
        context.clampedSpeed,
        context.wheelGroundContactCount,
      );
    }
    this.applyGroundSupportForces(
      fixedStepSec,
      context.wheelGroundContactCount,
      isTraversalControlActive,
    );
    this.syncObstacleColliderActivation(context.linkMap);

    this.physicsEngine.step(fixedStepSec);

    const supportProfile = this.getWheelSupportProfile();
    this.lastWheelSupportProfile = supportProfile;
    const isOnObstacleSupport = Boolean(
      supportProfile &&
      Math.abs(supportProfile.averageLift) > WHEEL_SUPPORT_MIN_LIFT_METERS,
    );
    context.wheelGroundContactCount =
      this.wheelController.updateGroundContactState();

    const hasObstacleContactNow =
      this.contactSolver.updateVehicleObstacleContact();
    const contactedObstacle =
      this.contactSolver.getApproachInfo()?.obstacleInfo || null;
    const postStepTraversalApproach =
      this.getObstacleTraversalApproachInfo()?.obstacleInfo || null;
    if (this.activeObstacleTraversalPath && !this.isObstacleTraversalActive()) {
      this.activeObstacleTraversalPath = null;
    }
    if (!this.activeObstacleTraversalPath && postStepTraversalApproach) {
      this.activeObstacleTraversalPath = this.getObstacleTraversalPath(
        postStepTraversalApproach,
      );
    }

    const isClimbingApproach =
      preStepClimbApproach ||
      this.contactSolver.isClimbApproach(
        contactedObstacle || preStepApproach?.obstacleInfo || null,
      );
    const isObstaclePathActive = this.contactSolver.isObstacleTraversalActive();
    const hasObstacleControl = Boolean(
      hasObstacleContactNow || isClimbingApproach || isObstaclePathActive,
    );
    this.isVehicleObstacleContact = hasObstacleControl;

    if (Math.abs(effectiveSteerSign) < STEER_SIGN_EPSILON) {
      this.preserveObstacleHeading(headingYaw);
      this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
      if (hasObstacleControl) {
        this.suppressObstacleLateralDrift(referencePosition, headingYaw);
        this.suppressObstacleLateralSlip();
      }
    }

    if (hasObstacleControl) {
      if (isStraightDrive) {
        this.setBodyPlanarVelocity(targetVelocityX, targetVelocityY);
      }
    } else {
      const velocity = this.body.linvel();
      if (Math.hypot(velocity.x, velocity.y) > 0.02) {
        this.body.setLinvel(
          new this.rapier.Vector3(
            velocity.x * DRIVE_FREE_ROLL_DECAY,
            velocity.y * DRIVE_FREE_ROLL_DECAY,
            velocity.z,
          ),
          true,
        );
      }

      if (isStraightDrive) {
        this.preserveObstacleHeading(headingYaw);
        this.setBodyPlanarVelocity(targetVelocityX, targetVelocityY);
        this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);

        // Lateral lock only; vertical position belongs to the wheel support plane.
        // Hold the straight line through the start point along the commanded heading.
        if (this.straightDriveReferencePose) {
          this.suppressObstacleLateralDrift(
            this.straightDriveReferencePose,
            this.straightDriveReferencePose.yaw,
          );
          this.preserveObstacleHeading(this.straightDriveReferencePose.yaw);
        }
      }
    }

    if (this.hasActivatedDynamicGroundClamp && !isOnObstacleSupport) {
      this.clampVehicleAboveGround();
    }

    if (!isOnObstacleSupport && !hasObstacleControl) {
      this.stabilizeFlatGroundVerticalMotion();
    }

    // Wheel support geometry is the single source of truth for ride height.
    this.applyWheelSupportRideHeight(supportProfile);
    this.updateWheelObstacleFlex(supportProfile, fixedStepSec);

    // Center turn must keep the 4-wheel center fixed on every substep, not just per frame.
    this.constrainCenterTurnPivot();

    this.renderer.syncVehicle();
    this.simulationElapsedSec += fixedStepSec;
    this.recordWheelZChartObstacleContactEvent(
      hasObstacleContactNow,
      this.simulationElapsedSec,
    );
    this.sampleWheelCenterZForChart(this.simulationElapsedSec);
  }

  finalizeObstacleFrame(context) {
    const hasObstacleContact =
      this.contactSolver.updateVehicleObstacleContact();

    const isClimbingApproach = this.contactSolver.isClimbApproach(
      context.obstacleApproach?.obstacleInfo || null,
    );
    this.isVehicleObstacleContact = Boolean(
      hasObstacleContact || isClimbingApproach,
    );
    if (
      this.isVehicleObstacleContact &&
      Math.abs(context.effectiveSteerSign) < STEER_SIGN_EPSILON
    ) {
      this.preserveObstacleHeading();
      this.suppressObstacleLateralSlip();
      this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
    }
    if (this.keepUprightOnFlatGround) {
      this.setUprightRotationLockEnabled(!this.isVehicleObstacleContact);
    }

    return hasObstacleContact;
  }

  syncCarFrameVisualPose() {
    const nextPosition = this.body.translation();
    const nextRotation = this.body.rotation();

    this.carFrame.position.set(nextPosition.x, nextPosition.y, nextPosition.z);
    this.carFrame.quaternion
      .set(nextRotation.x, nextRotation.y, nextRotation.z, nextRotation.w)
      .normalize();

    const supportProfile =
      this.lastWheelSupportProfile || this.getWheelSupportProfile();
    if (
      supportProfile &&
      Math.abs(supportProfile.averageLift) > WHEEL_SUPPORT_MIN_LIFT_METERS
    ) {
      const traversalYaw = this.extractYawFromQuaternion(nextRotation);
      const yawRotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        traversalYaw,
      );
      const pitchRotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        supportProfile.pitchRad,
      );
      const rollRotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        supportProfile.rollRad,
      );
      this.carFrame.quaternion
        .copy(yawRotation.multiply(pitchRotation).multiply(rollRotation))
        .normalize();
    }

    this.carFrame.updateMatrixWorld(true);
    // Arrows are synced here, after tilt is applied, so they follow pitch/roll and not just yaw.
    this.syncVehicleDirectionArrows();
    this.syncVehicleYawIndicator();
    this.syncWheelRotationToBodyTravel();
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

    // Playback scale stretches simulation time itself, so wheel arc and travel stay in lockstep.
    const visualSpeedScale = Math.max(Number(this.visualSpeedScale) || 1, 0.01);
    const simulationDeltaSec =
      Math.min((now - this.lastStepTimeMs) / 1000, 0.1) * visualSpeedScale;
    this.lastStepTimeMs = now;

    const driveViewer = this.vehicleController.getDriveSource();
    const { throttleSign, steerSign } = this.resolveDriveSigns(driveViewer);
    const clampedSpeed = Math.min(
      this.vehicleController.getSpeedMps(),
      this.maxSpeedMps,
    );
    const effectiveSteerSign = clampedSpeed > 1e-3 ? steerSign : 0;
    const wheelGroundContactCount =
      this.wheelController.updateGroundContactState();
    const hasDriveCommand = throttleSign !== 0 || steerSign !== 0;

    this.lastDriveCommandState = {
      throttleSign,
      steerSign,
      hasMoveCommand: hasDriveCommand,
    };
    if (hasDriveCommand) {
      this.hasActivatedSimulationMotion = true;
      this.hasActivatedDynamicGroundClamp = true;
    }

    if (!this.hasActivatedSimulationMotion) {
      this.body.setLinvel(new this.rapier.Vector3(0, 0, 0), true);
      this.body.setAngvel(new this.rapier.Vector3(0, 0, 0), true);
      this.renderer.syncVehicle();
      return;
    }

    // Support geometry is recomputed per substep; drop the previous frame's snapshot.
    this.lastWheelSupportProfile = null;

    const contactState = this.refreshObstacleContactState();
    const isNearFlatGroundSupport = this.isBodyNearFlatGroundSupport();
    if (this.keepUprightOnFlatGround) {
      this.setUprightRotationLockEnabled(
        isNearFlatGroundSupport && !this.isVehicleObstacleContact,
      );
    }

    const context = {
      throttleSign,
      effectiveSteerSign,
      clampedSpeed,
      targetVelocityX: 0,
      targetVelocityY: 0,
      wheelGroundContactCount,
      linkMap: this.viewer?.robotModel?.links || null,
      obstacleApproach: contactState.approachInfo,
    };
    this.applyCommandedBodyMotion(
      context,
      contactState.hasColliderContact,
      isNearFlatGroundSupport,
    );

    // Follow the fixed-step update style from three.js Rapier vehicle controller example.
    this.physicsAccumulatorSec = Math.min(
      this.physicsAccumulatorSec + simulationDeltaSec,
      this.physicsFixedTimeStepSec * this.maxPhysicsCatchupSteps,
    );
    let stepIndex = 0;
    while (
      this.physicsAccumulatorSec >= this.physicsFixedTimeStepSec &&
      stepIndex < this.maxPhysicsCatchupSteps
    ) {
      this.runPhysicsSubstep(context);
      this.physicsAccumulatorSec -= this.physicsFixedTimeStepSec;
      stepIndex += 1;
    }

    const hasObstacleContact = this.finalizeObstacleFrame(context);

    this.maybeLogRuntimeDiagnostics(
      simulationDeltaSec,
      driveViewer,
      clampedSpeed,
      throttleSign,
      steerSign,
      hasObstacleContact,
    );

    this.constrainCenterTurnPivot();
    this.syncCarFrameVisualPose();
  }

  async runLoop() {
    try {
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

      applyPendingSimulationWheelAngleSpeedCommand();

      this.stepSimulation();
      this.updateSceneTreePlacement();
      this.trimWheelZChartHistory(this.simulationElapsedSec);
      this.renderWheelZChart(this.simulationElapsedSec);

      this.updateDebugPanel(this.physicsFixedTimeStepSec);
    } catch (error) {
      console.error("[URDF][Simulation] frame update failed:", error);
    } finally {
      // Always reschedule so a single frame error cannot stop the simulation permanently.
      this.simulationLoop.schedule();
    }
  }

  start() {
    this.initDebugPanel();
    this.initializeSpeedSliderPreference();
    this.initializeVisualSpeedSliderPreference();
    this.installCommandButtonFlash();
    this.installSliderTickInteractions();
    this.attachKeyboardControls();
    this.installDriveCommandHooks();
    this.syncInitialDriveStateFromUi();
    this.syncPauseButtonState();
    this.updateDebugPanel(this.debugStatusUpdateIntervalSec);
    this.simulationLoop.schedule();
  }

  getSliderTickValueAt(sliderElement, tickElement, clientX) {
    const tickBounds = tickElement.getBoundingClientRect();
    const minValue = Number.parseFloat(sliderElement.min);
    const maxValue = Number.parseFloat(sliderElement.max);
    const stepValue = Number.parseFloat(sliderElement.step) || 1;
    if (
      tickBounds.width <= 0 ||
      !Number.isFinite(minValue) ||
      !Number.isFinite(maxValue) ||
      maxValue <= minValue
    ) {
      return null;
    }

    // The tick strip is inset to match the slider track, so ratio maps straight to value.
    const ratio = THREE.MathUtils.clamp(
      (clientX - tickBounds.left) / tickBounds.width,
      0,
      1,
    );
    const rawValue = minValue + ratio * (maxValue - minValue);
    return THREE.MathUtils.clamp(
      minValue + Math.round((rawValue - minValue) / stepValue) * stepValue,
      minValue,
      maxValue,
    );
  }

  ensureSliderTickTooltip() {
    if (this.sliderTickTooltipElement) {
      return this.sliderTickTooltipElement;
    }

    const tooltip = document.createElement("div");
    tooltip.id = "slider-tick-tooltip";
    tooltip.className = "position-fixed badge text-bg-dark shadow-sm";
    tooltip.style.zIndex = "1080";
    tooltip.style.pointerEvents = "none";
    tooltip.style.transform = "translate(-50%, -130%)";
    tooltip.style.display = "none";
    document.body.appendChild(tooltip);
    this.sliderTickTooltipElement = tooltip;
    return tooltip;
  }

  hideSliderTickTooltip() {
    if (this.sliderTickTooltipElement) {
      this.sliderTickTooltipElement.style.display = "none";
    }
  }

  installSliderTickInteractions() {
    const tickBindings = [
      {
        tickSelector: ".slider-tick-scale-speed",
        sliderId: "drive-speed-mps",
        formatValue: (value) => `${value.toFixed(1)} m/s`,
      },
      {
        tickSelector: ".slider-tick-scale-visual",
        sliderId: "simulation-visual-speed-scale",
        formatValue: (value) =>
          this.formatVisualSpeedScaleLabel(
            this.getVisualSpeedScaleFromSliderValue(value),
          ),
      },
    ];

    tickBindings.forEach(({ tickSelector, sliderId, formatValue }) => {
      const tickElement = document.querySelector(tickSelector);
      const sliderElement = document.getElementById(sliderId);
      if (!tickElement || !sliderElement) {
        return;
      }

      tickElement.addEventListener("click", (event) => {
        const tickValue = this.getSliderTickValueAt(
          sliderElement,
          tickElement,
          event.clientX,
        );
        if (tickValue === null) {
          return;
        }

        sliderElement.value = String(tickValue);
        sliderElement.dispatchEvent(new Event("input", { bubbles: true }));
        sliderElement.dispatchEvent(new Event("change", { bubbles: true }));
      });

      tickElement.addEventListener("mousemove", (event) => {
        const tickValue = this.getSliderTickValueAt(
          sliderElement,
          tickElement,
          event.clientX,
        );
        if (tickValue === null) {
          return;
        }

        const tooltip = this.ensureSliderTickTooltip();
        tooltip.textContent = formatValue(tickValue);
        tooltip.style.left = `${event.clientX}px`;
        tooltip.style.top = `${tickElement.getBoundingClientRect().top}px`;
        tooltip.style.display = "block";
      });

      tickElement.addEventListener("mouseleave", () =>
        this.hideSliderTickTooltip(),
      );
    });

    window.addEventListener("scroll", () => this.hideSliderTickTooltip(), {
      passive: true,
    });
  }

  installCommandButtonFlash() {
    if (this.hasInstalledCommandButtonFlash) {
      return;
    }

    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-simulation-flash]");
      if (!button) {
        return;
      }

      button.classList.remove("simulation-command-flash");
      void button.offsetWidth;
      button.classList.add("simulation-command-flash");
    });
    this.hasInstalledCommandButtonFlash = true;
  }

  resetUiStates() {
    this.togglePause(false);
    this.syncPauseButtonState();
    this.applyDriveModeCommand("stop");
    this.resetRoadAttitude();
  }

  syncResetDriveButtonState() {
    const buttonIds = [
      "drive-btn-forward",
      "drive-btn-backward",
      "drive-btn-left",
      "drive-btn-right",
      "drive-btn-stop",
      "drive-btn-reset",
    ];
    buttonIds.forEach((buttonId) => {
      document.getElementById(buttonId)?.classList.remove("active");
    });
    document.getElementById("drive-btn-reset")?.classList.add("active");
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
    this.vehicleYawTrailingRad = null;
    this.vehicleYawIndicatorLastSyncMs = null;
    this.wheelVisualRotationDirectionByKey = {
      fl: -1,
      fr: -1,
      rl: -1,
      rr: -1,
    };
    this.isWheelRotationStopped = false;
    this.hasActivatedSimulationMotion = false;
    this.hasActivatedDynamicGroundClamp = false;
    this.straightDriveReferencePose = null;
    this.straightDriveWarmupSteps = 0;
    this.lastWheelSupportProfile = null;
    this.lastDriveCommandState = {
      throttleSign: 0,
      steerSign: 0,
      hasMoveCommand: false,
    };
    this.clearCenterTurnPivot();
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
    this.wheelGroundContactState = {
      fl: false,
      fr: false,
      rl: false,
      rr: false,
    };
    Object.keys(this.wheelObstacleFlexAngleRadByKey).forEach((wheelKey) => {
      this.wheelObstacleFlexAngleRadByKey[wheelKey] = 0;
      const joint =
        this.viewer?.robotModel?.joints?.[
          this.innerWheelJointNameByKey[wheelKey]
        ];
      if (joint && typeof joint.setJointValue === "function") {
        joint.setJointValue(0);
      }
    });
    this.obstacleColliderInfos.forEach((obstacleInfo) => {
      this.setObstacleContactHighlight(obstacleInfo, false, true);
      if (
        obstacleInfo?.collider &&
        typeof obstacleInfo.collider.setSensor === "function"
      ) {
        obstacleInfo.collider.setSensor(true);
      }
      obstacleInfo.isSpatiallyOverlapping = false;
      obstacleInfo.contactedWheelKeys = [];
      obstacleInfo.hasChassisProximity = false;
    });
    this.activeObstacleTraversalPath = null;
    this.isDriveStartPreparationPending = true;

    // On reset, always return to the URDF-authored pose without extra ground alignment offsets.
    this.renderer.syncVehicle();
    this.estimateWheelEffectiveRadiusMeters(
      this.carFrame,
      this.viewer?.robotModel?.links || null,
    );
    this.resetWheelBodiesFromVisual();
    this.commandedDriveMode = null;
    this.applyDriveModeCommand("stop");
    this.stopWheelRotation();
    this.settlePhysicsAfterReset();
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
    this.renderer.syncVehicle();
    this.syncCarFrameFromBody();
    this.resetWheelBodiesFromVisual();
    this.alignVehicleToGroundByWheelGap(
      this.viewer?.robotModel?.links || null,
      0,
    );
    this.syncCarFrameFromBody();
    this.resetWheelBodiesFromVisual();
    this.updateWheelGroundContactState();
    this.syncWheelGroundContactMarkers();
    this.isDriveStartPreparationPending = false;
    this.resetWheelTravelTracking();
    this.syncWheelChartBaselineFromPhysics();
    this.sampleWheelCenterZForChart(this.simulationElapsedSec);
    this.addGroundSurfaceGrid(this.groundGridPatches);
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
    this.syncResetDriveButtonState();
  }
}

let rapierDriveSimulation = null;
let lastAppliedSimulationWheelCommand = null;
let lastAppliedSimulationSurfaceObstacle = null;

const withSimulation = (action) => {
  if (!rapierDriveSimulation) {
    console.error("[URDF][Simulation] simulation is not initialized");
    return null;
  }
  return action(rapierDriveSimulation);
};

globalThis.resetSimulation = function () {
  return withSimulation((simulation) => simulation.reset());
};

globalThis.resetSimulationSpeed = function () {
  return withSimulation((simulation) => simulation.resetSpeedSliderToDefault());
};

globalThis.resetSimulationVisualSpeed = function () {
  return withSimulation((simulation) =>
    simulation.resetVisualSpeedSliderToDefault(),
  );
};

globalThis.resetSimulationAttitude = function () {
  return withSimulation((simulation) => simulation.resetRoadAttitude());
};

globalThis.resetSimulationRoll = function () {
  return withSimulation((simulation) => simulation.resetRoadRoll());
};

globalThis.resetSimulationPitch = function () {
  return withSimulation((simulation) => simulation.resetRoadPitch());
};

globalThis.setSimulationDriveMode = function (mode) {
  return withSimulation((simulation) => simulation.applyDriveModeCommand(mode));
};

function applySimulationWheelAngleSpeedCommand(command) {
  if (!command || typeof command.mode !== "string") {
    return false;
  }

  return withSimulation((simulation) => {
    simulation.isWheelRotationDrivenByCommand = true;
    simulation.applyDriveSpeedCommandMps(command.speedMps);
    simulation.applyDriveModeCommand(command.mode);

    Object.entries(command.wheelRpmByKey || {}).forEach(([wheelKey, rpm]) => {
      if (typeof globalThis.setWheelAnimationByKey === "function") {
        globalThis.setWheelAnimationByKey(wheelKey, rpm);
      }
    });
    if (simulation.isReady) {
      lastAppliedSimulationWheelCommand = command;
    }
    return true;
  });
}

function applyPendingSimulationWheelAngleSpeedCommand() {
  const latestCommand = globalThis.latestSimulationWheelAngleSpeedCommand;
  if (!latestCommand || latestCommand === lastAppliedSimulationWheelCommand) {
    return;
  }
  applySimulationWheelAngleSpeedCommand(latestCommand);
}

window.addEventListener("wcs:simulation-wheel-angle-speed", (event) => {
  applySimulationWheelAngleSpeedCommand(event?.detail);
});

function applySimulationSurfaceObstacle(obstacleValue) {
  const normalizedValue = Number(obstacleValue);
  if (
    !Number.isInteger(normalizedValue) ||
    normalizedValue < 0 ||
    normalizedValue > 2
  ) {
    return false;
  }

  return withSimulation((simulation) => {
    if (!simulation.isReady) {
      return false;
    }
    lastAppliedSimulationSurfaceObstacle = normalizedValue;
    return simulation.applyDynamicSurfaceObstacle(normalizedValue);
  });
}

window.addEventListener("wcs:simulation-surface-obstacle", (event) => {
  applySimulationSurfaceObstacle(event?.detail?.value);
});

globalThis.setSimulationSurfaceObstacle = function (obstacleValue) {
  globalThis.latestSimulationSurfaceObstacle = Number(obstacleValue);
  return applySimulationSurfaceObstacle(obstacleValue);
};

globalThis.getSimulationWheelRadiusMetersByKey = function () {
  return withSimulation((simulation) => {
    const fallbackRadius = Math.max(
      Number(simulation.wheelEffectiveRadiusMeters) || 0.16,
      0.05,
    );
    return ["fr", "fl", "rr", "rl"].reduce((result, wheelKey) => {
      const radius = Number(simulation.wheelRadiusMetersByKey?.[wheelKey]);
      result[wheelKey] =
        Number.isFinite(radius) && radius > 0 ? radius : fallbackRadius;
      return result;
    }, {});
  });
};

globalThis.toggleSimulationPause = function (forcePaused = null) {
  return withSimulation((simulation) => simulation.togglePause(forcePaused));
};

globalThis.addSimulationPothole = function (
  centerX,
  centerY,
  sizeX = 0.15,
  sizeY = 0.15,
  depthMeters = 0.1,
) {
  return withSimulation((simulation) =>
    simulation.addPotholeRegion(centerX, centerY, sizeX, sizeY, depthMeters),
  );
};

globalThis.stopSimulationWheelRotation = function () {
  return withSimulation((simulation) => simulation.stopWheelRotation());
};

globalThis.setSimulationDriveSpeedMps = function (mps) {
  return withSimulation((simulation) =>
    simulation.applyDriveSpeedCommandMps(mps),
  );
};

globalThis.setSimulationDriveSpeedKmh = function (kmh) {
  return withSimulation((simulation) =>
    simulation.applyDriveSpeedCommandKmh(kmh),
  );
};

globalThis.setSimulationVisualSpeed = function (scale) {
  return withSimulation((simulation) =>
    simulation.applyVisualSpeedScale(
      simulation.getVisualSpeedScaleFromSliderValue(scale),
    ),
  );
};

let isSimulationControlBusy = false;

globalThis.runSimulationControl = function (button, action) {
  if (isSimulationControlBusy || typeof action !== "function") {
    return Promise.resolve();
  }

  const controlButtons = Array.from(
    document.querySelectorAll("button[data-simulation-control]"),
  );
  const initiallyDisabled = new Map(
    controlButtons.map((controlButton) => [
      controlButton,
      controlButton.disabled,
    ]),
  );
  isSimulationControlBusy = true;
  controlButtons.forEach((controlButton) => {
    controlButton.disabled = true;
    controlButton.setAttribute("aria-busy", "true");
  });

  let result;
  try {
    result = action();
  } catch (error) {
    console.error("[URDF][Simulation] control command failed:", error);
    result = null;
  }

  return Promise.resolve(result).finally(() => {
    controlButtons.forEach((controlButton) => {
      controlButton.disabled = initiallyDisabled.get(controlButton) === true;
      controlButton.removeAttribute("aria-busy");
    });
    isSimulationControlBusy = false;
  });
};

try {
  rapierDriveSimulation = new RapierDriveSimulation();
  rapierDriveSimulation.start();
  applySimulationWheelAngleSpeedCommand(
    globalThis.latestSimulationWheelAngleSpeedCommand,
  );
  if (lastAppliedSimulationSurfaceObstacle === null) {
    applySimulationSurfaceObstacle(
      globalThis.latestSimulationSurfaceObstacle ?? 0,
    );
  }
} catch (error) {
  console.error("[URDF][Simulation] startup failed:", error);
}
