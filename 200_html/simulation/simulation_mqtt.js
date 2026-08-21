(function () {
  const VEHICLE_OPERATION_TOPIC = "vehicle/operation/command";
  const driveModeByCommand = {
    0: "stop",
    1: "forward",
    2: "backward",
    3: "left",
    4: "right",
  };
  const commandByDriveMode = {
    stop: 0,
    forward: 1,
    backward: 2,
    left: 3,
    right: 4,
  };

  function dispatchDriveCommand(command) {
    const mode = driveModeByCommand[Number(command)];
    if (!mode) {
      return;
    }

    window.dispatchEvent(
      new CustomEvent("wcs:simulation-drive-command", {
        detail: { command: Number(command), mode },
      }),
    );
  }

  window.runSimulationMqttDriveCommand = function (mode) {
    const command = commandByDriveMode[String(mode || "stop").toLowerCase()];
    if (!Number.isInteger(command)) {
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

    return window.WcsMqtt.sendMQTTMessage(VEHICLE_OPERATION_TOPIC, command, 1);
  };

  window.prcessMqttMessage = function (topic, value) {
    if (topic !== VEHICLE_OPERATION_TOPIC) {
      return;
    }

    dispatchDriveCommand(value);
  };
})();
