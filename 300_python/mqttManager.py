import json
import os
import platform
import signal
import sys
import time
from enum import IntEnum

import paho.mqtt.client as mqtt

class OperationCommand(IntEnum):
    STOP = 0
    FORWARD = 1
    REVERSE = 2
    TURN_LEFT = 3
    TURN_RIGHT = 4


class VehicleExecState(IntEnum):
    STOP = 0
    RUN = 1


class SurfaceState(IntEnum):
    ASPHALT = 0


class SurfaceObstacle(IntEnum):
    NONE = 0


WHEEL_IDS = ["fl", "fr", "rr", "rl"]

SENSOR_DEFINITIONS = [
    {"id": "ToF", "count": 4, "enabled": True},
    {"id": "IMU", "count": 5, "enabled": True},
    {"id": "Current", "count": 4, "enabled": True},
    {"id": "Camera", "count": 1, "enabled": True},
    {"id": "Lidar", "count": 1, "enabled": True},
]

WHEEL_RADIUS_M = 0.32

WHEEL_ID_MAPPING = {
    "fl": 1,
    "fr": 2,
    "rr": 3,
    "rl": 4,
}

SENSOR_COUNT_TOPIC_TEMPLATE = "sensor/{sensor_id}/count"
WHEEL_ID_TOPIC_TEMPLATE = "wheel/{wheel_str_id}/id"
WHEEL_RADIUS_TOPIC_TEMPLATE = "wheel/{wheel_str_id}/radius"

INITIAL_CONNECT_TOPIC_SPECS = (
    ("vehicle/linear/speed", lambda sim: round(sim.linear_speed, 3), "VEHICLE"),
    ("vehicle/linear/max_speed", lambda sim: round(sim.max_speed, 2), "VEHICLE"),
    ("vehicle/operation/command", lambda sim: sim.command.value, "VEHICLE"),
    ("vehicle/operation/state", lambda sim: sim.exec_state.value, "VEHICLE"),
    ("vehicle/surface/state", lambda sim: sim.surface_state.value, "SURFACE"),
    ("vehicle/surface/obstacle", lambda sim: sim.surface_obstacle.value, "OBSTACLE"),
    ("vehicle/road/roll_angle", lambda sim: sim.road_roll_angle, "ROAD"),
    ("vehicle/road/pitch_angle", lambda sim: sim.road_pitch_angle, "ROAD"),
    ("vehicle/current_video/file_name", lambda sim: sim.current_video_file_name, "VIDEO"),
)

_shutdown_flag = False


def iter_sensor_definitions_in_order():
    for sensor_def in SENSOR_DEFINITIONS:
        yield sensor_def


class MqttManager:
    def __init__(self, broker="localhost", port=1883):
        try:
            self.client = mqtt.Client(
                callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                client_id="wcs_manager",
            )
            print("[MQTT] Using paho-mqtt 2.0+ with callback API version 2")
        except (TypeError, AttributeError):
            try:
                self.client = mqtt.Client(client_id="wcs_manager")
                print("[MQTT] Using paho-mqtt 1.6+ compatibility mode")
            except TypeError:
                self.client = mqtt.Client("wcs_manager")
                print("[MQTT] Using paho-mqtt legacy compatibility mode")

        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message

        self.broker = broker
        self.port = port

        # 초기 접속 시 전달할 기준 정보
        self.linear_speed = 0.0
        self.max_speed = 13.9
        self.command = OperationCommand.FORWARD
        self.exec_state = VehicleExecState.RUN
        self.surface_state = SurfaceState.ASPHALT
        self.surface_obstacle = SurfaceObstacle.NONE
        self.road_roll_angle = 0.0
        self.road_pitch_angle = 0.0
        self.current_video_file_name = ""

        # 선택적 외부 주입 데이터
        self.vehicle_data = {}
        self.wheel_data = {}

        self.publish_count = 0
        self.running = True
        self.script_path = os.path.abspath(__file__)
        self.last_modified = os.path.getmtime(self.script_path) if os.path.exists(self.script_path) else 0

    def _on_connect(self, client, _userdata, _flags, reason_code, _properties=None):
        print("MQTT Connected:", reason_code)
        client.subscribe("client/connect")
        print("[MQTT] Subscribed to client/connect")

    def _on_message(self, _client, _userdata, msg):
        try:
            topic = msg.topic
            payload = msg.payload.decode("utf-8")
            print(f"[MQTT] Received: {topic} -> {payload}")

            if topic == "client/connect":
                print("[CONNECT] Client connection detected - Publishing initial settings...")
                self._publish_settings_on_client_connect(payload)
        except Exception as e:
            print(f"[MQTT] Message processing error: {e}")

    def _extract_client_connect_id(self, payload):
        try:
            connect_info = json.loads(str(payload))
        except (TypeError, ValueError, json.JSONDecodeError):
            return None

        client_id = str(connect_info.get("client_id") or "").strip()
        return client_id or None

    def _publish_settings_on_client_connect(self, client_connect_payload=None):
        try:
            client_id = self._extract_client_connect_id(client_connect_payload)
            print(f"[SETTINGS] Publishing initial settings (client_id={client_id})")

            for sensor_def in iter_sensor_definitions_in_order():
                sensor_id = sensor_def["id"]
                self._publish(SENSOR_COUNT_TOPIC_TEMPLATE.format(sensor_id=sensor_id), sensor_def["count"])

            # 센서 인터페이스 기준값
            obstacle_value = int(self.surface_obstacle.value)
            for sensor_def in iter_sensor_definitions_in_order():
                sensor_id = sensor_def["id"]
                sensor_enabled = bool(sensor_def["enabled"])
                supports_obstacle = sensor_id in ("ToF", "Lidar", "Camera")
                for index in range(sensor_def["count"]):
                    topic_prefix = f"sensor/{sensor_id}/{index}"
                    sensor_state = 1 if sensor_enabled else 0
                    sensor_value = obstacle_value if sensor_id == "Camera" else 0
                    sensor_obstacle = obstacle_value if (sensor_enabled and supports_obstacle) else SurfaceObstacle.NONE.value
                    obstacle_confidence = 0.8 if (sensor_enabled and supports_obstacle and obstacle_value != SurfaceObstacle.NONE.value) else 0.0

                    self._publish(f"{topic_prefix}/state", sensor_state)
                    self._publish(f"{topic_prefix}/value", sensor_value)
                    self._publish(f"{topic_prefix}/obstacle", sensor_obstacle)
                    self._publish(f"{topic_prefix}/obstacle/confidence", obstacle_confidence)

            self._publish("obstacle", obstacle_value)
            self._publish("obstacle/sensors", [])
            self._publish("obstacle/confidence", 0.0 if obstacle_value == SurfaceObstacle.NONE.value else 0.8)

            if self.vehicle_data:
                for key, value in self.vehicle_data.items():
                    self._publish(f"vehicle/{key}", value)

            if self.wheel_data:
                for wheel_id in range(1, 5):
                    for key, value in self.wheel_data.items():
                        self._publish(f"wheel/{wheel_id}/{key}", value)

            for wheel_str_id, wheel_num_id in WHEEL_ID_MAPPING.items():
                self._publish(WHEEL_ID_TOPIC_TEMPLATE.format(wheel_str_id=wheel_str_id), wheel_num_id)

            for wheel_str_id in WHEEL_IDS:
                self._publish(WHEEL_RADIUS_TOPIC_TEMPLATE.format(wheel_str_id=wheel_str_id), WHEEL_RADIUS_M)

            for topic, payload_resolver, log_tag in INITIAL_CONNECT_TOPIC_SPECS:
                payload = payload_resolver(self)
                self._publish(topic, payload)
                print(f"[{log_tag}] Published {topic} -> {payload}")

            print("[SETTINGS] Initial settings published successfully")
        except Exception as e:
            print(f"[SETTINGS] Error publishing settings: {e}")

    def _normalize_obstacle_sensor_payload(self, value):
        if value is None:
            return []
        if isinstance(value, (list, tuple)):
            return list(value)
        if isinstance(value, dict):
            return [value]
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return []
            try:
                decoded = json.loads(text)
                return self._normalize_obstacle_sensor_payload(decoded)
            except (TypeError, ValueError, json.JSONDecodeError):
                return [text]
        return [value]

    def _publish(self, topic, value):
        if topic == "obstacle/sensors":
            payload = json.dumps(self._normalize_obstacle_sensor_payload(value), ensure_ascii=False)
        else:
            payload = str(value)

        self.client.publish(topic, payload, retain=True)
        self.publish_count += 1
        print(f"[{self.publish_count}] [PUB] {topic} -> {payload}")

    def _check_file_changes(self):
        try:
            if os.path.exists(self.script_path):
                current_modified = os.path.getmtime(self.script_path)
                if current_modified > self.last_modified:
                    print(f"[MONITOR] 파일 변경 감지: {self.script_path}")
                    self._cleanup()
                    sys.exit(0)
        except Exception as e:
            print(f"[MONITOR] 파일 모니터링 오류: {e}")

    def _cleanup(self):
        try:
            if self.client:
                print("[CLEANUP] MQTT 클라이언트 연결 종료")
                self.client.loop_stop()
                self.client.disconnect()
        except Exception as e:
            print(f"[CLEANUP] 정리 중 오류: {e}")

    def run(self):
        self.client.connect(self.broker, self.port, 60)
        self.client.loop_start()

        print(f"[MANAGER] 시작 - PID: {os.getpid()}")
        print(f"[MONITOR] 파일 모니터링: {self.script_path}")
        print("[INFO] client/connect 기반 초기 정보 발행 전용 모드")
        print("-" * 70)

        last_monitor_check_at = 0.0
        while self.running and not _shutdown_flag:
            try:
                now = time.time()
                if now - last_monitor_check_at >= 10.0:
                    self._check_file_changes()
                    last_monitor_check_at = now
                time.sleep(1)
            except KeyboardInterrupt:
                print("\n[MANAGER] 사용자 중단 요청")
                break
            except Exception as e:
                print(f"[MANAGER] 실행 오류: {e}")
                time.sleep(1)

        self._cleanup()
        print("[MANAGER] 종료")


def signal_handler(signum, _frame):
    global _shutdown_flag
    print(f"\n[SIGNAL] Signal {signum} received - Graceful shutdown...")
    _shutdown_flag = True


def setup_signal_handlers():
    try:
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
        if hasattr(signal, "SIGHUP"):
            signal.signal(signal.SIGHUP, signal_handler)
        print("[SIGNAL] Signal handlers registered")
    except Exception as e:
        print(f"[SIGNAL] Signal handler setup error: {e}")


def main():
    global _shutdown_flag
    setup_signal_handlers()

    try:
        _shutdown_flag = False
        broker = "localhost"
        if platform.system() == "Windows":
            broker = "orangepi6plus"
        port = 1883

        print("=" * 50)
        print("Starting WCS MQTT Initial-Connect Publisher")
        print(f"OS: {platform.system()}")
        print(f"MQTT Broker: {broker}:{port}")
        print(f"PID: {os.getpid()}")
        print("[MODE] client/connect 기반 초기 정보 발행 전용")
        print("=" * 50)

        manager = MqttManager(broker, port)
        manager.run()
        sys.exit(0)
    except KeyboardInterrupt:
        print("\n[MAIN] 사용자 중단 - 서비스 정지")
        sys.exit(0)
    except Exception as e:
        print(f"[MAIN] 오류 발생: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
