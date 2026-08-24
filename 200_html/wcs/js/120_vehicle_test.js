$(document).ready(function () {
  const wheelCommand = window.WcsVehicleWheelCommand;
  if (!wheelCommand) {
    console.error("[Vehicle Test] Shared wheel command module is unavailable.");
    return;
  }

  const pendingPublishTimers = {};
  const vehicleDirectionWheelKeys = wheelCommand.WHEEL_KEYS;
  const vehicleAngleSpeedPayloadWheelKeys = wheelCommand.WHEEL_KEYS;
  const vehicleAngleSpeedTopic = wheelCommand.TOPIC;
  const vehicleCommandSpeedScale = {
    0: 0.0,
    1: 1.0,
    2: 0.8,
    3: 0.6,
    4: 0.6,
  };
  const vehicleButtonSelector =
    typeof window.getVehicleDirectionButtonSelector === "function"
      ? window.getVehicleDirectionButtonSelector()
      : "#vehicle-forward, #vehicle-backward, #vehicle-turn-left, #vehicle-turn-right, #vehicle-stop";
  let wheelCommandBlinkTimerIds = [];
  let lastVehicleCurrSpeedMsSent = null;
  let latestVehicleMaxSpeedMps = 27.8;
  let vehicleWheelRadiusReadyLogged = false;
  let lastVehicleWheelRadiusSyncSignature = null;
  let vehicleDirectionCommandIssuedByUser = false;
  window.vehicleSpeedUiManualUntil = 0;
  window.suppressAutoStopUntil = 0;
  window.manualWheelTestActive = false;
  window.manualWheelTestWheel = null;
  window.vehicleDirectionCommandActive = false;

  function getVehicleWheelRadiusByKey(wheelKey) {
    const normalizedWheelKey = String(wheelKey || "")
      .trim()
      .toLowerCase();
    const radius = Number(window.wheelRadiusById?.[normalizedWheelKey]);
    if (!Number.isFinite(radius) || radius <= 0) {
      return null;
    }

    return radius;
  }

  function hasAllVehicleWheelRadii() {
    return vehicleDirectionWheelKeys.every(
      (wheelKey) => getVehicleWheelRadiusByKey(wheelKey) !== null,
    );
  }

  function getVehicleWheelRadiusSignature() {
    if (!hasAllVehicleWheelRadii()) {
      return null;
    }

    return vehicleAngleSpeedPayloadWheelKeys
      .map((wheelKey) => getVehicleWheelRadiusByKey(wheelKey).toFixed(9))
      .join(",");
  }

  function getActiveVehicleCommandContext() {
    if (!vehicleDirectionCommandIssuedByUser) {
      return {
        selectedButtonId: "vehicle-stop",
        selectedCommand: 0,
        selectedSpeedMps: 0.1,
      };
    }

    const selectedButton = $(vehicleButtonSelector).filter(".active").first();
    const selectedButtonId = selectedButton.length
      ? selectedButton.attr("id")
      : "vehicle-stop";
    const selectedCommand =
      typeof window.getVehicleCommandByButtonId === "function"
        ? window.getVehicleCommandByButtonId(selectedButtonId)
        : 0;
    const selectedSpeedMps = Math.max(
      0.1,
      Number.parseFloat($("#vehicleCurrSpeedSlider").val()) || 0.1,
    );

    return {
      selectedButtonId,
      selectedCommand,
      selectedSpeedMps,
    };
  }

  function syncInitialVehicleStopUi() {
    if (vehicleDirectionCommandIssuedByUser) {
      return;
    }

    if (typeof window.syncVehicleDirectionButtons === "function") {
      window.syncVehicleDirectionButtons(0, vehicleButtonSelector);
    } else {
      $(vehicleButtonSelector)
        .removeClass("active text-white")
        .addClass("text-black");
      $("#vehicle-stop")
        .addClass("active text-white")
        .removeClass("text-black");
    }

    if (typeof window.clearVehicleWheelHighlights === "function") {
      window.clearVehicleWheelHighlights();
    }
    window.vehicleDirectionCommandActive = false;
  }

  function syncVehicleWheelAngleSpeedsFromActiveCommand(reason = "sync") {
    const radiusSignature = getVehicleWheelRadiusSignature();
    if (
      radiusSignature === null ||
      radiusSignature === lastVehicleWheelRadiusSyncSignature
    ) {
      return;
    }

    lastVehicleWheelRadiusSyncSignature = radiusSignature;
    const { selectedCommand, selectedSpeedMps } =
      getActiveVehicleCommandContext();
    const isPublished = publishVehicleWheelAngleSpeeds(
      selectedCommand,
      selectedSpeedMps,
    );
    if (isPublished) {
      console.log(
        `[Vehicle Test] 📏 휠 반경 수신 후 각속도 동기화: ${reason}, command=${selectedCommand}, speed=${selectedSpeedMps.toFixed(1)} m/s`,
      );
    }
  }

  function cancelPendingPublish(topic) {
    if (pendingPublishTimers[topic]) {
      clearTimeout(pendingPublishTimers[topic]);
      pendingPublishTimers[topic] = null;
    }
  }

  function updateVehicleSpeedUi(speedMps, isManual = false) {
    const numericMps = Number.parseFloat(speedMps);
    const normalizedMps = Number.isFinite(numericMps)
      ? Math.max(0.1, numericMps)
      : 0.1;
    $("#vehicleCurrSpeedSlider").val(normalizedMps.toFixed(1));

    $('[id="vehicle/linear/speed"]').text(`${normalizedMps.toFixed(1)} m/s`);

    if (isManual) {
      window.vehicleSpeedUiManualUntil = Date.now() + 1500;
    }
  }

  function initializeVehicleSpeedUiFromMqtt(topic, value) {
    const numericMs = Number.parseFloat(value);
    if (!Number.isFinite(numericMs)) {
      return;
    }

    if (topic === "vehicle/linear/speed") {
      const speedMps = Math.max(0.1, numericMs);
      updateVehicleSpeedUi(speedMps, false);
      lastVehicleCurrSpeedMsSent = Number(numericMs.toFixed(2));
      console.log(
        `[Vehicle Test] 📥 초기 UI 동기화(linear): ${speedMps.toFixed(1)} m/s`,
      );
    }
  }

  function updateVehicleCurrSpeedSliderMaxFromMqtt(topic, value) {
    if (topic !== "vehicle/linear/max_speed") {
      return;
    }

    const numericMs = Number.parseFloat(value);
    if (!Number.isFinite(numericMs)) {
      return;
    }

    const normalizedMaxMps = Math.max(0.1, Number(numericMs.toFixed(1)));
    $("#vehicleCurrSpeedSlider").attr("max", normalizedMaxMps.toFixed(1));
    latestVehicleMaxSpeedMps = normalizedMaxMps;

    const currentSpeedMps =
      Number.parseFloat($("#vehicleCurrSpeedSlider").val()) || 0.1;
    updateVehicleSpeedUi(Math.min(currentSpeedMps, normalizedMaxMps), false);
  }

  if (
    typeof window.prcessMqttMessage === "function" &&
    !window.vehicleTestInitMqttHooked
  ) {
    const originalProcessMqtt = window.prcessMqttMessage;
    window.prcessMqttMessage = function (topic, value) {
      originalProcessMqtt(topic, value);
      syncInitialVehicleStopUi();

      if (topic === "vehicle/linear/speed") {
        initializeVehicleSpeedUiFromMqtt(topic, value);
      }

      if (topic === "vehicle/linear/max_speed") {
        updateVehicleCurrSpeedSliderMaxFromMqtt(topic, value);
      }

      if (/^wheel\/(fl|fr|rl|rr)\/radius$/i.test(topic)) {
        if (hasAllVehicleWheelRadii()) {
          if (!vehicleWheelRadiusReadyLogged) {
            console.log("[Vehicle Test] 📏 서버에서 휠 반경 4개 수신 완료");
            vehicleWheelRadiusReadyLogged = true;
          }
          syncVehicleWheelAngleSpeedsFromActiveCommand("wheel-radius-init");
        }
      }
    };
    window.vehicleTestInitMqttHooked = true;
  }

  function publishWhenConnected(
    topic,
    payload,
    retries = 20,
    intervalMs = 250,
  ) {
    if (pendingPublishTimers[topic]) {
      clearTimeout(pendingPublishTimers[topic]);
      pendingPublishTimers[topic] = null;
    }

    const isConnected = Boolean(
      window.mqttClient && window.mqttClient.connected,
    );
    if (isConnected) {
      window.WcsMqtt.sendMQTTMessage(topic, payload, 1);
      return;
    }

    if (retries <= 0) {
      console.warn(`[Vehicle Test] MQTT 미연결로 발행 실패: ${topic}`);
      return;
    }

    pendingPublishTimers[topic] = setTimeout(() => {
      pendingPublishTimers[topic] = null;
      publishWhenConnected(topic, payload, retries - 1, intervalMs);
    }, intervalMs);
  }

  function applyMeasuredVehicleWheelRadii(detail) {
    if (detail?.viewerId !== "vehicle-urdf-viewer") {
      return false;
    }

    const measuredRadii = {};
    for (const wheelKey of vehicleAngleSpeedPayloadWheelKeys) {
      const radius = Number(detail.radiusByKey?.[wheelKey]);
      if (!Number.isFinite(radius) || radius <= 0) {
        return false;
      }
      measuredRadii[wheelKey] = Number(radius.toFixed(9));
    }

    window.wheelRadiusById = window.wheelRadiusById || {};
    Object.assign(window.wheelRadiusById, measuredRadii);
    vehicleAngleSpeedPayloadWheelKeys.forEach((wheelKey) => {
      publishWhenConnected(`wheel/${wheelKey}/radius`, measuredRadii[wheelKey]);
    });

    console.log("[Vehicle Test] 모델 휠 반경 측정 완료:", measuredRadii);
    syncVehicleWheelAngleSpeedsFromActiveCommand("urdf-wheel-radius");
    return true;
  }

  window.addEventListener("wcs:urdf-wheel-radii-ready", function (event) {
    applyMeasuredVehicleWheelRadii(event.detail);
  });

  const loadedVehicleViewer =
    window.urdfViewersById?.["vehicle-urdf-viewer"] || null;
  if (
    typeof loadedVehicleViewer?.measureWheelRadiusMetersByKey === "function"
  ) {
    applyMeasuredVehicleWheelRadii({
      viewerId: "vehicle-urdf-viewer",
      radiusByKey: loadedVehicleViewer.measureWheelRadiusMetersByKey(),
    });
  }

  $('input[name="wheelTestPosition"]').change(function () {
    const selectedWheel = $(this).val();
    console.log(`[Vehicle Test] 🎯 바퀴 선택 변경: ${selectedWheel}`);

    if (typeof window.setVehicleWheelHighlightByKey === "function") {
      window.setVehicleWheelHighlightByKey(selectedWheel.toLowerCase());
    }
  });

  const initialWheel = $('input[name="wheelTestPosition"]:checked')
    .val()
    .toLowerCase();
  if (typeof window.setVehicleWheelHighlightByKey === "function") {
    window.setVehicleWheelHighlightByKey(initialWheel);
  }

  syncInitialVehicleStopUi();

  function applyVehicleDirectionAnimation(command, speedMps) {
    // 휠 애니메이션은 MQTT wheel/angle/speed 토픽으로만 반영한다.
    // 테스트 페이지에서는 방향 명령에 따른 로컬 URDF 구동(추정 애니메이션)을 수행하지 않는다.
    void command;
    void speedMps;
  }

  function buildVehicleWheelAngleSpeedByCommand(command, speedMps) {
    const commandNumber = Number(command);
    const baseSpeedMps = Math.max(0.1, Number(speedMps) || 0.1);
    const speedScale = vehicleCommandSpeedScale[commandNumber] ?? 1.0;

    return wheelCommand.buildAngleSpeedByKey({
      command: commandNumber,
      speedMps: baseSpeedMps,
      speedScale,
      radiusByKey: window.wheelRadiusById,
    });
  }

  function publishVehicleWheelAngleSpeeds(command, speedMps) {
    const wheelAngleSpeedByKey = buildVehicleWheelAngleSpeedByCommand(
      command,
      speedMps,
    );

    if (!hasAllVehicleWheelRadii()) {
      console.warn(
        "[Vehicle Test] 휠 반경 미수신 상태라 wheel/*/angle/speed 발행을 보류합니다.",
      );
      return false;
    }

    const payload = wheelCommand.serializeAngleSpeeds(wheelAngleSpeedByKey);
    if (payload === null) {
      return false;
    }
    publishWhenConnected(vehicleAngleSpeedTopic, payload);

    return true;
  }

  function publishVehicleStopCommandOnLoad() {
    const selectedCommand = 0;
    const selectedSpeedMps = 0.1;
    const stopPayload = wheelCommand.serializeAngleSpeeds({
      fr: 0,
      fl: 0,
      rr: 0,
      rl: 0,
    });

    publishWhenConnected(vehicleAngleSpeedTopic, stopPayload);
    syncInitialVehicleStopUi();
    applyVehicleCommandWheelHighlight(selectedCommand);
    applyVehicleDirectionAnimation(selectedCommand, selectedSpeedMps);
    console.log(
      `[Vehicle Test] 📨 초기 정지 각속도 발행: ${vehicleAngleSpeedTopic} = ${stopPayload}`,
    );
  }

  publishVehicleStopCommandOnLoad();

  function applyVehicleCommandWheelHighlight(command) {
    const commandNumber = Number(command);
    const wheelKeys =
      typeof window.getVehicleHighlightWheelKeysByCommand === "function"
        ? window.getVehicleHighlightWheelKeysByCommand(commandNumber)
        : [];

    if (wheelKeys.length === 0) {
      if (typeof window.clearVehicleWheelHighlights === "function") {
        window.clearVehicleWheelHighlights();
      }
      return;
    }

    if (typeof window.setVehicleWheelHighlightByKeys === "function") {
      window.setVehicleWheelHighlightByKeys(wheelKeys);
    }
  }

  $("#test-clockwise, #test-counterclockwise, #test-stop")
    .removeClass("active btn-secondary text-white")
    .addClass("btn-outline-secondary text-black");
  $("#test-stop")
    .removeClass("btn-outline-secondary text-black")
    .addClass("active btn-secondary text-white");

  function setWheelTestButtonActive(buttonElement) {
    $("#test-clockwise, #test-counterclockwise, #test-stop")
      .removeClass("active btn-secondary text-white")
      .addClass("btn-outline-secondary text-black");

    buttonElement
      .removeClass("btn-outline-secondary text-black")
      .addClass("active btn-secondary text-white");
  }

  function clearWheelCommandBlinkTimers() {
    wheelCommandBlinkTimerIds.forEach((timerId) => clearTimeout(timerId));
    wheelCommandBlinkTimerIds = [];
  }

  function sendWheelCommand(command, buttonElement, actionName, icon) {
    const selectedWheel = $('input[name="wheelTestPosition"]:checked')
      .val()
      .toLowerCase();
    const topic = `wheel/${selectedWheel}/angle/speed`;
    const angularSpeedAbs =
      Number.parseFloat($("#wheelTestSpeedSlider").val()) || 0;
    window.suppressAutoStopUntil = Date.now() + 1500;
    window.manualWheelTestActive =
      Number(command) === 1 || Number(command) === 2;
    window.manualWheelTestWheel = window.manualWheelTestActive
      ? selectedWheel
      : null;

    if (typeof window.setVehicleWheelHighlightByKey === "function") {
      window.setVehicleWheelHighlightByKey(selectedWheel);
    }

    setWheelTestButtonActive(buttonElement);

    const signedAngularSpeed =
      Number(command) === 0
        ? 0
        : Number(command) === 2
          ? -angularSpeedAbs
          : angularSpeedAbs;
    cancelPendingPublish(topic);
    window.WcsMqtt.sendMQTTMessage(topic, signedAngularSpeed, 1);

    console.log(
      `[Vehicle Test] ${icon} ${selectedWheel.toUpperCase()} 바퀴 ${actionName} 속도 전송: ${topic} = ${signedAngularSpeed} rad/s`,
    );

    clearWheelCommandBlinkTimers();
    if (Number(command) === 0) {
      return;
    }

    // Blink by toggling button classes 2 times
    for (let i = 0; i < 4; i++) {
      const timerId = setTimeout(
        () => {
          if (i % 2 === 0) {
            buttonElement
              .removeClass("active btn-secondary text-white")
              .addClass("btn-outline-secondary text-black");
          } else {
            buttonElement
              .removeClass("btn-outline-secondary text-black")
              .addClass("active btn-secondary text-white");
          }
        },
        (i + 1) * 150,
      );
      wheelCommandBlinkTimerIds.push(timerId);
    }
  }

  function sendVehicleCommand(command, buttonElement, actionName, icon) {
    vehicleDirectionCommandIssuedByUser = true;
    const commandSpeedMps = Math.max(
      0.1,
      Number.parseFloat($("#vehicleCurrSpeedSlider").val()) || 0.1,
    );
    const roundedSpeedMps = Number(commandSpeedMps.toFixed(1));
    window.suppressAutoStopUntil = Date.now() + 1500;
    window.manualWheelTestActive = false;
    window.manualWheelTestWheel = null;
    window.vehicleDirectionCommandActive =
      Number(command) >= 1 && Number(command) <= 4;

    if (Number(command) === 0) {
      clearWheelCommandBlinkTimers();
      setWheelTestButtonActive($("#test-stop"));
    }

    $(vehicleButtonSelector)
      .removeClass("active text-white")
      .addClass("text-black");

    buttonElement.addClass("active text-white").removeClass("text-black");

    applyVehicleCommandWheelHighlight(command);
    applyVehicleDirectionAnimation(command, commandSpeedMps);

    publishVehicleWheelAngleSpeeds(command, commandSpeedMps);
    lastVehicleCurrSpeedMsSent = roundedSpeedMps;
    console.log(
      `[Vehicle Test] ${icon} 차량 ${actionName} 휠 각속도 전송: command=${command}, speed=${roundedSpeedMps.toFixed(1)} m/s`,
    );

    // Blink by toggling button classes 2 times
    for (let i = 0; i < 4; i++) {
      setTimeout(
        () => {
          if (i % 2 === 0) {
            buttonElement
              .removeClass("active text-white")
              .addClass("text-black");
          } else {
            buttonElement
              .addClass("active text-white")
              .removeClass("text-black");
          }
        },
        (i + 1) * 150,
      );
    }
  }

  $("#test-clockwise").click(function () {
    sendWheelCommand(1, $(this), "정회전", "⏰");
  });

  $("#test-counterclockwise").click(function () {
    sendWheelCommand(2, $(this), "역회전", "↩️");
  });

  $("#test-stop").click(function (event) {
    event.preventDefault();
    const $stopButton = $(this);
    clearWheelCommandBlinkTimers();
    setWheelTestButtonActive($stopButton);
    sendWheelCommand(0, $stopButton, "정지", "⏹️");
    setWheelTestButtonActive($stopButton);
  });

  $("#wheelTestSpeedSlider").on("input change", function () {
    const speedRad = Number.parseFloat($(this).val()) || 0;
    const rpm = (speedRad * 60) / (2 * Math.PI);
    $("#wheel-test-speed-value").text(`${Math.round(rpm)} rpm`);
  });

  $("#vehicle-forward").click(function () {
    sendVehicleCommand(1, $(this), "전진", "⬆️");
  });

  $("#vehicle-backward").click(function () {
    sendVehicleCommand(2, $(this), "후진", "⬇️");
  });

  $("#vehicle-turn-left").click(function () {
    sendVehicleCommand(3, $(this), "좌회전", "⬅️");
  });

  $("#vehicle-turn-right").click(function () {
    sendVehicleCommand(4, $(this), "우회전", "➡️");
  });

  $("#vehicle-stop").click(function () {
    sendVehicleCommand(0, $(this), "정지", "⏹️");
  });

  $("#vehicleCurrSpeedSlider").on("input change", function () {
    const speedMps = Math.max(0.1, Number.parseFloat($(this).val()) || 0.1);

    updateVehicleSpeedUi(speedMps, true);

    const selectedButton = $(vehicleButtonSelector).filter(".active").first();
    const selectedButtonId = selectedButton.length
      ? selectedButton.attr("id")
      : "vehicle-stop";
    const selectedCommand =
      typeof window.getVehicleCommandByButtonId === "function"
        ? window.getVehicleCommandByButtonId(selectedButtonId)
        : 0;
    applyVehicleDirectionAnimation(selectedCommand, speedMps);
    publishVehicleWheelAngleSpeeds(selectedCommand, speedMps);

    console.log(
      `[Vehicle Test] 🚀 휠 각속도 갱신 - ${speedMps.toFixed(1)} m/s, command=${selectedCommand}`,
    );
  });

  window.addEventListener("wcs:vehicle-direction-update", function (event) {
    const commandValue = Number.parseInt(event?.detail?.value, 10);
    if (!Number.isFinite(commandValue)) {
      return;
    }

    const latestSpeedMs = Number(window.latestVehicleLinearSpeedMs);
    const fallbackSpeedMps = Math.max(
      0.1,
      Number.parseFloat($("#vehicleCurrSpeedSlider").val()) || 0.1,
    );
    const speedMps = Number.isFinite(latestSpeedMs)
      ? Math.max(0.1, latestSpeedMs)
      : fallbackSpeedMps;

    applyVehicleDirectionAnimation(commandValue, speedMps);
  });
});
