(function () {
  const previousMqttMessageHandler = window.prcessMqttMessage;
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
  // A real wheel/angle/speed message that arrived *before* initialClientConnectObserved
  // flipped true - see the message handler's own comment for why this can happen (retained
  // delivery on subscribe can beat this client's own "client/connect" publish-then-echo
  // round trip) and why it must be remembered here instead of silently dropped.
  let pendingReceivedCommand = null;
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
      // -1 ("제거") clears every obstacle - see simulation.js's
      // applyDynamicSurfaceObstacle() comment - not an obstacle type index like 0/1/2.
      normalizedValue < -1 ||
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

  // receivedCommand: when this unlock is triggered directly by a real wheel/angle/speed
  // message (see the message handler's own call site below), that message's already-built
  // command - the broker's actual current state (e.g. a real robot that kept driving
  // forward across this page reload), not a stale guess. Priority order: a command passed
  // in here directly > pendingReceivedCommand (an earlier real message that arrived before
  // initialClientConnectObserved was true - see its own comment) > pendingStartupLocalCommand
  // (a command only *this* tab locally queued before the round trip finished) > stop.
  // Previously any real received message's content was discarded here in favor of
  // pendingStartupLocalCommand-or-stop, which meant a page reload while a robot was
  // genuinely still driving forward always inserted an unnecessary "stop" beat (sometimes
  // permanently, if no *further* message ever arrived to correct it) - visible in the
  // simulation (and its cycloid chart) as a brief disappear-then-jump, or a stall, on
  // every reload.
  function completeInitialWheelSync(receivedCommand) {
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
    const commandToApply =
      receivedCommand || pendingReceivedCommand || pendingStartupLocalCommand;
    pendingReceivedCommand = null;
    pendingStartupLocalCommand = null;
    if (commandToApply) {
      dispatchWheelCommand(commandToApply);
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
      // -1 ("제거") clears every obstacle - see simulation.js's
      // applyDynamicSurfaceObstacle() comment - not an obstacle type index like 0/1/2.
      normalizedValue < -1 ||
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
    if (typeof previousMqttMessageHandler === "function") {
      previousMqttMessageHandler(topic, value);
    }

    if (topic === "client/connect") {
      initialClientConnectObserved = true;
      window.clearTimeout(initialSyncUnlockTimer);
      // A real wheel/angle/speed message may have already arrived and been remembered as
      // pendingReceivedCommand (see its own comment) - retained delivery on subscribe can
      // beat this client's own publish-then-echo round trip for "client/connect" itself.
      // Apply it right away instead of waiting out the full timeout for no reason.
      if (!initialWheelSyncCompleted && pendingReceivedCommand) {
        completeInitialWheelSync(pendingReceivedCommand);
      } else {
        initialSyncUnlockTimer = window.setTimeout(
          completeInitialWheelSync,
          INITIAL_SYNC_UNLOCK_TIMEOUT_MS,
        );
      }
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
      const command = buildWheelCommand(angleSpeedByKey);
      if (initialClientConnectObserved) {
        // Apply this real message's own state directly - see
        // completeInitialWheelSync()'s own comment for why it must no longer be discarded.
        completeInitialWheelSync(command);
      } else {
        // "client/connect"'s own echo hasn't arrived yet - retained delivery on subscribe
        // can beat it. Remember this instead of silently dropping it (see
        // pendingReceivedCommand's own comment) so the "client/connect" handler (or, failing
        // that, the timeout) can still apply it instead of forcing an unwanted stop.
        pendingReceivedCommand = command;
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
