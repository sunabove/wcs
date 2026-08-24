(function () {
  const wheelCommand = window.WcsVehicleWheelCommand;
  if (!wheelCommand) {
    console.error(
      "[Simulation][MQTT] Shared wheel command module is unavailable.",
    );
    return;
  }

  const WHEEL_ANGLE_SPEED_TOPIC = wheelCommand.TOPIC;
  const SURFACE_OBSTACLE_TOPIC = "vehicle/surface/obstacle";
  const WHEEL_KEYS = wheelCommand.WHEEL_KEYS;
  const DEFAULT_WHEEL_RADIUS_METERS = 0.16;
  const WHEEL_RADIUS_PUBLISH_RETRY_COUNT = 40;
  const WHEEL_RADIUS_PUBLISH_RETRY_INTERVAL_MS = 250;
  const WHEEL_LINEAR_SPEED_BATCH_WAIT_MS = 150;
  const INITIAL_SYNC_UNLOCK_TIMEOUT_MS = 3000;
  let pendingWheelRadiusPublishTimer = null;
  let pendingWheelLinearSpeedTimer = null;
  let initialSyncUnlockTimer = null;
  let lastPublishedWheelRadiusSignature = null;
  let initialClientConnectObserved = false;
  let initialWheelSyncCompleted = false;
  let pendingStartupLocalCommand = null;
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

  function dispatchStopCommand() {
    const command = buildWheelCommand({ fr: 0, fl: 0, rr: 0, rl: 0 });
    if (command) {
      dispatchWheelCommand(command);
    }
  }

  function syncSurfaceObstacleButtons(obstacleValue) {
    const normalizedValue = Number(obstacleValue);
    if (
      !Number.isInteger(normalizedValue) ||
      normalizedValue < 0 ||
      normalizedValue > 2
    ) {
      return false;
    }

    document
      .querySelectorAll("[data-surface-obstacle-value]")
      .forEach(function (button) {
        const isActive =
          Number(button.dataset.surfaceObstacleValue) === normalizedValue;
        button.classList.toggle("active", isActive);
        button.setAttribute("aria-pressed", String(isActive));
      });
    return true;
  }

  function dispatchSurfaceObstacle(obstacleValue) {
    const normalizedValue = Number(obstacleValue);
    if (!syncSurfaceObstacleButtons(normalizedValue)) {
      return false;
    }

    window.latestSimulationSurfaceObstacle = normalizedValue;
    window.dispatchEvent(
      new CustomEvent("wcs:simulation-surface-obstacle", {
        detail: { value: normalizedValue },
      }),
    );
    return true;
  }

  function completeInitialWheelSync() {
    if (initialWheelSyncCompleted) {
      return;
    }

    window.clearTimeout(initialSyncUnlockTimer);
    initialSyncUnlockTimer = null;
    window.clearTimeout(pendingWheelLinearSpeedTimer);
    pendingWheelLinearSpeedTimer = null;
    pendingWheelLinearSpeedKeys.clear();
    WHEEL_KEYS.forEach(function (wheelKey) {
      latestWheelLinearSpeedByKey[wheelKey] = 0;
    });
    initialWheelSyncCompleted = true;
    if (pendingStartupLocalCommand) {
      dispatchWheelCommand(pendingStartupLocalCommand);
      pendingStartupLocalCommand = null;
    } else {
      dispatchStopCommand();
    }
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

  function applyIndividualWheelSpeedMessage(topic, value) {
    const topicMatch = String(topic || "").match(
      /^wheel\/(fr|fl|rr|rl)\/(linear|angle)\/speed$/i,
    );
    if (!topicMatch) {
      return false;
    }

    if (!initialWheelSyncCompleted) {
      return true;
    }

    const receivedSpeed = Number(value);
    if (!Number.isFinite(receivedSpeed)) {
      console.warn(`[Simulation][MQTT] Invalid ${topic} payload:`, value);
      return true;
    }

    const wheelKey = topicMatch[1].toLowerCase();
    const speedType = topicMatch[2].toLowerCase();
    const linearSpeedMps =
      speedType === "angle"
        ? receivedSpeed * getWheelRadiusMetersByKey()[wheelKey]
        : receivedSpeed;
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

    const published = window.WcsMqtt.sendMQTTMessage(
      WHEEL_ANGLE_SPEED_TOPIC,
      payload,
      1,
    );
    if (published && !initialWheelSyncCompleted) {
      pendingStartupLocalCommand = buildWheelCommand(
        parseWheelAngleSpeeds(payload),
      );
      if (pendingStartupLocalCommand) {
        dispatchWheelCommand(pendingStartupLocalCommand);
      }
    }
    return published;
  };

  window.runSimulationMqttObstacleCommand = function (obstacleValue) {
    const normalizedValue = Number(obstacleValue);
    if (
      !Number.isInteger(normalizedValue) ||
      normalizedValue < 0 ||
      normalizedValue > 2
    ) {
      console.warn(
        "[Simulation][MQTT] Invalid surface obstacle:",
        obstacleValue,
      );
      return false;
    }

    if (
      !window.WcsMqtt ||
      typeof window.WcsMqtt.sendMQTTMessage !== "function"
    ) {
      console.warn("[Simulation][MQTT] MQTT client is unavailable.");
      return false;
    }

    const published = window.WcsMqtt.sendMQTTMessage(
      SURFACE_OBSTACLE_TOPIC,
      normalizedValue,
      1,
    );
    if (published) {
      dispatchSurfaceObstacle(normalizedValue);
    }
    return published;
  };

  window.prcessMqttMessage = function (topic, value) {
    if (topic === "client/connect") {
      initialClientConnectObserved = true;
      window.clearTimeout(initialSyncUnlockTimer);
      initialSyncUnlockTimer = window.setTimeout(
        completeInitialWheelSync,
        INITIAL_SYNC_UNLOCK_TIMEOUT_MS,
      );
      return;
    }

    if (topic === SURFACE_OBSTACLE_TOPIC) {
      dispatchSurfaceObstacle(value);
      return;
    }

    if (applyIndividualWheelSpeedMessage(topic, value)) {
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

    if (!initialWheelSyncCompleted) {
      if (initialClientConnectObserved) {
        completeInitialWheelSync();
      }
      return;
    }

    const command = buildWheelCommand(angleSpeedByKey);
    if (command) {
      dispatchWheelCommand(command);
    }
  };

  dispatchStopCommand();
  dispatchSurfaceObstacle(0);
})();
