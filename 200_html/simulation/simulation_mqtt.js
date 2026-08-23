(function () {
  const WHEEL_ANGLE_SPEED_TOPIC = "wheel/angle/speed";
  const WHEEL_KEYS = ["fr", "fl", "rr", "rl"];
  const DEFAULT_WHEEL_RADIUS_METERS = 0.16;
  const ANGULAR_SPEED_EPSILON = 1e-6;
  const wheelDirectionByMode = {
    stop: { fr: 0, fl: 0, rr: 0, rl: 0 },
    forward: { fr: 1, fl: 1, rr: 1, rl: 1 },
    backward: { fr: -1, fl: -1, rr: -1, rl: -1 },
    left: { fr: 1, fl: -1, rr: 1, rl: -1 },
    right: { fr: -1, fl: 1, rr: -1, rl: 1 },
  };

  function getWheelRadiusMetersByKey() {
    const providedRadii =
      typeof window.getSimulationWheelRadiusMetersByKey === "function"
        ? window.getSimulationWheelRadiusMetersByKey()
        : null;

    return WHEEL_KEYS.reduce(function (result, wheelKey) {
      const radius = Number(providedRadii?.[wheelKey]);
      result[wheelKey] =
        Number.isFinite(radius) && radius > 0
          ? radius
          : DEFAULT_WHEEL_RADIUS_METERS;
      return result;
    }, {});
  }

  function parseWheelAngleSpeeds(value) {
    const parts = String(value).split(",");
    if (
      parts.length !== WHEEL_KEYS.length ||
      parts.some(function (part) {
        return part.trim() === "";
      })
    ) {
      return null;
    }

    const speeds = parts.map(function (part) {
      return Number(part.trim());
    });
    if (
      speeds.some(function (speed) {
        return !Number.isFinite(speed);
      })
    ) {
      return null;
    }

    return WHEEL_KEYS.reduce(function (result, wheelKey, index) {
      result[wheelKey] = speeds[index];
      return result;
    }, {});
  }

  function resolveDriveMode(angleSpeedByKey) {
    const leftSpeed = (angleSpeedByKey.fl + angleSpeedByKey.rl) * 0.5;
    const rightSpeed = (angleSpeedByKey.fr + angleSpeedByKey.rr) * 0.5;
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

  function buildWheelCommand(angleSpeedByKey) {
    const wheelRadiusByKey = getWheelRadiusMetersByKey();
    const speedMps =
      WHEEL_KEYS.reduce(function (sum, wheelKey) {
        return (
          sum + Math.abs(angleSpeedByKey[wheelKey]) * wheelRadiusByKey[wheelKey]
        );
      }, 0) / WHEEL_KEYS.length;
    const wheelRpmByKey = WHEEL_KEYS.reduce(function (result, wheelKey) {
      result[wheelKey] = (angleSpeedByKey[wheelKey] * 60) / (2 * Math.PI);
      return result;
    }, {});

    return {
      mode: resolveDriveMode(angleSpeedByKey),
      speedMps,
      angleSpeedByKey,
      wheelRpmByKey,
    };
  }

  function dispatchWheelCommand(command) {
    window.latestSimulationWheelAngleSpeedCommand = command;
    window.dispatchEvent(
      new CustomEvent("wcs:simulation-wheel-angle-speed", { detail: command }),
    );
  }

  window.runSimulationMqttDriveCommand = function (mode) {
    const normalizedMode = String(mode || "stop").toLowerCase();
    const wheelDirections = wheelDirectionByMode[normalizedMode];
    if (!wheelDirections) {
      console.warn("[Simulation][MQTT] Invalid drive mode:", mode);
      return false;
    }

    if (
      !window.WcsMqtt ||
      typeof window.WcsMqtt.sendMQTTMessage !== "function"
    ) {
      console.warn("[Simulation][MQTT] MQTT client is unavailable.");
      return false;
    }

    const speedInput = document.getElementById("drive-speed-mps");
    const speedMps = Math.max(Number(speedInput?.value) || 0, 0);
    const wheelRadiusByKey = getWheelRadiusMetersByKey();
    const payload = WHEEL_KEYS.map(function (wheelKey) {
      const angularSpeed =
        (wheelDirections[wheelKey] * speedMps) / wheelRadiusByKey[wheelKey];
      return Number(angularSpeed.toFixed(3));
    }).join(",");

    return window.WcsMqtt.sendMQTTMessage(WHEEL_ANGLE_SPEED_TOPIC, payload, 1);
  };

  window.prcessMqttMessage = function (topic, value) {
    if (topic !== WHEEL_ANGLE_SPEED_TOPIC) {
      return;
    }

    const angleSpeedByKey = parseWheelAngleSpeeds(value);
    if (!angleSpeedByKey) {
      console.warn(
        `[Simulation][MQTT] Invalid ${WHEEL_ANGLE_SPEED_TOPIC} payload:`,
        value,
      );
      return;
    }

    dispatchWheelCommand(buildWheelCommand(angleSpeedByKey));
  };
})();
