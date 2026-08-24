(function (global) {
  const TOPIC = "wheel/angle/speed";
  const WHEEL_KEYS = Object.freeze(["fr", "fl", "rr", "rl"]);
  const MODE_BY_COMMAND = Object.freeze({
    0: "stop",
    1: "forward",
    2: "backward",
    3: "left",
    4: "right",
  });
  const DIRECTION_BY_MODE = Object.freeze({
    stop: Object.freeze({ fr: 0, fl: 0, rr: 0, rl: 0 }),
    forward: Object.freeze({ fr: 1, fl: 1, rr: 1, rl: 1 }),
    backward: Object.freeze({ fr: -1, fl: -1, rr: -1, rl: -1 }),
    left: Object.freeze({ fr: 1, fl: -1, rr: 1, rl: -1 }),
    right: Object.freeze({ fr: -1, fl: 1, rr: -1, rl: 1 }),
  });
  const ANGULAR_SPEED_EPSILON = 1e-6;

  function normalizeMode(modeOrCommand) {
    const command = Number(modeOrCommand);
    if (
      String(modeOrCommand ?? "").trim() !== "" &&
      Number.isInteger(command) &&
      MODE_BY_COMMAND[command]
    ) {
      return MODE_BY_COMMAND[command];
    }

    const mode = String(modeOrCommand || "stop").toLowerCase();
    return DIRECTION_BY_MODE[mode] ? mode : null;
  }

  function normalizeRadii(radiusByKey, fallbackRadius = null) {
    const fallback = Number(fallbackRadius);
    const normalized = {};

    for (const wheelKey of WHEEL_KEYS) {
      const providedRadius = Number(radiusByKey?.[wheelKey]);
      const radius =
        Number.isFinite(providedRadius) && providedRadius > 0
          ? providedRadius
          : fallback;
      if (!Number.isFinite(radius) || radius <= 0) {
        return null;
      }
      normalized[wheelKey] = radius;
    }

    return normalized;
  }

  function buildAngleSpeedByKey(options = {}) {
    const mode = normalizeMode(options.mode ?? options.command);
    const directionByKey = mode ? DIRECTION_BY_MODE[mode] : null;
    const radiusByKey = normalizeRadii(
      options.radiusByKey,
      options.fallbackRadius,
    );
    if (!directionByKey || !radiusByKey) {
      return null;
    }

    const speedMps = Math.max(Number(options.speedMps) || 0, 0);
    const speedScale = Math.max(Number(options.speedScale ?? 1) || 0, 0);
    const precision = Number.isInteger(options.precision)
      ? Math.max(0, options.precision)
      : 3;

    return WHEEL_KEYS.reduce(function (result, wheelKey) {
      const angularSpeed =
        (directionByKey[wheelKey] * speedMps * speedScale) /
        radiusByKey[wheelKey];
      result[wheelKey] = Number(angularSpeed.toFixed(precision));
      return result;
    }, {});
  }

  function serializeAngleSpeeds(angleSpeedByKey) {
    const values = WHEEL_KEYS.map(function (wheelKey) {
      return Number(angleSpeedByKey?.[wheelKey]);
    });
    return values.every(Number.isFinite) ? values.join(",") : null;
  }

  function buildPayload(options = {}) {
    return serializeAngleSpeeds(buildAngleSpeedByKey(options));
  }

  function parsePayload(value) {
    const parts = String(value).split(",");
    if (
      parts.length !== WHEEL_KEYS.length ||
      parts.some(function (part) {
        return part.trim() === "";
      })
    ) {
      return null;
    }

    const values = parts.map(function (part) {
      return Number(part.trim());
    });
    if (!values.every(Number.isFinite)) {
      return null;
    }

    return WHEEL_KEYS.reduce(function (result, wheelKey, index) {
      result[wheelKey] = values[index];
      return result;
    }, {});
  }

  function resolveMode(angleSpeedByKey) {
    const leftSpeed =
      (Number(angleSpeedByKey?.fl) + Number(angleSpeedByKey?.rl)) * 0.5;
    const rightSpeed =
      (Number(angleSpeedByKey?.fr) + Number(angleSpeedByKey?.rr)) * 0.5;
    if (!Number.isFinite(leftSpeed) || !Number.isFinite(rightSpeed)) {
      return null;
    }

    const leftStopped = Math.abs(leftSpeed) <= ANGULAR_SPEED_EPSILON;
    const rightStopped = Math.abs(rightSpeed) <= ANGULAR_SPEED_EPSILON;
    if (leftStopped && rightStopped) {
      return "stop";
    }
    if (
      leftSpeed > ANGULAR_SPEED_EPSILON &&
      rightSpeed > ANGULAR_SPEED_EPSILON
    ) {
      return "forward";
    }
    if (
      leftSpeed < -ANGULAR_SPEED_EPSILON &&
      rightSpeed < -ANGULAR_SPEED_EPSILON
    ) {
      return "backward";
    }
    if (
      leftSpeed < -ANGULAR_SPEED_EPSILON &&
      rightSpeed > ANGULAR_SPEED_EPSILON
    ) {
      return "left";
    }
    if (
      leftSpeed > ANGULAR_SPEED_EPSILON &&
      rightSpeed < -ANGULAR_SPEED_EPSILON
    ) {
      return "right";
    }

    return Math.abs(leftSpeed + rightSpeed) >= Math.abs(rightSpeed - leftSpeed)
      ? leftSpeed + rightSpeed >= 0
        ? "forward"
        : "backward"
      : rightSpeed - leftSpeed >= 0
        ? "left"
        : "right";
  }

  function buildReceivedCommand(angleSpeedByKey, radiusByKey) {
    const normalizedRadii = normalizeRadii(radiusByKey);
    const mode = resolveMode(angleSpeedByKey);
    if (!normalizedRadii || !mode) {
      return null;
    }

    const speedMps =
      WHEEL_KEYS.reduce(function (sum, wheelKey) {
        return (
          sum + Math.abs(angleSpeedByKey[wheelKey]) * normalizedRadii[wheelKey]
        );
      }, 0) / WHEEL_KEYS.length;
    const wheelRpmByKey = WHEEL_KEYS.reduce(function (result, wheelKey) {
      result[wheelKey] = (angleSpeedByKey[wheelKey] * 60) / (2 * Math.PI);
      return result;
    }, {});

    return { mode, speedMps, angleSpeedByKey, wheelRpmByKey };
  }

  global.WcsVehicleWheelCommand = Object.freeze({
    TOPIC,
    WHEEL_KEYS,
    normalizeMode,
    normalizeRadii,
    buildAngleSpeedByKey,
    serializeAngleSpeeds,
    buildPayload,
    parsePayload,
    resolveMode,
    buildReceivedCommand,
  });
})(window);
