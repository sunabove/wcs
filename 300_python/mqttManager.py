import json
import os
import platform
import signal
import sys
import time
from enum import IntEnum

import paho.mqtt.client as mqtt


class VehicleExecState(IntEnum):
    STOP = 0
    RUN = 1


class SurfaceState(IntEnum):
    ASPHALT = 0


class SurfaceObstacle(IntEnum):
    NONE = 0
    DANCHA = 1
    POT_HOLE = 2


class MqttConfig:
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
    SENSOR_ENABLED_TOPIC_TEMPLATE = "sensor/{sensor_id}/enabled"

    WHEEL_PUBLISH_SPECS = [
        ("wheel/{wheel_str_id}/id",           lambda mgr, wid: MqttConfig.WHEEL_ID_MAPPING[wid]),
        ("wheel/{wheel_str_id}/radius",       lambda mgr, wid: MqttConfig.WHEEL_RADIUS_M),
        ("wheel/{wheel_str_id}/angle/speed",  lambda mgr, wid: float(mgr.wheel_rpm_by_id.get(wid, 0.0))),
        ("wheel/{wheel_str_id}/linear/speed", lambda mgr, wid: float(mgr.wheel_speed_by_id.get(wid, 0.0))),
        ("wheel/{wheel_str_id}/power",        lambda mgr, wid: float(mgr.wheel_power_by_id.get(wid, 0.0))),
        ("wheel/{wheel_str_id}/pid/p",        lambda mgr, wid: float(mgr.wheel_pid_by_id.get(wid, {}).get("p", 0.0))),
        ("wheel/{wheel_str_id}/pid/i",        lambda mgr, wid: float(mgr.wheel_pid_by_id.get(wid, {}).get("i", 0.0))),
        ("wheel/{wheel_str_id}/pid/d",        lambda mgr, wid: float(mgr.wheel_pid_by_id.get(wid, {}).get("d", 0.0))),
        ("wheel/{wheel_str_id}/tof/distance", lambda mgr, wid: float(mgr.wheel_tof_distance_by_id.get(wid, 0.0))),
        ("wheel/{wheel_str_id}/axis/angle",   lambda mgr, wid: float(mgr.wheel_axis_angle_by_id.get(wid, 0.0))),
    ]

    INITIAL_CONNECT_TOPIC_SPECS = (
        ("vehicle/battery/remain_amount", lambda mgr: round(mgr.battery_remain_amount, 1), "BATTERY"),
        ("vehicle/drive/available_time", lambda mgr: int(mgr.drive_available_time), "DRIVE"),
        ("vehicle/drive/elapsed_time", lambda mgr: int(mgr.drive_elapsed_time), "DRIVE"),
        ("vehicle/drive/total_distance", lambda mgr: int(mgr.drive_total_distance), "DRIVE"),
        ("vehicle/linear/max_speed", lambda mgr: round(mgr.max_speed, 2), "VEHICLE"),
        ("vehicle/linear/acceleration", lambda mgr: round(mgr.linear_acceleration, 3), "VEHICLE"),
        ("vehicle/operation/state", lambda mgr: mgr.operation_state.value, "VEHICLE"),
        ("vehicle/surface/state", lambda mgr: mgr.surface_state.value, "SURFACE"),
        ("vehicle/surface/obstacle", lambda mgr: mgr.surface_obstacle.value, "OBSTACLE"),
        ("vehicle/road/roll_angle", lambda mgr: mgr.road_roll_angle, "ROAD"),
        ("vehicle/road/pitch_angle", lambda mgr: mgr.road_pitch_angle, "ROAD"),
        ("vehicle/current_video/file_name", lambda mgr: mgr.current_video_file_name, "VIDEO"),
    )

    @classmethod
    def iter_sensor_definitions_in_order(cls):
        for sensor_def in cls.SENSOR_DEFINITIONS:
            yield sensor_def

_shutdown_flag = False


class MqttManager:
    STATE_FILE_NAME = "mqtt_manager_state.json"

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
        self.battery_remain_amount = 0.0
        self.drive_available_time = 0
        self.drive_elapsed_time = 0
        self.drive_total_distance = 0

        self.max_speed = 13.9
        self.linear_acceleration = 0.0
        self.operation_state = VehicleExecState.RUN
        self.surface_state = SurfaceState.ASPHALT
        self.surface_obstacle = SurfaceObstacle.NONE
        self.road_roll_angle = 0.0
        self.road_pitch_angle = 0.0
        self.current_video_file_name = ""

        self.wheel_power_by_id = {wheel_id: 0.0 for wheel_id in MqttConfig.WHEEL_IDS}
        self.wheel_pid_by_id = {
            wheel_id: {"p": 0.0, "i": 0.0, "d": 0.0}
            for wheel_id in MqttConfig.WHEEL_IDS
        }
        self.wheel_rpm_by_id = {wheel_id: 0.0 for wheel_id in MqttConfig.WHEEL_IDS}
        self.wheel_speed_by_id = {wheel_id: 0.0 for wheel_id in MqttConfig.WHEEL_IDS}
        self.wheel_tof_distance_by_id = {wheel_id: 0.0 for wheel_id in MqttConfig.WHEEL_IDS}
        self.wheel_axis_angle_by_id = {wheel_id: 0.0 for wheel_id in MqttConfig.WHEEL_IDS}

        # 선택적 외부 주입 데이터
        self.vehicle_data = {}
        self.wheel_data = {}
        self.sensor_settings_by_id = {}
        self.sensor_row_values_by_key = {}
        self._initialize_sensor_state_cache()

        self.publish_count = 0
        self.running = True
        self._init_ready = False
        self._pending_connect_payloads = []
        self.script_path = os.path.abspath(__file__)
        self.last_modified = os.path.getmtime(self.script_path) if os.path.exists(self.script_path) else 0
        self.state_file_path = os.path.join(os.path.dirname(self.script_path), self.STATE_FILE_NAME)
        self._load_persistent_state()

    def _load_persistent_state(self):
        try:
            if not os.path.exists(self.state_file_path):
                return

            with open(self.state_file_path, "r", encoding="utf-8") as state_file:
                saved_state = json.load(state_file)

            if not isinstance(saved_state, dict):
                return

            saved_video_file_name = str(saved_state.get("current_video_file_name") or "").strip()
            self.current_video_file_name = saved_video_file_name
            print(f"[STATE] Loaded current video file: {self.current_video_file_name}")
        except Exception as e:
            print(f"[STATE] Failed to load persistent state: {e}")

    def _save_persistent_state(self):
        state_payload = {
            "current_video_file_name": str(self.current_video_file_name or "").strip(),
        }

        temp_state_file_path = f"{self.state_file_path}.tmp"
        try:
            with open(temp_state_file_path, "w", encoding="utf-8") as state_file:
                json.dump(state_payload, state_file, ensure_ascii=False, indent=2)
            os.replace(temp_state_file_path, self.state_file_path)
            print(f"[STATE] Saved current video file: {state_payload['current_video_file_name']}")
        except Exception as e:
            print(f"[STATE] Failed to save persistent state: {e}")
            try:
                if os.path.exists(temp_state_file_path):
                    os.remove(temp_state_file_path)
            except Exception:
                pass

    def _initialize_sensor_state_cache(self):
        self.sensor_settings_by_id = {}
        self.sensor_row_values_by_key = {}

        for sensor_def in MqttConfig.iter_sensor_definitions_in_order():
            sensor_id = sensor_def["id"]
            sensor_count = max(1, int(sensor_def["count"]))
            sensor_enabled = bool(sensor_def["enabled"])
            self.sensor_settings_by_id[sensor_id] = {
                "count": sensor_count,
                "enabled": sensor_enabled,
            }

            for index in range(sensor_count):
                self.sensor_row_values_by_key[self._build_sensor_row_key(sensor_id, index)] = self._build_default_sensor_row_value(
                    sensor_id,
                    sensor_enabled,
                )

    def _build_sensor_row_key(self, sensor_id, index):
        return f"{sensor_id}#{int(index)}"

    def _build_default_sensor_row_value(self, sensor_id, sensor_enabled):
        obstacle_value = int(self.surface_obstacle.value)
        supports_obstacle = sensor_id in ("ToF", "Lidar", "Camera")
        return {
            "state": 1 if sensor_enabled else 0,
            "value": obstacle_value if sensor_id == "Camera" else 0,
            "obstacle": obstacle_value if (sensor_enabled and supports_obstacle) else SurfaceObstacle.NONE.value,
            "obstacle_confidence": 0.8 if (sensor_enabled and supports_obstacle and obstacle_value != SurfaceObstacle.NONE.value) else 0.0,
        }

    def _parse_bool_payload(self, payload):
        payload_text = str(payload or "").strip().lower()
        return payload_text in ("1", "true", "on", "yes")

    def _parse_numeric_payload(self, payload):
        text = str(payload or "").strip()
        if text == "":
            return 0
        try:
            numeric = float(text)
        except (TypeError, ValueError):
            return text

        if numeric.is_integer():
            return int(numeric)
        return numeric

    def _store_sensor_message(self, topic, payload):
        topic_text = str(topic or "").strip()
        if not topic_text.startswith("sensor/"):
            return False

        count_match = topic_text.split("/")
        if len(count_match) == 3 and count_match[2] == "count":
            sensor_id = count_match[1]
            sensor_count = max(1, int(self._parse_numeric_payload(payload) or 1))
            sensor_setting = self.sensor_settings_by_id.setdefault(sensor_id, {"count": sensor_count, "enabled": True})
            sensor_setting["count"] = sensor_count
            sensor_enabled = bool(sensor_setting.get("enabled", True))
            for index in range(sensor_count):
                row_key = self._build_sensor_row_key(sensor_id, index)
                self.sensor_row_values_by_key.setdefault(row_key, self._build_default_sensor_row_value(sensor_id, sensor_enabled))
            return True

        if len(count_match) == 3 and count_match[2] == "enabled":
            sensor_id = count_match[1]
            sensor_enabled = self._parse_bool_payload(payload)
            sensor_setting = self.sensor_settings_by_id.setdefault(sensor_id, {"count": 1, "enabled": sensor_enabled})
            sensor_setting["enabled"] = sensor_enabled
            sensor_count = max(1, int(sensor_setting.get("count", 1)))
            for index in range(sensor_count):
                row_key = self._build_sensor_row_key(sensor_id, index)
                row_value = self.sensor_row_values_by_key.setdefault(row_key, self._build_default_sensor_row_value(sensor_id, sensor_enabled))
                row_value.setdefault("state", 1 if sensor_enabled else 0)
            return True

        if len(count_match) < 4:
            return False

        sensor_id = count_match[1]
        try:
            sensor_index = int(count_match[2])
        except (TypeError, ValueError):
            return False

        metric_name = "/".join(count_match[3:])
        row_key = self._build_sensor_row_key(sensor_id, sensor_index)
        sensor_setting = self.sensor_settings_by_id.setdefault(sensor_id, {"count": sensor_index + 1, "enabled": True})
        sensor_setting["count"] = max(sensor_index + 1, int(sensor_setting.get("count", 1)))
        row_value = self.sensor_row_values_by_key.setdefault(
            row_key,
            self._build_default_sensor_row_value(sensor_id, bool(sensor_setting.get("enabled", True))),
        )

        if metric_name == "state":
            row_value["state"] = 1 if self._parse_bool_payload(payload) else 0
            return True
        if metric_name == "value":
            row_value["value"] = self._parse_numeric_payload(payload)
            return True
        if metric_name == "obstacle":
            row_value["obstacle"] = int(self._parse_numeric_payload(payload) or 0)
            return True
        if metric_name == "obstacle/confidence":
            parsed_value = self._parse_numeric_payload(payload)
            try:
                row_value["obstacle_confidence"] = float(parsed_value)
            except (TypeError, ValueError):
                row_value["obstacle_confidence"] = 0.0
            return True

        return False

    def _on_connect(self, client, _userdata, _flags, reason_code, _properties=None):
        print("MQTT Connected:", reason_code)
        client.subscribe("sensor/#")
        client.subscribe("wheel/#")
        client.subscribe("vehicle/#")
        client.subscribe("client/connect")
        print("[MQTT] Subscribed to sensor/#")
        print("[MQTT] Subscribed to wheel/#")
        print("[MQTT] Subscribed to vehicle/#")
        print("[MQTT] Subscribed to client/connect")

    def _on_message(self, _client, _userdata, msg):
        try:
            topic = msg.topic
            payload = msg.payload.decode("utf-8")
            print(f"[MQTT] Received: {topic} -> {payload}")

            if topic == "client/connect":
                if not self._init_ready:
                    self._pending_connect_payloads.append(payload)
                    print("[CONNECT] Queued - waiting for initialization...")
                else:
                    print("[CONNECT] Client connection detected - Publishing initial settings...")
                    self._publish_settings_on_client_connect(payload)
            elif self._store_sensor_message(topic, payload):
                print(f"[SENSOR] Stored latest sensor topic: {topic}")
            elif self._store_wheel_message(topic, payload):
                print(f"[WHEEL] Stored latest wheel topic: {topic}")
            elif self._store_vehicle_message(topic, payload):
                print(f"[VEHICLE] Stored latest vehicle topic: {topic}")
        except Exception as e:
            print(f"[MQTT] Message processing error: {e}")

    def _store_wheel_message(self, topic, payload):
        topic_text = str(topic or "").strip()
        if not topic_text.startswith("wheel/"):
            return False

        parts = topic_text.split("/")
        if len(parts) < 3:
            return False

        wheel_str_id = parts[1]
        if wheel_str_id not in MqttConfig.WHEEL_IDS:
            return False

        metric = "/".join(parts[2:])

        if metric == "angle/speed":
            self.wheel_rpm_by_id[wheel_str_id] = self._parse_numeric_payload(payload)
            return True
        if metric == "linear/speed":
            self.wheel_speed_by_id[wheel_str_id] = self._parse_numeric_payload(payload)
            return True
        if metric == "power":
            self.wheel_power_by_id[wheel_str_id] = self._parse_numeric_payload(payload)
            return True
        if metric == "pid/p":
            self.wheel_pid_by_id.setdefault(wheel_str_id, {})["p"] = self._parse_numeric_payload(payload)
            return True
        if metric == "pid/i":
            self.wheel_pid_by_id.setdefault(wheel_str_id, {})["i"] = self._parse_numeric_payload(payload)
            return True
        if metric == "pid/d":
            self.wheel_pid_by_id.setdefault(wheel_str_id, {})["d"] = self._parse_numeric_payload(payload)
            return True
        if metric == "tof/distance":
            self.wheel_tof_distance_by_id[wheel_str_id] = self._parse_numeric_payload(payload)
            return True
        if metric == "axis/angle":
            self.wheel_axis_angle_by_id[wheel_str_id] = self._parse_numeric_payload(payload)
            return True

        # 유효한 휠 ID의 미처리 메트릭은 여기서 소비 (차량 명령 핸들러로 전달되지 않도록)
        return True

    def _store_vehicle_message(self, topic, payload):
        topic_text = str(topic or "").strip()
        if not topic_text.startswith("vehicle/"):
            return False

        metric = topic_text[len("vehicle/"):]

        if metric == "operation/state":
            try:
                self.operation_state = VehicleExecState(int(self._parse_numeric_payload(payload)))
            except (ValueError, KeyError):
                pass
            return True
        if metric == "linear/max_speed":
            self.max_speed = float(self._parse_numeric_payload(payload))
            return True
        if metric == "linear/acceleration":
            self.linear_acceleration = float(self._parse_numeric_payload(payload))
            return True
        if metric == "battery/remain_amount":
            self.battery_remain_amount = float(self._parse_numeric_payload(payload))
            return True
        if metric == "drive/available_time":
            self.drive_available_time = int(self._parse_numeric_payload(payload))
            return True
        if metric == "drive/elapsed_time":
            self.drive_elapsed_time = int(self._parse_numeric_payload(payload))
            return True
        if metric == "drive/total_distance":
            self.drive_total_distance = int(self._parse_numeric_payload(payload))
            return True
        if metric == "surface/state":
            try:
                self.surface_state = SurfaceState(int(self._parse_numeric_payload(payload)))
            except (ValueError, KeyError):
                pass
            return True
        if metric == "surface/obstacle":
            try:
                self.surface_obstacle = SurfaceObstacle(int(self._parse_numeric_payload(payload)))
            except (ValueError, KeyError):
                pass
            return True
        if metric == "road/roll_angle":
            self.road_roll_angle = float(self._parse_numeric_payload(payload))
            return True
        if metric == "road/pitch_angle":
            self.road_pitch_angle = float(self._parse_numeric_payload(payload))
            return True
        if metric == "current_video/file_name":
            next_video_file_name = str(payload or "").strip()
            if self.current_video_file_name != next_video_file_name:
                self.current_video_file_name = next_video_file_name
                self._save_persistent_state()
            return True

        return False

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

            for sensor_def in MqttConfig.iter_sensor_definitions_in_order():
                sensor_id = sensor_def["id"]
                sensor_setting = self.sensor_settings_by_id.get(sensor_id) or {
                    "count": sensor_def["count"],
                    "enabled": sensor_def["enabled"],
                }
                sensor_count = max(1, int(sensor_setting.get("count", sensor_def["count"])))
                sensor_enabled = bool(sensor_setting.get("enabled", sensor_def["enabled"]))
                self._publish(MqttConfig.SENSOR_COUNT_TOPIC_TEMPLATE.format(sensor_id=sensor_id), sensor_count)
                self._publish(MqttConfig.SENSOR_ENABLED_TOPIC_TEMPLATE.format(sensor_id=sensor_id), 1 if sensor_enabled else 0)

                for index in range(sensor_count):
                    topic_prefix = f"sensor/{sensor_id}/{index}"
                    row_key = self._build_sensor_row_key(sensor_id, index)
                    row_value = self.sensor_row_values_by_key.get(row_key) or self._build_default_sensor_row_value(sensor_id, sensor_enabled)
                    sensor_state = int(row_value.get("state", 1 if sensor_enabled else 0))
                    sensor_value = row_value.get("value", 0)
                    sensor_obstacle = int(row_value.get("obstacle", SurfaceObstacle.NONE.value))
                    obstacle_confidence = row_value.get("obstacle_confidence", 0.0)

                    self._publish(f"{topic_prefix}/state", sensor_state)
                    self._publish(f"{topic_prefix}/value", sensor_value)
                    self._publish(f"{topic_prefix}/obstacle", sensor_obstacle)
                    self._publish(f"{topic_prefix}/obstacle/confidence", obstacle_confidence)

            obstacle_value = int(self.surface_obstacle.value)
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

            for wheel_str_id in MqttConfig.WHEEL_IDS:
                for template, value_getter in MqttConfig.WHEEL_PUBLISH_SPECS:
                    topic = template.format(wheel_str_id=wheel_str_id)
                    self._publish(topic, value_getter(self, wheel_str_id))

            for topic, payload_resolver, log_tag in MqttConfig.INITIAL_CONNECT_TOPIC_SPECS:
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

        # retained 메시지 수신 대기 후 초기화 완료 처리
        time.sleep(1.0)
        self._init_ready = True
        print("[MANAGER] 초기화 완료 - 클라이언트 연결 처리 시작")
        for pending_payload in self._pending_connect_payloads:
            print("[CONNECT] Processing queued client connection...")
            self._publish_settings_on_client_connect(pending_payload)
        self._pending_connect_payloads.clear()

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
