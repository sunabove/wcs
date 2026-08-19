$(document).ready(function () {
  const pendingPublishTimers = {};
  const vehicleDirectionWheelKeys = ["fl", "fr", "rl", "rr"];
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
  let lastVehicleCurrSpeedMsSent = null;
  let lastVehicleDirectionCommandSent = null;
  let latestVehicleMaxSpeedKmh = 100.0;
  let vehicleWheelRadiusReadyLogged = false;
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

  function getActiveVehicleCommandContext() {
    const selectedButton = $(vehicleButtonSelector).filter(".active").first();
    const selectedButtonId = selectedButton.length
      ? selectedButton.attr("id")
      : "vehicle-stop";
    const selectedCommand =
      typeof window.getVehicleCommandByButtonId === "function"
        ? window.getVehicleCommandByButtonId(selectedButtonId)
        : 0;
    const selectedSpeedKmh =
      Number.parseFloat($("#vehicleCurrSpeedSlider").val()) || 0;

    return {
      selectedButtonId,
      selectedCommand,
      selectedSpeedKmh,
    };
  }

  function syncVehicleWheelAngleSpeedsFromActiveCommand(reason = "sync") {
    const { selectedCommand, selectedSpeedKmh } =
      getActiveVehicleCommandContext();
    const isPublished = publishVehicleWheelAngleSpeeds(
      selectedCommand,
      selectedSpeedKmh,
    );
    if (isPublished) {
      console.log(
        `[Vehicle Test] 📏 휠 반경 수신 후 각속도 동기화: ${reason}, command=${selectedCommand}, speed=${selectedSpeedKmh.toFixed(1)} Km/h`,
      );
    }
  }

  function cancelPendingPublish(topic) {
    if (pendingPublishTimers[topic]) {
      clearTimeout(pendingPublishTimers[topic]);
      pendingPublishTimers[topic] = null;
    }
  }

  function updateVehicleSpeedUi(speedKmh, isManual = false) {
    const numericKmh = Number.parseFloat(speedKmh);
    const normalizedKmh = Number.isFinite(numericKmh)
      ? Math.max(0, numericKmh)
      : 0;
    $("#vehicleCurrSpeedSlider").val(normalizedKmh);

    const sliderMaxKmh = Number.parseFloat(
      $("#vehicleCurrSpeedSlider").attr("max"),
    );
    const effectiveMaxKmh = Number.isFinite(sliderMaxKmh)
      ? Math.max(0.1, sliderMaxKmh)
      : Math.max(0.1, latestVehicleMaxSpeedKmh);
    $('[id="vehicle/linear/speed"]').text(
      `${Math.round(normalizedKmh)}/${Math.round(effectiveMaxKmh)} Km/h`,
    );

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
      const speedKmh = Math.max(0, numericMs * 3.6);
      updateVehicleSpeedUi(speedKmh, false);
      lastVehicleCurrSpeedMsSent = Number(numericMs.toFixed(2));
      console.log(
        `[Vehicle Test] 📥 초기 UI 동기화(linear): ${speedKmh.toFixed(1)} Km/h`,
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

    const maxKmh = Math.max(0, numericMs * 3.6);
    const normalizedMaxKmh = Number(maxKmh.toFixed(1));
    $("#vehicleCurrSpeedSlider").attr("max", normalizedMaxKmh);
    latestVehicleMaxSpeedKmh = normalizedMaxKmh;

    const currKmh = Number.parseFloat($("#vehicleCurrSpeedSlider").val()) || 0;
    updateVehicleSpeedUi(currKmh, false);
  }

  if (
    typeof window.prcessMqttMessage === "function" &&
    !window.vehicleTestInitMqttHooked
  ) {
    const originalProcessMqtt = window.prcessMqttMessage;
    window.prcessMqttMessage = function (topic, value) {
      originalProcessMqtt(topic, value);

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

  $(vehicleButtonSelector)
    .removeClass("active text-white")
    .addClass("text-black");
  $("#vehicle-stop").addClass("active text-white").removeClass("text-black");

  function applyVehicleDirectionAnimation(command, speedKmh) {
    // 휠 애니메이션은 서버가 발행한 wheel/*/angle/speed 토픽으로만 반영한다.
    // 테스트 페이지에서는 방향 명령에 따른 로컬 URDF 구동(추정 애니메이션)을 수행하지 않는다.
    void command;
    void speedKmh;
  }

  function buildVehicleWheelAngleSpeedByCommand(command, speedKmh) {
    const commandNumber = Number(command);
    const baseSpeedMs = Math.max(0, Number(speedKmh) || 0) / 3.6;
    const speedScale = vehicleCommandSpeedScale[commandNumber] ?? 1.0;
    const effectiveSpeedMs = baseSpeedMs * speedScale;
    const inPlaceTurn = commandNumber === 3 || commandNumber === 4;

    return vehicleDirectionWheelKeys.reduce((accumulator, wheelKey) => {
      const wheelRadiusM = getVehicleWheelRadiusByKey(wheelKey);
      if (wheelRadiusM === null) {
        accumulator[wheelKey] = null;
        return accumulator;
      }

      const isLeftWheel = wheelKey === "fl" || wheelKey === "rl";
      let signedSpeedMs = 0;

      switch (commandNumber) {
        case 1:
          signedSpeedMs = effectiveSpeedMs;
          break;
        case 2:
          signedSpeedMs = -effectiveSpeedMs;
          break;
        case 3:
          signedSpeedMs = isLeftWheel ? -effectiveSpeedMs : effectiveSpeedMs;
          break;
        case 4:
          signedSpeedMs = isLeftWheel ? effectiveSpeedMs : -effectiveSpeedMs;
          break;
        case 0:
        default:
          signedSpeedMs = 0;
          break;
      }

      if (!inPlaceTurn && commandNumber !== 0) {
        signedSpeedMs =
          commandNumber === 2
            ? -Math.abs(signedSpeedMs)
            : Math.abs(signedSpeedMs);
      }

      accumulator[wheelKey] = Number((signedSpeedMs / wheelRadiusM).toFixed(3));
      return accumulator;
    }, {});
  }

  function publishVehicleWheelAngleSpeeds(command, speedKmh) {
    const wheelAngleSpeedByKey = buildVehicleWheelAngleSpeedByCommand(
      command,
      speedKmh,
    );

    if (!hasAllVehicleWheelRadii()) {
      console.warn(
        "[Vehicle Test] 휠 반경 미수신 상태라 wheel/*/angle/speed 발행을 보류합니다.",
      );
      return false;
    }

    Object.entries(wheelAngleSpeedByKey).forEach(([wheelKey, angleSpeed]) => {
      publishWhenConnected(`wheel/${wheelKey}/angle/speed`, angleSpeed);
    });

    return true;
  }

  function publishSelectedVehicleCommandOnLoad() {
    const { selectedButtonId, selectedCommand, selectedSpeedKmh } =
      getActiveVehicleCommandContext();

    publishWhenConnected("vehicle/operation/command", selectedCommand);
    publishVehicleWheelAngleSpeeds(selectedCommand, selectedSpeedKmh);
    applyVehicleCommandWheelHighlight(selectedCommand);
    applyVehicleDirectionAnimation(selectedCommand, selectedSpeedKmh);
    console.log(
      `[Vehicle Test] 📨 초기 방향 제어 명령 발행: vehicle/operation/command = ${selectedCommand} (${selectedButtonId})`,
    );

    // Blink the selected button by toggling classes 2 times
    const selectedButton = $(`#${selectedButtonId}`);
    if (selectedButton.length) {
      for (let i = 0; i < 4; i++) {
        setTimeout(
          () => {
            if (i % 2 === 0) {
              selectedButton
                .removeClass("active text-white")
                .addClass("text-black");
            } else {
              selectedButton
                .addClass("active text-white")
                .removeClass("text-black");
            }
          },
          (i + 1) * 150,
        );
      }
    }
  }

  publishSelectedVehicleCommandOnLoad();

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

  function sendWheelCommand(command, buttonElement, actionName, icon) {
    const selectedWheel = $('input[name="wheelTestPosition"]:checked')
      .val()
      .toLowerCase();
    const topic = `wheel/${selectedWheel}/operation/command`;
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

    $("#test-clockwise, #test-counterclockwise, #test-stop")
      .removeClass("active btn-secondary text-white")
      .addClass("btn-outline-secondary text-black");

    buttonElement
      .removeClass("btn-outline-secondary text-black")
      .addClass("active btn-secondary text-white");

    window.WcsMqtt.sendMQTTMessage(topic, command, 1);

    if (Number(command) === 1 || Number(command) === 2) {
      const signedAngularSpeed =
        Number(command) === 2 ? -angularSpeedAbs : angularSpeedAbs;
      window.WcsMqtt.sendMQTTMessage(
        `wheel/${selectedWheel}/angle/speed`,
        signedAngularSpeed,
        1,
      );
    } else if (Number(command) === 0) {
      vehicleDirectionWheelKeys.forEach((wheelKey) => {
        window.WcsMqtt.sendMQTTMessage(`wheel/${wheelKey}/angle/speed`, "0", 1);
      });
    }

    console.log(
      `[Vehicle Test] ${icon} ${selectedWheel.toUpperCase()} 바퀴 ${actionName} 명령 전송: ${topic} = ${command}`,
    );

    // Blink by toggling button classes 2 times
    for (let i = 0; i < 4; i++) {
      setTimeout(
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
    }
  }

  function sendVehicleCommand(command, buttonElement, actionName, icon) {
    const topic = "vehicle/operation/command";
    const speedTopic = "vehicle/linear/speed";
    const sliderSpeedKmh =
      Number.parseFloat($("#vehicleCurrSpeedSlider").val()) || 0;
    const sliderMaxKmh = Number.parseFloat(
      $("#vehicleCurrSpeedSlider").attr("max"),
    );
    const effectiveMaxKmh = Number.isFinite(sliderMaxKmh)
      ? Math.max(0, sliderMaxKmh)
      : Math.max(0, latestVehicleMaxSpeedKmh);

    let commandSpeedKmh = sliderSpeedKmh;
    if (Number(command) !== 0 && commandSpeedKmh <= 0 && effectiveMaxKmh > 0) {
      commandSpeedKmh = Number((effectiveMaxKmh * 0.1).toFixed(1));
      updateVehicleSpeedUi(commandSpeedKmh, true);
      console.log(
        `[Vehicle Test] ⚙️ 현재 속도 0 감지: 최고 속도의 10%로 보정 (${commandSpeedKmh.toFixed(1)} Km/h)`,
      );
    }

    const speedMs = commandSpeedKmh / 3.6;
    const roundedSpeedMs = Number(speedMs.toFixed(2));
    const sameCommand =
      Number(lastVehicleDirectionCommandSent) === Number(command);
    const sameSpeed =
      lastVehicleCurrSpeedMsSent !== null &&
      Math.abs(roundedSpeedMs - lastVehicleCurrSpeedMsSent) < 0.0001;
    window.suppressAutoStopUntil = Date.now() + 1500;
    window.manualWheelTestActive = false;
    window.manualWheelTestWheel = null;
    window.vehicleDirectionCommandActive =
      Number(command) >= 1 && Number(command) <= 4;

    $(vehicleButtonSelector)
      .removeClass("active text-white")
      .addClass("text-black");

    buttonElement.addClass("active text-white").removeClass("text-black");

    applyVehicleCommandWheelHighlight(command);
    applyVehicleDirectionAnimation(command, commandSpeedKmh);

    if (sameCommand && sameSpeed) {
      console.log(
        `[Vehicle Test] 중복 방향 명령 스킵: ${topic} = ${command}, ${speedTopic} = ${roundedSpeedMs}`,
      );
      return;
    }

    publishWhenConnected(speedTopic, roundedSpeedMs);
    lastVehicleCurrSpeedMsSent = roundedSpeedMs;

    publishWhenConnected(topic, command);
    publishVehicleWheelAngleSpeeds(command, commandSpeedKmh);
    lastVehicleDirectionCommandSent = Number(command);
    console.log(
      `[Vehicle Test] ${icon} 차량 ${actionName} 명령 전송: ${topic} = ${command}, ${speedTopic} = ${roundedSpeedMs}`,
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

  $("#test-stop").click(function () {
    sendWheelCommand(0, $(this), "정지", "⏹️");
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

  $("#vehicleCurrSpeedSlider").on("input change", function (event) {
    const speedKmh = Number.parseFloat($(this).val()) || 0;
    const speedMs = speedKmh / 3.6;
    const roundedSpeedMs = Number(speedMs.toFixed(2));

    updateVehicleSpeedUi(speedKmh, true);

    const isSameSpeed =
      lastVehicleCurrSpeedMsSent !== null &&
      Math.abs(roundedSpeedMs - lastVehicleCurrSpeedMsSent) < 0.0001;
    const isFinalChange = event.type === "change";
    if (isSameSpeed && !isFinalChange) {
      return;
    }

    const topic = "vehicle/linear/speed";
    sendMQTTMessage(topic, roundedSpeedMs, 1);
    lastVehicleCurrSpeedMsSent = roundedSpeedMs;

    const selectedButton = $(vehicleButtonSelector).filter(".active").first();
    const selectedButtonId = selectedButton.length
      ? selectedButton.attr("id")
      : "vehicle-stop";
    const selectedCommand =
      typeof window.getVehicleCommandByButtonId === "function"
        ? window.getVehicleCommandByButtonId(selectedButtonId)
        : 0;
    applyVehicleDirectionAnimation(selectedCommand, speedKmh);
    publishWhenConnected("vehicle/operation/command", selectedCommand);
    publishVehicleWheelAngleSpeeds(selectedCommand, speedKmh);

    console.log(
      `[Vehicle Test] 🚀 현재 속도 설정 - ${speedKmh.toFixed(1)} Km/h (${roundedSpeedMs.toFixed(2)} m/s): ${topic} = ${roundedSpeedMs}`,
    );
  });

  window.addEventListener("wcs:vehicle-direction-update", function (event) {
    const commandValue = Number.parseInt(event?.detail?.value, 10);
    if (!Number.isFinite(commandValue)) {
      return;
    }

    const latestSpeedMs = Number(window.latestVehicleLinearSpeedMs);
    const fallbackSpeedKmh =
      Number.parseFloat($("#vehicleCurrSpeedSlider").val()) || 0;
    const speedKmh = Number.isFinite(latestSpeedMs)
      ? Math.max(0, latestSpeedMs * 3.6)
      : fallbackSpeedKmh;

    applyVehicleDirectionAnimation(commandValue, speedKmh);
  });
});
