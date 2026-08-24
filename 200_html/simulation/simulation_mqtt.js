(function () {
  const wheelCommand = window.WcsVehicleWheelCommand;
  if (!wheelCommand) {
    console.error(
      "[Simulation][MQTT] Shared wheel command module is unavailable.",
    );
    return;
  }

  const WHEEL_ANGLE_SPEED_TOPIC = wheelCommand.TOPIC;
  const WHEEL_KEYS = wheelCommand.WHEEL_KEYS;
  const DEFAULT_WHEEL_RADIUS_METERS = 0.16;
  const WHEEL_RADIUS_PUBLISH_RETRY_COUNT = 40;
  const WHEEL_RADIUS_PUBLISH_RETRY_INTERVAL_MS = 250;
  const WHEEL_LINEAR_SPEED_BATCH_WAIT_MS = 150;
  let pendingWheelRadiusPublishTimer = null;
  let pendingWheelLinearSpeedTimer = null;
  let lastPublishedWheelRadiusSignature = null;
  const latestWheelLinearSpeedByKey = WHEEL_KEYS.reduce(function (
    result,
    wheelKey,
  ) {
    result[wheelKey] = 0;
    return result;
  }, {});
  const pendingWheelLinearSpeedKeys = new Set();

  function getWheelRadiusMetersByKey() {
    const providedRadii =
      typeof window.getSimulationWheelRadiusMetersByKey === "function"
        ? window.getSimulationWheelRadiusMetersByKey()
        : null;

    return wheelCommand.normalizeRadii(
      providedRadii,
      DEFAULT_WHEEL_RADIUS_METERS,
    );
  }

  function normalizeMeasuredWheelRadii(radiusByKey) {
    const normalizedRadii = {};

    for (const wheelKey of WHEEL_KEYS) {
      const radius = Number(radiusByKey?.[wheelKey]);
      if (!Number.isFinite(radius) || radius <= 0) {
        return null;
      }
      normalizedRadii[wheelKey] = Number(radius.toFixed(9));
    }

    return normalizedRadii;
  }

  function publishMeasuredWheelRadii(radiusByKey, retriesRemaining) {
    const normalizedRadii = normalizeMeasuredWheelRadii(radiusByKey);
    if (!normalizedRadii) {
      console.warn(
        "[Simulation][MQTT] Invalid measured wheel radii:",
        radiusByKey,
      );
      return false;
    }

    const signature = WHEEL_KEYS.map(function (wheelKey) {
      return normalizedRadii[wheelKey];
    }).join(",");
    if (signature === lastPublishedWheelRadiusSignature) {
      return true;
    }

    if (
      !window.mqttClient?.connected ||
      !window.WcsMqtt ||
      typeof window.WcsMqtt.sendMQTTMessage !== "function"
    ) {
      if (retriesRemaining <= 0) {
        console.warn("[Simulation][MQTT] Wheel radius publish timed out.");
        return false;
      }

      window.clearTimeout(pendingWheelRadiusPublishTimer);
      pendingWheelRadiusPublishTimer = window.setTimeout(function () {
        pendingWheelRadiusPublishTimer = null;
        publishMeasuredWheelRadii(normalizedRadii, retriesRemaining - 1);
      }, WHEEL_RADIUS_PUBLISH_RETRY_INTERVAL_MS);
      return false;
    }

    const published = WHEEL_KEYS.every(function (wheelKey) {
      return window.WcsMqtt.sendMQTTMessage(
        `wheel/${wheelKey}/radius`,
        normalizedRadii[wheelKey],
        1,
      );
    });
    if (published) {
      lastPublishedWheelRadiusSignature = signature;
      console.log(
        "[Simulation][MQTT] Measured wheel radii published:",
        normalizedRadii,
      );
    }
    return published;
  }

  window.publishSimulationWheelRadii = function (radiusByKey) {
    return publishMeasuredWheelRadii(
      radiusByKey,
      WHEEL_RADIUS_PUBLISH_RETRY_COUNT,
    );
  };

  function parseWheelAngleSpeeds(value) {
    return wheelCommand.parsePayload(value);
  }

  function buildWheelCommand(angleSpeedByKey) {
    return wheelCommand.buildReceivedCommand(
      angleSpeedByKey,
      getWheelRadiusMetersByKey(),
    );
  }

  function dispatchWheelCommand(command) {
    window.latestSimulationWheelAngleSpeedCommand = command;
    window.dispatchEvent(
      new CustomEvent("wcs:simulation-wheel-angle-speed", { detail: command }),
    );
  }

  function flushPendingWheelLinearSpeeds() {
    if (pendingWheelLinearSpeedKeys.size === 0) {
      return false;
    }

    window.clearTimeout(pendingWheelLinearSpeedTimer);
    pendingWheelLinearSpeedTimer = null;
    const angleSpeedByKey = wheelCommand.linearToAngleSpeedByKey(
      latestWheelLinearSpeedByKey,
      getWheelRadiusMetersByKey(),
    );
    if (!angleSpeedByKey) {
      return false;
    }

    const command = buildWheelCommand(angleSpeedByKey);
    if (!command) {
      return false;
    }

    pendingWheelLinearSpeedKeys.clear();
    dispatchWheelCommand(command);
    return true;
  }

  function applyWheelLinearSpeedMessage(topic, value) {
    const topicMatch = String(topic || "").match(
      /^wheel\/(fr|fl|rr|rl)\/linear\/speed$/i,
    );
    if (!topicMatch) {
      return false;
    }

    const linearSpeedMps = Number(value);
    if (!Number.isFinite(linearSpeedMps)) {
      console.warn(`[Simulation][MQTT] Invalid ${topic} payload:`, value);
      return true;
    }

    const wheelKey = topicMatch[1].toLowerCase();
    latestWheelLinearSpeedByKey[wheelKey] = linearSpeedMps;
    pendingWheelLinearSpeedKeys.add(wheelKey);
    if (pendingWheelLinearSpeedKeys.size === WHEEL_KEYS.length) {
      flushPendingWheelLinearSpeeds();
      return true;
    }

    window.clearTimeout(pendingWheelLinearSpeedTimer);
    pendingWheelLinearSpeedTimer = window.setTimeout(
      flushPendingWheelLinearSpeeds,
      WHEEL_LINEAR_SPEED_BATCH_WAIT_MS,
    );
    return true;
  }

  window.runSimulationMqttDriveCommand = function (mode) {
    const normalizedMode = wheelCommand.normalizeMode(mode);
    if (!normalizedMode) {
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
    const payload = wheelCommand.buildPayload({
      mode: normalizedMode,
      speedMps,
      radiusByKey: getWheelRadiusMetersByKey(),
    });
    if (payload === null) {
      console.warn("[Simulation][MQTT] Wheel radius data is unavailable.");
      return false;
    }

    return window.WcsMqtt.sendMQTTMessage(WHEEL_ANGLE_SPEED_TOPIC, payload, 1);
  };

  window.prcessMqttMessage = function (topic, value) {
    if (applyWheelLinearSpeedMessage(topic, value)) {
      return;
    }

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

    const command = buildWheelCommand(angleSpeedByKey);
    if (command) {
      dispatchWheelCommand(command);
    }
  };
})();
