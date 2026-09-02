import * as THREE from "three";
import URDFLoader from "urdf-loader";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSG } from "three-csg-ts";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

const $ = window.jQuery;
const VEHICLE_AUDIO_STORAGE_KEY = "wcs.vehicle.showAudio";

function ensureGlobalUserGestureTracker() {
  if (window.__wcsUserGestureTrackerAttached === true) {
    return;
  }

  const markGesture = function () {
    window.__wcsAnyUserGestureDetected = true;
  };

  document.addEventListener("pointerdown", markGesture, true);
  document.addEventListener("keydown", markGesture, true);
  document.addEventListener("touchstart", markGesture, true);

  window.__wcsUserGestureTrackerAttached = true;
}

function hasGlobalUserGestureDetected() {
  return window.__wcsAnyUserGestureDetected === true;
}

ensureGlobalUserGestureTracker();

// 각 뷰어를 위한 클래스
class URDFViewer {
  constructor(containerElement) {
    this.container = containerElement;
    this.robotModel = null;
    this.xyGridHelper = null;
    this.axesHelper = null;
    this.axesRootGroup = null;
    this.axisLineByKey = {
      x: null,
      y: null,
      z: null,
    };
    this.axisLengthScaleRatio = 0.55;
    this.axisLengthExtraRatio = 0.625;
    this.axisLabelSprites = [];
    this.axisLabelScaleRatio = 0.1;
    this.axisLabelNearOriginRatio = 0.06;
    this.axisLabelMinOffset = 0.03;
    this.referenceToggleStep = 0;
    this.directionalLight = null;
    this.directionalLightRadius = 1;
    // See the controls "change" listener in setupCameraAngleLogging() for why this
    // throttle exists: it keeps the shadow-casting light from being repositioned every
    // single frame during a drag/zoom, which flickered the ground shadow.
    this.directionalLightUpdateThrottleMs = 150;
    this.lastInteractiveDirectionalLightUpdateMs = 0;
    // Set by simulation.js around its own vehicle-follow camera updates (see
    // syncCameraToVehicleTranslation() there) - those call controls.update() every
    // physics step while driving, which fires the "change" listener below just like a
    // real orbit drag would. Left unguarded, that repositioned the shadow-casting light
    // (which is camera-relative - see resetDirectionalLight()) every throttle interval
    // for as long as the vehicle kept moving, i.e. continuously - reading as the entire
    // ground flashing/recoloring every ~150ms during simulation driving, not just the
    // brief shimmer during an actual user drag this throttle was built for.
    this.suppressInteractiveDirectionalLightFollow = false;
    this.goalTarget = new THREE.Vector3(0, 0, 0);
    this.goalTargetVerticalOffset = 0;
    this.overlayDragPanPixels = 0;
    this.overlayZoomOutRatio = 0;
    this.isInitialCameraPoseReady = false;
    this.pendingOverlayDragPixels = null;
    this.pendingOverlayZoomOutRatio = null;
    this.isOrbitInteractionActive = false;
    this.isDragging = false;
    this.lastAngleLogAt = 0;
    this.angleLogIntervalMs = 120;
    this.cameraPosTextElement = null;
    this.cameraPosCopyText =
      "0.000, 0.000, 0.000|0.000, 0.000, 0.000|0.000, 1.000, 0.000";
    this.cameraToastElement = null;
    this.cameraToastHideTimer = null;
    this.cameraToastHideDelayMs = 3000;
    this.lastFrameTimeMs = performance.now();
    this.wheelSpeedInputByKey = {};
    this.wheelSpeedValueByKey = {};
    this.wheelSpeedRpmByKey = {
      fl: 0,
      fr: 0,
      rl: 0,
      rr: 0,
    };
    this.wheelAngularSpeedRadByKey = {
      fl: this.convertRpmToRadPerSec(0),
      fr: this.convertRpmToRadPerSec(0),
      rl: this.convertRpmToRadPerSec(0),
      rr: this.convertRpmToRadPerSec(0),
    };
    this.wheelDirectionSignByKey = {
      fl: 1,
      fr: 1,
      rl: 1,
      rr: 1,
    };
    this.driveMode = "stop";
    this.driveSpeedKmh = 0;
    this.driveAnimationPoseSnapshot = null;
    this.kmhToRpmFactor = 4;
    this.kmhToRpmFactorByWheelKey = {};
    this.wheelJointNameByKey = {
      fl: "wheel_fl_joint",
      fr: "wheel_fr_joint",
      rl: "wheel_rl_joint",
      rr: "wheel_rr_joint",
    };
    this.wheelLinkNameByKey = {
      fl: "wheel_fl",
      fr: "wheel_fr",
      rl: "wheel_rl",
      rr: "wheel_rr",
    };
    // sw_17's wheel pods drive the wheel (spin axis: local -x) through a bevel gear pair
    // whose pinion - inner_gear_{key} - spins about a different axis (local z). Rotating
    // wheel_{key}_joint alone therefore leaves that pinion visually motionless even
    // though physically it has to turn first for the wheel to turn at all. See
    // resolveInnerGearJointTargets()/ensureInnerGearRatioMeasured()/
    // applyInnerGearRotation() below - harmless no-op on models (vehicle.urdf, sw_14,
    // sw_15) that don't have this joint.
    this.innerGearJointNameByKey = {
      fl: "inner_gear_fl_joint",
      fr: "inner_gear_fr_joint",
      rl: "inner_gear_rl_joint",
      rr: "inner_gear_rr_joint",
    };
    this.innerGearLinkNameByKey = {
      fl: "inner_gear_fl",
      fr: "inner_gear_fr",
      rl: "inner_gear_rl",
      rr: "inner_gear_rr",
    };
    this.innerGearRuntimeTargetByKey = {
      fl: null,
      fr: null,
      rl: null,
      rr: null,
    };
    // Populated lazily by ensureInnerGearRatioMeasured() once both links' mesh geometry
    // has actually finished loading (null until then, re-tried every call - see
    // urdf-loader-progressive-mesh-reveal in the project memory for why mesh files can
    // still be pending well after the joint/link tree itself has parsed).
    this.innerGearRatioByKey = {
      fl: null,
      fr: null,
      rl: null,
      rr: null,
    };
    // inner_wheel_{key}_joint shares inner_gear_{key}_joint's exact origin/axis (see the
    // comment above) but is a second, independent continuous joint on swing_link: it's
    // the carrier arm that the wheel is mounted eccentrically on, not part of the bevel
    // pair itself. Orbiting it is what lets the wheel physically climb up and over a
    // step edge instead of just rolling - see simulation.js's updateWheelClimbGait(),
    // which drives it through setInnerWheelCarrierAngle() below. Kept here (not in
    // simulation.js) so applyInnerGearRotation() can read the current carrier angle
    // without simulation.js having to know anything about how inner_gear is driven.
    this.innerWheelJointNameByKey = {
      fl: "inner_wheel_fl_joint",
      fr: "inner_wheel_fr_joint",
      rl: "inner_wheel_rl_joint",
      rr: "inner_wheel_rr_joint",
    };
    this.innerWheelRuntimeTargetByKey = {
      fl: null,
      fr: null,
      rl: null,
      rr: null,
    };
    this.innerWheelCarrierAngleRadByKey = {
      fl: 0,
      fr: 0,
      rl: 0,
      rr: 0,
    };
    // Populated lazily by measureInnerWheelOrbitRadiusMeters() - unlike
    // innerGearRatioByKey this only needs the joint/link *tree* (a fixed joint-origin
    // offset), not mesh geometry, so it's available as soon as robotModel exists.
    this.innerWheelOrbitRadiusMetersByKey = {
      fl: null,
      fr: null,
      rl: null,
      rr: null,
    };
    this.wheelAngles = {
      fl: 0,
      fr: 0,
      rl: 0,
      rr: 0,
    };
    this.wheelVisualAngularSpeedRadByKey = {
      fl: 0,
      fr: 0,
      rl: 0,
      rr: 0,
    };
    // Set by simulation.js's updateWheelClimbGait() (setWheelRotationLocked() below) while
    // a wheel's outer tire is pressed against an obstacle face - the carrier is doing the
    // climbing instead, see wheelClimbLockedByKey's comment there. Checked by *both*
    // applyWheelTravelDistances() and applyWheelAnimation() so the lock holds regardless of
    // which of those two independent drive paths (rolling-without-slip physics travel, or
    // an externally commanded RPM/animation clock - e.g. MQTT wheel-speed commands) is
    // actually driving this wheel this frame.
    this.wheelRotationLockedByKey = {
      fl: false,
      fr: false,
      rl: false,
      rr: false,
    };
    this.isWheelRotationDrivenByTravel = false;
    this.wheelAnimationTimeScale = 1;
    const wheelVisualRotationSign = Number.parseFloat(
      containerElement.getAttribute("wheel-visual-rotation-sign"),
    );
    this.wheelVisualRotationSign =
      Number.isFinite(wheelVisualRotationSign) && wheelVisualRotationSign < 0
        ? -1
        : 1;
    this.enableWheelVisualFilter = this.parseBooleanAttribute(
      containerElement.getAttribute("wheelVisualFilter"),
      true,
    );
    this.wheelVisualAngularSpeedCapRad = 20;
    this.wheelVisualCompressionK = 8;
    this.wheelVisualSmoothingHz = 12;
    this.wheelVisualMaxStepRadPerFrame = Math.PI / 8;
    this.wheelRuntimeTargetByKey = {
      fl: null,
      fr: null,
      rl: null,
      rr: null,
    };
    this.wheelHighlightMeshesByKey = {
      fl: [],
      fr: [],
      rl: [],
      rr: [],
    };
    this.wheelHighlightBaseColor = new THREE.Color(0x141414);
    this.wheelHighlightAccentColor = new THREE.Color(0xffb000);
    this.wheelHighlightDimColor = new THREE.Color(0x4f4f4f);
    this.wheelHighlightEmissiveColor = new THREE.Color(0x3a1f00);
    this.wheelFlashAccentColor = new THREE.Color(0xffc84d);
    this.wheelFlashEmissiveColor = new THREE.Color(0x6a3300);
    this.highlightedWheelKey = null;
    this.viewerWheelKey =
      this.parseViewerWheelKey(containerElement.id) ||
      String(window.pendingWheelViewerKey || "")
        .trim()
        .toLowerCase() ||
      this.getSelectedWheelKeyFromDom();
    this.wheelFlashTimeoutId = null;
    this.roadRollAngleDeg = 0;
    this.roadPitchAngleDeg = 0;
    this.carFrameRollAlertThresholdDeg = 8;
    this.carFrameAlertMaterials = [];
    this.isCarFrameAlertActive = false;
    this.carFrameAlertTintColor = new THREE.Color(0xd32f2f);
    this.carFrameAlertEmissiveColor = new THREE.Color(0x521414);
    this.attitudeOverlayElement = null;
    this.rollNeedleElement = null;
    this.pitchNeedleElement = null;
    this.showCompass = this.parseBooleanAttribute(
      containerElement.getAttribute("showCompass"),
      false,
    );
    this.compassOverlayElement = null;
    this.compassRenderer = null;
    this.compassScene = null;
    this.compassCamera = null;
    this.compassModelGroup = null;
    this.compassDragState = null;
    this.compassArcballSensitivity = 1.0;
    this.compassDragActivateDistancePx = 3;
    this.initialCameraPose = null;
    this.viewCubeOverlayElement = null;
    this.viewCubeCubeElement = null;
    this.viewCubeActiveFaceKey = null;
    this.viewCubeButtonByFace = {};
    this.viewCubeDragState = null;
    this.viewCubeSuppressClickUntilMs = 0;
    this.viewCubeIgnoreFaceClickUntilMs = 0;
    this.viewCubeArcballSensitivity = 1.0;
    this.viewCubeDragActivateDistancePx = 4;
    this.mainOrbitDragState = null;
    this.mainOrbitArcballSensitivity = 1.0;
    this.mainOrbitDragActivateDistancePx = 4;
    this.showAttitude = this.parseBooleanAttribute(
      containerElement.getAttribute("showAttitude"),
      false,
    );
    this.showWheelInfo = this.parseBooleanAttribute(
      containerElement.getAttribute("showWheelInfo"),
      false,
    );
    this.showAudio = this.parseBooleanAttribute(
      containerElement.getAttribute("showAudio"),
      false,
    );
    this.showTransparency = this.parseBooleanAttribute(
      containerElement.getAttribute("showTransparency"),
      false,
    );
    this.showViewCube = this.parseBooleanAttribute(
      containerElement.getAttribute("showViewCube"),
      false,
    );
    this.enableGroundHoleCarving = this.parseBooleanAttribute(
      containerElement.getAttribute("enableGroundHoleCarving"),
      true,
    );
    this.hideHoleCuttersAfterCarving = this.parseBooleanAttribute(
      containerElement.getAttribute("hideHoleCuttersAfterCarving"),
      true,
    );
    this.enableGroundHoleShading = this.parseBooleanAttribute(
      containerElement.getAttribute("enableGroundHoleShading"),
      false,
    );
    // Vertex-color tint multiplied onto the carved pothole walls/floor so the
    // cavity reads as a depression even when the top surface and the CSG-cut
    // faces share the exact same base material/lighting.
    this.groundHoleRimShadeColor = new THREE.Color(0x433f37);
    this.groundHoleDeepShadeColor = new THREE.Color(0x15130f);
    // Vertex-color shading alone was too subtle from steep top-down angles:
    // the walls foreshorten to almost nothing and only the (nearly flat,
    // nearly uniformly colored) floor is visible, so the cavity read as a
    // flat discolored patch rather than a hole. On top of that, drawn line
    // segments trace every hard crease of the carved cavity — rim, the
    // corners between adjacent walls, and each wall-to-floor seam — in a
    // fixed screen-space width, so the cavity's outline stays crisp and
    // visible regardless of viewing angle, lighting, or how coarsely the
    // CSG result happened to be triangulated. See attachGroundHoleEdgeLines().
    this.groundHoleEdgeLineColor = new THREE.Color(0x0a0806);
    this.groundHoleEdgeLineWidthPixels = 2.5;
    // Line2/LineMaterial objects currently attached for carved cavities, kept
    // around so applyContainerResize() can keep their resolution uniform in
    // sync with the actual render target size (required for correct
    // constant-pixel-width lines) and so they can be disposed together.
    this.groundHoleEdgeLineObjects = [];
    // Carved pothole cavity nodes whose baked rim/deep vertex-color shading
    // (applyGroundHoleShading()) can be temporarily swapped for a flat red alert
    // color while the vehicle is over the hole - see setGroundHoleCavityAlertActive().
    this.groundHoleCavityAlertTargets = [];
    this.groundHoleCavityAlertColor = new THREE.Color(0xff0000);
    this.isGroundHoleCavityAlertActive = false;
    // Fallback only: used when a carved cavity has no measurable depth (e.g.
    // a degenerate/near-zero-height cutter). Normally the actual carved
    // depth of each cavity is measured and used instead — see
    // applyGroundHoleShading().
    this.groundHoleShadeFullDepthMeters = 0.06;
    this.wheelInfoOverlayElement = null;
    this.wheelInfoToggleButtonElement = null;
    this.wheelInfoOverlayStorageKey = this.getWheelInfoOverlayStorageKey();
    this.isWheelInfoOverlayVisible = this.showWheelInfo;
    this.carFrameOpacityControlElement = null;
    this.carFrameOpacitySliderElement = null;
    this.carFrameOpacityValueElement = null;
    this.carFrameOpacitySyncTimerIds = [];
    this.carFrameOpacityStorageKey = this.getCarFrameOpacityStorageKey();
    this.carFrameOpacity = this.showTransparency
      ? this.loadCarFrameOpacity()
      : 1;
    this.persistCameraPose = this.parseBooleanAttribute(
      containerElement.getAttribute("persistCameraPose"),
      true,
    );
    const cameraPoseStorageKey = this.getCameraPoseStorageKey();
    this.cameraPoseStorageKey = this.persistCameraPose
      ? cameraPoseStorageKey
      : null;
    if (!this.persistCameraPose && typeof window.localStorage !== "undefined") {
      try {
        window.localStorage.removeItem(cameraPoseStorageKey);
      } catch (error) {
        // Ignore storage removal errors in restricted browser modes.
      }
    }
    if (this.showWheelInfo) {
      this.isWheelInfoOverlayVisible = this.loadWheelInfoOverlayVisibleState();
    }
    this.urdfPath =
      containerElement.getAttribute("urdf") ||
      "/urdf/model/vehicle/vehicle.urdf";
    const rawCameraPose = containerElement.getAttribute("cameraPose");
    const rawCameraPosition = containerElement.getAttribute("cameraPosition");
    const rawCameraTarget = containerElement.getAttribute("cameraTarget");
    const rawCameraUp = containerElement.getAttribute("cameraUp");
    const parsedCameraPose = this.parseCameraPose(rawCameraPose);
    const parsedSavedCameraPose =
      parsedCameraPose == null ? this.loadSavedCameraPose() : null;
    const effectiveCameraPose = parsedCameraPose || parsedSavedCameraPose;
    this.hasCustomCameraPose = parsedCameraPose != null;
    this.hasStoredCameraPose = parsedSavedCameraPose != null;
    this.hasAnyPoseSource = effectiveCameraPose != null;
    this.hasCustomCameraPosition =
      this.hasAnyPoseSource ||
      (rawCameraPosition != null &&
        String(rawCameraPosition).trim().length > 0);
    this.hasCustomCameraTarget =
      this.hasAnyPoseSource ||
      (rawCameraTarget != null && String(rawCameraTarget).trim().length > 0);
    this.hasCustomCameraUp =
      this.hasAnyPoseSource ||
      (rawCameraUp != null && String(rawCameraUp).trim().length > 0);
    this.cameraFitMarginRatio = 0.05;
    this.cameraPosition = this.hasAnyPoseSource
      ? effectiveCameraPose.position.clone()
      : this.hasCustomCameraPosition
        ? this.parseVector3Attribute(
            rawCameraPosition,
            new THREE.Vector3(4, 4, 8),
          )
        : new THREE.Vector3(4, 4, 8);
    this.cameraTarget = this.hasAnyPoseSource
      ? effectiveCameraPose.target.clone()
      : this.hasCustomCameraTarget
        ? this.parseVector3Attribute(
            rawCameraTarget,
            new THREE.Vector3(0, 0, 0),
          )
        : new THREE.Vector3(0, 0, 0);
    this.cameraUp = this.hasAnyPoseSource
      ? effectiveCameraPose.up.clone()
      : this.hasCustomCameraUp
        ? this.parseUpVector(rawCameraUp)
        : new THREE.Vector3(0, 1, 0);

    this.init();
  }

  parseVector3Attribute(rawValue, fallback) {
    const tokens = String(rawValue || "")
      .split(",")
      .map((value) => Number.parseFloat(value.trim()));
    if (
      tokens.length < 3 ||
      !Number.isFinite(tokens[0]) ||
      !Number.isFinite(tokens[1]) ||
      !Number.isFinite(tokens[2])
    ) {
      return fallback;
    }
    return new THREE.Vector3(tokens[0], tokens[1], tokens[2]);
  }

  parseUpVector(rawValue) {
    const fallback = new THREE.Vector3(0, 1, 0);
    const parsed = this.parseVector3Attribute(rawValue, fallback.clone());
    if (parsed.lengthSq() < 1e-8) {
      return fallback;
    }
    return parsed.normalize();
  }

  parseCameraPose(rawValue) {
    const normalizedValue = String(rawValue || "").trim();
    if (!normalizedValue) {
      return null;
    }

    const parts = normalizedValue.split("|").map((value) => value.trim());
    if (parts.length < 1 || parts.length > 3 || !parts[0]) {
      return null;
    }

    const fallbackPosition = new THREE.Vector3(4, 4, 8);
    const fallbackTarget = new THREE.Vector3(0, 0, 0);
    const position = this.parseVector3Attribute(
      parts[0],
      fallbackPosition.clone(),
    );
    const target = parts[1]
      ? this.parseVector3Attribute(parts[1], fallbackTarget.clone())
      : fallbackTarget.clone();
    const up = parts[2]
      ? this.parseUpVector(parts[2])
      : new THREE.Vector3(0, 1, 0);

    return {
      position,
      target,
      up,
    };
  }

  getCameraPoseStorageKey() {
    const containerId = String(this.container?.id || "").trim();
    if (containerId) {
      return `wcs.urdf.camera_pose.${containerId}`;
    }

    const containerClassName = String(this.container?.className || "")
      .trim()
      .replace(/\s+/g, "_");
    if (containerClassName) {
      return `wcs.urdf.camera_pose.class_${containerClassName}`;
    }

    return "wcs.urdf.camera_pose.default";
  }

  loadSavedCameraPose() {
    if (
      !this.cameraPoseStorageKey ||
      typeof window.localStorage === "undefined"
    ) {
      return null;
    }

    try {
      const savedValue = window.localStorage.getItem(this.cameraPoseStorageKey);
      if (!savedValue) {
        return null;
      }

      return this.parseCameraPose(savedValue);
    } catch (error) {
      return null;
    }
  }

  getCurrentCameraPoseValueText() {
    if (!this.camera || !this.controls) {
      return null;
    }

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
    const tx = formatPositionValue(this.controls.target.x);
    const ty = formatPositionValue(this.controls.target.y);
    const tz = formatPositionValue(this.controls.target.z);
    const ux = formatPositionValue(this.camera.up.x);
    const uy = formatPositionValue(this.camera.up.y);
    const uz = formatPositionValue(this.camera.up.z);

    return `${px}, ${py}, ${pz}|${tx}, ${ty}, ${tz}|${ux}, ${uy}, ${uz}`;
  }

  saveCurrentCameraPoseToStorage() {
    if (
      !this.cameraPoseStorageKey ||
      typeof window.localStorage === "undefined"
    ) {
      return;
    }

    const visiblePosition = this.camera.position.clone();
    const visibleTarget = this.controls.target.clone();
    const cameraOffset = visiblePosition.clone().sub(visibleTarget);
    const visibleDistance = cameraOffset.length();
    const overlayZoomOutRatio = Number(this.overlayZoomOutRatio) || 0;
    const baseDistance =
      Number.isFinite(visibleDistance) && visibleDistance > 0.0001
        ? visibleDistance / Math.max(1 + overlayZoomOutRatio, 0.001)
        : visibleDistance;
    const baseTarget = visibleTarget.clone();
    const overlayDragPixels = Number(this.overlayDragPanPixels) || 0;
    const containerHeight = Number(
      this.container?.clientHeight ||
        this.container?.getBoundingClientRect?.().height ||
        0,
    );

    if (overlayDragPixels > 0 && containerHeight > 0 && visibleDistance > 0) {
      let worldPerPixel = 0;
      if (this.camera.isPerspectiveCamera) {
        const fovRad = THREE.MathUtils.degToRad(this.camera.fov || 50);
        worldPerPixel =
          (2 * visibleDistance * Math.tan(fovRad / 2)) / containerHeight;
      } else if (this.camera.isOrthographicCamera) {
        const frustumHeight =
          (this.camera.top - this.camera.bottom) /
          Math.max(this.camera.zoom || 1, 0.001);
        worldPerPixel = frustumHeight / containerHeight;
      }

      const viewDirection = visibleTarget
        .clone()
        .sub(visiblePosition)
        .normalize();
      const cameraRight = new THREE.Vector3()
        .crossVectors(viewDirection, this.camera.up)
        .normalize();
      const screenUp = new THREE.Vector3()
        .crossVectors(cameraRight, viewDirection)
        .normalize();
      if (worldPerPixel > 0 && screenUp.lengthSq() > 0) {
        baseTarget.addScaledVector(
          screenUp,
          -overlayDragPixels * worldPerPixel,
        );
      }
    }

    const basePosition =
      cameraOffset.lengthSq() > 0
        ? baseTarget
            .clone()
            .add(cameraOffset.normalize().multiplyScalar(baseDistance))
        : visiblePosition;
    const formatPositionValue = (value) => {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? numberValue.toFixed(3) : "0.000";
    };
    const formatVector = (vector) =>
      [vector.x, vector.y, vector.z].map(formatPositionValue).join(", ");
    const poseText = `${formatVector(basePosition)}|${formatVector(baseTarget)}|${formatVector(this.camera.up)}`;
    if (!poseText) {
      return;
    }

    try {
      window.localStorage.setItem(this.cameraPoseStorageKey, poseText);
    } catch (error) {
      // Ignore storage write errors in restricted browser modes.
    }
  }

  parseBooleanAttribute(rawValue, fallbackValue) {
    if (rawValue == null) {
      return fallbackValue;
    }

    const normalized = String(rawValue).trim().toLowerCase();
    if (
      normalized === "" ||
      normalized === "true" ||
      normalized === "1" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }

    if (
      normalized === "false" ||
      normalized === "0" ||
      normalized === "no" ||
      normalized === "off"
    ) {
      return false;
    }

    return fallbackValue;
  }

  getWheelInfoOverlayStorageKey() {
    const containerId = String(this.container?.id || "").trim();
    if (containerId) {
      return `wcs.urdf.wheel_info_visible.${containerId}`;
    }

    const containerClassName = String(this.container?.className || "")
      .trim()
      .replace(/\s+/g, "_");
    if (containerClassName) {
      return `wcs.urdf.wheel_info_visible.class_${containerClassName}`;
    }

    return "wcs.urdf.wheel_info_visible.default";
  }

  loadWheelInfoOverlayVisibleState() {
    if (
      !this.wheelInfoOverlayStorageKey ||
      typeof window.localStorage === "undefined"
    ) {
      return this.showWheelInfo;
    }

    try {
      const savedValue = window.localStorage.getItem(
        this.wheelInfoOverlayStorageKey,
      );
      if (savedValue == null) {
        return this.showWheelInfo;
      }
      return this.parseBooleanAttribute(savedValue, this.showWheelInfo);
    } catch (error) {
      return this.showWheelInfo;
    }
  }

  saveWheelInfoOverlayVisibleState() {
    if (
      !this.wheelInfoOverlayStorageKey ||
      typeof window.localStorage === "undefined"
    ) {
      return;
    }

    try {
      window.localStorage.setItem(
        this.wheelInfoOverlayStorageKey,
        this.isWheelInfoOverlayVisible ? "1" : "0",
      );
    } catch (error) {
      // Ignore storage write errors in restricted browser modes.
    }
  }

  getCarFrameOpacityStorageKey() {
    const containerId = String(this.container?.id || "").trim();
    if (containerId) {
      return `wcs.urdf.car_frame_opacity.${containerId}`;
    }

    const containerClassName = String(this.container?.className || "")
      .trim()
      .replace(/\s+/g, "_");
    if (containerClassName) {
      return `wcs.urdf.car_frame_opacity.class_${containerClassName}`;
    }

    return "wcs.urdf.car_frame_opacity.default";
  }

  loadCarFrameOpacity() {
    const fallbackOpacity = 1;
    if (
      !this.carFrameOpacityStorageKey ||
      typeof window.localStorage === "undefined"
    ) {
      return fallbackOpacity;
    }

    try {
      const savedValue = window.localStorage.getItem(
        this.carFrameOpacityStorageKey,
      );
      if (savedValue == null) {
        return fallbackOpacity;
      }

      const parsedValue = Number.parseFloat(savedValue);
      if (!Number.isFinite(parsedValue)) {
        return fallbackOpacity;
      }

      // Backward compatibility: accept legacy percent-like values (e.g. 42, "42%")
      // as well as normalized values (0.1~1.0).
      if (parsedValue > 1) {
        return THREE.MathUtils.clamp(parsedValue / 100, 0.1, 1);
      }

      return THREE.MathUtils.clamp(parsedValue, 0.1, 1);
    } catch (error) {
      return fallbackOpacity;
    }
  }

  saveCarFrameOpacity() {
    if (
      !this.carFrameOpacityStorageKey ||
      typeof window.localStorage === "undefined"
    ) {
      return;
    }

    try {
      window.localStorage.setItem(
        this.carFrameOpacityStorageKey,
        String(this.carFrameOpacity),
      );
    } catch (error) {
      // Ignore storage write errors in restricted browser modes.
    }
  }

  updateCarFrameOpacityControlState() {
    if (this.carFrameOpacitySliderElement) {
      const sliderValue = Math.round(
        THREE.MathUtils.clamp(this.carFrameOpacity, 0.1, 1) * 100,
      );
      this.carFrameOpacitySliderElement.value = String(sliderValue);
      this.carFrameOpacitySliderElement.style.setProperty(
        "--slider-percent",
        `${sliderValue}%`,
      );
    }

    if (this.carFrameOpacityValueElement) {
      const percentValue = Math.round(
        THREE.MathUtils.clamp(this.carFrameOpacity, 0.1, 1) * 100,
      );
      this.carFrameOpacityValueElement.textContent = `${percentValue}%`;
    }
  }

  setCarFrameOpacityControlVisible(visible) {
    if (!this.carFrameOpacityControlElement) {
      return;
    }

    this.carFrameOpacityControlElement.style.display = visible
      ? "inline-flex"
      : "none";
  }

  getCarFrameOpacityTargetRoot() {
    if (!this.robotModel) {
      return null;
    }

    const linkMap = this.robotModel.links || {};
    const candidateRoots = [
      linkMap.car_frame,
      linkMap.base_link,
      linkMap.chassis,
      this.robotModel,
    ].filter(Boolean);

    const hasRenderableMesh = (rootObject) => {
      if (!rootObject || typeof rootObject.traverse !== "function") {
        return false;
      }

      let found = false;
      rootObject.traverse((object) => {
        if (found) {
          return;
        }

        if (object && object.isMesh && object.material) {
          found = true;
        }
      });

      return found;
    };

    for (const candidate of candidateRoots) {
      if (hasRenderableMesh(candidate)) {
        return candidate;
      }
    }

    return candidateRoots[0] || null;
  }

  applyCarFrameOpacity(opacityValue) {
    const targetRoot = this.getCarFrameOpacityTargetRoot();
    if (!targetRoot) {
      return;
    }

    const opacity = THREE.MathUtils.clamp(Number(opacityValue), 0.1, 1);
    targetRoot.traverse((object) => {
      if (!object || !object.isMesh || !object.material) {
        return;
      }

      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      materials.forEach((material) => {
        if (!material) {
          return;
        }

        if (!material.userData.carFrameOpacitySource) {
          material.userData.carFrameOpacitySource = {
            opacity: THREE.MathUtils.clamp(Number(material.opacity), 0, 1),
            transparent: material.transparent,
            depthWrite: material.depthWrite,
          };
        }

        const source = material.userData.carFrameOpacitySource;
        const weightedOpacity = source.opacity * opacity;
        material.transparent = source.transparent || weightedOpacity < 1;
        material.opacity = weightedOpacity;
        material.depthWrite = opacity >= 1 ? source.depthWrite : false;
        material.needsUpdate = true;
      });
    });
  }

  setCarFrameOpacity(opacityValue) {
    if (!this.showTransparency) {
      return;
    }

    const opacity = THREE.MathUtils.clamp(Number(opacityValue), 0.1, 1);
    this.carFrameOpacity = opacity;
    this.saveCarFrameOpacity();
    this.applyCarFrameOpacity(opacity);
    this.updateCarFrameOpacityControlState();
  }

  clearCarFrameOpacitySyncTimers() {
    if (
      !Array.isArray(this.carFrameOpacitySyncTimerIds) ||
      this.carFrameOpacitySyncTimerIds.length === 0
    ) {
      return;
    }

    this.carFrameOpacitySyncTimerIds.forEach((timerId) => {
      try {
        clearTimeout(timerId);
      } catch (error) {
        // Ignore timeout cleanup errors.
      }
    });
    this.carFrameOpacitySyncTimerIds = [];
  }

  scheduleInitialCarFrameOpacitySync() {
    if (!this.showTransparency) {
      return;
    }

    this.clearCarFrameOpacitySyncTimers();

    // Mesh-based URDFs (e.g. STL) can finish material creation after loader callback.
    // Re-apply opacity a few times so initial transparency reflects persisted values.
    const retryDelayMs = [0, 120, 320, 750, 1400];
    retryDelayMs.forEach((delayMs) => {
      const timerId = setTimeout(() => {
        if (!this.showTransparency || !this.robotModel) {
          return;
        }

        this.applyCarFrameOpacity(this.carFrameOpacity);
        this.updateCarFrameOpacityControlState();
      }, delayMs);
      this.carFrameOpacitySyncTimerIds.push(timerId);
    });
  }

  parseViewerWheelKey(containerId) {
    const idText = String(containerId || "")
      .trim()
      .toLowerCase();
    const matched = idText.match(/^([a-z]{2})-wheel-urdf-viewer$/);
    if (!matched) {
      return null;
    }

    const wheelKey = matched[1];
    if (
      !Object.prototype.hasOwnProperty.call(this.wheelSpeedRpmByKey, wheelKey)
    ) {
      return null;
    }

    return wheelKey;
  }

  getSelectedWheelKeyFromDom() {
    const selectedWheel = document.querySelector(
      'input[name="wheelPosition"]:checked',
    );
    const wheelKey = String(selectedWheel?.value || "")
      .trim()
      .toLowerCase();

    if (
      !Object.prototype.hasOwnProperty.call(this.wheelSpeedRpmByKey, wheelKey)
    ) {
      return null;
    }

    return wheelKey;
  }

  setViewerWheelKey(key) {
    const normalizedKey = String(key || "")
      .trim()
      .toLowerCase();
    if (
      !Object.prototype.hasOwnProperty.call(
        this.wheelSpeedRpmByKey,
        normalizedKey,
      )
    ) {
      return;
    }

    this.viewerWheelKey = normalizedKey;

    if (this.robotModel) {
      this.resolveWheelAnimationTargets();
    }
  }

  flashViewerWheel() {
    if (!this.viewerWheelKey || !this.robotModel) {
      return;
    }

    const runtimeTarget =
      this.wheelRuntimeTargetByKey[this.viewerWheelKey] || null;
    const wheelObject = runtimeTarget?.ref || null;
    if (!wheelObject) {
      return;
    }

    if (this.wheelFlashTimeoutId) {
      clearTimeout(this.wheelFlashTimeoutId);
      this.wheelFlashTimeoutId = null;
    }

    const materials = [];
    wheelObject.traverse((node) => {
      if (!node || !node.isMesh || !node.material) {
        return;
      }

      const nodeMaterials = Array.isArray(node.material)
        ? node.material
        : [node.material];
      nodeMaterials.forEach((material) => {
        if (material) {
          materials.push(material);
        }
      });
    });

    if (materials.length === 0) {
      return;
    }

    const originalStates = materials.map((material) => ({
      material: material,
      color: material.color ? material.color.clone() : null,
      emissive: material.emissive ? material.emissive.clone() : null,
    }));

    materials.forEach((material) => {
      if (material.color) {
        material.color.copy(this.wheelFlashAccentColor);
      }

      if (material.emissive) {
        material.emissive.copy(this.wheelFlashEmissiveColor);
      }
      material.needsUpdate = true;
    });

    this.wheelFlashTimeoutId = setTimeout(() => {
      originalStates.forEach((state) => {
        if (state.color && state.material.color) {
          state.material.color.copy(state.color);
        }

        if (state.emissive && state.material.emissive) {
          state.material.emissive.copy(state.emissive);
        }

        state.material.needsUpdate = true;
      });
      this.wheelFlashTimeoutId = null;
    }, 500);
  }

  init() {
    // 동적 크기 계산
    const containerRect = this.container.getBoundingClientRect();
    const width = containerRect.width;
    const height = containerRect.height;

    // Scene 생성
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);

    // Camera 생성
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000);
    this.camera.position.copy(this.cameraPosition);
    this.camera.up.copy(this.cameraUp);

    // Renderer 생성
    // logarithmicDepthBuffer: camera.near/far get set to a ~1:10000 ratio once the model
    // is fitted (see the cameraFit setup below), and several near-coplanar ground layers
    // (ground, ground grid, ground extension - only ~mm apart) sit far from the camera at
    // times. A standard linear depth buffer doesn't have enough precision across that
    // range, so those layers z-fight - which flavor wins changes with sub-pixel camera
    // motion, reading as the ground flickering, worse at grazing/oblique viewing angles
    // where the depth difference between layers projects to fewer distinguishable
    // buffer steps. A logarithmic depth buffer keeps precision usable across the whole
    // near/far range instead of concentrating it near the camera.
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      logarithmicDepthBuffer: true,
    });
    // Keep canvas size tied to container CSS to avoid cumulative inline-height growth on resize.
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.style.display = "block";
    // Hidden until loadURDF()'s revealRobotAndFitCamera() shows it again: otherwise the
    // canvas starts painting the scene background (currently sky blue) the moment the
    // renderer exists, well before the model has finished loading, so the container
    // flashes as a blank sky-colored rectangle and only then does the model pop in on
    // top of it - instead of the sky and the model appearing together in one frame.
    this.renderer.domElement.style.visibility = "hidden";
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    // Controls 설정
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    // 휠 줌은 항상 허용하고, 좌클릭은 회전, 우클릭은 패닝으로 분리한다.
    this.controls.enabled = true;
    this.controls.enableZoom = true;
    this.controls.enableRotate = false;
    this.controls.enablePan = true;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    if (this.hasCustomCameraTarget) {
      this.goalTarget.copy(this.cameraTarget);
      this.applyGoalTargetToControls();
    }
    this.cameraPosTextElement = $("#camera-pos-text");
    this.setupCameraAngleLogging();
    if (this.showViewCube) {
      this.setupViewCubeOverlay();
    }
    this.setupCameraToastOverlay();
    this.setupWheelControls();
    if (this.showAttitude) {
      this.setupAttitudeOverlay();
    }
    if (this.showCompass) {
      this.setupCompassOverlay();
    }
    if (this.showWheelInfo) {
      this.setupWheelInfoOverlay();
    }

    // 조명 설정
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
    this.directionalLight.castShadow = true;
    this.scene.add(this.directionalLight);
    this.scene.add(this.directionalLight.target);
    this.resetDirectionalLight(new THREE.Vector3(0, 0, 0), 1);

    const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
    this.scene.add(ambientLight);

    // 바닥 그리드와 축 추가
    // Built from LineSegments2/LineMaterial (same technique as
    // attachGroundHoleEdgeLines()'s pothole outline) instead of plain
    // THREE.GridHelper: GridHelper's LineBasicMaterial rasterizes each line at a fixed
    // 1px in screen space with whatever antialiasing the GPU/driver happens to do for
    // thin primitives, which is inconsistent enough that at grazing camera angles
    // (e.g. the view-cube L/R side views) sub-pixel camera motion - even just the
    // residual OrbitControls damping tail after a real drag/zoom, well before it fully
    // settles - visibly shimmers/flickers each line frame to frame. LineMaterial
    // computes each line's actual screen-space coverage in its fragment shader and
    // antialiases that directly, which is far more stable under the same camera
    // motion. Geometry/coloring is pulled from a throwaway THREE.GridHelper instead of
    // reimplementing its line-position math here.
    const gridHelperSource = new THREE.GridHelper(10, 20, 0x888888, 0xcccccc);
    const gridLineGeometry = new LineSegmentsGeometry();
    gridLineGeometry.setPositions(
      gridHelperSource.geometry.getAttribute("position").array,
    );
    gridLineGeometry.setColors(
      gridHelperSource.geometry.getAttribute("color").array,
    );
    gridHelperSource.geometry.dispose();

    const gridLineMaterial = new LineMaterial({
      vertexColors: true,
      linewidth: 1.25,
      worldUnits: false,
      resolution: new THREE.Vector2(Math.max(width, 1), Math.max(height, 1)),
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    const gridHelper = new LineSegments2(gridLineGeometry, gridLineMaterial);
    gridHelper.rotation.x = Math.PI / 2;
    gridHelper.visible = false;
    gridHelper.renderOrder = 999;
    this.scene.add(gridHelper);
    this.xyGridHelper = gridHelper;

    this.createAxisGuides(new THREE.Vector3(1, 1, 1));
    this.addAxisLabels(new THREE.Vector3(1, 1, 1));

    // 마우스 이벤트 설정
    this.setupMouseEvents();

    // URDF 로드
    this.loadURDF();

    // 애니메이션 시작
    this.animate();

    // 리사이즈 이벤트 설정
    this.setupResizeHandler();
  }

  ensureContainerOverlayPositioning() {
    if (!this.container) {
      return;
    }

    const computedStyle = window.getComputedStyle(this.container);
    if (computedStyle.position === "static") {
      this.container.style.position = "relative";
    }
  }

  blockOverlayPointerInteractions(overlayElement) {
    if (!overlayElement) {
      return;
    }

    const stopOverlayEvent = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const blockedEvents = [
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
      "mousedown",
      "mousemove",
      "mouseup",
      "touchstart",
      "touchmove",
      "touchend",
      "wheel",
      "click",
      "contextmenu",
    ];

    blockedEvents.forEach((eventName) => {
      overlayElement.addEventListener(eventName, stopOverlayEvent, true);
    });
  }

  setupWheelInfoOverlay() {
    if (!this.container || this.wheelInfoOverlayElement) {
      return;
    }

    const templateElement = document.getElementById(
      "wheel-info-table-template",
    );
    if (!templateElement) {
      console.warn(
        "[URDF] wheel-info-table-template not found. Wheel info overlay skipped.",
      );
      return;
    }

    this.ensureContainerOverlayPositioning();

    const overlayElement = document.createElement("div");
    overlayElement.style.position = "absolute";
    overlayElement.style.inset = "0";
    overlayElement.style.zIndex = "14";
    overlayElement.style.pointerEvents = "none";

    const wheelLayout = [
      { key: "fl", label: "FL", top: "96px", left: "10px" },
      { key: "fr", label: "FR", top: "96px", right: "10px" },
      { key: "rl", label: "RL", bottom: "10px", left: "10px" },
      { key: "rr", label: "RR", bottom: "10px", right: "10px" },
    ];

    const templateHtml = templateElement.innerHTML;
    wheelLayout.forEach((wheel) => {
      const panelElement = document.createElement("div");
      panelElement.style.position = "absolute";
      panelElement.style.width = "230px";
      panelElement.style.maxWidth = "34%";
      panelElement.style.pointerEvents = "none";
      panelElement.style.background = "rgba(255, 255, 255, 0.92)";
      panelElement.style.border = "1px solid rgba(0, 0, 0, 0.08)";
      panelElement.style.borderRadius = "8px";
      panelElement.style.boxShadow = "0 2px 6px rgba(0, 0, 0, 0.16)";
      panelElement.style.overflow = "hidden";
      panelElement.style.backdropFilter = "blur(1px)";

      if (wheel.top) {
        panelElement.style.top = wheel.top;
      }
      if (wheel.bottom) {
        panelElement.style.bottom = wheel.bottom;
      }
      if (wheel.left) {
        panelElement.style.left = wheel.left;
      }
      if (wheel.right) {
        panelElement.style.right = wheel.right;
      }

      panelElement.innerHTML = templateHtml
        .replaceAll("__WHEEL_KEY__", wheel.key)
        .replaceAll("__WHEEL_LABEL__", wheel.label);

      overlayElement.appendChild(panelElement);
    });

    this.container.appendChild(overlayElement);
    this.wheelInfoOverlayElement = overlayElement;
    this.setWheelInfoOverlayVisible(this.isWheelInfoOverlayVisible);
  }

  setWheelInfoOverlayVisible(isVisible) {
    this.isWheelInfoOverlayVisible = !!isVisible;
    this.saveWheelInfoOverlayVisibleState();

    if (this.wheelInfoOverlayElement) {
      this.wheelInfoOverlayElement.style.display = this
        .isWheelInfoOverlayVisible
        ? ""
        : "none";
    }

    this.updateWheelInfoToggleButtonState();
  }

  toggleWheelInfoOverlayVisible() {
    this.setWheelInfoOverlayVisible(!this.isWheelInfoOverlayVisible);
  }

  updateWheelInfoToggleButtonState() {
    if (!this.wheelInfoToggleButtonElement) {
      return;
    }

    const isVisible = this.isWheelInfoOverlayVisible;
    this.wheelInfoToggleButtonElement.innerHTML = isVisible
      ? '<i class="bi bi-gear-fill" aria-hidden="true"></i>'
      : '<i class="bi bi-gear" aria-hidden="true"></i>';
    this.wheelInfoToggleButtonElement.setAttribute(
      "aria-pressed",
      isVisible ? "true" : "false",
    );
    this.wheelInfoToggleButtonElement.setAttribute(
      "aria-label",
      isVisible ? "휠 정보 숨기기" : "휠 정보 표시",
    );
    this.wheelInfoToggleButtonElement.title = isVisible
      ? "휠 정보 숨기기"
      : "휠 정보 표시";
    this.wheelInfoToggleButtonElement.style.background = isVisible
      ? "rgba(255, 255, 255, 0.98)"
      : "rgba(229, 231, 235, 0.96)";
    this.wheelInfoToggleButtonElement.style.borderColor = isVisible
      ? "rgba(32, 46, 66, 0.45)"
      : "rgba(107, 114, 128, 0.85)";
    this.wheelInfoToggleButtonElement.style.color = isVisible
      ? "#1f2937"
      : "#6b7280";
  }

  setupAttitudeOverlay() {
    this.ensureContainerOverlayPositioning();

    // Match overlay widgets with road video overlay vertical start.
    const overlayTopPx = "10px";

    const panelElement = document.createElement("div");
    panelElement.style.position = "absolute";
    panelElement.style.top = overlayTopPx;
    panelElement.style.right = this.showCompass ? "80px" : "10px";
    panelElement.style.zIndex = "13";
    panelElement.style.padding = "8px";
    panelElement.style.background = "rgba(255, 255, 255, 0.88)";
    panelElement.style.border = "1px solid rgba(30, 30, 30, 0.2)";
    panelElement.style.borderRadius = "10px";
    panelElement.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.12)";
    panelElement.style.pointerEvents = "auto";
    panelElement.style.cursor = "pointer";
    panelElement.style.transition =
      "box-shadow 140ms ease, transform 140ms ease, border-color 140ms ease";
    panelElement.style.width = "auto";

    const dialElement = document.createElement("div");
    dialElement.style.position = "relative";
    dialElement.style.width = "48px";
    dialElement.style.height = "48px";
    dialElement.style.margin = "0 auto";
    dialElement.style.border = "1px solid rgba(34, 34, 34, 0.28)";
    dialElement.style.borderRadius = "999px";
    dialElement.style.background = "rgba(245, 247, 250, 0.9)";

    const crossXElement = document.createElement("div");
    crossXElement.style.position = "absolute";
    crossXElement.style.left = "50%";
    crossXElement.style.top = "8px";
    crossXElement.style.width = "1px";
    crossXElement.style.height = "40px";
    crossXElement.style.transform = "translateX(-50%)";
    crossXElement.style.background = "rgba(50, 50, 50, 0.16)";

    const crossYElement = document.createElement("div");
    crossYElement.style.position = "absolute";
    crossYElement.style.left = "8px";
    crossYElement.style.top = "50%";
    crossYElement.style.width = "40px";
    crossYElement.style.height = "1px";
    crossYElement.style.transform = "translateY(-50%)";
    crossYElement.style.background = "rgba(50, 50, 50, 0.16)";

    const rollNeedleElement = document.createElement("div");
    rollNeedleElement.style.position = "absolute";
    rollNeedleElement.style.left = "50%";
    rollNeedleElement.style.top = "50%";
    rollNeedleElement.style.width = "2px";
    rollNeedleElement.style.height = "22px";
    rollNeedleElement.style.background = "#d33";
    rollNeedleElement.style.transformOrigin = "50% calc(100% - 2px)";
    rollNeedleElement.style.transform = "translate(-50%, -100%) rotate(0deg)";
    rollNeedleElement.style.borderRadius = "2px";

    const pitchNeedleElement = document.createElement("div");
    pitchNeedleElement.style.position = "absolute";
    pitchNeedleElement.style.left = "50%";
    pitchNeedleElement.style.top = "50%";
    pitchNeedleElement.style.width = "2px";
    pitchNeedleElement.style.height = "18px";
    pitchNeedleElement.style.background = "#2f6bdf";
    pitchNeedleElement.style.transformOrigin = "50% calc(100% - 2px)";
    pitchNeedleElement.style.transform = "translate(-50%, -100%) rotate(90deg)";
    pitchNeedleElement.style.borderRadius = "2px";

    const centerDotElement = document.createElement("div");
    centerDotElement.style.position = "absolute";
    centerDotElement.style.left = "50%";
    centerDotElement.style.top = "50%";
    centerDotElement.style.width = "6px";
    centerDotElement.style.height = "6px";
    centerDotElement.style.transform = "translate(-50%, -50%)";
    centerDotElement.style.background = "#222";
    centerDotElement.style.borderRadius = "999px";

    dialElement.appendChild(crossXElement);
    dialElement.appendChild(crossYElement);
    dialElement.appendChild(rollNeedleElement);
    dialElement.appendChild(pitchNeedleElement);
    dialElement.appendChild(centerDotElement);

    panelElement.appendChild(dialElement);
    this.blockOverlayPointerInteractions(panelElement);
    this.container.appendChild(panelElement);

    this.attitudeOverlayElement = panelElement;
    this.rollNeedleElement = rollNeedleElement;
    this.pitchNeedleElement = pitchNeedleElement;
    this.updateAttitudeOverlay();
  }

  setupCompassOverlay() {
    if (!this.container || this.compassOverlayElement) {
      return;
    }

    this.ensureContainerOverlayPositioning();

    const panelElement = document.createElement("div");
    panelElement.style.position = "absolute";
    panelElement.style.top = "10px";
    panelElement.style.right = "10px";
    panelElement.style.zIndex = "13";
    panelElement.style.padding = "8px";
    panelElement.style.background = "rgba(255, 255, 255, 0.9)";
    panelElement.style.border = "1px solid rgba(30, 30, 30, 0.2)";
    panelElement.style.borderRadius = "10px";
    panelElement.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.12)";
    panelElement.style.pointerEvents = "auto";

    const viewportElement = document.createElement("div");
    viewportElement.style.position = "relative";
    viewportElement.style.width = "48px";
    viewportElement.style.height = "48px";
    viewportElement.style.margin = "0 auto";
    viewportElement.style.border = "1px solid rgba(34, 34, 34, 0.28)";
    viewportElement.style.borderRadius = "999px";
    viewportElement.style.background = "rgba(245, 247, 250, 0.92)";
    viewportElement.style.overflow = "hidden";
    viewportElement.style.cursor = "pointer";
    viewportElement.style.transition =
      "box-shadow 140ms ease, border-color 140ms ease, background-color 140ms ease";

    panelElement.addEventListener("mouseenter", () => {
      panelElement.style.borderColor = "rgba(54, 120, 255, 0.35)";
      panelElement.style.boxShadow = "0 5px 14px rgba(37, 99, 235, 0.20)";
      panelElement.style.transform = "translateY(-1px)";
    });

    panelElement.addEventListener("mouseleave", () => {
      panelElement.style.borderColor = "rgba(30, 30, 30, 0.2)";
      panelElement.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.12)";
      panelElement.style.transform = "translateY(0)";
    });

    panelElement.addEventListener(
      "dblclick",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.restoreInitialCameraPose();
      },
      true,
    );

    viewportElement.addEventListener("mouseenter", () => {
      viewportElement.style.borderColor = "rgba(30, 90, 220, 0.55)";
      viewportElement.style.background = "rgba(234, 242, 255, 0.96)";
      viewportElement.style.boxShadow =
        "0 0 0 2px rgba(59, 130, 246, 0.16) inset";
    });

    viewportElement.addEventListener("mouseleave", () => {
      viewportElement.style.borderColor = "rgba(34, 34, 34, 0.28)";
      viewportElement.style.background = "rgba(245, 247, 250, 0.92)";
      viewportElement.style.boxShadow = "none";
    });

    const compassRenderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
    });
    compassRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    compassRenderer.setSize(48, 48, false);
    compassRenderer.setClearColor(0x000000, 0);
    compassRenderer.domElement.style.width = "48px";
    compassRenderer.domElement.style.height = "48px";
    compassRenderer.domElement.style.display = "block";
    compassRenderer.domElement.style.cursor = "default";
    viewportElement.appendChild(compassRenderer.domElement);

    const compassScene = new THREE.Scene();
    const compassCamera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
    compassCamera.position.set(0, 0, 4.2);
    compassCamera.lookAt(0, 0, 0);

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.1);
    compassScene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.7);
    keyLight.position.set(2, 2, 3);
    compassScene.add(keyLight);

    const compassModelGroup = this.createCompassModelGroup();
    compassScene.add(compassModelGroup);

    panelElement.appendChild(viewportElement);
    this.blockOverlayPointerInteractions(panelElement);
    this.setupCompassDragInteraction(panelElement, viewportElement);

    this.container.appendChild(panelElement);
    this.compassOverlayElement = panelElement;
    this.compassRenderer = compassRenderer;
    this.compassScene = compassScene;
    this.compassCamera = compassCamera;
    this.compassModelGroup = compassModelGroup;
    this.updateCameraToastAnchorPosition();
    this.updateCompassOverlay();
  }

  setupCompassDragInteraction(interactionElement, viewportElement) {
    if (!interactionElement || !viewportElement) {
      return;
    }

    viewportElement.style.cursor = "pointer";

    const projectToArcball = (clientX, clientY) => {
      const rect = viewportElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return new THREE.Vector3(0, 0, 1);
      }

      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
      const lengthSq = x * x + y * y;

      if (lengthSq > 1) {
        const invLength = 1 / Math.sqrt(lengthSq);
        return new THREE.Vector3(x * invLength, y * invLength, 0);
      }

      const z = Math.sqrt(Math.max(0, 1 - lengthSq));
      return new THREE.Vector3(x, y, z).normalize();
    };

    const onPointerMove = (event) => {
      if (!this.compassDragState || !this.controls || !this.camera) {
        return;
      }

      const deltaX = event.clientX - this.compassDragState.lastClientX;
      const deltaY = event.clientY - this.compassDragState.lastClientY;
      this.compassDragState.lastClientX = event.clientX;
      this.compassDragState.lastClientY = event.clientY;
      this.compassDragState.totalMove += Math.hypot(deltaX, deltaY);
      const nextArcball = projectToArcball(event.clientX, event.clientY);

      if (
        this.compassDragState.totalMove <= this.compassDragActivateDistancePx
      ) {
        this.compassDragState.arcballVector = nextArcball;
        return;
      }

      if (!this.compassDragState.isActivated) {
        this.compassDragState.isActivated = true;
        this.compassDragState.arcballVector = nextArcball;
        return;
      }

      const previousArcball = this.compassDragState.arcballVector;
      this.compassDragState.arcballVector = nextArcball;

      const axisCamera = new THREE.Vector3().crossVectors(
        previousArcball,
        nextArcball,
      );
      if (axisCamera.lengthSq() < 1e-10) {
        return;
      }

      const dot = THREE.MathUtils.clamp(
        previousArcball.dot(nextArcball),
        -1,
        1,
      );
      const angle = Math.acos(dot) * this.compassArcballSensitivity;
      if (!Number.isFinite(angle) || angle <= 1e-6) {
        return;
      }

      axisCamera.normalize();
      const axisWorld = axisCamera
        .clone()
        .applyQuaternion(this.camera.quaternion)
        .normalize();

      const target = this.controls.target.clone();
      const offset = this.camera.position.clone().sub(target);
      const rotation = new THREE.Quaternion().setFromAxisAngle(
        axisWorld,
        angle,
      );
      offset.applyQuaternion(rotation);
      this.camera.up.applyQuaternion(rotation).normalize();

      this.camera.position.copy(target.clone().add(offset));
      this.camera.lookAt(target);
      this.controls.update();
      this.updateCompassOverlay();
      this.updateViewCubeOverlay();
      this.resetDirectionalLight(
        this.controls.target,
        this.directionalLightRadius,
      );
      this.logCameraInfos(false);
    };

    const endDrag = () => {
      if (!this.compassDragState) {
        return;
      }

      const movedEnough =
        this.compassDragState.totalMove > this.compassDragActivateDistancePx;
      this.compassDragState = null;
      viewportElement.style.cursor = "pointer";

      if (movedEnough) {
        this.logCameraInfos(true);
        this.saveCurrentCameraPoseToStorage();
      }

      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", endDrag, true);
      window.removeEventListener("pointercancel", endDrag, true);
      window.removeEventListener("blur", endDrag);
    };

    interactionElement.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 || !this.controls || !this.camera) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        viewportElement.style.cursor = "grabbing";
        this.compassDragState = {
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          totalMove: 0,
          isActivated: false,
          arcballVector: projectToArcball(event.clientX, event.clientY),
        };

        window.addEventListener("pointermove", onPointerMove, true);
        window.addEventListener("pointerup", endDrag, true);
        window.addEventListener("pointercancel", endDrag, true);
        window.addEventListener("blur", endDrag);
      },
      true,
    );
  }

  createCompassModelGroup() {
    const group = new THREE.Group();

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.04, 0.035, 10, 40),
      new THREE.MeshBasicMaterial({
        color: 0x8b98a9,
        transparent: true,
        opacity: 0.9,
      }),
    );
    group.add(ring);

    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(0.76, 20, 16),
      new THREE.MeshPhongMaterial({
        color: 0x7fb3ff,
        transparent: true,
        opacity: 0.28,
        shininess: 70,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    group.add(globe);

    const shaftNorth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.66, 10),
      new THREE.MeshPhongMaterial({ color: 0xef4444, shininess: 80 }),
    );
    shaftNorth.position.y = 0.33;
    group.add(shaftNorth);

    const tipNorth = new THREE.Mesh(
      new THREE.ConeGeometry(0.1, 0.22, 12),
      new THREE.MeshPhongMaterial({ color: 0xdc2626, shininess: 90 }),
    );
    tipNorth.position.y = 0.77;
    group.add(tipNorth);

    const shaftSouth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.48, 10),
      new THREE.MeshPhongMaterial({ color: 0x1d4ed8, shininess: 80 }),
    );
    shaftSouth.position.y = -0.25;
    group.add(shaftSouth);

    const tipSouth = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.18, 12),
      new THREE.MeshPhongMaterial({ color: 0x1e40af, shininess: 90 }),
    );
    tipSouth.position.y = -0.58;
    tipSouth.rotation.z = Math.PI;
    group.add(tipSouth);

    const centerDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 12, 10),
      new THREE.MeshPhongMaterial({ color: 0x111827, shininess: 100 }),
    );
    group.add(centerDot);

    const axisDefs = [
      { dir: new THREE.Vector3(1, 0, 0), color: 0xff3333 },
      { dir: new THREE.Vector3(0, 1, 0), color: 0x22aa22 },
      { dir: new THREE.Vector3(0, 0, 1), color: 0x3366ff },
    ];

    axisDefs.forEach((axisDef) => {
      const axisLength = 1.0;
      const coneHeight = 0.2;
      const lineEnd = axisDef.dir
        .clone()
        .multiplyScalar(axisLength - coneHeight);
      const coneCenter = axisDef.dir
        .clone()
        .multiplyScalar(axisLength - coneHeight * 0.5);

      const axisLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          lineEnd,
        ]),
        new THREE.LineBasicMaterial({
          color: axisDef.color,
          transparent: true,
          opacity: 0.95,
        }),
      );
      group.add(axisLine);

      const axisCone = new THREE.Mesh(
        new THREE.ConeGeometry(0.08, coneHeight, 12),
        new THREE.MeshPhongMaterial({ color: axisDef.color, shininess: 90 }),
      );
      axisCone.position.copy(coneCenter);
      axisCone.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        axisDef.dir.clone().normalize(),
      );
      group.add(axisCone);
    });

    return group;
  }

  setupViewCubeOverlay() {
    if (!this.container || this.viewCubeOverlayElement) {
      return;
    }

    this.ensureContainerOverlayPositioning();

    // Match overlay widgets with road video overlay vertical start.
    const overlayTopPx = "10px";

    const wrapperElement = document.createElement("div");
    wrapperElement.style.position = "absolute";
    wrapperElement.style.top = overlayTopPx;
    wrapperElement.style.left = "10px";
    wrapperElement.style.zIndex = "1000";
    wrapperElement.style.display = "inline-flex";
    wrapperElement.style.flexDirection = "row";
    wrapperElement.style.alignItems = "flex-start";
    wrapperElement.style.columnGap = "6px";
    wrapperElement.style.pointerEvents = "auto";

    const panelElement = document.createElement("div");
    panelElement.style.position = "relative";
    panelElement.style.width = "auto";
    panelElement.style.padding = "8px";
    panelElement.style.background = "rgba(255, 255, 255, 0.92)";
    panelElement.style.border = "1px solid rgba(20, 20, 20, 0.2)";
    panelElement.style.borderRadius = "10px";
    panelElement.style.boxShadow = "0 3px 10px rgba(0, 0, 0, 0.16)";
    panelElement.style.pointerEvents = "auto";
    panelElement.style.userSelect = "none";
    panelElement.style.zIndex = "1001";
    panelElement.style.transition =
      "box-shadow 140ms ease, transform 140ms ease, border-color 140ms ease";

    panelElement.addEventListener("mouseenter", () => {
      panelElement.style.borderColor = "rgba(51, 102, 255, 0.35)";
      panelElement.style.boxShadow = "0 6px 14px rgba(37, 99, 235, 0.22)";
      panelElement.style.transform = "translateY(-1px)";
    });

    panelElement.addEventListener("mouseleave", () => {
      panelElement.style.borderColor = "rgba(20, 20, 20, 0.2)";
      panelElement.style.boxShadow = "0 3px 10px rgba(0, 0, 0, 0.16)";
      panelElement.style.transform = "translateY(0)";
    });

    this.viewCubeButtonByFace = {};

    const gridElement = document.createElement("div");
    gridElement.style.display = "grid";
    gridElement.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
    gridElement.style.columnGap = "4px";
    gridElement.style.rowGap = "4px";

    const createFaceButton = (faceKey, label, title) => {
      const buttonElement = document.createElement("button");
      buttonElement.type = "button";
      buttonElement.textContent = label;
      buttonElement.title = title;
      buttonElement.style.minWidth = "28px";
      buttonElement.style.height = "24px";
      buttonElement.style.border = "1px solid rgba(32, 46, 66, 0.45)";
      buttonElement.style.borderRadius = "4px";
      buttonElement.style.background = "rgba(255, 255, 255, 0.98)";
      buttonElement.style.color = "#1f2937";
      buttonElement.style.fontSize = "9px";
      buttonElement.style.fontWeight = "700";
      buttonElement.style.cursor = "pointer";
      buttonElement.style.padding = "0 4px";
      buttonElement.style.lineHeight = "1.1";
      buttonElement.style.whiteSpace = "nowrap";
      buttonElement.style.transition =
        "background-color 120ms ease, color 120ms ease, border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease";

      const applyHoverOn = () => {
        buttonElement.style.background = "rgba(59, 130, 246, 0.16)";
        buttonElement.style.borderColor = "rgba(37, 99, 235, 0.78)";
        buttonElement.style.color = "#0b2a66";
        buttonElement.style.boxShadow = "0 1px 4px rgba(37, 99, 235, 0.26)";
        buttonElement.style.transform = "translateY(-1px)";
      };

      const applyHoverOff = () => {
        buttonElement.style.background = "rgba(255, 255, 255, 0.98)";
        buttonElement.style.borderColor = "rgba(32, 46, 66, 0.45)";
        buttonElement.style.color = "#1f2937";
        buttonElement.style.boxShadow = "none";
        buttonElement.style.transform = "translateY(0)";
      };

      buttonElement.addEventListener("mouseenter", applyHoverOn);
      buttonElement.addEventListener("mouseleave", applyHoverOff);
      buttonElement.addEventListener("focus", applyHoverOn);
      buttonElement.addEventListener("blur", applyHoverOff);
      buttonElement.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setCameraByViewCubeFace(faceKey);
      });
      this.viewCubeButtonByFace[faceKey] = buttonElement;
      return buttonElement;
    };

    gridElement.appendChild(createFaceButton("front", "F", "Front (+X)"));
    gridElement.appendChild(createFaceButton("back", "B", "Back (-X)"));
    gridElement.appendChild(createFaceButton("left", "L", "Left (+Y)"));
    gridElement.appendChild(createFaceButton("right", "R", "Right (-Y)"));
    gridElement.appendChild(createFaceButton("top", "U", "Up (+Z)"));
    gridElement.appendChild(createFaceButton("bottom", "D", "Down (-Z)"));

    panelElement.appendChild(gridElement);
    wrapperElement.appendChild(panelElement);

    if (this.showWheelInfo) {
      const wheelToggleButtonElement = document.createElement("button");
      wheelToggleButtonElement.type = "button";
      wheelToggleButtonElement.setAttribute(
        "aria-label",
        "휠 정보 오버레이 토글",
      );
      wheelToggleButtonElement.style.pointerEvents = "auto";
      wheelToggleButtonElement.style.position = "relative";
      wheelToggleButtonElement.style.zIndex = "1002";
      wheelToggleButtonElement.style.height = "32px";
      wheelToggleButtonElement.style.width = "32px";
      wheelToggleButtonElement.style.padding = "0";
      wheelToggleButtonElement.style.marginTop = "0";
      wheelToggleButtonElement.style.border =
        "1px solid rgba(32, 46, 66, 0.45)";
      wheelToggleButtonElement.style.borderRadius = "8px";
      wheelToggleButtonElement.style.display = "inline-flex";
      wheelToggleButtonElement.style.alignItems = "center";
      wheelToggleButtonElement.style.justifyContent = "center";
      wheelToggleButtonElement.style.fontSize = "14px";
      wheelToggleButtonElement.style.fontWeight = "700";
      wheelToggleButtonElement.style.lineHeight = "1";
      wheelToggleButtonElement.style.cursor = "pointer";
      wheelToggleButtonElement.style.userSelect = "none";
      wheelToggleButtonElement.style.transition =
        "background-color 120ms ease, color 120ms ease, border-color 120ms ease";
      wheelToggleButtonElement.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.toggleWheelInfoOverlayVisible();
      });

      this.wheelInfoToggleButtonElement = wheelToggleButtonElement;
      this.updateWheelInfoToggleButtonState();
      wrapperElement.appendChild(wheelToggleButtonElement);
    }

    if (this.showTransparency) {
      const opacityControlElement = document.createElement("div");
      opacityControlElement.style.display = "inline-flex";
      opacityControlElement.style.alignItems = "center";
      opacityControlElement.style.gap = "6px";
      opacityControlElement.style.height = "32px";
      opacityControlElement.style.padding = "0 8px";
      opacityControlElement.style.border = "1px solid rgba(32, 46, 66, 0.45)";
      opacityControlElement.style.borderRadius = "8px";
      opacityControlElement.style.background = "rgba(255, 255, 255, 0.96)";
      opacityControlElement.style.pointerEvents = "auto";
      opacityControlElement.style.position = "relative";
      opacityControlElement.style.zIndex = "1002";
      opacityControlElement.style.alignSelf = "flex-start";

      const opacityLabelElement = document.createElement("span");
      opacityLabelElement.className = "small fw-semibold text-nowrap";
      opacityLabelElement.textContent = "투명도";
      opacityLabelElement.style.color = "#1f2937";

      const opacitySliderElement = document.createElement("input");
      opacitySliderElement.type = "range";
      opacitySliderElement.min = "10";
      opacitySliderElement.max = "100";
      opacitySliderElement.step = "1";
      opacitySliderElement.className = "form-range m-0";
      opacitySliderElement.style.width = "96px";
      opacitySliderElement.style.cursor = "pointer";
      opacitySliderElement.style.pointerEvents = "auto";
      opacitySliderElement.style.touchAction = "pan-y";
      opacitySliderElement.setAttribute(
        "aria-label",
        "car_frame 내부 요소 투명도",
      );

      const opacityValueElement = document.createElement("span");
      opacityValueElement.className = "small fw-semibold text-nowrap";
      opacityValueElement.style.minWidth = "42px";
      opacityValueElement.style.textAlign = "right";
      opacityValueElement.style.color = "#1f2937";

      opacitySliderElement.value = String(
        Math.round(this.carFrameOpacity * 100),
      );
      opacityValueElement.textContent = `${Math.round(this.carFrameOpacity * 100)}%`;
      opacitySliderElement.style.setProperty(
        "--slider-percent",
        `${Math.round(this.carFrameOpacity * 100)}%`,
      );

      opacitySliderElement.addEventListener("input", (event) => {
        const nextValue = Number.parseFloat(event.target.value);
        this.setCarFrameOpacity(nextValue / 100);
      });

      this.carFrameOpacitySliderElement = opacitySliderElement;
      this.carFrameOpacityValueElement = opacityValueElement;
      this.carFrameOpacityControlElement = opacityControlElement;

      opacityControlElement.appendChild(opacityLabelElement);
      opacityControlElement.appendChild(opacitySliderElement);
      opacityControlElement.appendChild(opacityValueElement);
      wrapperElement.appendChild(opacityControlElement);
    }

    this.container.appendChild(wrapperElement);
    this.viewCubeOverlayElement = wrapperElement;
    this.viewCubeCubeElement = null;
    this.updateViewCubeOverlay();
  }

  setupViewCubeDragInteraction(interactionElement) {
    if (!interactionElement) {
      return;
    }

    interactionElement.style.cursor = "grab";

    const projectToArcball = (clientX, clientY) => {
      const rect = interactionElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return new THREE.Vector3(0, 0, 1);
      }

      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
      const lengthSq = x * x + y * y;

      if (lengthSq > 1) {
        const invLength = 1 / Math.sqrt(lengthSq);
        return new THREE.Vector3(x * invLength, y * invLength, 0);
      }

      const z = Math.sqrt(Math.max(0, 1 - lengthSq));
      return new THREE.Vector3(x, y, z).normalize();
    };

    const onPointerMove = (event) => {
      if (!this.viewCubeDragState || !this.controls || !this.camera) {
        return;
      }

      const deltaX = event.clientX - this.viewCubeDragState.lastClientX;
      const deltaY = event.clientY - this.viewCubeDragState.lastClientY;
      this.viewCubeDragState.lastClientX = event.clientX;
      this.viewCubeDragState.lastClientY = event.clientY;
      this.viewCubeDragState.totalMove += Math.hypot(deltaX, deltaY);
      const nextArcball = projectToArcball(event.clientX, event.clientY);

      if (
        this.viewCubeDragState.totalMove <= this.viewCubeDragActivateDistancePx
      ) {
        this.viewCubeDragState.arcballVector = nextArcball;
        return;
      }

      if (!this.viewCubeDragState.isActivated) {
        this.viewCubeDragState.isActivated = true;
        this.viewCubeSuppressClickUntilMs = performance.now() + 150;
        this.viewCubeDragState.arcballVector = nextArcball;
        return;
      }

      this.viewCubeSuppressClickUntilMs = performance.now() + 150;

      const previousArcball = this.viewCubeDragState.arcballVector;
      this.viewCubeDragState.arcballVector = nextArcball;

      const axisCamera = new THREE.Vector3().crossVectors(
        previousArcball,
        nextArcball,
      );
      if (axisCamera.lengthSq() < 1e-10) {
        return;
      }

      const dot = THREE.MathUtils.clamp(
        previousArcball.dot(nextArcball),
        -1,
        1,
      );
      const angle = Math.acos(dot) * this.viewCubeArcballSensitivity;
      if (!Number.isFinite(angle) || angle <= 1e-6) {
        return;
      }

      axisCamera.normalize();
      const axisWorld = axisCamera
        .clone()
        .applyQuaternion(this.camera.quaternion)
        .normalize();

      const target = this.controls.target.clone();
      const offset = this.camera.position.clone().sub(target);

      // Use standard drag direction: pointer movement rotates the camera in the same arcball direction.
      const rotation = new THREE.Quaternion().setFromAxisAngle(
        axisWorld,
        angle,
      );
      offset.applyQuaternion(rotation);
      this.camera.up.applyQuaternion(rotation).normalize();

      this.camera.position.copy(target.clone().add(offset));
      this.camera.lookAt(target);
      this.controls.update();
      this.updateViewCubeOverlay();
      this.resetDirectionalLight(
        this.controls.target,
        this.directionalLightRadius,
      );
      this.logCameraInfos(false);
    };

    const endDrag = () => {
      if (!this.viewCubeDragState) {
        return;
      }
      const movedEnough =
        this.viewCubeDragState.totalMove > this.viewCubeDragActivateDistancePx;
      this.viewCubeDragState = null;
      interactionElement.style.cursor = "grab";
      if (movedEnough) {
        this.viewCubeIgnoreFaceClickUntilMs = performance.now() + 300;
        this.logCameraInfos(true);
        this.saveCurrentCameraPoseToStorage();
      }
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", endDrag, true);
      window.removeEventListener("pointercancel", endDrag, true);
      window.removeEventListener("blur", endDrag);
    };

    interactionElement.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      interactionElement.style.cursor = "grabbing";
      this.viewCubeDragState = {
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        totalMove: 0,
        isActivated: false,
        arcballVector: projectToArcball(event.clientX, event.clientY),
      };

      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerup", endDrag, true);
      window.addEventListener("pointercancel", endDrag, true);
      window.addEventListener("blur", endDrag);
    });
  }

  setCameraByViewCubeFace(faceKey) {
    if (!this.controls || !this.camera) {
      return;
    }

    const faceVectors = this.getCameraVectorsByFace(faceKey);
    if (!faceVectors) {
      return;
    }

    const focusBounds = this.getPrimaryFocusBounds();
    const nextTarget = focusBounds.center.clone();
    const currentDistanceFromChassisCenter = this.camera.position.distanceTo(
      this.controls.target,
    );
    const nextDistance =
      Number.isFinite(currentDistanceFromChassisCenter) &&
      currentDistanceFromChassisCenter > 0.001
        ? currentDistanceFromChassisCenter
        : this.calculateFitDistanceForFace(
            focusBounds.size,
            faceKey,
            this.cameraFitMarginRatio,
          );
    const overlayDragPixels = Number(this.overlayDragPanPixels) || 0;
    const containerHeight = Number(
      this.container?.clientHeight ||
        this.container?.getBoundingClientRect?.().height ||
        0,
    );
    if (overlayDragPixels > 0 && containerHeight > 0) {
      let worldPerPixel = 0;
      if (this.camera.isPerspectiveCamera) {
        const fovRad = THREE.MathUtils.degToRad(this.camera.fov || 50);
        worldPerPixel =
          (2 * nextDistance * Math.tan(fovRad / 2)) / containerHeight;
      } else if (this.camera.isOrthographicCamera) {
        const frustumHeight =
          (this.camera.top - this.camera.bottom) /
          Math.max(this.camera.zoom || 1, 0.001);
        worldPerPixel = frustumHeight / containerHeight;
      }

      const viewDirection = faceVectors.direction.clone().negate();
      const cameraRight = new THREE.Vector3()
        .crossVectors(viewDirection, faceVectors.up)
        .normalize();
      const screenUp = new THREE.Vector3()
        .crossVectors(cameraRight, viewDirection)
        .normalize();
      if (worldPerPixel > 0 && screenUp.lengthSq() > 0) {
        nextTarget.addScaledVector(screenUp, overlayDragPixels * worldPerPixel);
      }
    }
    const nextPosition = nextTarget
      .clone()
      .add(faceVectors.direction.multiplyScalar(nextDistance));

    this.animateCameraToPoseWithTarget(
      nextPosition,
      nextTarget,
      faceVectors.up,
      240,
      () => {
        this.saveCurrentCameraPoseToStorage();
        this.updateCameraToastOverlay();
        this.showCameraToastOverlay();
      },
    );
  }

  getPrimaryFocusBounds() {
    const fallbackTarget =
      this.controls?.target?.clone?.() || new THREE.Vector3(0, 0, 0);
    const fallbackSize = new THREE.Vector3(1, 1, 1);

    if (!this.robotModel) {
      return {
        center: fallbackTarget,
        size: fallbackSize,
      };
    }

    const linkMap = this.robotModel.links || {};
    const carFrame = linkMap.car_frame || null;
    const bbox = new THREE.Box3();

    if (carFrame) {
      const childLinkRoots = Object.values(linkMap).filter((linkRoot) => {
        if (!linkRoot || linkRoot === carFrame) {
          return false;
        }

        let parent = linkRoot.parent;
        while (parent) {
          if (parent === carFrame) {
            return true;
          }
          parent = parent.parent;
        }
        return false;
      });

      carFrame.updateWorldMatrix(true, true);
      carFrame.traverse((node) => {
        if (!node?.isMesh || !node.geometry) {
          return;
        }

        const belongsToChildLink = childLinkRoots.some((linkRoot) => {
          let current = node;
          while (current) {
            if (current === linkRoot) {
              return true;
            }
            current = current.parent;
          }
          return false;
        });
        if (belongsToChildLink) {
          return;
        }

        if (!node.geometry.boundingBox) {
          node.geometry.computeBoundingBox();
        }
        if (node.geometry.boundingBox) {
          bbox.union(
            node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld),
          );
        }
      });
    }

    if (bbox.isEmpty()) {
      return {
        center: fallbackTarget,
        size: fallbackSize,
      };
    }

    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());

    return {
      center,
      size,
    };
  }

  getCameraVectorsByFace(faceKey) {
    const directionByFace = {
      front: new THREE.Vector3(1, 0, 0),
      back: new THREE.Vector3(-1, 0, 0),
      left: new THREE.Vector3(0, 1, 0),
      right: new THREE.Vector3(0, -1, 0),
      top: new THREE.Vector3(0, 0, 1),
      bottom: new THREE.Vector3(0, 0, -1),
    };

    const upByFace = {
      front: new THREE.Vector3(0, 0, 1),
      back: new THREE.Vector3(0, 0, 1),
      left: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(0, 0, 1),
      top: new THREE.Vector3(1, 0, 0),
      bottom: new THREE.Vector3(-1, 0, 0),
    };

    const direction = directionByFace[faceKey];
    if (!direction) {
      return null;
    }

    return {
      direction: direction.clone(),
      up: (upByFace[faceKey] || upByFace.front).clone(),
    };
  }

  setCameraFromFace(center, distance, faceKey) {
    const faceVectors = this.getCameraVectorsByFace(faceKey);
    if (!this.camera || !center || !faceVectors) {
      return;
    }

    const safeDistance =
      Number.isFinite(distance) && distance > 0.001 ? distance : 3;
    this.camera.position
      .copy(center)
      .add(faceVectors.direction.multiplyScalar(safeDistance));
    this.camera.up.copy(faceVectors.up);
    this.camera.lookAt(center);
  }

  animateCameraToPose(nextPosition, nextUp, durationMs = 220) {
    if (!this.camera || !this.controls || !nextPosition || !nextUp) {
      return;
    }

    const startPosition = this.camera.position.clone();
    const startUp = this.camera.up.clone();
    const target = this.controls.target.clone();
    const startTimeMs = performance.now();

    const easeInOut = (t) => {
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    };

    const step = () => {
      const elapsedMs = performance.now() - startTimeMs;
      const progress =
        durationMs > 0
          ? THREE.MathUtils.clamp(elapsedMs / durationMs, 0, 1)
          : 1;
      const eased = easeInOut(progress);

      this.camera.position.copy(
        startPosition.clone().lerp(nextPosition, eased),
      );
      this.camera.up.copy(startUp.clone().lerp(nextUp, eased).normalize());
      this.camera.lookAt(target);
      this.controls.update();
      this.updateViewCubeOverlay();
      this.resetDirectionalLight(
        this.controls.target,
        this.directionalLightRadius,
      );

      if (progress < 1) {
        requestAnimationFrame(step);
        return;
      }

      this.logCameraInfos(true);
    };

    requestAnimationFrame(step);
  }

  animateCameraToPoseWithTarget(
    nextPosition,
    nextTarget,
    nextUp,
    durationMs = 260,
    onComplete = null,
  ) {
    if (
      !this.camera ||
      !this.controls ||
      !nextPosition ||
      !nextTarget ||
      !nextUp
    ) {
      return;
    }

    const startPosition = this.camera.position.clone();
    const startUp = this.camera.up.clone();
    const startTarget = this.controls.target.clone();
    const targetPosition = nextPosition.clone();
    const targetUp = nextUp.clone().normalize();
    const targetTarget = nextTarget.clone();
    const startTimeMs = performance.now();

    const easeInOut = (t) => {
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    };

    const step = () => {
      const elapsedMs = performance.now() - startTimeMs;
      const progress =
        durationMs > 0
          ? THREE.MathUtils.clamp(elapsedMs / durationMs, 0, 1)
          : 1;
      const eased = easeInOut(progress);

      this.camera.position.copy(
        startPosition.clone().lerp(targetPosition, eased),
      );
      this.camera.up.copy(startUp.clone().lerp(targetUp, eased).normalize());
      this.controls.target.copy(startTarget.clone().lerp(targetTarget, eased));
      this.camera.lookAt(this.controls.target);
      this.controls.update();
      this.updateCompassOverlay();
      this.updateViewCubeOverlay();
      this.resetDirectionalLight(
        this.controls.target,
        this.directionalLightRadius,
      );

      if (progress < 1) {
        requestAnimationFrame(step);
        return;
      }

      this.goalTarget.set(
        this.controls.target.x,
        this.controls.target.y + this.goalTargetVerticalOffset,
        this.controls.target.z,
      );
      this.logCameraInfos(true);

      if (typeof onComplete === "function") {
        onComplete();
      }
    };

    requestAnimationFrame(step);
  }

  updateViewCubeOverlay() {
    const hasButtons =
      this.viewCubeButtonByFace &&
      Object.keys(this.viewCubeButtonByFace).length > 0;
    if (!hasButtons || !this.controls || !this.camera) {
      return;
    }

    const target = this.controls.target.clone();
    const cameraOffset = this.camera.position.clone().sub(target);
    if (cameraOffset.lengthSq() < 1e-8) {
      return;
    }

    const direction = cameraOffset.normalize();
    const absX = Math.abs(direction.x);
    const absY = Math.abs(direction.y);
    const absZ = Math.abs(direction.z);

    let activeFaceKey = "front";
    if (absX >= absY && absX >= absZ) {
      activeFaceKey = direction.x >= 0 ? "front" : "back";
    } else if (absY >= absX && absY >= absZ) {
      activeFaceKey = direction.y >= 0 ? "left" : "right";
    } else {
      activeFaceKey = direction.z >= 0 ? "top" : "bottom";
    }

    this.viewCubeActiveFaceKey = activeFaceKey;
  }

  updateAttitudeOverlay() {
    const rollDeg = Number.isFinite(this.roadRollAngleDeg)
      ? this.roadRollAngleDeg
      : 0;
    const pitchDeg = Number.isFinite(this.roadPitchAngleDeg)
      ? this.roadPitchAngleDeg
      : 0;

    if (this.rollNeedleElement) {
      this.rollNeedleElement.style.transform = `translate(-50%, -100%) rotate(${rollDeg}deg)`;
    }

    if (this.pitchNeedleElement) {
      this.pitchNeedleElement.style.transform = `translate(-50%, -100%) rotate(${90 + pitchDeg}deg)`;
    }
  }

  updateCompassOverlay() {
    if (
      !this.compassRenderer ||
      !this.compassScene ||
      !this.compassCamera ||
      !this.compassModelGroup ||
      !this.camera
    ) {
      return;
    }

    const cameraQuaternion = new THREE.Quaternion();
    this.camera.getWorldQuaternion(cameraQuaternion);

    // Keep world north fixed and rotate the compass opposite to camera orientation.
    this.compassModelGroup.quaternion.copy(cameraQuaternion).invert();
    this.compassRenderer.render(this.compassScene, this.compassCamera);
  }

  setupCameraAngleLogging() {
    if (this.cameraPosTextElement && this.cameraPosTextElement.length > 0) {
      this.cameraPosTextElement.off("click").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.copyTextToClipboard(this.cameraPosCopyText)
          .then(() => {
            this.showCameraToastMessage(
              "cameraPose가 클립보드에 복사되었습니다.",
            );
          })
          .catch(() => {
            this.showCameraToastMessage("cameraPose 복사에 실패했습니다.");
          });
      });
    }

    this.controls.addEventListener("start", () => {
      this.isDragging = true;
    });

    this.controls.addEventListener("end", () => {
      this.isDragging = false;

      // setOverlayZoomOutRatio()/setOverlayVerticalDragPixels() (used to zoom/pan the
      // camera out of the way of the video overlay) compute each new adjustment as a
      // relative delta from their own remembered overlayZoomOutRatio/overlayDragPanPixels
      // - they assume the camera hasn't moved except through themselves since the last
      // call. A real user drag/wheel interaction (enableZoom/enablePan are both on)
      // breaks that assumption: the next overlay open/close then divides out or reapplies
      // an offset against a base that no longer means what it used to, and repeating
      // that (drag the view around while the overlay is open, close it, reopen it, ...)
      // compounds into the camera's distance run away - the reported "geographic area
      // shrinks/grows a lot" bug. Absorb the user's end state as the new baseline so the
      // next overlay adjustment starts fresh instead of compounding on stale bookkeeping.
      this.overlayZoomOutRatio = 0;
      this.overlayDragPanPixels = 0;
      this.goalTarget.copy(this.controls.target);
      this.goalTargetVerticalOffset = 0;

      // Land on an accurate light/shadow position now that the camera has actually
      // stopped, since the "change" handler below throttles this during the drag itself.
      this.resetDirectionalLight(
        this.controls.target,
        this.directionalLightRadius,
      );
      this.logCameraInfos(true);
      this.saveCurrentCameraPoseToStorage();
      this.updateCameraToastOverlay();
      this.showCameraToastOverlay();
    });

    this.controls.addEventListener("change", () => {
      // resetDirectionalLight() moves the shadow-casting light's position and its
      // shadow-camera frustum (recomputing shadow.camera.left/right/top/bottom/near/far
      // and calling updateProjectionMatrix()). "change" fires on every single frame of a
      // drag/zoom - and, with damping enabled, keeps firing for a bit after the pointer
      // is released/the wheel stops - so calling it unthrottled here moved the shadow map
      // a tiny amount every frame. Each of those tiny moves shifts which texels of the
      // (fixed-resolution) shadow map line up with the ground, which reads as the ground
      // shadow flickering/shimmering during - and for a few damping frames after - every
      // orbit, pan, or wheel zoom. Throttling this to a few times a second keeps the
      // light roughly following the camera during interaction without the per-frame
      // shadow-map churn; the "end" handler above does one last unthrottled call so the
      // light/shadow end up exactly right once the camera actually settles.
      if (!this.suppressInteractiveDirectionalLightFollow) {
        const nowMs = performance.now();
        if (
          !this.lastInteractiveDirectionalLightUpdateMs ||
          nowMs - this.lastInteractiveDirectionalLightUpdateMs >=
            this.directionalLightUpdateThrottleMs
        ) {
          this.lastInteractiveDirectionalLightUpdateMs = nowMs;
          this.resetDirectionalLight(
            this.controls.target,
            this.directionalLightRadius,
          );
        }
      }
      this.updateViewCubeOverlay();
      this.updateCompassOverlay();
      this.logCameraInfos(false);
    });
  }

  setupCameraToastOverlay() {
    if (!this.container || this.cameraToastElement) {
      return;
    }

    const toastElement = document.createElement("div");
    toastElement.style.position = "absolute";
    toastElement.style.right = "12px";
    toastElement.style.bottom = "12px";
    toastElement.style.zIndex = "20";
    toastElement.style.padding = "8px 10px";
    toastElement.style.background = "rgba(17, 17, 17, 0.82)";
    toastElement.style.border = "1px solid rgba(255, 255, 255, 0.12)";
    toastElement.style.borderRadius = "10px";
    toastElement.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.22)";
    toastElement.style.color = "#ffffff";
    toastElement.style.fontSize = "12px";
    toastElement.style.fontWeight = "700";
    toastElement.style.letterSpacing = "0.02em";
    toastElement.style.pointerEvents = "auto";
    toastElement.style.cursor = "pointer";
    toastElement.style.display = "none";
    toastElement.style.whiteSpace = "nowrap";
    toastElement.title =
      'cameraPose="0.000, 0.000, 0.000|0.000, 0.000, 0.000|0.000, 1.000, 0.000"';
    toastElement.textContent =
      "0.000, 0.000, 0.000|0.000, 0.000, 0.000|0.000, 1.000, 0.000";

    const stopOverlayEvent = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    toastElement.addEventListener("pointerdown", stopOverlayEvent, true);
    toastElement.addEventListener("mousedown", stopOverlayEvent, true);
    toastElement.addEventListener("click", (event) => {
      stopOverlayEvent(event);
      this.copyCameraToastToClipboard();
    });

    this.container.appendChild(toastElement);
    this.cameraToastElement = toastElement;
    this.updateCameraToastAnchorPosition();
  }

  updateCameraToastAnchorPosition() {
    if (!this.cameraToastElement) {
      return;
    }

    if (this.showCompass && this.compassOverlayElement) {
      const compassTopPx =
        Number.parseFloat(this.compassOverlayElement.style.top || "10") || 10;
      const compassHeightPx = Number(
        this.compassOverlayElement.offsetHeight || 64,
      );
      const toastTopPx = compassTopPx + compassHeightPx + 8;

      this.cameraToastElement.style.right = "10px";
      this.cameraToastElement.style.top = `${toastTopPx}px`;
      this.cameraToastElement.style.bottom = "auto";
      return;
    }

    this.cameraToastElement.style.right = "12px";
    this.cameraToastElement.style.top = "auto";
    this.cameraToastElement.style.bottom = "12px";
  }

  updateCameraToastOverlay() {
    if (!this.cameraToastElement) {
      return;
    }

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
    const tx = formatPositionValue(this.controls?.target?.x);
    const ty = formatPositionValue(this.controls?.target?.y);
    const tz = formatPositionValue(this.controls?.target?.z);
    const ux = formatPositionValue(this.camera.up.x);
    const uy = formatPositionValue(this.camera.up.y);
    const uz = formatPositionValue(this.camera.up.z);
    const poseValueText = `${px}, ${py}, ${pz}|${tx}, ${ty}, ${tz}|${ux}, ${uy}, ${uz}`;
    this.cameraToastElement.textContent = poseValueText;
    this.cameraToastElement.title = `cameraPose="${poseValueText}"`;
  }

  copyCameraToastToClipboard() {
    if (!this.cameraToastElement) {
      return;
    }

    const textToCopy =
      this.cameraToastElement.textContent ||
      "0.000, 0.000, 0.000|0.000, 0.000, 0.000|0.000, 1.000, 0.000";

    this.copyTextToClipboard(textToCopy)
      .then(() => {
        this.showCameraToastMessage("cameraPose가 클립보드에 복사되었습니다.");
      })
      .catch(() => {
        this.showCameraToastMessage("cameraPose 복사에 실패했습니다.");
      });
  }

  copyTextToClipboard(textToCopy) {
    if (!textToCopy) {
      return Promise.reject(new Error("No text to copy"));
    }

    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      return navigator.clipboard.writeText(textToCopy).catch(() => {
        this.copyTextToClipboardFallback(textToCopy);
      });
    }

    return Promise.resolve(this.copyTextToClipboardFallback(textToCopy));
  }

  copyTextToClipboardFallback(text) {
    const tempTextArea = document.createElement("textarea");
    tempTextArea.value = text;
    tempTextArea.setAttribute("readonly", "");
    tempTextArea.style.position = "fixed";
    tempTextArea.style.left = "-9999px";
    tempTextArea.style.top = "-9999px";
    document.body.appendChild(tempTextArea);
    tempTextArea.select();

    try {
      const copied = document.execCommand("copy");
      if (!copied) {
        throw new Error("execCommand returned false");
      }
    } catch (error) {
      console.warn("[URDF] 카메라 좌표 복사 실패:", error);
      document.body.removeChild(tempTextArea);
      throw error;
    }

    document.body.removeChild(tempTextArea);
  }

  showCameraToastMessage(message, durationMs = 1600) {
    if (!this.cameraToastElement || !message) {
      return;
    }

    this.cameraToastElement.textContent = String(message);
    this.cameraToastElement.title = String(message);
    this.cameraToastElement.style.display = "block";

    if (this.cameraToastHideTimer) {
      clearTimeout(this.cameraToastHideTimer);
    }

    this.cameraToastHideTimer = setTimeout(() => {
      this.hideCameraToastOverlay();
    }, durationMs);
  }

  showCameraToastOverlay() {
    if (!this.cameraToastElement) {
      return;
    }

    this.cameraToastElement.style.display = "block";

    if (this.cameraToastHideTimer) {
      clearTimeout(this.cameraToastHideTimer);
    }

    this.cameraToastHideTimer = setTimeout(() => {
      this.hideCameraToastOverlay();
    }, this.cameraToastHideDelayMs);
  }

  hideCameraToastOverlay() {
    if (!this.cameraToastElement) {
      return;
    }

    this.cameraToastElement.style.display = "none";
    if (this.cameraToastHideTimer) {
      clearTimeout(this.cameraToastHideTimer);
      this.cameraToastHideTimer = null;
    }
  }

  hideCameraToastOverlayLater() {
    if (!this.cameraToastElement) {
      return;
    }

    if (this.cameraToastHideTimer) {
      clearTimeout(this.cameraToastHideTimer);
    }

    this.cameraToastHideTimer = setTimeout(() => {
      this.hideCameraToastOverlay();
    }, this.cameraToastHideDelayMs);
  }

  setupWheelControls() {
    Object.keys(this.wheelSpeedRpmByKey).forEach((key) => {
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

  getSignedWheelRpm(key) {
    const rpm = Number(this.wheelSpeedRpmByKey[key]) || 0;
    const directionSign = Number(this.wheelDirectionSignByKey[key]) || 1;
    return rpm * directionSign;
  }

  getDisplayedWheelRpm(key) {
    return this.getSignedWheelRpm(key);
  }

  formatRpmText(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return "0";
    }

    const rounded = Math.round(numeric * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  updateWheelSpeedFromInput(key) {
    const inputElement = this.wheelSpeedInputByKey[key];
    if (!inputElement || inputElement.length === 0) {
      return;
    }

    const inputRpm = Number.parseFloat(inputElement.val());
    const signedRpm = Number.isFinite(inputRpm)
      ? THREE.MathUtils.clamp(Math.round(inputRpm), -120, 120)
      : this.getSignedWheelRpm(key);
    const normalizedRpm = Math.abs(signedRpm);
    const directionSign = signedRpm < 0 ? -1 : 1;

    this.setWheelDirectionSign(key, directionSign);
    this.wheelSpeedRpmByKey[key] = normalizedRpm;
    this.wheelAngularSpeedRadByKey[key] =
      this.convertRpmToRadPerSec(normalizedRpm);
    inputElement.val(String(signedRpm));

    const valueElement = this.wheelSpeedValueByKey[key];
    if (valueElement && valueElement.length > 0) {
      valueElement.text(`${this.getDisplayedWheelRpm(key)} rpm`);
    }
  }

  captureDriveAnimationPoseSnapshot() {
    if (!this.robotModel) {
      return;
    }

    const carFrame =
      this.robotModel.links?.car_frame ||
      this.robotModel.links?.base_link ||
      this.robotModel.root ||
      null;
    if (!carFrame) {
      return;
    }

    this.driveAnimationPoseSnapshot = {
      position: carFrame.position.clone(),
      quaternion: carFrame.quaternion.clone(),
    };
  }

  restoreDriveAnimationPoseSnapshot() {
    if (!this.robotModel) {
      return;
    }

    const carFrame =
      this.robotModel.links?.car_frame ||
      this.robotModel.links?.base_link ||
      this.robotModel.root ||
      null;
    if (!carFrame || !this.driveAnimationPoseSnapshot) {
      return;
    }

    carFrame.position.copy(this.driveAnimationPoseSnapshot.position);
    carFrame.quaternion
      .copy(this.driveAnimationPoseSnapshot.quaternion)
      .normalize();
    carFrame.updateMatrixWorld(true);
  }

  setWheelSpeedRpm(key, rpm) {
    const numericRpm = Number.parseFloat(rpm);
    const directionSign =
      Number.isFinite(numericRpm) && numericRpm < 0 ? -1 : 1;
    const normalizedRpm = Number.isFinite(numericRpm)
      ? Math.max(Math.abs(numericRpm), 0)
      : this.wheelSpeedRpmByKey[key];

    this.captureDriveAnimationPoseSnapshot();
    this.setWheelDirectionSign(key, directionSign);

    this.wheelSpeedRpmByKey[key] = normalizedRpm;
    this.wheelAngularSpeedRadByKey[key] =
      this.convertRpmToRadPerSec(normalizedRpm);

    const inputElement = this.wheelSpeedInputByKey[key];
    if (inputElement && inputElement.length > 0) {
      inputElement.val(this.formatRpmText(this.getDisplayedWheelRpm(key)));
    }

    const valueElement = this.wheelSpeedValueByKey[key];
    if (valueElement && valueElement.length > 0) {
      valueElement.text(
        `${this.formatRpmText(this.getDisplayedWheelRpm(key))} rpm`,
      );
    }

    this.restoreDriveAnimationPoseSnapshot();
  }

  setWheelDirectionSign(key, sign) {
    this.wheelDirectionSignByKey[key] = sign >= 0 ? 1 : -1;
  }

  convertKmhToRpm(kmh, wheelKey = null) {
    const perWheelFactor = Number(this.kmhToRpmFactorByWheelKey?.[wheelKey]);
    const rpmFactor =
      Number.isFinite(perWheelFactor) && perWheelFactor > 0
        ? perWheelFactor
        : this.kmhToRpmFactor;
    return Math.max(kmh, 0) * rpmFactor;
  }

  applyDriveMode(mode, speedKmh) {
    this.driveMode = mode;
    this.driveSpeedKmh = Number.isFinite(Number(speedKmh))
      ? Math.max(Number(speedKmh), 0)
      : this.driveSpeedKmh;

    this.captureDriveAnimationPoseSnapshot();
    const rpmForWheel = (wheelKey) =>
      this.convertKmhToRpm(this.driveSpeedKmh, wheelKey);
    const straightDriveRpm = this.convertKmhToRpm(this.driveSpeedKmh);
    const wheelRpmByMode = {
      forward: {
        fl: straightDriveRpm,
        fr: straightDriveRpm,
        rl: straightDriveRpm,
        rr: straightDriveRpm,
      },
      backward: {
        fl: -straightDriveRpm,
        fr: -straightDriveRpm,
        rl: -straightDriveRpm,
        rr: -straightDriveRpm,
      },
      left: {
        fl: -rpmForWheel("fl"),
        fr: rpmForWheel("fr"),
        rl: -rpmForWheel("rl"),
        rr: rpmForWheel("rr"),
      },
      right: {
        fl: rpmForWheel("fl"),
        fr: -rpmForWheel("fr"),
        rl: rpmForWheel("rl"),
        rr: -rpmForWheel("rr"),
      },
      stop: { fl: 0, fr: 0, rl: 0, rr: 0 },
    };
    const wheelRpms = wheelRpmByMode[mode] || wheelRpmByMode.stop;

    Object.entries(wheelRpms).forEach(([key, rpm]) => {
      this.setWheelSpeedRpm(key, rpm);
    });
    this.updateWheelHighlightsByDriveDirection();
  }

  updateWheelHighlightsByDriveDirection() {
    if (this.container.id !== "vehicle-urdf-viewer") {
      return;
    }

    const forwardWheelKeys = Object.keys(this.wheelSpeedRpmByKey).filter(
      (key) => {
        const rpm = Number(this.wheelSpeedRpmByKey[key]) || 0;
        const directionSign = Number(this.wheelDirectionSignByKey[key]) || 1;
        return rpm > 0 && directionSign > 0;
      },
    );

    if (forwardWheelKeys.length > 0) {
      this.applyWheelHighlightByKeys(forwardWheelKeys);
      return;
    }

    this.clearWheelHighlights();
  }

  toVisualWheelAngularSpeedRad(targetAngularSpeedRad) {
    const numericTarget = Number(targetAngularSpeedRad);
    if (!Number.isFinite(numericTarget) || Math.abs(numericTarget) <= 1e-8) {
      return 0;
    }

    const sign = numericTarget >= 0 ? 1 : -1;
    const absTarget = Math.abs(numericTarget);
    const omegaCap = Math.max(
      Number(this.wheelVisualAngularSpeedCapRad) || 0,
      0.001,
    );
    const compressionK = Math.max(
      Number(this.wheelVisualCompressionK) || 0,
      0.001,
    );

    // 1) Hard cap for extreme values, 2) nonlinear compression for readability at high speed.
    const capped = Math.min(absTarget, omegaCap * 4);
    const compressed = omegaCap * (1 - Math.exp(-capped / compressionK));

    return sign * Math.min(compressed, omegaCap);
  }

  setWheelVisualFilterEnabled(enabled) {
    this.enableWheelVisualFilter = enabled !== false;
  }

  setWheelAnimationTimeScale(scale) {
    const numericScale = Number(scale);
    this.wheelAnimationTimeScale = Number.isFinite(numericScale)
      ? Math.max(numericScale, 0)
      : 1;
  }

  setWheelRotationDrivenByTravel(enabled) {
    this.isWheelRotationDrivenByTravel = enabled === true;
    if (this.isWheelRotationDrivenByTravel) {
      Object.keys(this.wheelVisualAngularSpeedRadByKey).forEach((key) => {
        this.wheelVisualAngularSpeedRadByKey[key] = 0;
      });
    }
  }

  getCarFrameForwardWorld() {
    const carFrame =
      this.robotModel?.links?.car_frame || this.robotModel?.root || null;
    if (!carFrame) {
      return null;
    }

    carFrame.updateWorldMatrix(true, false);
    const carFrameQuaternion = carFrame.getWorldQuaternion(
      new THREE.Quaternion(),
    );
    return new THREE.Vector3(1, 0, 0)
      .applyQuaternion(carFrameQuaternion)
      .normalize();
  }

  getWheelTravelRotationSign(runtimeTarget, forwardWorld) {
    if (
      runtimeTarget?.type !== "joint" ||
      !runtimeTarget.ref ||
      !forwardWorld
    ) {
      return 1;
    }

    const jointAxis = runtimeTarget.ref.axis;
    if (!jointAxis) {
      return 1;
    }

    const axisLocal = new THREE.Vector3(
      Number(jointAxis.x),
      Number(jointAxis.y),
      Number(jointAxis.z),
    );
    if (axisLocal.lengthSq() <= 1e-10) {
      return 1;
    }

    runtimeTarget.ref.updateWorldMatrix(true, false);
    const axisWorld = axisLocal
      .normalize()
      .applyQuaternion(
        runtimeTarget.ref.getWorldQuaternion(new THREE.Quaternion()),
      )
      .normalize();
    const positiveRotationTravel = new THREE.Vector3(0, 0, -1).cross(axisWorld);
    if (positiveRotationTravel.lengthSq() <= 1e-10) {
      return 1;
    }

    return positiveRotationTravel.dot(forwardWorld) >= 0 ? 1 : -1;
  }

  getWheelAnimationRotationSign(runtimeTarget, forwardWorld) {
    if (runtimeTarget?.type === "joint") {
      return this.getWheelTravelRotationSign(runtimeTarget, forwardWorld);
    }

    return this.wheelVisualRotationSign;
  }

  // Shared core of the distance-based (rolling-without-slip) rotation update - factored
  // out so applyWheelPassiveRotation() below can drive a single locked wheel the exact
  // same way applyWheelTravelDistances() drives an unlocked one, instead of duplicating
  // the rotation-sign/inner-gear/joint-vs-link logic.
  applyWheelDistanceRotationForKey(key, distanceMeters, radiusMeters, forwardWorld) {
    const runtimeTarget = this.wheelRuntimeTargetByKey[key];
    if (
      !runtimeTarget ||
      !Number.isFinite(distanceMeters) ||
      !Number.isFinite(radiusMeters) ||
      radiusMeters <= 0
    ) {
      return;
    }

    const rotationSign = this.getWheelTravelRotationSign(
      runtimeTarget,
      forwardWorld,
    );
    this.wheelAngles[key] += (rotationSign * distanceMeters) / radiusMeters;
    // Must happen before the wheel joint itself is driven - see the comment on
    // innerGearJointNameByKey in the constructor.
    this.applyInnerGearRotation(key);
    if (runtimeTarget.type === "joint") {
      runtimeTarget.ref.setJointValue(this.wheelAngles[key]);
      return;
    }

    if (runtimeTarget.type === "link") {
      const rotationAxis =
        runtimeTarget.axis || (this.viewerWheelKey ? "x" : "y");
      const linkRotationSign = Number.isFinite(runtimeTarget.rotationSign)
        ? runtimeTarget.rotationSign
        : this.viewerWheelKey
          ? -1
          : 1;
      runtimeTarget.ref.rotation[rotationAxis] =
        this.wheelAngles[key] * linkRotationSign;
    }
  }

  applyWheelTravelDistances(distanceMetersByKey, radiusMetersByKey = {}) {
    const forwardWorld = this.getCarFrameForwardWorld();
    Object.keys(this.wheelRuntimeTargetByKey).forEach((key) => {
      if (this.wheelRotationLockedByKey[key]) {
        // The outer tire itself stays frozen *relative to normal drive-commanded
        // rotation* here, but inner_gear_{key}_joint still has to keep tracking the
        // carrier's own motion (applyInnerGearRotation()'s carrierAngle term) - per
        // simulation.js's updateWheelClimbGait(), it's specifically the carrier
        // ("중간휠") and this gear ("내부휠") that keep moving to close the 기준각도
        // (reference angle) back to 0. The outer tire ("외부휠") itself still needs to
        // passively roll along with wherever the carrier is carrying it, though - see
        // applyWheelPassiveRotation() below, which updateWheelClimbGait() calls directly
        // for exactly that, bypassing this drive-commanded path entirely.
        this.applyInnerGearRotation(key);
        return;
      }
      this.applyWheelDistanceRotationForKey(
        key,
        Number(distanceMetersByKey?.[key]),
        Number(radiusMetersByKey?.[key]),
        forwardWorld,
      );
    });
  }

  // Called by simulation.js's updateWheelClimbGait() for a wheel it currently has
  // rotation-locked (see wheelRotationLockedByKey's own comment) - drive-commanded
  // rotation is suppressed there (applyWheelTravelDistances()/applyWheelAnimation() both
  // skip the wheel while locked), but the outer tire still has to visually roll along
  // with however the carrier is moving its center this frame, the same
  // rolling-without-slip relation the normal drive path uses (arc length = distance /
  // radius) - a wheel whose center is being carried through space without any
  // corresponding spin would visibly slide rather than roll. Bypasses
  // wheelRotationLockedByKey entirely (this call *is* the intentional rotation source
  // while locked, not a locked-out one) - callers must gate calling this on their own
  // lock state instead, same as applyInnerGearRotation() being called unconditionally.
  applyWheelPassiveRotation(key, distanceMeters, radiusMeters) {
    this.applyWheelDistanceRotationForKey(
      key,
      distanceMeters,
      radiusMeters,
      this.getCarFrameForwardWorld(),
    );
  }

  applyWheelAnimation(deltaSec) {
    if (!this.robotModel || this.isWheelRotationDrivenByTravel) {
      return;
    }

    const scaledDeltaSec = deltaSec * this.wheelAnimationTimeScale;
    const forwardWorld = this.getCarFrameForwardWorld();

    Object.keys(this.wheelSpeedRpmByKey).forEach((key) => {
      if (this.wheelRotationLockedByKey[key]) {
        // See the matching comment in applyWheelTravelDistances() - the outer tire stays
        // frozen, but inner_gear_{key}_joint still has to keep tracking the carrier's own
        // motion while it's the one closing 기준각도 back to 0.
        this.applyInnerGearRotation(key);
        return;
      }
      const runtimeTarget = this.wheelRuntimeTargetByKey[key];
      if (!runtimeTarget) {
        return;
      }

      const wheelAngularSpeedRad = this.wheelAngularSpeedRadByKey[key] || 0;
      const wheelDirection = this.wheelDirectionSignByKey[key] || 1;
      const rotationSign = this.getWheelAnimationRotationSign(
        runtimeTarget,
        forwardWorld,
      );
      const targetAngularSpeedRad =
        rotationSign * wheelDirection * wheelAngularSpeedRad;
      let clampedAngleStep = targetAngularSpeedRad * scaledDeltaSec;

      if (this.enableWheelVisualFilter) {
        const visualTargetAngularSpeedRad = this.toVisualWheelAngularSpeedRad(
          targetAngularSpeedRad,
        );

        const smoothingHz = Math.max(
          Number(this.wheelVisualSmoothingHz) || 0,
          0,
        );
        const alpha =
          smoothingHz > 0
            ? 1 - Math.exp(-smoothingHz * Math.max(scaledDeltaSec, 0))
            : 1;
        const currentVisualAngularSpeedRad =
          Number(this.wheelVisualAngularSpeedRadByKey[key]) || 0;
        const nextVisualAngularSpeedRad =
          currentVisualAngularSpeedRad +
          (visualTargetAngularSpeedRad - currentVisualAngularSpeedRad) * alpha;
        this.wheelVisualAngularSpeedRadByKey[key] = nextVisualAngularSpeedRad;

        const maxStepRad = Math.max(
          Number(this.wheelVisualMaxStepRadPerFrame) || 0,
          0.001,
        );
        const rawAngleStep = nextVisualAngularSpeedRad * scaledDeltaSec;
        clampedAngleStep = THREE.MathUtils.clamp(
          rawAngleStep,
          -maxStepRad,
          maxStepRad,
        );
      } else {
        // Physical-mode rendering path: use raw signed angular velocity without visual compression.
        this.wheelVisualAngularSpeedRadByKey[key] = targetAngularSpeedRad;
      }

      if (Math.abs(clampedAngleStep) <= 1e-10) {
        return;
      }

      this.wheelAngles[key] += clampedAngleStep;

      // Must happen before the wheel joint itself is driven - see the comment on
      // innerGearJointNameByKey in the constructor.
      this.applyInnerGearRotation(key);

      if (runtimeTarget.type === "joint") {
        runtimeTarget.ref.setJointValue(this.wheelAngles[key]);
        return;
      }

      if (runtimeTarget.type === "link") {
        const rotationAxis =
          runtimeTarget.axis || (this.viewerWheelKey ? "x" : "y");
        const rotationSign = Number.isFinite(runtimeTarget.rotationSign)
          ? runtimeTarget.rotationSign
          : this.viewerWheelKey
            ? -1
            : 1;
        runtimeTarget.ref.rotation[rotationAxis] =
          this.wheelAngles[key] * rotationSign;
      }
    });
  }

  resolveLinkRotationInfoFromJoint(joint) {
    const axisCandidates = [
      joint?.axis,
      joint?.jointAxis,
      joint?.urdfJoint?.axis,
      joint?.urdfNode?.axis,
    ];

    for (const axisCandidate of axisCandidates) {
      let x = NaN;
      let y = NaN;
      let z = NaN;

      if (Array.isArray(axisCandidate) && axisCandidate.length >= 3) {
        x = Number(axisCandidate[0]);
        y = Number(axisCandidate[1]);
        z = Number(axisCandidate[2]);
      } else if (axisCandidate && typeof axisCandidate === "object") {
        x = Number(axisCandidate.x);
        y = Number(axisCandidate.y);
        z = Number(axisCandidate.z);
      }

      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        continue;
      }

      const axisEntries = [
        { axis: "x", value: x },
        { axis: "y", value: y },
        { axis: "z", value: z },
      ];

      axisEntries.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
      const dominant = axisEntries[0];
      if (!dominant || Math.abs(dominant.value) < 1e-6) {
        continue;
      }

      return {
        axis: dominant.axis,
        rotationSign: dominant.value >= 0 ? 1 : -1,
      };
    }

    return null;
  }

  applyRoadAttitudeAngles() {
    this.updateAttitudeOverlay();

    if (!this.robotModel) {
      return;
    }

    const linkMap = this.robotModel.links || {};
    const carFrame = linkMap.car_frame || null;
    const groundLink = linkMap.ground_patch || linkMap.ground || null;
    const rollRad = THREE.MathUtils.degToRad(this.roadRollAngleDeg);
    const pitchRad = THREE.MathUtils.degToRad(this.roadPitchAngleDeg);

    const attitudeTargets = [];
    // 현재 URDF 구조(ellipsoid_surface -> ground -> car_frame) 기준으로
    // ground만 기울여도 car_frame 및 하위 링크에 회전이 전파된다.
    if (groundLink) {
      attitudeTargets.push(groundLink);
    } else if (carFrame) {
      // ground 링크를 찾지 못할 때만 기존처럼 차체를 직접 회전한다.
      attitudeTargets.push(carFrame);
    }

    attitudeTargets.forEach((target) => {
      target.rotation.set(rollRad, pitchRad, 0);
    });

    this.applyCarFrameRollAlertVisual(carFrame);
  }

  ensureCarFrameAlertMaterials(carFrame) {
    if (!carFrame) {
      return [];
    }

    if (
      Array.isArray(this.carFrameAlertMaterials) &&
      this.carFrameAlertMaterials.length > 0
    ) {
      return this.carFrameAlertMaterials;
    }

    const linkMap = this.robotModel?.links || {};
    const excludedRoots = [
      linkMap.ellipsoid_surface_patch || null,
      linkMap.ground_patch || null,
    ].filter(Boolean);

    const isExcludedRoadNode = (node) => {
      if (!node || excludedRoots.length === 0) {
        return false;
      }

      return excludedRoots.some(
        (root) => node === root || this.isDescendantObject3D(node, root),
      );
    };

    const collectedMaterials = [];
    carFrame.traverse((node) => {
      if (!node || !node.isMesh || !node.material || isExcludedRoadNode(node)) {
        return;
      }

      if (!node.userData.__wcsCarFrameMaterialCloned) {
        if (Array.isArray(node.material)) {
          node.material = node.material.map(
            (material) => material?.clone?.() || material,
          );
        } else if (node.material?.clone) {
          node.material = node.material.clone();
        }
        node.userData.__wcsCarFrameMaterialCloned = true;
      }

      const materials = Array.isArray(node.material)
        ? node.material
        : [node.material];
      materials.forEach((material) => {
        if (
          !material ||
          collectedMaterials.some((item) => item.material === material)
        ) {
          return;
        }

        collectedMaterials.push({
          material: material,
          baseColor: material.color ? material.color.clone() : null,
          baseEmissive: material.emissive ? material.emissive.clone() : null,
        });
      });
    });

    this.carFrameAlertMaterials = collectedMaterials;
    return this.carFrameAlertMaterials;
  }

  applyCarFrameRollAlertVisual(carFrame) {
    const alertMaterials = this.ensureCarFrameAlertMaterials(carFrame);
    if (!alertMaterials || alertMaterials.length === 0) {
      return;
    }

    const shouldAlert =
      Math.abs(Number(this.roadRollAngleDeg) || 0) >
      this.carFrameRollAlertThresholdDeg;
    if (this.isCarFrameAlertActive === shouldAlert) {
      return;
    }

    alertMaterials.forEach((item) => {
      if (!item || !item.material) {
        return;
      }

      if (item.baseColor && item.material.color) {
        if (shouldAlert) {
          item.material.color
            .copy(item.baseColor)
            .lerp(this.carFrameAlertTintColor, 0.85);
        } else {
          item.material.color.copy(item.baseColor);
        }
      }

      if (item.baseEmissive && item.material.emissive) {
        if (shouldAlert) {
          item.material.emissive.copy(this.carFrameAlertEmissiveColor);
        } else {
          item.material.emissive.copy(item.baseEmissive);
        }
      }

      item.material.needsUpdate = true;
    });

    this.isCarFrameAlertActive = shouldAlert;
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

    if (this.viewerWheelKey) {
      const singleWheelLink = linkMap.wheel || null;
      if (singleWheelLink) {
        Object.keys(this.wheelRuntimeTargetByKey).forEach((key) => {
          this.wheelRuntimeTargetByKey[key] =
            key === this.viewerWheelKey
              ? { type: "link", ref: singleWheelLink }
              : null;
        });

        console.log(
          `[URDF] ${this.viewerWheelKey.toUpperCase()} 단일 휠 뷰어 연결: wheel 링크`,
        );
        return;
      }
    }

    Object.keys(this.wheelJointNameByKey).forEach((key) => {
      const expectedJointName = this.wheelJointNameByKey[key];
      let joint = jointMap[expectedJointName] || null;

      if (!joint) {
        const keySuffix = `_${key}`;
        const keyJointSuffix = `${key}_joint`;
        const keyTokenRegex = new RegExp(`(^|[_/.-])${key}([_/.-]|$)`, "i");
        const canonicalWheelJointName = `wheel_${key}_joint`;
        const canonicalLower = canonicalWheelJointName.toLowerCase();

        // 1) wheel_${key}_joint 를 최우선으로 직접 탐색한다.
        const preferredJointName = jointNames.find((name) => {
          const lower = String(name || "").toLowerCase();
          return (
            lower === canonicalLower ||
            lower.endsWith(`/${canonicalLower}`) ||
            lower.endsWith(`.${canonicalLower}`) ||
            lower.endsWith(`_${canonicalLower}`)
          );
        });

        if (preferredJointName) {
          joint = jointMap[preferredJointName] || null;
        }

        if (joint) {
          // 최우선 후보를 찾았으면 추가 매칭을 생략한다.
        } else {
          const candidateJointName = jointNames
            .filter(
              (name) =>
                name === expectedJointName ||
                name.endsWith(expectedJointName) ||
                name.endsWith(keySuffix) ||
                name.endsWith(keyJointSuffix) ||
                (name.toLowerCase().includes("joint") &&
                  keyTokenRegex.test(name)),
            )
            .sort((a, b) => {
              const score = (name) => {
                const lower = String(name || "").toLowerCase();
                const canonical = canonicalWheelJointName.toLowerCase();
                const isInner = lower.includes("inner");

                if (lower === canonical) {
                  return 0;
                }
                if (
                  lower.endsWith(`/${canonical}`) ||
                  lower.endsWith(`.${canonical}`) ||
                  lower.endsWith(`_${canonical}`)
                ) {
                  return 1;
                }
                if (lower.includes(`wheel_${key}`) && !isInner) {
                  return 2;
                }
                if (lower.endsWith(keyJointSuffix.toLowerCase()) && !isInner) {
                  return 3;
                }
                if (lower.endsWith(expectedJointName.toLowerCase())) {
                  return 4;
                }
                if (isInner) {
                  return 8;
                }
                return 6;
              };

              return score(a) - score(b);
            })[0];

          if (candidateJointName) {
            joint = jointMap[candidateJointName];
          }
        }
      }

      if (joint && typeof joint.setJointValue === "function") {
        const expectedLinkName = this.wheelLinkNameByKey[key];
        const link = linkMap[expectedLinkName] || null;

        this.wheelRuntimeTargetByKey[key] = {
          type: "joint",
          ref: joint,
        };
        console.log(
          `[URDF] ${key.toUpperCase()} 휠 조인트 연결:`,
          joint.name || expectedJointName,
        );
        return;
      }

      const expectedLinkName = this.wheelLinkNameByKey[key];
      const link = linkMap[expectedLinkName] || null;
      if (link) {
        const linkRotationInfo = this.resolveLinkRotationInfoFromJoint(
          joint,
        ) || {
          axis: this.viewerWheelKey ? "x" : "y",
          rotationSign: this.viewerWheelKey ? -1 : 1,
        };
        this.wheelRuntimeTargetByKey[key] = {
          type: "link",
          ref: link,
          axis: linkRotationInfo.axis,
          rotationSign: linkRotationInfo.rotationSign,
        };
        console.warn(
          `[URDF] ${key.toUpperCase()} 조인트 미발견. 링크 회전 폴백 사용:`,
          expectedLinkName,
        );
        return;
      }

      this.wheelRuntimeTargetByKey[key] = null;
      console.warn(
        `[URDF] ${key.toUpperCase()} 휠 대상(조인트/링크)을 찾지 못했습니다.`,
      );
    });

    this.resolveInnerGearJointTargets();
    this.resolveInnerWheelJointTargets();
  }

  // See the comment on innerWheelJointNameByKey in the constructor. No-op (leaves every
  // key null) on models that don't have this joint - setInnerWheelCarrierAngle() below
  // then just tracks the angle without touching the scene, same as an unresolved wheel
  // target.
  resolveInnerWheelJointTargets() {
    const jointMap = this.robotModel?.joints || {};

    Object.keys(this.innerWheelJointNameByKey).forEach((key) => {
      const jointName = this.innerWheelJointNameByKey[key];
      const joint = jointMap[jointName] || null;
      this.innerWheelRuntimeTargetByKey[key] =
        joint && typeof joint.setJointValue === "function" ? joint : null;
      // Force a re-measure against this (possibly new) model's geometry.
      this.innerWheelOrbitRadiusMetersByKey[key] = null;
      this.innerWheelCarrierAngleRadByKey[key] = 0;

      if (this.innerWheelRuntimeTargetByKey[key]) {
        console.log(`[URDF] ${key.toUpperCase()} 캐리어(inner_wheel) 조인트 연결:`, jointName);
      }
    });
  }

  // See the comment on innerGearJointNameByKey in the constructor. No-op (leaves every
  // key null) on models that don't have these joints at all - applyInnerGearRotation()
  // below then just skips that wheel every frame, same as an unresolved wheel target.
  resolveInnerGearJointTargets() {
    const jointMap = this.robotModel?.joints || {};

    Object.keys(this.innerGearJointNameByKey).forEach((key) => {
      const jointName = this.innerGearJointNameByKey[key];
      const joint = jointMap[jointName] || null;
      this.innerGearRuntimeTargetByKey[key] =
        joint && typeof joint.setJointValue === "function" ? joint : null;
      // Force a re-measure against this (possibly new) model's geometry.
      this.innerGearRatioByKey[key] = null;

      if (this.innerGearRuntimeTargetByKey[key]) {
        console.log(`[URDF] ${key.toUpperCase()} 내부 기어 조인트 연결:`, jointName);
      }
    });
  }

  // Local (untransformed) bounding radius of a link's own mesh, used to auto-derive the
  // wheel<->inner-gear ratio from the model's actual geometry instead of a hardcoded
  // constant - same "average of the two larger box dimensions, halved" approach
  // simulation.js's estimateWheelEffectiveRadiusMeters() uses for the wheel radius
  // itself, so the two stay consistent with each other. Every <mesh> visual in this
  // wheel-pod assembly sits at origin xyz="0 0 0" relative to its own link (see
  // sw17.urdf), so the mesh's own geometry.boundingBox already *is* the link's local
  // bounding box - no extra transform math needed.
  measureLinkLocalRadius(link) {
    if (!link) {
      return null;
    }

    let mesh = null;
    link.traverse((child) => {
      if (!mesh && child.isMesh && child.geometry) {
        mesh = child;
      }
    });
    if (!mesh) {
      return null;
    }

    if (!mesh.geometry.boundingBox) {
      mesh.geometry.computeBoundingBox();
    }

    const size = mesh.geometry.boundingBox
      .getSize(new THREE.Vector3())
      .toArray()
      .sort((a, b) => a - b);
    const radius = (size[1] + size[2]) * 0.25;
    return radius > 1e-6 ? radius : null;
  }

  // Returns null (not an error - just "not measurable yet") until both links' mesh
  // files have actually finished loading; see urdf-loader-progressive-mesh-reveal in
  // the project memory for why that can lag well behind the joint/link tree parsing.
  // Callers re-try every frame via applyInnerGearRotation() until this succeeds once,
  // then it's cached for the rest of this model's lifetime.
  ensureInnerGearRatioMeasured(key) {
    const cachedRatio = this.innerGearRatioByKey[key];
    if (Number.isFinite(cachedRatio)) {
      return cachedRatio;
    }

    const linkMap = this.robotModel?.links || {};
    const wheelRadius = this.measureLinkLocalRadius(
      linkMap[this.wheelLinkNameByKey[key]],
    );
    const gearRadius = this.measureLinkLocalRadius(
      linkMap[this.innerGearLinkNameByKey[key]],
    );
    if (!wheelRadius || !gearRadius) {
      return null;
    }

    // Bevel-gear pair meshing at their pitch radii: matching tangential speed at the
    // contact point means angularSpeed_gear * gearRadius == angularSpeed_wheel *
    // wheelRadius, i.e. the (smaller, faster-spinning) pinion must turn by
    // wheelAngle * (wheelRadius / gearRadius) for every wheelAngle the wheel itself
    // turns by.
    const ratio = wheelRadius / gearRadius;
    this.innerGearRatioByKey[key] = ratio;
    console.log(`[URDF] ${key.toUpperCase()} 내부 기어비 자동 계산:`, {
      wheelRadius,
      gearRadius,
      ratio,
    });
    return ratio;
  }

  // Distance from inner_wheel_{key}_joint's own rotation axis (Z, in swing_link's local
  // frame - see the comment on innerWheelJointNameByKey in the constructor) out to
  // wheel_{key}_joint's mount point, i.e. the radius of the circle the wheel's own axle
  // sweeps out as the carrier orbits. Unlike ensureInnerGearRatioMeasured() this reads a
  // joint's fixed origin offset, not mesh geometry, so it only needs the joint/link
  // *tree* to exist (available as soon as robotModel is set, well before this model's
  // mesh files necessarily finish loading - see urdf-loader-progressive-mesh-reveal in
  // the project memory).
  measureInnerWheelOrbitRadiusMeters(key) {
    const cachedRadius = this.innerWheelOrbitRadiusMetersByKey[key];
    if (Number.isFinite(cachedRadius)) {
      return cachedRadius;
    }

    const wheelJoint = this.robotModel?.joints?.[this.wheelJointNameByKey[key]];
    const offset = wheelJoint?.position;
    if (!offset) {
      return null;
    }

    // Only the component perpendicular to the carrier's own rotation axis (Z) actually
    // sweeps as the carrier orbits - offset.z is a fixed along-axis displacement that
    // stays constant regardless of carrier angle, so it's deliberately excluded here.
    const radius = Math.hypot(offset.x, offset.y);
    if (!(radius > 1e-6)) {
      return null;
    }

    this.innerWheelOrbitRadiusMetersByKey[key] = radius;
    console.log(`[URDF] ${key.toUpperCase()} 캐리어 오빗 반경 자동 계산:`, radius);
    return radius;
  }

  // Called every frame by simulation.js's updateWheelClimbGait() to orbit the wheel pod's
  // carrier joint (see the comment on innerWheelJointNameByKey in the constructor) up and
  // over a step edge. Also just records the angle (even with no joint resolved) so
  // applyInnerGearRotation() below always has a value to read.
  setInnerWheelCarrierAngle(key, angleRad) {
    const numericAngleRad = Number.isFinite(angleRad) ? angleRad : 0;
    this.innerWheelCarrierAngleRadByKey[key] = numericAngleRad;

    const carrierJoint = this.innerWheelRuntimeTargetByKey[key];
    if (carrierJoint) {
      carrierJoint.setJointValue(numericAngleRad);
    }
  }

  // Called every frame by simulation.js's updateWheelClimbGait() alongside
  // setInnerWheelCarrierAngle() above - see wheelRotationLockedByKey's own comment in the
  // constructor for why both wheel-driving methods below need to check this.
  setWheelRotationLocked(key, locked) {
    if (!Object.prototype.hasOwnProperty.call(this.wheelRotationLockedByKey, key)) {
      return;
    }
    this.wheelRotationLockedByKey[key] = locked === true;
  }

  // Drives inner_gear_{key}_joint from the same wheelAngles[key] the wheel joint itself
  // is about to be set from, scaled by the auto-measured gear ratio, plus a correction
  // for the carrier (inner_wheel_{key}_joint, driven separately by
  // setInnerWheelCarrierAngle() above) whenever it's orbiting to climb a step. inner_gear
  // (sun) and wheel (planet) mesh at a fixed center distance carried by inner_wheel, so
  // the standard planetary relation is (gearAngle - carrierAngle) = k * (wheelAngle -
  // carrierAngle) for some constant k - solving for gearAngle and picking k = +ratio (the
  // sign already in use below, before the carrier term existed, for the carrier-parked
  // case) gives gearAngle = carrierAngle*(1 - ratio) + wheelAngle*ratio. That reduces
  // exactly to the original wheelAngle*ratio when carrierAngle is 0 (normal driving, the
  // carrier always parked there), so this is a strict extension, not a behavior change,
  // for every wheel that never climbs anything. The k = +ratio choice itself is still the
  // same untested assumption the original comment flagged (sign not verified against the
  // actual bevel-gear handedness in the mesh) - flip it here if the pinion is ever
  // observed spinning the wrong way, in either mode.
  applyInnerGearRotation(key) {
    const gearJoint = this.innerGearRuntimeTargetByKey[key];
    if (!gearJoint) {
      return;
    }

    const ratio = this.ensureInnerGearRatioMeasured(key);
    if (!Number.isFinite(ratio)) {
      return;
    }

    const carrierAngleRad = Number(this.innerWheelCarrierAngleRadByKey[key]) || 0;
    gearJoint.setJointValue(
      carrierAngleRad * (1 - ratio) + this.wheelAngles[key] * ratio,
    );
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
    const tx = formatPositionValue(this.controls?.target?.x);
    const ty = formatPositionValue(this.controls?.target?.y);
    const tz = formatPositionValue(this.controls?.target?.z);
    const ux = formatPositionValue(this.camera.up.x);
    const uy = formatPositionValue(this.camera.up.y);
    const uz = formatPositionValue(this.camera.up.z);
    const poseValueText = `${px}, ${py}, ${pz}|${tx}, ${ty}, ${tz}|${ux}, ${uy}, ${uz}`;
    this.cameraPosCopyText = poseValueText;

    if (this.cameraPosTextElement && this.cameraPosTextElement.length > 0) {
      this.cameraPosTextElement.text(poseValueText);
      this.cameraPosTextElement.attr("title", `cameraPose="${poseValueText}"`);
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

  calculateFitDistance(radius, marginRatio = 0.05) {
    const safeRadius = Math.max(radius, 0.001);
    const paddedRadius = safeRadius * (1 + Math.max(marginRatio, 0));

    const vFovHalfRad = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
    const hFovHalfRad = Math.atan(Math.tan(vFovHalfRad) * this.camera.aspect);
    const limitingHalfFov = Math.max(Math.min(vFovHalfRad, hFovHalfRad), 0.001);

    return paddedRadius / Math.tan(limitingHalfFov);
  }

  calculateFitDistanceForFace(sizeVec3, faceKey, marginRatio = 0.05) {
    if (!sizeVec3) {
      return this.calculateFitDistance(1, marginRatio);
    }

    const axisPairsByFace = {
      front: ["y", "z"],
      back: ["y", "z"],
      left: ["x", "z"],
      right: ["x", "z"],
      top: ["x", "y"],
      bottom: ["x", "y"],
    };

    const [verticalAxis, horizontalAxis] = axisPairsByFace[faceKey] || [
      "x",
      "y",
    ];
    const verticalSize =
      Math.max(Number(sizeVec3[verticalAxis]) || 0, 0.001) *
      (1 + Math.max(marginRatio, 0));
    const horizontalSize =
      Math.max(Number(sizeVec3[horizontalAxis]) || 0, 0.001) *
      (1 + Math.max(marginRatio, 0));

    const vFovHalfRad = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
    const hFovHalfRad = Math.atan(Math.tan(vFovHalfRad) * this.camera.aspect);

    const distanceByHeight =
      (verticalSize * 0.5) / Math.tan(Math.max(vFovHalfRad, 0.001));
    const distanceByWidth =
      (horizontalSize * 0.5) / Math.tan(Math.max(hFovHalfRad, 0.001));

    return Math.max(distanceByHeight, distanceByWidth, 0.001);
  }

  resetDirectionalLight(center, radius) {
    if (!this.directionalLight) {
      return;
    }

    const safeRadius = Math.max(radius, 0.001);
    this.directionalLightRadius = safeRadius;

    const lightDirection = this.camera.position.clone().sub(center);
    if (lightDirection.lengthSq() < 1e-8) {
      lightDirection.set(1, 1, 2);
    }

    lightDirection.normalize();

    const worldUp = new THREE.Vector3(0, 0, 1);
    const sideDirection = new THREE.Vector3().crossVectors(
      lightDirection,
      worldUp,
    );
    if (sideDirection.lengthSq() < 1e-8) {
      sideDirection.set(0, 1, 0);
    } else {
      sideDirection.normalize();
    }

    const elevatedDirection = lightDirection
      .clone()
      .multiplyScalar(2.0)
      .add(sideDirection.multiplyScalar(0.7))
      .add(worldUp.clone().multiplyScalar(1.2))
      .normalize();

    this.directionalLight.position.copy(
      center.clone().add(elevatedDirection.multiplyScalar(safeRadius * 2.6)),
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
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;

    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = "bold 144px Arial";
    context.fillStyle = colorHex;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 128, 128);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    const sprite = new THREE.Sprite(material);
    sprite.position.copy(position);
    sprite.scale.set(0.2, 0.2, 0.2);
    sprite.renderOrder = 1000;
    sprite.userData.axisLabelText = text;
    sprite.userData.axisLabelColor = colorHex;

    return sprite;
  }

  createAxisLine(endVector, colorHex) {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      endVector,
    ]);
    const material = new THREE.LineBasicMaterial({
      color: colorHex,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    return new THREE.Line(geometry, material);
  }

  createAxisGuides(axisLengths) {
    if (!this.axesRootGroup) {
      this.axesRootGroup = new THREE.Group();
      this.scene.add(this.axesRootGroup);
    }

    const lengthX = Math.max(Number(axisLengths?.x) || 0, 0.001);
    const lengthY = Math.max(Number(axisLengths?.y) || 0, 0.001);
    const lengthZ = Math.max(Number(axisLengths?.z) || 0, 0.001);

    const axesGroup = new THREE.Group();
    axesGroup.visible = false;

    const xLine = this.createAxisLine(
      new THREE.Vector3(lengthX, 0, 0),
      0xff3333,
    );
    const yLine = this.createAxisLine(
      new THREE.Vector3(0, lengthY, 0),
      0x22aa22,
    );
    const zLine = this.createAxisLine(
      new THREE.Vector3(0, 0, lengthZ),
      0x3366ff,
    );

    axesGroup.add(xLine);
    axesGroup.add(yLine);
    axesGroup.add(zLine);

    this.axesRootGroup.add(axesGroup);
    this.axesHelper = axesGroup;
    this.axisLineByKey = {
      x: xLine,
      y: yLine,
      z: zLine,
    };
  }

  updateAxisLineLength(axisKey, length) {
    const axisLine = this.axisLineByKey[axisKey];
    if (!axisLine) {
      return;
    }

    const safeLength = Math.max(Number(length) || 0, 0.001);
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0)];
    if (axisKey === "x") {
      points[1].x = safeLength;
    } else if (axisKey === "y") {
      points[1].y = safeLength;
    } else {
      points[1].z = safeLength;
    }

    axisLine.geometry.setFromPoints(points);
    axisLine.geometry.computeBoundingSphere();
  }

  addAxisLabels(axisLengths) {
    if (!this.axesRootGroup) {
      this.axesRootGroup = new THREE.Group();
      this.scene.add(this.axesRootGroup);
    }

    const lengthX = Math.max(Number(axisLengths?.x) || 0, 0.001);
    const lengthY = Math.max(Number(axisLengths?.y) || 0, 0.001);
    const lengthZ = Math.max(Number(axisLengths?.z) || 0, 0.001);
    const maxAxisLength = Math.max(lengthX, lengthY, lengthZ);
    const nearOriginOffset = Math.max(
      maxAxisLength * this.axisLabelNearOriginRatio,
      this.axisLabelMinOffset,
    );
    const xLabel = this.createAxisLabel(
      "X",
      "#ff3333",
      new THREE.Vector3(nearOriginOffset, 0, 0),
    );
    const yLabel = this.createAxisLabel(
      "Y",
      "#22aa22",
      new THREE.Vector3(0, nearOriginOffset, 0),
    );
    const zLabel = this.createAxisLabel(
      "Z",
      "#3366ff",
      new THREE.Vector3(0, 0, nearOriginOffset),
    );

    xLabel.visible = false;
    yLabel.visible = false;
    zLabel.visible = false;

    this.axesRootGroup.add(xLabel);
    this.axesRootGroup.add(yLabel);
    this.axesRootGroup.add(zLabel);

    this.axisLabelSprites = [xLabel, yLabel, zLabel];
  }

  updateAxisGuideLengthsByModelSize(modelSizeVec3) {
    if (!modelSizeVec3) {
      return;
    }

    const sizeX = Math.max(Number(modelSizeVec3.x) || 0, 0.001);
    const sizeY = Math.max(Number(modelSizeVec3.y) || 0, 0.001);
    const sizeZ = Math.max(Number(modelSizeVec3.z) || 0, 0.001);

    const axisLengthX = sizeX * this.axisLengthExtraRatio;
    const axisLengthY = sizeY * this.axisLengthExtraRatio;
    const axisLengthZ = sizeZ * this.axisLengthExtraRatio * 2;

    this.updateAxisLineLength("x", axisLengthX);
    this.updateAxisLineLength("y", axisLengthY);
    this.updateAxisLineLength("z", axisLengthZ);

    const maxAxisLength = Math.max(axisLengthX, axisLengthY, axisLengthZ);
    const nearOriginOffset = Math.max(
      maxAxisLength * this.axisLabelNearOriginRatio,
      this.axisLabelMinOffset,
    );
    if (this.axisLabelSprites.length >= 3) {
      this.axisLabelSprites[0].position.set(nearOriginOffset, 0, 0);
      this.axisLabelSprites[1].position.set(0, nearOriginOffset, 0);
      this.axisLabelSprites[2].position.set(0, 0, nearOriginOffset);
    }
  }

  redrawAxisLabelSpriteFont(sprite, fontPx) {
    if (!sprite || !sprite.material || !sprite.material.map) {
      return;
    }

    const canvas = sprite.material.map.image;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const text = sprite.userData.axisLabelText || "";
    const color = sprite.userData.axisLabelColor || "#ffffff";

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = `bold ${fontPx}px Arial`;
    context.fillStyle = color;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, canvas.width / 2, canvas.height / 2);
    sprite.material.map.needsUpdate = true;
  }

  updateAxisLabelScaleByModelSize(modelSizeVec3) {
    if (!modelSizeVec3 || this.axisLabelSprites.length === 0) {
      return;
    }

    const labelScale = 0.09;
    const fontPx = 162;

    this.axisLabelSprites.forEach((sprite) => {
      if (sprite) {
        sprite.scale.set(labelScale, labelScale, labelScale);
        this.redrawAxisLabelSpriteFont(sprite, fontPx);
      }
    });
  }

  updateAxisAnchorFromModel() {
    if (!this.axesRootGroup) {
      return;
    }

    this.axesRootGroup.position.set(0, 0, 0);
  }

  setReferenceGuidesVisible(isVisible) {
    if (this.xyGridHelper) {
      this.xyGridHelper.visible = isVisible;
    }

    if (this.axesHelper) {
      this.axesHelper.visible = isVisible;
    }

    this.axisLabelSprites.forEach((sprite) => {
      if (sprite) {
        sprite.visible = isVisible;
      }
    });
  }

  setAxesAndLabelsVisible(isVisible) {
    if (this.axesHelper) {
      this.axesHelper.visible = isVisible;
    }

    this.axisLabelSprites.forEach((sprite) => {
      if (sprite) {
        sprite.visible = isVisible;
      }
    });
  }

  toggleAxesAndLabels() {
    const currentVisible = this.axesHelper ? this.axesHelper.visible : false;
    const nextVisible = !currentVisible;
    this.setAxesAndLabelsVisible(nextVisible);
    console.log(`[URDF] axes+labels ${nextVisible ? "ON" : "OFF"}`);
  }

  toggleXYGrid() {
    if (!this.xyGridHelper) {
      return;
    }

    const nextVisible = !this.xyGridHelper.visible;
    this.xyGridHelper.visible = nextVisible;
    console.log(`[URDF] XY grid ${nextVisible ? "ON" : "OFF"}`);
  }

  setupMouseEvents() {
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const projectToArcball = (clientX, clientY) => {
      const rect = this.container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return new THREE.Vector3(0, 0, 1);
      }

      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
      const lengthSq = x * x + y * y;

      if (lengthSq > 1) {
        const invLength = 1 / Math.sqrt(lengthSq);
        return new THREE.Vector3(x * invLength, y * invLength, 0);
      }

      const z = Math.sqrt(Math.max(0, 1 - lengthSq));
      return new THREE.Vector3(x, y, z).normalize();
    };

    const getRobotIntersections = (event) => {
      if (!this.robotModel) {
        return [];
      }

      const rect = this.container.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;

      if (!width || !height) {
        return [];
      }

      mouse.x = ((event.clientX - rect.left) / width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / height) * 2 + 1;
      raycaster.setFromCamera(mouse, this.camera);

      return raycaster.intersectObject(this.robotModel, true);
    };

    const isChassisHit = (hitObject) => {
      if (!hitObject || !this.robotModel) {
        return false;
      }

      const linkMap = this.robotModel?.links || {};
      const carFrame = linkMap.car_frame || null;
      if (!carFrame) {
        return true;
      }

      const excludedLinkRoots = [
        linkMap.ellipsoid_surface_patch || null,
        linkMap.ground_patch || null,
        linkMap.wheel_fl || null,
        linkMap.wheel_fr || null,
        linkMap.wheel_rl || null,
        linkMap.wheel_rr || null,
      ].filter(Boolean);

      const isExcludedNode = excludedLinkRoots.some((root) => {
        return hitObject === root || this.isDescendantObject3D(hitObject, root);
      });

      if (isExcludedNode) {
        return false;
      }

      return (
        hitObject === carFrame || this.isDescendantObject3D(hitObject, carFrame)
      );
    };

    const disableOrbitInteraction = () => {
      this.isOrbitInteractionActive = false;
      this.mainOrbitDragState = null;
    };

    const startMainOrbitDrag = (event) => {
      this.mainOrbitDragState = {
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        totalMove: 0,
        isActivated: false,
        arcballVector: projectToArcball(event.clientX, event.clientY),
      };
    };

    const updateMainOrbitDrag = (event) => {
      if (!this.mainOrbitDragState || !this.controls || !this.camera) {
        return;
      }

      const deltaX = event.clientX - this.mainOrbitDragState.lastClientX;
      const deltaY = event.clientY - this.mainOrbitDragState.lastClientY;
      this.mainOrbitDragState.lastClientX = event.clientX;
      this.mainOrbitDragState.lastClientY = event.clientY;
      this.mainOrbitDragState.totalMove += Math.hypot(deltaX, deltaY);

      const nextArcball = projectToArcball(event.clientX, event.clientY);
      if (
        this.mainOrbitDragState.totalMove <=
        this.mainOrbitDragActivateDistancePx
      ) {
        this.mainOrbitDragState.arcballVector = nextArcball;
        return;
      }

      if (!this.mainOrbitDragState.isActivated) {
        this.mainOrbitDragState.isActivated = true;
        this.mainOrbitDragState.arcballVector = nextArcball;
        return;
      }

      const previousArcball = this.mainOrbitDragState.arcballVector;
      this.mainOrbitDragState.arcballVector = nextArcball;

      const axisCamera = new THREE.Vector3().crossVectors(
        previousArcball,
        nextArcball,
      );
      if (axisCamera.lengthSq() < 1e-10) {
        return;
      }

      const dot = THREE.MathUtils.clamp(
        previousArcball.dot(nextArcball),
        -1,
        1,
      );
      const angle = Math.acos(dot) * this.mainOrbitArcballSensitivity;
      if (!Number.isFinite(angle) || angle <= 1e-6) {
        return;
      }

      axisCamera.normalize();
      const axisWorld = axisCamera
        .clone()
        .applyQuaternion(this.camera.quaternion)
        .normalize();

      const target = this.controls.target.clone();
      const offset = this.camera.position.clone().sub(target);
      const rotation = new THREE.Quaternion().setFromAxisAngle(
        axisWorld,
        -angle,
      );
      offset.applyQuaternion(rotation);
      this.camera.up.applyQuaternion(rotation).normalize();

      this.camera.position.copy(target.clone().add(offset));
      this.camera.lookAt(target);
      this.controls.update();
      this.resetDirectionalLight(
        this.controls.target,
        this.directionalLightRadius,
      );
      this.logCameraInfos(false);
    };

    const endMainOrbitDrag = () => {
      if (!this.mainOrbitDragState) {
        return;
      }

      if (
        this.mainOrbitDragState.isActivated ||
        this.mainOrbitDragState.totalMove > this.mainOrbitDragActivateDistancePx
      ) {
        this.logCameraInfos(true);
        this.saveCurrentCameraPoseToStorage();
      }

      this.mainOrbitDragState = null;
    };

    this.renderer.domElement.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.controls || event.ctrlKey) {
          return;
        }

        if (event.button === 0) {
          event.preventDefault();
          startMainOrbitDrag(event);
        } else if (event.button === 2) {
          event.preventDefault();
        }

        const intersects = getRobotIntersections(event);
        const chassisHit = intersects.find((intersection) =>
          isChassisHit(intersection?.object),
        );
        this.isOrbitInteractionActive =
          event.button === 0 || event.button === 2;
      },
      true,
    );

    this.renderer.domElement.addEventListener(
      "pointermove",
      (event) => {
        updateMainOrbitDrag(event);
      },
      true,
    );

    this.renderer.domElement.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });

    window.addEventListener(
      "pointerup",
      (event) => {
        disableOrbitInteraction();
        if (event.button === 0) {
          endMainOrbitDrag();
        }
      },
      true,
    );
    window.addEventListener("pointercancel", disableOrbitInteraction, true);
    window.addEventListener("blur", disableOrbitInteraction);

    this.container.addEventListener("mousedown", (event) => {
      if (event.ctrlKey) {
        if (this.referenceToggleStep === 0) {
          this.toggleAxesAndLabels();
        } else {
          this.toggleXYGrid();
        }

        this.referenceToggleStep = (this.referenceToggleStep + 1) % 2;
        return;
      }

      if (event.button !== 0) {
        return;
      }

      const intersects = getRobotIntersections(event);
      const chassisHit = intersects.find((intersection) =>
        isChassisHit(intersection?.object),
      );
      if (chassisHit && chassisHit.point) {
        this.goalTarget.copy(chassisHit.point);
        this.applyGoalTargetToControls();
        console.log("[URDF] 목표 지점 설정:", this.goalTarget);
      }
    });
  }

  applyGoalTargetToControls() {
    if (!this.controls) {
      return;
    }

    this.controls.target.set(
      this.goalTarget.x,
      this.goalTarget.y - this.goalTargetVerticalOffset,
      this.goalTarget.z,
    );
    this.controls.update();
  }

  snapshotInitialCameraPose() {
    if (!this.camera || !this.controls) {
      return;
    }

    this.initialCameraPose = {
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      up: this.camera.up.clone(),
    };
  }

  restoreInitialCameraPose() {
    if (!this.initialCameraPose || !this.camera || !this.controls) {
      return;
    }

    const positionDiff = this.camera.position.distanceTo(
      this.initialCameraPose.position,
    );
    const targetDiff = this.controls.target.distanceTo(
      this.initialCameraPose.target,
    );
    const currentUp = this.camera.up.clone().normalize();
    const initialUp = this.initialCameraPose.up.clone().normalize();
    const upDot = THREE.MathUtils.clamp(currentUp.dot(initialUp), -1, 1);
    const upAngle = Math.acos(upDot);

    const isSamePose =
      positionDiff < 1e-4 && targetDiff < 1e-4 && upAngle < 1e-3;
    if (isSamePose) {
      return;
    }

    this.overlayDragPanPixels = 0;
    this.overlayZoomOutRatio = 0;

    this.animateCameraToPoseWithTarget(
      this.initialCameraPose.position,
      this.initialCameraPose.target,
      this.initialCameraPose.up,
      260,
    );
    this.showCameraToastMessage("초기 위치로 복귀했습니다.", 1200);
  }

  setGoalTargetVerticalOffset(offsetValue) {
    const numericOffset = Number(offsetValue);
    this.goalTargetVerticalOffset = Number.isFinite(numericOffset)
      ? THREE.MathUtils.clamp(numericOffset, -2, 2)
      : 0;
    this.applyGoalTargetToControls();
    this.resetDirectionalLight(
      this.controls.target,
      this.directionalLightRadius,
    );
  }

  markInitialCameraPoseReady() {
    this.isInitialCameraPoseReady = true;

    if (this.pendingOverlayZoomOutRatio != null) {
      const queuedZoomOutRatio = this.pendingOverlayZoomOutRatio;
      this.pendingOverlayZoomOutRatio = null;
      this.setOverlayZoomOutRatio(queuedZoomOutRatio);
    }

    if (this.pendingOverlayDragPixels != null) {
      const queuedPixels = this.pendingOverlayDragPixels;
      this.pendingOverlayDragPixels = null;
      this.setOverlayVerticalDragPixels(queuedPixels);
    }
  }

  setOverlayVerticalDragPixels(pixelHeight) {
    if (!this.controls || !this.camera) {
      return;
    }

    const requestedPixels = Number(pixelHeight);
    if (!this.isInitialCameraPoseReady) {
      this.pendingOverlayDragPixels = Number.isFinite(requestedPixels)
        ? requestedPixels
        : 0;
      return;
    }

    const containerHeight = Number(
      this.container?.clientHeight ||
        this.container?.getBoundingClientRect?.().height ||
        0,
    );
    if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
      return;
    }

    const nextPixels = Number.isFinite(requestedPixels)
      ? THREE.MathUtils.clamp(requestedPixels, 0, containerHeight * 0.85)
      : 0;
    const deltaPixels = nextPixels - this.overlayDragPanPixels;

    if (Math.abs(deltaPixels) < 0.5) {
      return;
    }

    const target = this.controls.target.clone();
    const viewDir = target.clone().sub(this.camera.position).normalize();
    if (viewDir.lengthSq() === 0) {
      return;
    }

    let worldPerPixel = 0;
    if (this.camera.isPerspectiveCamera) {
      const distance = Math.max(this.camera.position.distanceTo(target), 0.001);
      const fovRad = THREE.MathUtils.degToRad(this.camera.fov || 50);
      worldPerPixel = (2 * distance * Math.tan(fovRad / 2)) / containerHeight;
    } else if (this.camera.isOrthographicCamera) {
      const frustumHeight =
        (this.camera.top - this.camera.bottom) /
        Math.max(this.camera.zoom || 1, 0.001);
      worldPerPixel = frustumHeight / containerHeight;
    }

    if (!Number.isFinite(worldPerPixel) || worldPerPixel <= 0) {
      return;
    }

    const right = new THREE.Vector3()
      .crossVectors(viewDir, this.camera.up)
      .normalize();
    if (right.lengthSq() === 0) {
      return;
    }

    const screenUp = new THREE.Vector3()
      .crossVectors(right, viewDir)
      .normalize();
    const panOffset = screenUp.multiplyScalar(deltaPixels * worldPerPixel);

    this.camera.position.add(panOffset);
    this.goalTarget.add(panOffset);
    this.overlayDragPanPixels = nextPixels;
    this.applyGoalTargetToControls();
    this.resetDirectionalLight(
      this.controls.target,
      this.directionalLightRadius,
    );
  }

  setOverlayZoomOutRatio(zoomOutRatio) {
    if (!this.controls || !this.camera) {
      return;
    }

    const requestedRatio = Number(zoomOutRatio);
    const nextRatio = Number.isFinite(requestedRatio)
      ? THREE.MathUtils.clamp(requestedRatio, 0, 0.35)
      : 0;

    if (!this.isInitialCameraPoseReady) {
      this.pendingOverlayZoomOutRatio = nextRatio;
      return;
    }

    const currentRatio = Number(this.overlayZoomOutRatio) || 0;
    if (Math.abs(nextRatio - currentRatio) < 0.0005) {
      return;
    }

    const target = this.controls.target.clone();
    const cameraOffset = this.camera.position.clone().sub(target);
    const currentDistance = cameraOffset.length();
    if (!Number.isFinite(currentDistance) || currentDistance <= 0.0001) {
      return;
    }

    const baseDistance = currentDistance / Math.max(1 + currentRatio, 0.001);
    const nextDistance = baseDistance * (1 + nextRatio);
    const normalizedOffset = cameraOffset
      .normalize()
      .multiplyScalar(nextDistance);

    this.camera.position.copy(target.clone().add(normalizedOffset));
    this.overlayZoomOutRatio = nextRatio;
    this.controls.update();
    this.resetDirectionalLight(
      this.controls.target,
      this.directionalLightRadius,
    );
    this.logCameraInfos(true);
  }

  loadURDF() {
    // URDFLoader's onComplete (below) fires as soon as the joint/link *tree* is parsed,
    // but each <mesh filename=...> (STL/DAE/OBJ) it references keeps loading
    // asynchronously afterward and gets attached to its link as it individually
    // resolves. Since the render loop runs continuously, that showed up as the model
    // visibly assembling piece by piece instead of appearing all at once.
    //
    // A previous attempt at this hooked a THREE.LoadingManager's itemsTotal/itemsLoaded/
    // onLoad instead of the counter below, on the assumption that URDFLoader's mesh
    // sub-loaders (STLLoader/ColladaLoader, constructed with that same manager) drive it
    // reliably enough to gate on - that didn't actually eliminate the piece-by-piece
    // reveal in practice, so don't reintroduce it without confirming why first. Counting
    // loadMeshCb's own start/done calls directly - URDFLoader's own public hook for
    // "load this mesh file", captured into parse() by reference before any mesh loading
    // begins (see parse()'s `const loadMeshCb = this.loadMeshCb`) - has no such
    // indirection to go wrong.
    let pendingMeshLoadCount = 0;
    let hasParsedUrdfStructure = false;
    let hasRevealedRobot = false;
    // Reassigned inside onComplete below, once `robot` actually exists, to the real
    // implementation (which closes over it directly). Calls to
    // revealOnceEverythingIsLoaded() before that point are always no-ops anyway, since
    // hasParsedUrdfStructure only flips to true inside that same onComplete.
    let revealRobotAndFitCamera = () => {};
    const revealOnceEverythingIsLoaded = () => {
      if (hasRevealedRobot || !hasParsedUrdfStructure || pendingMeshLoadCount > 0) {
        return;
      }
      revealRobotAndFitCamera();
    };

    const loader = new URDFLoader();
    // Some models (e.g. sw_17's sw17.urdf) author their <mesh filename="..."> as ROS
    // "package://sw17/meshes/foo.STL" URIs instead of a plain relative path like
    // "../meshes/foo.STL" (which is what sw_14/sw_15's URDFs use, and which resolves
    // correctly on its own via URDFLoader's workingPath). A package:// URI isn't a
    // fetchable URL at all in the browser, so it has to be rewritten first.
    // URDFLoader's `packages` option can be a function taking the package name (e.g.
    // "sw17") and returning the directory to resolve it against; it does NOT prepend
    // workingPath itself for package:// paths (unlike plain relative ones), so the
    // directory has to be derived from urdfPath here rather than assumed. Every model
    // seen so far keeps its meshes one level up from its own urdf/ folder regardless of
    // the package name/number, so package://<anything>/<relPath> always maps to
    // "<urdf file's own directory>/../<relPath>" - i.e. exactly the "../" a plain
    // relative mesh path would already use.
    const urdfDirectory = this.urdfPath.replace(/\/[^/]*$/, "");
    loader.packages = () => `${urdfDirectory}/..`;
    const loadMeshDirectly = loader.defaultMeshLoader.bind(loader);
    loader.loadMeshCb = (path, manager, done) => {
      pendingMeshLoadCount += 1;
      loadMeshDirectly(path, manager, (mesh, err) => {
        pendingMeshLoadCount -= 1;
        done(mesh, err);
        revealOnceEverythingIsLoaded();
      });
    };

    console.log(`[URDF] URDF 파일 로딩 중... (${this.urdfPath})`);

    loader.load(
      this.urdfPath,

      (robot) => {
        console.log("[URDF] ✅ URDF 로드 성공");

        this.scene.add(robot);
        // Hidden until revealRobotAndFitCamera() below confirms every referenced mesh
        // file has actually finished loading.
        robot.visible = false;
        this.robotModel = robot;
        this.applyGroundHoleCarvingByCSG();
        this.applyGroundLayerPolygonOffsetSeparation();
        this.carFrameAlertMaterials = [];
        this.isCarFrameAlertActive = false;
        this.resolveWheelAnimationTargets();
        this.resolveWheelHighlightTargets();
        this.applyRoadAttitudeAngles();
        this.publishMeasuredWheelRadii();

        if (this.showTransparency) {
          this.scheduleInitialCarFrameOpacitySync();
        }

        if (
          this.container.id === "vehicle-urdf-viewer" &&
          Array.isArray(window.pendingVehicleWheelHighlightKeys) &&
          window.pendingVehicleWheelHighlightKeys.length > 0
        ) {
          this.applyWheelHighlightByKeys(
            window.pendingVehicleWheelHighlightKeys,
          );
        } else if (
          this.container.id === "vehicle-urdf-viewer" &&
          window.pendingVehicleWheelHighlightKey
        ) {
          this.applyWheelHighlightByKey(window.pendingVehicleWheelHighlightKey);
        }

        // 자동 피팅 로직 - runs once every referenced mesh file has actually finished
        // loading (see loadMeshCb's wrapper above this callback), not after a blind
        // delay: a fixed timeout either fires too early on a slow connection (fit
        // computed from an incomplete bounding box, and the model still visibly missing
        // pieces at the moment it's revealed) or just wastes time waiting on a fast one.
        revealRobotAndFitCamera = () => {
          if (hasRevealedRobot) {
            return;
          }
          hasRevealedRobot = true;
          robot.visible = true;

          const bbox = new THREE.Box3().setFromObject(robot);
          const center = bbox.getCenter(new THREE.Vector3());
          const size = bbox.getSize(new THREE.Vector3());
          const sphere = bbox.getBoundingSphere(new THREE.Sphere());
          const radius = Math.max(sphere.radius, 0.001);

          console.log("[URDF] 📏 모델 반경:", radius);
          console.log("[URDF] 📍 모델 중심:", center);

          this.updateAxisGuideLengthsByModelSize(size);
          this.updateAxisLabelScaleByModelSize(size);

          if (this.hasCustomCameraPosition) {
            console.log("[URDF] cameraPose 지정됨: 사용자 카메라 위치 유지");
          } else {
            const fitDistance = this.calculateFitDistanceForFace(
              size,
              "front",
              this.cameraFitMarginRatio,
            );
            this.setCameraFromFace(center, fitDistance, "front");
            console.log(
              "[URDF] cameraPose/저장 포즈 미지정: front view 자동 피팅 카메라 적용 (마진 5%)",
            );
          }

          const poseTarget = this.hasCustomCameraTarget
            ? this.cameraTarget.clone()
            : center.clone();
          const currentCameraDist = Math.max(
            this.camera.position.distanceTo(poseTarget),
            0.01,
          );
          this.camera.near = Math.max(currentCameraDist / 100, 0.01);
          this.camera.far = Math.max(currentCameraDist * 100, 10);
          this.camera.updateProjectionMatrix();

          this.goalTarget.copy(poseTarget);
          this.applyGoalTargetToControls();
          this.controls.minDistance = currentCameraDist * 0.2;
          this.controls.maxDistance = currentCameraDist * 8;
          this.resetDirectionalLight(this.controls.target, radius);
          this.snapshotInitialCameraPose();
          this.logCameraInfos(true);
          this.markInitialCameraPoseReady();
          // Show the canvas now that the model and its camera fit are both ready, so the
          // background and the fully-assembled model appear together in the same frame
          // instead of the background flashing alone first.
          this.renderer.domElement.style.visibility = "visible";

          console.log("[URDF] ✅ 카메라/클리핑/컨트롤 범위 갱신 완료");
        };

        hasParsedUrdfStructure = true;
        // Safety net: defaultMeshLoader() never calls its `done` callback at all for a
        // mesh file that fails to load (no onError is wired to the underlying
        // STLLoader/ColladaLoader.load() call), which would otherwise leave
        // pendingMeshLoadCount stuck above zero and the robot hidden forever. Fall back
        // to revealing (whatever did load) after a generous wait instead of risking a
        // permanently blank viewer.
        setTimeout(revealRobotAndFitCamera, 8000);
        // Covers both "no mesh files were ever pending" (an all-primitive URDF) and
        // "every mesh file had already finished loading by the time parse() returned"
        // (e.g. served from cache) - in either case no future loadMeshCb completion will
        // ever fire to trigger revealOnceEverythingIsLoaded() on its own.
        revealOnceEverythingIsLoaded();
      },
      (progress) => {
        if (progress?.total) {
          const percent = ((progress.loaded / progress.total) * 100).toFixed(1);
          console.log(`[URDF] URDF 로딩 진행률: ${percent}%`);
        }
      },
      (error) => {
        console.error("[URDF] ❌ URDF 로드 실패:", error);
        // The URDF file itself never resolved, so onComplete above never ran and never
        // got the chance to reveal the canvas - leave it hidden forever otherwise.
        this.renderer.domElement.style.visibility = "visible";
      },
    );
  }

  measureWheelRadiusMetersByKey() {
    const linkMap = this.robotModel?.links || null;
    if (!linkMap) {
      return null;
    }

    const isDescendant = (child, ancestor) => {
      let current = child?.parent || null;
      while (current) {
        if (current === ancestor) {
          return true;
        }
        current = current.parent;
      }
      return false;
    };
    const radiusByKey = {};

    Object.entries(this.wheelLinkNameByKey).forEach(
      ([wheelKey, wheelLinkName]) => {
        const wheelLink = linkMap[wheelLinkName] || null;
        if (!wheelLink) {
          return;
        }

        const otherLinkRoots = Object.values(linkMap).filter(
          (link) => link && link !== wheelLink && isDescendant(link, wheelLink),
        );
        const bounds = new THREE.Box3();
        const inverseWheelWorld = new THREE.Matrix4();
        const wheelLocalPoints = [];
        let hasMesh = false;

        wheelLink.updateWorldMatrix(true, true);
        inverseWheelWorld.copy(wheelLink.matrixWorld).invert();
        wheelLink.traverse((node) => {
          if (!node?.isMesh || !node.geometry) {
            return;
          }
          if (
            otherLinkRoots.some(
              (link) => node === link || isDescendant(node, link),
            )
          ) {
            return;
          }

          if (!node.geometry.boundingBox) {
            node.geometry.computeBoundingBox();
          }
          if (!node.geometry.boundingBox) {
            return;
          }

          const meshToWheel = new THREE.Matrix4().multiplyMatrices(
            inverseWheelWorld,
            node.matrixWorld,
          );
          const positionAttribute = node.geometry.getAttribute("position");
          if (positionAttribute) {
            for (let index = 0; index < positionAttribute.count; index += 1) {
              wheelLocalPoints.push(
                new THREE.Vector3()
                  .fromBufferAttribute(positionAttribute, index)
                  .applyMatrix4(meshToWheel),
              );
            }
          }
          bounds.union(
            node.geometry.boundingBox.clone().applyMatrix4(meshToWheel),
          );
          hasMesh = true;
        });

        if (!hasMesh || bounds.isEmpty()) {
          return;
        }

        const dimensions = bounds
          .getSize(new THREE.Vector3())
          .toArray()
          .map((value, axisIndex) => ({ value, axisIndex }))
          .sort((left, right) => left.value - right.value);
        const radialAxisIndexes = [
          dimensions[1].axisIndex,
          dimensions[2].axisIndex,
        ];
        const center = bounds.getCenter(new THREE.Vector3());
        const measuredRadius = wheelLocalPoints.reduce((largest, point) => {
          const radialA =
            point.getComponent(radialAxisIndexes[0]) -
            center.getComponent(radialAxisIndexes[0]);
          const radialB =
            point.getComponent(radialAxisIndexes[1]) -
            center.getComponent(radialAxisIndexes[1]);
          return Math.max(largest, Math.hypot(radialA, radialB));
        }, 0);
        radiusByKey[wheelKey] = measuredRadius;
      },
    );

    return Object.keys(radiusByKey).length === 4 ? radiusByKey : null;
  }

  publishMeasuredWheelRadii() {
    const radiusByKey = this.measureWheelRadiusMetersByKey();
    if (!radiusByKey) {
      return;
    }

    window.dispatchEvent(
      new CustomEvent("wcs:urdf-wheel-radii-ready", {
        detail: {
          viewerId: this.container.id,
          urdfPath: this.urdfPath,
          radiusByKey,
        },
      }),
    );
  }

  createWorldSpaceMeshFromSource(sourceMesh) {
    if (!sourceMesh || !sourceMesh.isMesh || !sourceMesh.geometry) {
      return null;
    }

    const worldGeometry = sourceMesh.geometry.clone();
    worldGeometry.applyMatrix4(sourceMesh.matrixWorld);
    worldGeometry.computeVertexNormals();

    const sourceMaterial = Array.isArray(sourceMesh.material)
      ? sourceMesh.material[0]
      : sourceMesh.material;
    const worldMaterial = sourceMaterial?.clone
      ? sourceMaterial.clone()
      : new THREE.MeshStandardMaterial({ color: 0x777777 });

    const worldMesh = new THREE.Mesh(worldGeometry, worldMaterial);
    worldMesh.matrixAutoUpdate = false;
    worldMesh.matrix.identity();
    worldMesh.updateMatrix();
    worldMesh.updateMatrixWorld(true);
    return worldMesh;
  }

  disposeTemporaryMesh(mesh) {
    if (!mesh) {
      return;
    }

    if (mesh.geometry) {
      mesh.geometry.dispose();
    }

    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((material) => material?.dispose?.());
    } else if (mesh.material?.dispose) {
      mesh.material.dispose();
    }
  }

  getGroundSurfaceAxisInfo(geometry) {
    if (!geometry) {
      return null;
    }

    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }

    const box = geometry.boundingBox;
    if (!box) {
      return null;
    }

    const size = new THREE.Vector3();
    box.getSize(size);

    // The ground patch is a thin slab; its thinnest dimension is the surface
    // normal axis, and the slab's top face along that axis is the drivable
    // surface that potholes are carved down from.
    let axis = "y";
    let minSize = Infinity;
    ["x", "y", "z"].forEach((candidateAxis) => {
      if (size[candidateAxis] < minSize) {
        minSize = size[candidateAxis];
        axis = candidateAxis;
      }
    });

    return { axis, top: box.max[axis] };
  }

  /**
   * Darkens the CSG-carved walls/floor of a pothole cavity with baked vertex
   * colors so the depression is visible regardless of viewing angle or
   * lighting direction, instead of relying purely on normal-based shading
   * (which made the 4 cut faces look identical to the untouched ground).
   * Returns the geometry to use going forward (may be a new instance).
   */
  applyGroundHoleShading(geometry, groundSurfaceAxisInfo) {
    if (!this.enableGroundHoleShading || !groundSurfaceAxisInfo) {
      return geometry;
    }

    const workingGeometry = geometry.index ? geometry.toNonIndexed() : geometry;
    if (workingGeometry !== geometry) {
      geometry.dispose();
    }

    const positionAttribute = workingGeometry.getAttribute("position");
    if (!positionAttribute) {
      return workingGeometry;
    }

    const { axis, top } = groundSurfaceAxisInfo;
    const epsilonMeters = 1e-4;
    const configuredFullDepthMeters = Math.max(
      this.groundHoleShadeFullDepthMeters,
      epsilonMeters,
    );
    const rimColor = this.groundHoleRimShadeColor;
    const deepColor = this.groundHoleDeepShadeColor;
    const edgeLineColor = this.groundHoleEdgeLineColor;
    const surfaceColor = new THREE.Color(1, 1, 1);
    const shadedColor = new THREE.Color();

    const vertexA = new THREE.Vector3();
    const vertexB = new THREE.Vector3();
    const vertexC = new THREE.Vector3();
    const colors = new Float32Array(positionAttribute.count * 3);
    const triangleCount = Math.floor(positionAttribute.count / 3);
    const depthBelowSurfaceByTriangle = new Float32Array(triangleCount);
    // Vertex indices belonging to the carved cavity (walls/floor, not the untouched
    // top surface) - collected below so setGroundHoleCavityAlertActive() can swap just
    // these vertices' baked color for a flat red alert color and back again.
    const cavityVertexIndices = [];

    // First pass: measure how deep this specific carved cavity actually goes.
    // Hole depth varies a lot between models/meshes (a couple cm for a thin
    // box cutter vs several cm for a sculpted STL), so normalizing against a
    // single fixed constant made shallow holes barely darker than the rim
    // color and never reach the dark "deep" color at all. Normalizing by the
    // observed max depth instead guarantees every carved cavity spans the
    // full rim-to-deep gradient, regardless of how deep it physically is.
    let observedMaxDepthMeters = 0;
    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
      const i0 = triangleIndex * 3;
      vertexA.fromBufferAttribute(positionAttribute, i0);
      vertexB.fromBufferAttribute(positionAttribute, i0 + 1);
      vertexC.fromBufferAttribute(positionAttribute, i0 + 2);

      const centroidHeight = (vertexA[axis] + vertexB[axis] + vertexC[axis]) / 3;
      const depthBelowSurface = top - centroidHeight;
      depthBelowSurfaceByTriangle[triangleIndex] = depthBelowSurface;
      if (depthBelowSurface > observedMaxDepthMeters) {
        observedMaxDepthMeters = depthBelowSurface;
      }
    }

    const fullDepthMeters =
      observedMaxDepthMeters > epsilonMeters
        ? observedMaxDepthMeters
        : configuredFullDepthMeters;

    // Band of "just below the surface" triangles that get forced to a flat
    // near-black outline instead of the smooth rim→deep gradient, so the
    // cavity boundary reads as a distinct line even when the walls are
    // foreshortened to near-invisibility by a steep top-down viewing angle.
    // Scales with the cavity's own depth (thin ring on a shallow scrape,
    // thicker on a deep hole) but is capped so it never swallows the whole
    // gradient on a shallow cavity.
    const edgeBandMeters = Math.min(fullDepthMeters * 0.25, 0.015);

    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
      const i0 = triangleIndex * 3;
      const i1 = i0 + 1;
      const i2 = i0 + 2;
      const depthBelowSurface = depthBelowSurfaceByTriangle[triangleIndex];

      let colorToWrite;
      if (depthBelowSurface > epsilonMeters) {
        if (depthBelowSurface <= edgeBandMeters) {
          colorToWrite = edgeLineColor;
        } else {
          const depthRatio = THREE.MathUtils.clamp(
            (depthBelowSurface - edgeBandMeters) /
              (fullDepthMeters - edgeBandMeters),
            0,
            1,
          );
          shadedColor.copy(rimColor).lerp(deepColor, depthRatio);
          colorToWrite = shadedColor;
        }
      } else {
        colorToWrite = surfaceColor;
      }

      const isCavityTriangle = depthBelowSurface > epsilonMeters;
      [i0, i1, i2].forEach((vertexIndex) => {
        colors[vertexIndex * 3] = colorToWrite.r;
        colors[vertexIndex * 3 + 1] = colorToWrite.g;
        colors[vertexIndex * 3 + 2] = colorToWrite.b;
        if (isCavityTriangle) {
          cavityVertexIndices.push(vertexIndex);
        }
      });
    }

    workingGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    workingGeometry.userData.potholeCavityVertexIndices = cavityVertexIndices;
    workingGeometry.userData.potholeCavityBakedColors = colors.slice();
    return workingGeometry;
  }

  /**
   * Traces every hard crease of a carved pothole cavity — the rim where it
   * meets the undisturbed ground, the corners between adjacent CSG-cut
   * walls, and each wall-to-floor seam — with a constant-screen-width line
   * in a strongly contrasting color. Vertex-color shading (applyGroundHole-
   * Shading()) darkens the faces themselves, but that's easy to miss from a
   * steep top-down angle where the walls foreshorten to almost nothing;
   * drawn lines stay legible regardless of viewing angle, lighting, or
   * triangulation density. Replaces any edge-line overlay previously
   * attached to this node (e.g. from an earlier carve pass).
   */
  attachGroundHoleEdgeLines(node, geometry, groundSurfaceAxisInfo) {
    if (node.userData.groundHoleEdgeLines) {
      const previousLines = node.userData.groundHoleEdgeLines;
      node.remove(previousLines);
      previousLines.geometry.dispose();
      previousLines.material.dispose();
      const objectIndex = this.groundHoleEdgeLineObjects.indexOf(previousLines);
      if (objectIndex !== -1) {
        this.groundHoleEdgeLineObjects.splice(objectIndex, 1);
      }
      node.userData.groundHoleEdgeLines = null;
    }

    if (!this.enableGroundHoleShading || !groundSurfaceAxisInfo) {
      return;
    }

    // Detect every hard-angle crease in the carved geometry (rim, wall-wall
    // corners, wall-floor seams) via three.js's own face-normal comparison,
    // then keep only the ones that actually border the cavity — i.e. at
    // least one endpoint sits below the original ground surface. Without
    // that filter this would also outline the ground mesh's own outer
    // boundary (both endpoints at depth ~0), which has nothing to do with
    // the pothole.
    const { axis, top } = groundSurfaceAxisInfo;
    const epsilonMeters = 1e-4;
    const allEdges = new THREE.EdgesGeometry(geometry, 20);
    const edgePositions = allEdges.getAttribute("position");
    const vertex = new THREE.Vector3();
    const cavityEdgePositions = [];
    if (edgePositions) {
      const segmentCount = Math.floor(edgePositions.count / 2);
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
        const i0 = segmentIndex * 2;
        const i1 = i0 + 1;
        vertex.fromBufferAttribute(edgePositions, i0);
        const depthA = top - vertex[axis];
        const ax = vertex.x, ay = vertex.y, az = vertex.z;
        vertex.fromBufferAttribute(edgePositions, i1);
        const depthB = top - vertex[axis];
        if (depthA > epsilonMeters || depthB > epsilonMeters) {
          cavityEdgePositions.push(ax, ay, az, vertex.x, vertex.y, vertex.z);
        }
      }
    }
    allEdges.dispose();

    if (cavityEdgePositions.length === 0) {
      return;
    }

    const edgeLineGeometry = new LineSegmentsGeometry();
    edgeLineGeometry.setPositions(cavityEdgePositions);

    const containerRect = this.container.getBoundingClientRect();
    const edgeLineMaterial = new LineMaterial({
      color: this.groundHoleEdgeLineColor.getHex(),
      linewidth: this.groundHoleEdgeLineWidthPixels,
      worldUnits: false,
      resolution: new THREE.Vector2(
        Math.max(containerRect.width, 1),
        Math.max(containerRect.height, 1),
      ),
    });

    const edgeLines = new LineSegments2(edgeLineGeometry, edgeLineMaterial);
    edgeLines.computeLineDistances();
    node.add(edgeLines);
    node.userData.groundHoleEdgeLines = edgeLines;
    this.groundHoleEdgeLineObjects.push(edgeLines);
  }

  /**
   * Clones the ground mesh's material(s) and turns on vertexColors so the
   * baked pothole shading from applyGroundHoleShading() actually renders.
   * Cloning keeps unrelated meshes that may share the same material instance
   * (e.g. other untouched ground patches) unaffected.
   */
  enableGroundHoleShadingMaterial(node) {
    if (!this.enableGroundHoleShading || !node.material) {
      return;
    }

    const isMaterialArray = Array.isArray(node.material);
    const materials = isMaterialArray ? node.material : [node.material];
    const shadedMaterials = materials.map((material) => {
      if (!material) {
        return material;
      }

      const shadedMaterial = material.clone ? material.clone() : material;
      shadedMaterial.vertexColors = true;
      shadedMaterial.needsUpdate = true;
      return shadedMaterial;
    });

    node.material = isMaterialArray ? shadedMaterials : shadedMaterials[0];
  }

  applyGroundHoleCarvingByCSG() {
    if (!this.enableGroundHoleCarving || !this.robotModel) {
      return;
    }

    const linkMap = this.robotModel.links || {};
    const groundLinkKeys = ["ground", "ground_patch"].filter(
      (key) => !!linkMap[key],
    );
    const holeLinkKeys = Object.keys(linkMap).filter((key) =>
      /hole|pothole/i.test(key),
    );

    if (groundLinkKeys.length === 0 || holeLinkKeys.length === 0) {
      return;
    }

    this.groundHoleCavityAlertTargets = [];
    const cutterMeshes = [];
    holeLinkKeys.forEach((linkKey) => {
      const holeLink = linkMap[linkKey];
      if (!holeLink) {
        return;
      }

      holeLink.updateWorldMatrix(true, true);
      holeLink.traverse((node) => {
        if (!node || !node.isMesh || node.isLineSegments2 || !node.geometry) {
          return;
        }

        const cutterMesh = this.createWorldSpaceMeshFromSource(node);
        if (cutterMesh) {
          cutterMeshes.push(cutterMesh);
        }
      });
    });

    if (cutterMeshes.length === 0) {
      return;
    }

    let carvedMeshCount = 0;
    groundLinkKeys.forEach((linkKey) => {
      const groundLink = linkMap[linkKey];
      if (!groundLink) {
        return;
      }

      groundLink.updateWorldMatrix(true, true);
      groundLink.traverse((node) => {
        if (!node || !node.isMesh || node.isLineSegments2 || !node.geometry) {
          return;
        }

        let resultMesh = this.createWorldSpaceMeshFromSource(node);
        if (!resultMesh) {
          return;
        }

        const groundSurfaceAxisInfo = this.getGroundSurfaceAxisInfo(
          node.geometry,
        );

        cutterMeshes.forEach((cutterMesh) => {
          const previousResultMesh = resultMesh;
          resultMesh = CSG.subtract(resultMesh, cutterMesh);
          this.disposeTemporaryMesh(previousResultMesh);
        });

        let localGeometry = resultMesh.geometry.clone();
        const inverseWorld = new THREE.Matrix4()
          .copy(node.matrixWorld)
          .invert();
        localGeometry.applyMatrix4(inverseWorld);
        localGeometry = this.applyGroundHoleShading(
          localGeometry,
          groundSurfaceAxisInfo,
        );
        localGeometry.computeVertexNormals();
        localGeometry.computeBoundingBox();
        localGeometry.computeBoundingSphere();

        node.geometry.dispose();
        node.geometry = localGeometry;
        node.updateMatrixWorld(true);
        this.enableGroundHoleShadingMaterial(node);
        this.attachGroundHoleEdgeLines(node, localGeometry, groundSurfaceAxisInfo);
        if (localGeometry.userData.potholeCavityVertexIndices?.length > 0) {
          this.groundHoleCavityAlertTargets.push({ geometry: localGeometry });
        }

        this.disposeTemporaryMesh(resultMesh);
        carvedMeshCount += 1;
      });
    });

    cutterMeshes.forEach((mesh) => this.disposeTemporaryMesh(mesh));

    if (this.hideHoleCuttersAfterCarving) {
      holeLinkKeys.forEach((linkKey) => {
        const holeLink = linkMap[linkKey];
        if (holeLink) {
          holeLink.visible = false;
        }
      });
    }

    if (carvedMeshCount > 0) {
      console.log(
        `[URDF] ✅ CSG ground carving applied with ${cutterMeshes.length} cutter(s).`,
      );
    }
  }

  // Toggles the carved pothole cavity itself (the actual depression cut into the
  // ground mesh, not the - normally hidden after carving - cutter link) between its
  // baked rim/deep shading (applyGroundHoleShading()) and a flat red alert color, so
  // the depression's own surface visibly lights up while a vehicle is over/colliding
  // with it (see simulation.js's updateObstacleContactState()). Only touches the
  // vertices applyGroundHoleShading() identified as belonging to the cavity walls/
  // floor - the surrounding undisturbed ground surface is untouched either way.
  // Colors are stored per-vertex and multiply the mesh's base material color (three.js
  // vertex-color semantics), so the result is a red-tinted version of the ground's own
  // color rather than pure red - still clearly distinct from the normal dark rim/deep
  // gradient it replaces.
  setGroundHoleCavityAlertActive(isActive) {
    if (this.isGroundHoleCavityAlertActive === isActive) {
      return;
    }
    this.isGroundHoleCavityAlertActive = isActive;

    const alertColor = this.groundHoleCavityAlertColor;
    (this.groundHoleCavityAlertTargets || []).forEach((target) => {
      const geometry = target?.geometry;
      const colorAttribute = geometry?.getAttribute("color");
      const cavityVertexIndices = geometry?.userData?.potholeCavityVertexIndices;
      const bakedColors = geometry?.userData?.potholeCavityBakedColors;
      if (!colorAttribute || !cavityVertexIndices || !bakedColors) {
        return;
      }

      cavityVertexIndices.forEach((vertexIndex) => {
        if (isActive) {
          colorAttribute.setXYZ(
            vertexIndex,
            alertColor.r,
            alertColor.g,
            alertColor.b,
          );
        } else {
          colorAttribute.setXYZ(
            vertexIndex,
            bakedColors[vertexIndex * 3],
            bakedColors[vertexIndex * 3 + 1],
            bakedColors[vertexIndex * 3 + 2],
          );
        }
      });
      colorAttribute.needsUpdate = true;
    });
  }

  // Ground-family visual layers z-fight at grazing camera angles (worst case: view-cube
  // L/R side views combined with zooming) even with logarithmicDepthBuffer enabled,
  // because some of them are exactly or near coplanar by design - e.g. in sw17.urdf,
  // obstacle_rock_1's bottom face (z=0.005 in world) lands exactly on ground's top face
  // (also z=0.005), and obstacle_wood_bar's bottom sits only 5mm above it. At a grazing
  // angle those near-zero depth differences fall within the GPU's per-pixel depth
  // precision, so which layer wins the depth test flips frame to frame - read as the
  // ground area flickering. glPolygonOffset resolves that deterministically regardless
  // of viewing angle by biasing each layer's rendered depth apart: the background
  // reference plane (ellipsoid_surface) is pushed away, the ground slab stays neutral,
  // and anything meant to sit visibly on top of the ground (obstacle_*) is pulled
  // toward the camera so it always wins.
  //
  // ellipsoid_surface and ground are also both semi-transparent (rgba alpha 0.5 and 0.8
  // in sw17.urdf), and ellipsoid_surface's larger XY footprint means its translucent
  // apron is visible around the ground's perimeter, overlapping it in screen space from
  // most angles. Three.js draws transparent objects in a separate pass, back-to-front,
  // ordered by each object's distance to the camera - with depthWrite left at its
  // default (true), that per-object distance sort is what decides draw order, and for
  // two large, nearly-parallel, closely-spaced transparent slabs like these the
  // "which one is farther" answer can flip between frames from sub-pixel camera motion
  // alone (independent of the opaque z-fighting above, and NOT something
  // polygonOffset touches - it only affects the depth test, not this distance sort).
  // That's the second, likely dominant, flicker source. Pinning it down with an
  // explicit renderOrder and depthWrite=false removes the ambiguity: draw order becomes
  // fixed (ellipsoid_surface, then ground, then obstacles) instead of camera-distance
  // dependent, and since neither of these two write depth, they can't fight each other
  // in the depth buffer either.
  applyGroundLayerPolygonOffsetSeparation() {
    const linkMap = this.robotModel?.links || {};

    const setLayerRenderTuning = (link, offsetAmount, renderOrder, options = {}) => {
      if (!link) {
        return;
      }

      link.traverse((node) => {
        if (!node?.isMesh || !node.material) {
          return;
        }

        node.renderOrder = renderOrder;

        const materials = Array.isArray(node.material)
          ? node.material
          : [node.material];
        materials.forEach((material) => {
          if (!material) {
            return;
          }
          material.polygonOffset = true;
          material.polygonOffsetFactor = offsetAmount;
          material.polygonOffsetUnits = offsetAmount;
          // Check opacity rather than trusting material.transparent to already be set -
          // URDFLoader isn't guaranteed to have flipped it on just because the URDF's
          // <color rgba> alpha was below 1.
          if (
            options.disableDepthWriteIfTransparent &&
            Number.isFinite(material.opacity) &&
            material.opacity < 1
          ) {
            material.transparent = true;
            material.depthWrite = false;
          }
          material.needsUpdate = true;
        });
      });
    };

    setLayerRenderTuning(linkMap.ellipsoid_surface, 2, 0, {
      disableDepthWriteIfTransparent: true,
    });
    setLayerRenderTuning(linkMap.ground || linkMap.ground_patch, 1, 1, {
      disableDepthWriteIfTransparent: true,
    });

    Object.keys(linkMap)
      .filter((linkKey) => /^obstacle_/i.test(linkKey))
      .forEach((linkKey) => setLayerRenderTuning(linkMap[linkKey], -1, 2));
  }

  resolveWheelHighlightTargets() {
    const linkMap = this.robotModel?.links || {};

    Object.keys(this.wheelLinkNameByKey).forEach((key) => {
      const expectedLinkName = this.wheelLinkNameByKey[key];
      const link = linkMap[expectedLinkName] || null;
      const meshes = [];

      if (!link) {
        this.wheelHighlightMeshesByKey[key] = meshes;
        return;
      }

      link.traverse((node) => {
        if (!node || !node.isMesh || !node.material) {
          return;
        }

        if (Array.isArray(node.material)) {
          node.material = node.material.map(
            (material) => material?.clone?.() || material,
          );
        } else if (node.material?.clone) {
          node.material = node.material.clone();
        }

        const clonedMaterials = Array.isArray(node.material)
          ? node.material
          : [node.material];
        clonedMaterials.forEach((material) => {
          if (!material) {
            return;
          }

          if (material.color) {
            material.userData = material.userData || {};
            if (!(material.userData.wheelBaseColor instanceof THREE.Color)) {
              material.userData.wheelBaseColor = material.color.clone();
            }
          }

          if (material.emissive) {
            material.userData = material.userData || {};
            if (!(material.userData.wheelBaseEmissive instanceof THREE.Color)) {
              material.userData.wheelBaseEmissive = material.emissive.clone();
            }
          }
        });

        meshes.push(node);
      });

      this.wheelHighlightMeshesByKey[key] = meshes;
    });
  }

  applyWheelHighlightByKey(selectedKey) {
    this.applyWheelHighlightByKeys([selectedKey]);
  }

  applyWheelHighlightByKeys(selectedKeys) {
    const normalizedKeySet = new Set(
      (Array.isArray(selectedKeys) ? selectedKeys : [])
        .map((key) =>
          String(key || "")
            .trim()
            .toLowerCase(),
        )
        .filter(
          (key) =>
            key &&
            Object.prototype.hasOwnProperty.call(
              this.wheelHighlightMeshesByKey,
              key,
            ),
        ),
    );

    if (normalizedKeySet.size === 0) {
      return;
    }

    const firstSelectedKey = normalizedKeySet.values().next().value || null;
    this.highlightedWheelKey = firstSelectedKey;

    Object.keys(this.wheelHighlightMeshesByKey).forEach((key) => {
      const wheelMeshes = this.wheelHighlightMeshesByKey[key] || [];
      const isSelected = normalizedKeySet.has(key);

      wheelMeshes.forEach((mesh) => {
        const materials = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        materials.forEach((material) => {
          if (!material) {
            return;
          }

          if (material.color) {
            const baseColor =
              material.userData?.wheelBaseColor instanceof THREE.Color
                ? material.userData.wheelBaseColor
                : this.wheelHighlightBaseColor;
            const targetColor = isSelected
              ? baseColor.clone().lerp(this.wheelHighlightAccentColor, 0.72)
              : baseColor.clone().lerp(this.wheelHighlightDimColor, 0.22);
            material.color.copy(targetColor);
          }

          if (material.emissive) {
            const baseEmissive =
              material.userData?.wheelBaseEmissive instanceof THREE.Color
                ? material.userData.wheelBaseEmissive
                : new THREE.Color(0x000000);
            const targetEmissive = isSelected
              ? this.wheelHighlightEmissiveColor
              : baseEmissive;
            material.emissive.copy(targetEmissive);
          }

          material.needsUpdate = true;
        });
      });
    });
  }

  clearWheelHighlights() {
    this.highlightedWheelKey = null;
    Object.keys(this.wheelHighlightMeshesByKey).forEach((key) => {
      const wheelMeshes = this.wheelHighlightMeshesByKey[key] || [];
      wheelMeshes.forEach((mesh) => {
        const materials = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        materials.forEach((material) => {
          if (!material) {
            return;
          }

          if (
            material.color &&
            material.userData?.wheelBaseColor instanceof THREE.Color
          ) {
            material.color.copy(material.userData.wheelBaseColor);
          }

          if (
            material.emissive &&
            material.userData?.wheelBaseEmissive instanceof THREE.Color
          ) {
            material.emissive.copy(material.userData.wheelBaseEmissive);
          }

          material.needsUpdate = true;
        });
      });
    });
  }

  // Applies the container's current box size to the renderer/camera. Shared by the window
  // "resize" listener and the ResizeObserver below, since either can legitimately change
  // the container's actual size without the other firing (e.g. a CSS-driven layout change
  // - like a table row growing to fit a min-height'd sibling cell - never dispatches a
  // window resize event, so init()'s one-time getBoundingClientRect() read can otherwise be
  // stuck at a stale, too-small size until an actual window resize happens to correct it).
  applyContainerResize() {
    const newRect = this.container.getBoundingClientRect();
    const newWidth = Math.max(newRect.width, 1);
    const newHeight = Math.max(newRect.height, 1);

    this.camera.aspect = newWidth / newHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(newWidth, newHeight, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";

    if (this.compassRenderer) {
      this.compassRenderer.setPixelRatio(
        Math.min(window.devicePixelRatio || 1, 2),
      );
      this.compassRenderer.setSize(48, 48, false);
    }

    // LineMaterial (used by the pothole edge-line overlay) computes its
    // constant screen-space line width from this resolution uniform — if it
    // goes stale after a resize, the outline width silently drifts from what
    // groundHoleEdgeLineWidthPixels asked for.
    if (this.groundHoleEdgeLineObjects && this.groundHoleEdgeLineObjects.length > 0) {
      this.groundHoleEdgeLineObjects.forEach((edgeLines) => {
        edgeLines.material.resolution.set(newWidth, newHeight);
      });
    }
    if (this.xyGridHelper?.material?.resolution) {
      this.xyGridHelper.material.resolution.set(newWidth, newHeight);
    }
  }

  setupResizeHandler() {
    window.addEventListener("resize", () => this.applyContainerResize());

    // Catches container-size changes that don't come with a window resize event - e.g. the
    // table row this container sits in settling to its final (min-height-driven) height
    // shortly after the initial layout, which otherwise left the canvas rendered at
    // init()'s smaller, stale size until the next real window resize.
    if (typeof ResizeObserver !== "undefined") {
      this.containerResizeObserver = new ResizeObserver(() => {
        this.applyContainerResize();
      });
      this.containerResizeObserver.observe(this.container);
    }
  }

  animate() {
    const now = performance.now();
    const deltaSec = Math.min((now - this.lastFrameTimeMs) / 1000, 0.1);
    this.lastFrameTimeMs = now;

    this.applyWheelAnimation(deltaSec);
    this.updateAxisAnchorFromModel();
    requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.updateCompassOverlay();
    this.renderer.render(this.scene, this.camera);
  }
}

function setWheelAnimationByKey(key, rpm) {
  const targetViewers = getWheelAnimationTargetViewersByKey(key);
  if (targetViewers.length === 0) {
    return;
  }

  targetViewers.forEach((viewer) => {
    viewer.setWheelSpeedRpm(key, rpm);
  });
}

function getWheelAnimationTargetViewersByKey(key) {
  const viewers = [];
  const vehicleViewer = getWheelAnimationTargetViewer();
  if (vehicleViewer) {
    viewers.push(vehicleViewer);
  }

  const wheelViewerId = `${key}-wheel-urdf-viewer`;
  const wheelViewer = window.urdfViewersById?.[wheelViewerId] || null;
  if (wheelViewer && !viewers.includes(wheelViewer)) {
    viewers.push(wheelViewer);
  }

  const genericWheelViewer =
    window.urdfViewersById?.["wheel-urdf-viewer"] || null;
  if (genericWheelViewer && !viewers.includes(genericWheelViewer)) {
    viewers.push(genericWheelViewer);
  }

  return viewers;
}

function getWheelAnimationTargetViewer() {
  if (window.urdfViewersById?.["vehicle-urdf-viewer"]) {
    return window.urdfViewersById["vehicle-urdf-viewer"];
  }

  if (Array.isArray(window.urdfViewers)) {
    const vehicleViewer = window.urdfViewers.find((viewer) => {
      const urdfPath = String(viewer?.urdfPath || "");
      return urdfPath.includes("/model/vehicle/vehicle.urdf");
    });

    if (vehicleViewer) {
      return vehicleViewer;
    }
  }

  return window.activeURDFViewer || null;
}

globalThis.setWheelAnimationByKey = setWheelAnimationByKey;

globalThis.setWheelVisualFilterEnabled = function (
  enabled,
  viewerId = "vehicle-urdf-viewer",
) {
  const viewer =
    window.urdfViewersById?.[viewerId] || window.activeURDFViewer || null;
  if (!viewer || typeof viewer.setWheelVisualFilterEnabled !== "function") {
    return;
  }

  viewer.setWheelVisualFilterEnabled(enabled);
};

globalThis.setWheelViewerKey = function (key) {
  window.pendingWheelViewerKey = String(key || "")
    .trim()
    .toLowerCase();

  const viewer = window.urdfViewersById?.["wheel-urdf-viewer"] || null;
  if (!viewer || typeof viewer.setViewerWheelKey !== "function") {
    return;
  }

  viewer.setViewerWheelKey(key);
};

globalThis.flashWheelViewer = function () {
  const viewer = window.urdfViewersById?.["wheel-urdf-viewer"] || null;
  if (!viewer || typeof viewer.flashViewerWheel !== "function") {
    return;
  }

  viewer.flashViewerWheel();
};

globalThis.setVehicleWheelHighlightByKey = function (key) {
  window.pendingVehicleWheelHighlightKeys = null;
  window.pendingVehicleWheelHighlightKey = String(key || "")
    .trim()
    .toLowerCase();

  const vehicleViewer = window.urdfViewersById?.["vehicle-urdf-viewer"] || null;
  if (
    !vehicleViewer ||
    typeof vehicleViewer.applyWheelHighlightByKey !== "function"
  ) {
    return;
  }

  vehicleViewer.applyWheelHighlightByKey(key);
};

globalThis.setVehicleWheelHighlightByKeys = function (keys) {
  const normalizedKeys = (Array.isArray(keys) ? keys : [])
    .map((key) =>
      String(key || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);

  window.pendingVehicleWheelHighlightKey = null;
  window.pendingVehicleWheelHighlightKeys = normalizedKeys;

  const vehicleViewer = window.urdfViewersById?.["vehicle-urdf-viewer"] || null;
  if (
    !vehicleViewer ||
    typeof vehicleViewer.applyWheelHighlightByKeys !== "function"
  ) {
    return;
  }

  vehicleViewer.applyWheelHighlightByKeys(normalizedKeys);
};

globalThis.clearVehicleWheelHighlights = function () {
  window.pendingVehicleWheelHighlightKey = null;
  window.pendingVehicleWheelHighlightKeys = [];

  const vehicleViewer = window.urdfViewersById?.["vehicle-urdf-viewer"] || null;
  if (
    !vehicleViewer ||
    typeof vehicleViewer.clearWheelHighlights !== "function"
  ) {
    return;
  }

  vehicleViewer.clearWheelHighlights();
};

function setDriveMode(mode) {
  if (!window.activeURDFViewer) {
    return;
  }

  const normalizedMode = String(mode || "")
    .trim()
    .toLowerCase();
  const speedInput = $("#drive-speed-kmh");
  let speedKmh =
    speedInput.length > 0 ? Number.parseFloat(speedInput.val()) : 0;
  speedKmh = Number.isFinite(speedKmh) ? Math.max(speedKmh, 0) : 0;

  if (normalizedMode !== "stop") {
    const minimumSpeedKmh = 0.1;
    speedKmh = Math.max(speedKmh, minimumSpeedKmh);
  }

  if (speedInput.length > 0) {
    speedInput.val(String(speedKmh));
    const speedValueElement = document.getElementById("drive-speed-kmh-value");
    if (speedValueElement) {
      speedValueElement.textContent = `${speedKmh} km/h`;
    }
  }

  window.activeURDFViewer.applyDriveMode(normalizedMode, speedKmh);
  updateDriveModeButtons(normalizedMode);
}

function setDriveSpeedKmh(kmh) {
  const numericKmh = Number.parseFloat(kmh);
  const normalizedKmh = Number.isFinite(numericKmh)
    ? Math.max(numericKmh, 0)
    : 0;
  const speedValueElement = document.getElementById("drive-speed-kmh-value");
  if (speedValueElement) {
    speedValueElement.textContent = `${normalizedKmh} km/h`;
  }

  if (!window.activeURDFViewer) {
    return;
  }

  const mode = window.activeURDFViewer.driveMode || "stop";

  if (mode === "stop") {
    // Keep the configured speed for the next drive command, but do not move while stopped.
    window.activeURDFViewer.driveSpeedKmh = normalizedKmh;
    return;
  }

  window.activeURDFViewer.applyDriveMode(mode, normalizedKmh);
}

function setRoadRollAngleDeg(angleDeg) {
  const numericAngleDeg = Number.parseFloat(angleDeg);
  const normalizedAngleDeg = Number.isFinite(numericAngleDeg)
    ? Math.min(30, Math.max(-30, numericAngleDeg))
    : 0;

  const spinner = document.getElementById("road-roll-angle-deg");
  if (spinner) {
    spinner.value = String(normalizedAngleDeg);
  }

  const valueElement = document.getElementById("road-roll-angle-deg-value");
  if (valueElement) {
    valueElement.textContent = `${normalizedAngleDeg}\u00b0`;
  }

  const targetViewer = getRoadAttitudeTargetViewer();
  if (
    !targetViewer ||
    typeof targetViewer.applyRoadRollAngleDeg !== "function"
  ) {
    return;
  }

  targetViewer.applyRoadRollAngleDeg(normalizedAngleDeg);
}

function setRoadPitchAngleDeg(angleDeg) {
  const numericAngleDeg = Number.parseFloat(angleDeg);
  const normalizedAngleDeg = Number.isFinite(numericAngleDeg)
    ? Math.min(30, Math.max(-30, numericAngleDeg))
    : 0;

  const spinner = document.getElementById("road-pitch-angle-deg");
  if (spinner) {
    spinner.value = String(normalizedAngleDeg);
  }

  const valueElement = document.getElementById("road-pitch-angle-deg-value");
  if (valueElement) {
    valueElement.textContent = `${normalizedAngleDeg}\u00b0`;
  }

  const targetViewer = getRoadAttitudeTargetViewer();
  if (
    !targetViewer ||
    typeof targetViewer.applyRoadPitchAngleDeg !== "function"
  ) {
    return;
  }

  targetViewer.applyRoadPitchAngleDeg(normalizedAngleDeg);
}

function getRoadAttitudeTargetViewer() {
  const vehicleViewer = window.urdfViewersById?.["vehicle-urdf-viewer"] || null;
  if (vehicleViewer) {
    return vehicleViewer;
  }

  if (Array.isArray(window.urdfViewers)) {
    const matchedViewer = window.urdfViewers.find((viewer) => {
      const urdfPath = String(viewer?.urdfPath || "");
      return urdfPath.includes("/model/vehicle/vehicle.urdf");
    });

    if (matchedViewer) {
      return matchedViewer;
    }
  }

  return window.activeURDFViewer || null;
}

const vehicleAudioState = {
  lastCommand: null,
  lastSurfaceState: null,
  lastObstacle: null,
  lastRollAngleDeg: null,
  baselineSeen: {
    command: false,
    surface: false,
    obstacle: false,
    roll: false,
  },
  lastRollAnnouncedAt: 0,
  minRollDeltaDeg: 2,
  minRollAnnounceIntervalMs: 1200,
  isActivated: false,
  isActivationListenerAttached: false,
  pendingMessage: null,
  pendingOptions: null,
  speakTimerId: null,
  speechQueue: [],
  isSpeaking: false,
  lastSpokenMessage: "",
  lastSpokenAt: 0,
  duplicateMessageBlockMs: 350,
};

function canUseSpeechSynthesis() {
  return (
    typeof window !== "undefined" &&
    typeof window.SpeechSynthesisUtterance === "function" &&
    window.speechSynthesis &&
    typeof window.speechSynthesis.speak === "function"
  );
}

function getPreferredSpeechVoice() {
  if (!canUseSpeechSynthesis()) {
    return null;
  }

  let voices = [];
  try {
    voices = window.speechSynthesis.getVoices() || [];
  } catch (error) {
    voices = [];
  }

  if (!Array.isArray(voices) || voices.length === 0) {
    return null;
  }

  const koVoice = voices.find(function (voice) {
    return String((voice && voice.lang) || "")
      .toLowerCase()
      .startsWith("ko");
  });
  return koVoice || voices[0] || null;
}

function hasUserActivatedDocument() {
  if (hasGlobalUserGestureDetected()) {
    return true;
  }

  try {
    return !!(
      navigator.userActivation &&
      navigator.userActivation.hasBeenActive === true
    );
  } catch (error) {
    return false;
  }
}

function readVehicleAudioEnabledFromStorage() {
  try {
    const rawValue = window.localStorage.getItem(VEHICLE_AUDIO_STORAGE_KEY);
    if (rawValue == null) {
      return null;
    }

    const normalized = String(rawValue).trim().toLowerCase();
    if (
      normalized === "true" ||
      normalized === "1" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }

    if (
      normalized === "false" ||
      normalized === "0" ||
      normalized === "no" ||
      normalized === "off"
    ) {
      return false;
    }
  } catch (error) {
    console.warn("[URDF][Audio] localStorage read failed:", error);
  }

  return null;
}

function writeVehicleAudioEnabledToStorage(enabled) {
  try {
    window.localStorage.setItem(
      VEHICLE_AUDIO_STORAGE_KEY,
      enabled ? "true" : "false",
    );
  } catch (error) {
    console.warn("[URDF][Audio] localStorage write failed:", error);
  }
}

function isVehicleAudioEnabled() {
  if (typeof window.vehicleAudioEnabled === "boolean") {
    return window.vehicleAudioEnabled;
  }

  const storageEnabled = readVehicleAudioEnabledFromStorage();
  if (storageEnabled != null) {
    return storageEnabled;
  }

  const viewer = getRoadAttitudeTargetViewer();
  return !!(viewer && viewer.showAudio === true);
}

function setVehicleAudioEnabled(enabled) {
  const normalizedEnabled = !!enabled;
  window.vehicleAudioEnabled = normalizedEnabled;
  window.__wcsAudioEnabled = normalizedEnabled;
  writeVehicleAudioEnabledToStorage(normalizedEnabled);

  if (normalizedEnabled) {
    setupVehicleAudioActivationListener();
    if (hasUserActivatedDocument()) {
      tryActivateVehicleAudio("auto");
    }
    return;
  }

  vehicleAudioState.pendingMessage = null;
  vehicleAudioState.pendingOptions = null;
  if (vehicleAudioState.speakTimerId) {
    clearTimeout(vehicleAudioState.speakTimerId);
    vehicleAudioState.speakTimerId = null;
  }

  if (canUseSpeechSynthesis()) {
    window.speechSynthesis.cancel();
  }

  vehicleAudioState.speechQueue = [];
  vehicleAudioState.isSpeaking = false;
  window.__wcsAudioSpeaking = false;
}

function tryActivateVehicleAudio(trigger = "system") {
  if (!canUseSpeechSynthesis()) {
    return false;
  }

  try {
    window.speechSynthesis.resume();
    window.speechSynthesis.getVoices();
  } catch (error) {
    console.warn("[URDF][Audio] speechSynthesis resume failed:", error);
  }

  const canActivateByGesture = trigger === "gesture";
  const canActivateByPriorInteraction =
    trigger === "auto" && hasUserActivatedDocument();

  // 브라우저 자동재생 정책상 사용자 제스처 또는 이미 사용자 상호작용이 확인된 경우에만 활성화한다.
  if (!canActivateByGesture && !canActivateByPriorInteraction) {
    return false;
  }

  vehicleAudioState.isActivated = true;

  const pendingMessage = vehicleAudioState.pendingMessage;
  const pendingOptions = vehicleAudioState.pendingOptions || {};
  if (pendingMessage) {
    vehicleAudioState.pendingMessage = null;
    vehicleAudioState.pendingOptions = null;
    speakVehicleStatus(pendingMessage, pendingOptions);
  }

  return true;
}

function setupVehicleAudioActivationListener() {
  if (
    vehicleAudioState.isActivationListenerAttached ||
    !isVehicleAudioEnabled()
  ) {
    return;
  }

  if (hasUserActivatedDocument()) {
    tryActivateVehicleAudio("auto");
    return;
  }

  vehicleAudioState.isActivationListenerAttached = true;

  const onFirstUserGesture = () => {
    tryActivateVehicleAudio("gesture");
    document.removeEventListener("pointerdown", onFirstUserGesture, true);
    document.removeEventListener("keydown", onFirstUserGesture, true);
    document.removeEventListener("touchstart", onFirstUserGesture, true);
  };

  document.addEventListener("pointerdown", onFirstUserGesture, true);
  document.addEventListener("keydown", onFirstUserGesture, true);
  document.addEventListener("touchstart", onFirstUserGesture, true);
}

function processVehicleSpeechQueue() {
  if (!isVehicleAudioEnabled() || !canUseSpeechSynthesis()) {
    return;
  }

  if (!vehicleAudioState.isActivated || vehicleAudioState.isSpeaking) {
    return;
  }

  if (
    !Array.isArray(vehicleAudioState.speechQueue) ||
    vehicleAudioState.speechQueue.length === 0
  ) {
    return;
  }

  const nextMessage = String(
    vehicleAudioState.speechQueue.shift() || "",
  ).trim();
  if (!nextMessage) {
    processVehicleSpeechQueue();
    return;
  }

  vehicleAudioState.isSpeaking = true;
  window.__wcsAudioSpeaking = true;

  try {
    window.speechSynthesis.resume();
    window.speechSynthesis.getVoices();
  } catch (error) {
    console.warn(
      "[URDF][Audio] speechSynthesis resume before queue speak failed:",
      error,
    );
  }

  const utterance = new window.SpeechSynthesisUtterance(nextMessage);
  const preferredVoice = getPreferredSpeechVoice();
  if (preferredVoice) {
    utterance.voice = preferredVoice;
    if (preferredVoice.lang) {
      utterance.lang = preferredVoice.lang;
    }
  } else {
    utterance.lang = "ko-KR";
  }
  utterance.rate = 1.05;
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.onend = () => {
    vehicleAudioState.isSpeaking = false;
    window.__wcsAudioSpeaking = false;
    processVehicleSpeechQueue();
  };
  utterance.onerror = () => {
    vehicleAudioState.isSpeaking = false;
    window.__wcsAudioSpeaking = false;
    processVehicleSpeechQueue();
  };
  try {
    window.speechSynthesis.speak(utterance);
  } catch (error) {
    console.warn("[URDF][Audio] speechSynthesis.speak failed:", error);
    vehicleAudioState.isSpeaking = false;
    window.__wcsAudioSpeaking = false;
    processVehicleSpeechQueue();
  }
}

function speakVehicleStatus(text, options = {}) {
  if (!isVehicleAudioEnabled() || !canUseSpeechSynthesis()) {
    return;
  }

  const message = String(text || "").trim();
  if (!message) {
    return;
  }

  const shouldInterrupt = !!(options && options.interrupt === true);

  const now = Date.now();
  window.__wcsAudioEnabled = true;
  window.__wcsLastSpeechText = message;
  window.__wcsLastSpeechAt = now;
  if (
    vehicleAudioState.lastSpokenMessage === message &&
    now - vehicleAudioState.lastSpokenAt <
      vehicleAudioState.duplicateMessageBlockMs
  ) {
    return;
  }

  if (!vehicleAudioState.isActivated) {
    if (hasUserActivatedDocument()) {
      tryActivateVehicleAudio("auto");
    }

    if (vehicleAudioState.isActivated) {
      // continue to enqueue/speak below.
    } else {
      vehicleAudioState.pendingMessage = message;
      vehicleAudioState.pendingOptions = options;
      setupVehicleAudioActivationListener();
      return;
    }
  }

  const globalSpeechState = window.__wcsGlobalSpeechState || {
    message: "",
    at: 0,
  };
  if (
    globalSpeechState.message === message &&
    now - globalSpeechState.at < 1200
  ) {
    return;
  }
  window.__wcsGlobalSpeechState = { message: message, at: now };

  if (shouldInterrupt && canUseSpeechSynthesis()) {
    try {
      window.speechSynthesis.cancel();
    } catch (error) {
      // Ignore cancel failures and continue queue handling.
    }
    vehicleAudioState.speechQueue = [];
    vehicleAudioState.isSpeaking = false;
    window.__wcsAudioSpeaking = false;
  } else if (vehicleAudioState.speechQueue.length >= 6) {
    // Keep queue bounded to prevent stale delayed speech.
    vehicleAudioState.speechQueue = vehicleAudioState.speechQueue.slice(-3);
  }

  vehicleAudioState.speechQueue.push(message);
  processVehicleSpeechQueue();

  vehicleAudioState.lastSpokenMessage = message;
  vehicleAudioState.lastSpokenAt = now;
}

function announceVehicleDriveCommand(commandValue) {
  if (!isVehicleAudioEnabled()) {
    return;
  }

  const numericCommand = Number.parseInt(commandValue, 10);
  const commandLabelByValue = {
    0: "정지",
    1: "전진",
    2: "후진",
    3: "좌회전",
    4: "우회전",
  };

  const commandLabel = commandLabelByValue[numericCommand];
  if (!commandLabel) {
    return;
  }

  // 첫 수신 명령값은 기준값만 설정하고 음성은 출력하지 않는다.
  if (!vehicleAudioState.baselineSeen.command) {
    vehicleAudioState.baselineSeen.command = true;
    vehicleAudioState.lastCommand = numericCommand;
    return;
  }

  if (vehicleAudioState.lastCommand === numericCommand) {
    return;
  }

  vehicleAudioState.lastCommand = numericCommand;
  speakVehicleStatus(`차량 ${commandLabel}`, { interrupt: true });
}

function announceVehicleRollAngleDeg(angleDeg) {
  if (!isVehicleAudioEnabled()) {
    return;
  }

  const numericAngle = Number(angleDeg);
  if (!Number.isFinite(numericAngle)) {
    return;
  }

  const roundedAngleDeg = Math.round(numericAngle);
  const now = Date.now();

  // 첫 수신값(대개 초기 0도)은 기준값만 설정하고 음성 출력하지 않는다.
  if (!vehicleAudioState.baselineSeen.roll) {
    vehicleAudioState.baselineSeen.roll = true;
    vehicleAudioState.lastRollAngleDeg = roundedAngleDeg;
    vehicleAudioState.lastRollAnnouncedAt = now;
    return;
  }

  if (vehicleAudioState.lastRollAngleDeg != null) {
    const angleDelta = Math.abs(
      roundedAngleDeg - vehicleAudioState.lastRollAngleDeg,
    );
    const elapsedMs = now - vehicleAudioState.lastRollAnnouncedAt;
    if (
      angleDelta < vehicleAudioState.minRollDeltaDeg ||
      elapsedMs < vehicleAudioState.minRollAnnounceIntervalMs
    ) {
      return;
    }
  }

  vehicleAudioState.lastRollAngleDeg = roundedAngleDeg;
  vehicleAudioState.lastRollAnnouncedAt = now;
  speakVehicleStatus(`롤 각도 ${roundedAngleDeg}도`, { interrupt: true });
}

function announceVehicleObstacle(obstacleValue) {
  if (!isVehicleAudioEnabled()) {
    return;
  }

  const numericObstacle = Number.parseInt(obstacleValue, 10);
  const obstacleLabelByValue = {
    0: "없음",
    1: "단차",
    2: "포트홀",
    3: "빙판길",
  };

  const obstacleLabel = obstacleLabelByValue[numericObstacle];
  if (!obstacleLabel) {
    return;
  }

  vehicleAudioState.baselineSeen.obstacle = true;

  if (vehicleAudioState.lastObstacle === numericObstacle) {
    return;
  }

  vehicleAudioState.lastObstacle = numericObstacle;
  speakVehicleStatus(`장애물 ${obstacleLabel}`, { interrupt: true });
}

function announceVehicleSurfaceState(surfaceStateValue) {
  if (!isVehicleAudioEnabled()) {
    return;
  }

  const numericSurfaceState = Number.parseInt(surfaceStateValue, 10);
  const surfaceLabelByValue = {
    0: "아스팔트",
    1: "보도블록",
    2: "흙길",
    3: "자갈길",
  };

  const surfaceLabel = surfaceLabelByValue[numericSurfaceState];
  if (!surfaceLabel) {
    return;
  }

  // 첫 수신 노면 상태(대개 초기 아스팔트)는 기준만 설정하고 음성은 출력하지 않는다.
  if (!vehicleAudioState.baselineSeen.surface) {
    vehicleAudioState.baselineSeen.surface = true;
    vehicleAudioState.lastSurfaceState = numericSurfaceState;
    return;
  }

  if (vehicleAudioState.lastSurfaceState === numericSurfaceState) {
    return;
  }

  vehicleAudioState.lastSurfaceState = numericSurfaceState;
  speakVehicleStatus(`${surfaceLabel}`, { interrupt: true });
}

function updateDriveModeButtons(activeMode) {
  const modes = ["forward", "backward", "left", "right", "stop"];
  modes.forEach((mode) => {
    const button = $(`#drive-btn-${mode}`);
    if (button.length === 0) {
      return;
    }

    const isActive = mode === activeMode;
    button.toggleClass("btn-success", isActive && mode === "forward");
    button.toggleClass("btn-secondary", isActive && mode === "backward");
    button.toggleClass(
      "btn-primary",
      isActive && (mode === "left" || mode === "right"),
    );
    button.toggleClass("btn-danger", isActive && mode === "stop");
    button.toggleClass("btn-outline-success", !isActive && mode === "forward");
    button.toggleClass(
      "btn-outline-secondary",
      !isActive && mode === "backward",
    );
    button.toggleClass(
      "btn-outline-primary",
      !isActive && (mode === "left" || mode === "right"),
    );
    button.toggleClass("btn-outline-danger", !isActive && mode === "stop");
  });
}

globalThis.setDriveMode = setDriveMode;
globalThis.setDriveSpeedKmh = setDriveSpeedKmh;
globalThis.setRoadRollAngleDeg = setRoadRollAngleDeg;
globalThis.setRoadPitchAngleDeg = setRoadPitchAngleDeg;
globalThis.setVehicleViewerVerticalOffset = function (offsetValue) {
  const vehicleViewer = window.urdfViewersById?.["vehicle-urdf-viewer"] || null;
  if (
    !vehicleViewer ||
    typeof vehicleViewer.setGoalTargetVerticalOffset !== "function"
  ) {
    return;
  }

  vehicleViewer.setGoalTargetVerticalOffset(offsetValue);
};
globalThis.setVehicleViewerOverlayDragPixels = function (pixelHeight) {
  const vehicleViewer = window.urdfViewersById?.["vehicle-urdf-viewer"] || null;
  if (
    !vehicleViewer ||
    typeof vehicleViewer.setOverlayVerticalDragPixels !== "function"
  ) {
    return;
  }

  vehicleViewer.setOverlayVerticalDragPixels(pixelHeight);
};
globalThis.setVehicleViewerOverlayZoomOutRatio = function (zoomOutRatio) {
  const vehicleViewer = window.urdfViewersById?.["vehicle-urdf-viewer"] || null;
  if (
    !vehicleViewer ||
    typeof vehicleViewer.setOverlayZoomOutRatio !== "function"
  ) {
    return;
  }

  vehicleViewer.setOverlayZoomOutRatio(zoomOutRatio);
};
globalThis.isVehicleAudioEnabled = isVehicleAudioEnabled;
globalThis.setVehicleAudioEnabled = setVehicleAudioEnabled;
globalThis.activateVehicleAudioByGesture = function () {
  setVehicleAudioEnabled(true);
  return tryActivateVehicleAudio("gesture");
};
globalThis.announceVehicleDriveCommand = announceVehicleDriveCommand;
globalThis.announceVehicleRollAngleDeg = announceVehicleRollAngleDeg;
globalThis.announceVehicleObstacle = announceVehicleObstacle;
globalThis.announceVehicleSurfaceState = announceVehicleSurfaceState;

// 초기화 함수
function initURDFViewers() {
  console.log("[URDF] 🚀 URDF Viewer 초기화 시작...");
  window.activeURDFViewer = null;
  window.urdfViewers = [];
  window.urdfViewersById = {};

  // robot-container 클래스를 가진 모든 요소들 찾기
  const containers = $(".urdf-container, .robot-container").toArray();

  if (containers.length === 0) {
    console.error(
      "[URDF] ❌ urdf-container 또는 robot-container 클래스를 가진 요소를 찾을 수 없습니다.",
    );
    return;
  }

  console.log(`[URDF] 📦 ${containers.length}개의 urdf-container 발견`);

  // 각 컨테이너에 대해 URDFViewer 생성
  containers.forEach((container, index) => {
    const viewIndex = index + 1;
    const containerClass = container.className;

    // 컨테이너 내부의 기존 HTML 요소들 모두 삭제
    container.innerHTML = "";

    console.log(
      `[URDF] 🔧 ${containerClass} 요소 초기화 중... (ViewIndex: ${viewIndex})`,
    );

    const viewer = new URDFViewer(container);
    window.activeURDFViewer = viewer;
    window.urdfViewers.push(viewer);

    if (container.id) {
      window.urdfViewersById[container.id] = viewer;
    }
  });

  window.dispatchEvent(new CustomEvent("urdfviewerready"));

  setDriveSpeedKmh($("#drive-speed-kmh").val());
  setRoadRollAngleDeg($("#road-roll-angle-deg").val());
  setRoadPitchAngleDeg($("#road-pitch-angle-deg").val());
  updateDriveModeButtons(null);

  if (isVehicleAudioEnabled()) {
    // 사용자 제스처 전에 MQTT 이벤트가 먼저 와도 안내 문구를 보류해 두었다가 재생하기 위해 리스너를 준비한다.
    setupVehicleAudioActivationListener();
    tryActivateVehicleAudio("system");
  }

  const storageEnabled = readVehicleAudioEnabledFromStorage();
  const viewer = getRoadAttitudeTargetViewer();
  if (viewer) {
    if (viewer.showAudio === true) {
      // showAudio=true 페이지에서는 과거 localStorage의 OFF 값으로 영구 음소거되지 않게 ON을 우선한다.
      setVehicleAudioEnabled(true);
    } else {
      // showAudio=false일 때는 명시적으로 음소거 (localStorage 값 무시)
      setVehicleAudioEnabled(false);
    }
  }

  console.log("[URDF] 🚀 모든 URDF Viewer 초기화 완료");
}

// DOM 준비 후 초기화
$(initURDFViewers);
