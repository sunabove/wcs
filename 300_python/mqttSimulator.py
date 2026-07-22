import time
import random
import json
import threading
import platform
import sys
import os
import signal
import math
from enum import IntEnum
import paho.mqtt.client as mqtt


# ===== Enum =====
class OperationCommand(IntEnum):
    STOP = 0
    FORWARD = 1
    REVERSE = 2
    TURN_LEFT = 3
    TURN_RIGHT = 4
    TOF_CALIBRATION = 5


class VehicleExecState(IntEnum):
    STOP = 0
    RUN = 1


class SurfaceState(IntEnum):
    ASPHALT = 0
    BLOCK = 1
    DIRT_ROAD = 2
    GRAVEL_ROAD = 3


class SurfaceObstacle(IntEnum):
    NONE = 0
    STEP = 1
    POT_HOLE = 2
    ICE_ROAD = 3


WHEEL_IDS = ["fl", "fr", "rr", "rl"]

SENSOR_DEFINITIONS = [
    {"id": "ToF", "count": 4, "target": "거리,장애물", "enabled": True},
    {"id": "IMU", "count": 5, "target": "가속도,각속도", "enabled": True},
    {"id": "Current", "count": 4, "target": "전류", "enabled": True},
    {"id": "Camera", "count": 1, "target": "장애물", "enabled": True},
    {"id": "Lidar", "count": 1, "target": "거리,장애물", "enabled": True}, 
]

# 일반 승용차(16~18인치급) 외경 기준 반지름: 약 0.31~0.33m
WHEEL_RADIUS_M = 0.32

# 바퀴 ID 매핑 (문자열 -> 숫자)
WHEEL_ID_MAPPING = {
    "fl": 1,  # Front Left
    "fr": 2,  # Front Right  
    "rr": 3,  # Rear Right
    "rl": 4   # Rear Left
}

SENSOR_COUNT_TOPIC_TEMPLATE = "sensor/{sensor_id}/count"
SENSOR_TARGET_TOPIC_TEMPLATE = "sensor/{sensor_id}/target"
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

# ===== 전역 변수 =====
_shutdown_flag = False


def iter_sensor_definitions_in_order():
    """SENSOR_DEFINITIONS 선언 순서를 기준으로 순회한다."""
    for sensor_def in SENSOR_DEFINITIONS:
        yield sensor_def


# ===== Simulator =====
class MqttSimulator:
    def __init__(self, broker="localhost", port=1883):
        # MQTT 클라이언트 생성 - paho-mqtt 버전별 호환성 처리
        try:
            # paho-mqtt 2.0+ 버전용 - 최신 callback API 버전 사용
            self.client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, client_id="wcs_simulator")
            print("[MQTT] Using paho-mqtt 2.0+ with callback API version 2")
        except (TypeError, AttributeError):
            try:
                # paho-mqtt 1.6+ 버전용 - client_id만 전달
                self.client = mqtt.Client(client_id="wcs_simulator")
                print("[MQTT] Using paho-mqtt 1.6+ compatibility mode")
            except TypeError:
                # paho-mqtt 구버전용 - 위치 인수로 전달
                self.client = mqtt.Client("wcs_simulator")
                print("[MQTT] Using paho-mqtt legacy compatibility mode")
        
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message

        self.broker = broker
        self.port = port

        # vehicle 상태
        self.elapsed_time = 0
        self.total_distance = 0.0  # 총 주행시간(초)을 거리처럼 사용
        self.current_session_distance = 0.0  # 현재 세션 거리
        self.battery_voltage = 48.0
        self.battery_max_voltage = 48.0  # 배터리 최대 전압 (100% 기준)
        self.exec_state = VehicleExecState.RUN
        self.command = OperationCommand.FORWARD
        self.surface_state = SurfaceState.ASPHALT  # 초기 노면 상태
        self.surface_obstacle = SurfaceObstacle.NONE  # 초기 장애물 상태
        self.surface_state_lock_time = 0  # 노면 상태 락 유지 시간 (초)
        self.surface_state_lock_duration = 0  # 노면 상태 락 지속 시간
        self.road_roll_angle = 0.0  # rad
        self.road_pitch_angle = 0.0  # rad
        self.current_video_file_name = ""
        
        # 시뮬레이션 제어 변수
        self.route_center_x = 0.0
        self.route_center_y = 0.0
        self.route_radius_m = 45.0
        self.route_wobble_m = 8.0
        self.route_hill_amplitude_m = 6.0
        self.route_loop_length_m = 2.0 * math.pi * self.route_radius_m
        self.route_distance_m = 0.0
        self.route_base_speed_mps = 8.0
        self.route_min_speed_mps = 4.0
        self.route_max_speed_mps = 10.0
        self.target_speed = self.route_base_speed_mps  # 목표 속도 (m/s)
        self.current_speed = 0.0  # 현재 실제 속도
        self.max_speed = 13.9  # 최고 속도 제한 초기값 (m/s, 50 km/h)

        # 위치 상태
        self.pos_x = 0.0
        self.pos_y = 0.0
        self.pos_z = 0.0

        self.linear_speed = 0.0
        self.linear_acc = 0.0

        self.angle = 0.0
        self.angle_speed = 0.0
        self.angle_acc = 0.0

        # wheel 상태
        self.wheels = {wid: self._init_wheel() for wid in WHEEL_IDS}
        
        # Publish 통계
        self.publish_count = 0
        self.last_vehicle_state_published = None
        self.last_vehicle_max_speed_published = None
        self.wheel_id_initial_published = False
        self.wheel_radius_initial_published = False
        self.wheel_radius_published_client_ids = set()
        self.last_sensor_interface_payloads = {}
        
        # 재시작 및 모니터링
        self.running = True
        self.manual_wheel_test_active = False
        self.manual_wheel_test_wheel = None
        self.manual_wheel_test_command = OperationCommand.STOP
        self.manual_wheel_test_angular_speed = 8.0  # rad/s
        self.direction_control_speed_only_mode = False
        self.last_published_vehicle_linear_speed = None
        self.last_published_vehicle_linear_speed_at = 0.0
        self.start_time = time.time()
        self.script_path = os.path.abspath(__file__)
        self.last_modified = os.path.getmtime(self.script_path) if os.path.exists(self.script_path) else 0
    pass  # __init__

    def _init_wheel(self):
        return {
            "x": 0.0,
            "y": 0.0,
            "z": 0.0,
            "speed": 0.0,
            "acc": 0.0,
            "angle": 0.0,
            "angle_speed": 0.0,
            "angle_acc": 0.0,
            "axis_angle": 0.0,
            "torque": 0.0,
            "power": 0.0,
            "pid_p": 0.0,
            "pid_i": 0.0,
            "pid_d": 0.0,
            "tof_distance": 0.0,
            "tof_calib": 0.0,
            "command": OperationCommand.STOP,
            "state": VehicleExecState.STOP,
        }
    pass  # _init_wheel

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        print("MQTT Connected:", reason_code)
        # MQTT 토픽 구독
        client.subscribe("client/connect")
        client.subscribe("vehicle/linear/speed")
        client.subscribe("vehicle/linear/max_speed")
        client.subscribe("vehicle/operation/command")
        client.subscribe("vehicle/surface/state")
        client.subscribe("vehicle/surface/obstacle")
        client.subscribe("vehicle/road/roll_angle")
        client.subscribe("vehicle/road/pitch_angle")
        client.subscribe("vehicle/current_video/file_name")
        client.subscribe("sensor/#")
        client.subscribe("obstacle")
        client.subscribe("obstacle/#")
        
        # wheel ID 요청 및 설정 구독 (fl, fr, rr, rl 각각)
        for wheel_id in WHEEL_IDS:
            client.subscribe(f"wheel/{wheel_id}/id_request")  # ID 요청
            client.subscribe(f"wheel/{wheel_id}/id")          # ID 설정
            client.subscribe(f"wheel/{wheel_id}/operation/command")
            
        print("[MQTT] Subscribed to client/connect, vehicle/linear/speed, vehicle/linear/max_speed, vehicle/operation/command, vehicle/surface/state, vehicle/surface/obstacle, vehicle/road/roll_angle, vehicle/road/pitch_angle, vehicle/current_video/file_name, sensor/#, obstacle/#, wheel/*/id_request, wheel/*/id, wheel/*/operation/command topics")
    
    def _on_message(self, client, userdata, msg):
        """MQTT 메시지 수신 처리"""
        try:
            topic = msg.topic
            payload = msg.payload.decode('utf-8')

            self._cache_sensor_interface_payload(topic, payload)
            
            print(f"[MQTT] Received: {topic} -> {payload}")
            
            if topic == "vehicle/operation/command":
                try:
                    command_value = int(payload)
                    if command_value in [
                        OperationCommand.STOP.value,
                        OperationCommand.FORWARD.value,
                        OperationCommand.REVERSE.value,
                        OperationCommand.TURN_LEFT.value,
                        OperationCommand.TURN_RIGHT.value,
                    ]:
                        # 차량 명령이 들어오면 수동 휠 테스트 상태(특히 wheel stop 잔여 상태)를 무시한다.
                        self.manual_wheel_test_active = False
                        self.manual_wheel_test_wheel = None
                        self.manual_wheel_test_command = OperationCommand.STOP
                        self.direction_control_speed_only_mode = True

                        self.command = OperationCommand(command_value)
                        self.exec_state = VehicleExecState.STOP if self.command == OperationCommand.STOP else VehicleExecState.RUN

                        command_names = {
                            OperationCommand.STOP: "정지",
                            OperationCommand.FORWARD: "전진",
                            OperationCommand.REVERSE: "후진",
                            OperationCommand.TURN_LEFT: "좌회전",
                            OperationCommand.TURN_RIGHT: "우회전",
                        }
                        print(f"[VEHICLE_CMD] 차량 명령 설정: {command_names.get(self.command, '알수없음')} ({command_value})")
                    else:
                        print(f"[VEHICLE_CMD] 잘못된 차량 명령 값: {command_value} (허용: 0-4)")
                except ValueError:
                    print(f"[VEHICLE_CMD] 잘못된 차량 명령 형식: {payload}")
            elif topic.startswith("wheel/") and topic.endswith("/operation/command"):
                # 휠 토픽은 클라이언트 직접 발행 방침으로 전환되어 시뮬레이터에서 처리하지 않는다.
                print(f"[WHEEL_TEST] Ignored by simulator policy: {topic} -> {payload}")
            elif topic == "vehicle/surface/state":
                try:
                    new_surface_state = int(payload)
                    if 0 <= new_surface_state <= 3:
                        self.surface_state = SurfaceState(new_surface_state)
                        self.surface_state_lock_time = 0
                        self.surface_state_lock_duration = 30
                        surface_names = ['ASPHALT', 'BLOCK', 'DIRT_ROAD', 'GRAVEL_ROAD']
                        surface_name = surface_names[new_surface_state]
                        print(f"[SURFACE] 노면 상태 설정: {surface_name} ({new_surface_state}) - {self.surface_state_lock_duration}초 유지")
                    else:
                        print(f"[SURFACE] 잘못된 노면 상태 값: {new_surface_state} (허용: 0-3)")
                except ValueError:
                    print(f"[SURFACE] 잘못된 노면 상태 형식: {payload}")
            elif topic == "vehicle/surface/obstacle":
                try:
                    new_surface_obstacle = int(payload)
                    if 0 <= new_surface_obstacle <= 3:
                        self.surface_obstacle = SurfaceObstacle(new_surface_obstacle)
                        obstacle_names = ['NONE', 'STEP', 'POT_HOLE', 'ICE_ROAD']
                        obstacle_name = obstacle_names[new_surface_obstacle]
                        print(f"[OBSTACLE] 장애물 상태 설정: {obstacle_name} ({new_surface_obstacle})")
                    else:
                        print(f"[OBSTACLE] 잘못된 장애물 상태 값: {new_surface_obstacle} (허용: 0-3)")
                except ValueError:
                    print(f"[OBSTACLE] 잘못된 장애물 상태 형식: {payload}")
            elif topic == "vehicle/road/roll_angle":
                try:
                    self.road_roll_angle = float(payload)
                    print(f"[ROAD] Roll 각도 설정: {self.road_roll_angle:.4f} rad")
                except ValueError:
                    print(f"[ROAD] 잘못된 Roll 각도 형식: {payload}")
            elif topic == "vehicle/road/pitch_angle":
                try:
                    self.road_pitch_angle = float(payload)
                    print(f"[ROAD] Pitch 각도 설정: {self.road_pitch_angle:.4f} rad")
                except ValueError:
                    print(f"[ROAD] 잘못된 Pitch 각도 형식: {payload}")
            elif topic == "vehicle/current_video/file_name":
                self.current_video_file_name = str(payload).strip()
                print(f"[VIDEO] 현재 동영상 파일명 설정: {self.current_video_file_name}")
            elif topic == "client/connect":
                print("[CONNECT] Client connection detected - Publishing settings...")
                self._publish_settings_on_client_connect(payload)
            elif topic == "vehicle/linear/speed":
                try:
                    # vehicle/linear/speed는 상태 토픽으로도 발행되므로,
                    # 직전에 스스로 발행한 self-echo는 명령으로 처리하지 않는다.
                    if (
                        self.last_published_vehicle_linear_speed is not None
                        and (time.time() - self.last_published_vehicle_linear_speed_at) < 2.0
                    ):
                        try:
                            incoming_speed = float(payload)
                            if abs(incoming_speed - self.last_published_vehicle_linear_speed) < 0.001:
                                return
                        except ValueError:
                            if str(payload) == str(self.last_published_vehicle_linear_speed):
                                return

                    new_current_speed = float(payload)
                    if 0.0 <= new_current_speed <= 27.8:  # 0~100 km/h 범위 제한
                        old_target = self.target_speed
                        clamped_speed = min(new_current_speed, self.max_speed)
                        self.target_speed = clamped_speed
                        print(f"[SPEED] 현재 속도 명령 반영({topic}): {old_target:.1f} -> {self.target_speed:.1f} m/s ({self.target_speed*3.6:.0f} km/h)")

                        # 차량 방향 명령이 활성화되어 있으면,
                        # 현재 속도 변경을 즉시 바퀴 속도에 반영한다.
                        if (
                            not self.manual_wheel_test_active
                            and self.command in [
                                OperationCommand.FORWARD,
                                OperationCommand.REVERSE,
                                OperationCommand.TURN_LEFT,
                                OperationCommand.TURN_RIGHT,
                            ]
                        ):
                            self.manual_wheel_test_active = False
                            self.manual_wheel_test_wheel = None
                            self.manual_wheel_test_command = OperationCommand.STOP
                            self.direction_control_speed_only_mode = True
                    else:
                        print(f"[SPEED] 잘못된 현재 속도 범위: {new_current_speed:.1f} m/s (허용: 0.0-27.8 m/s, 0-100 km/h)")
                except ValueError:
                    print(f"[SPEED] 잘못된 현재 속도 형식: {payload}")
            elif topic == "vehicle/linear/max_speed":
                try:
                    new_max_speed = float(payload)
                    if 0.0 <= new_max_speed <= 27.8:  # 0~100 km/h 범위 제한
                        old_speed = self.max_speed
                        self.max_speed = new_max_speed
                        print(f"[SPEED] 최고 속도 변경({topic}): {old_speed:.1f} -> {new_max_speed:.1f} m/s ({new_max_speed*3.6:.0f} km/h)")

                        # 목표 속도가 새 최고 속도를 초과하면 조정
                        if self.target_speed > self.max_speed:
                            self.target_speed = self.max_speed * 0.9
                            print(f"[SPEED] 목표 속도 조정: {self.target_speed:.1f} m/s")

                        if (
                            not self.manual_wheel_test_active
                            and self.command in [
                                OperationCommand.FORWARD,
                                OperationCommand.REVERSE,
                                OperationCommand.TURN_LEFT,
                                OperationCommand.TURN_RIGHT,
                            ]
                        ):
                            self.manual_wheel_test_active = False
                            self.manual_wheel_test_wheel = None
                            self.manual_wheel_test_command = OperationCommand.STOP
                            self.direction_control_speed_only_mode = True
                    else:
                        print(f"[SPEED] 잘못된 최고 속도 범위: {new_max_speed:.1f} m/s (허용: 0.0-27.8 m/s, 0-100 km/h)")
                except ValueError:
                    print(f"[SPEED] 잘못된 최고 속도 형식: {payload}")
            elif topic.endswith("/id_request"):
                # 휠 토픽은 클라이언트 직접 발행 방침으로 전환되어 응답 발행을 하지 않는다.
                print(f"[WHEEL_ID_REQ] Ignored by simulator policy: {topic}")
            elif topic.split("/")[-1] == "id" and topic.startswith("wheel/"):
                print(f"[WHEEL_ID_SET] Ignored by simulator policy: {topic} -> {payload}")
                
        except Exception as e:
            print(f"[MQTT] Message processing error: {e}")
    pass  # _on_message

    def _cache_sensor_interface_payload(self, topic, payload):
        if self._is_sensor_interface_topic(topic):
            self.last_sensor_interface_payloads[topic] = str(payload)
    pass  # _cache_sensor_interface_payload

    def _extract_client_connect_id(self, payload):
        try:
            connect_info = json.loads(str(payload))
        except (TypeError, ValueError, json.JSONDecodeError):
            return None

        client_id = str(connect_info.get("client_id") or "").strip()
        return client_id or None
    pass  # _extract_client_connect_id
    
    def _publish_settings_on_client_connect(self, client_connect_payload=None):
        """클라이언트 연결 시 모든 vehicle과 wheel 설정 정보를 publish"""
        try:
            client_id = self._extract_client_connect_id(client_connect_payload)
            print("[SETTINGS] Publishing all vehicle and wheel settings...")

            # 센서 타입 정의 정보 발행
            for sensor_def in iter_sensor_definitions_in_order():
                sensor_id = sensor_def["id"]
                sensor_count_topic = SENSOR_COUNT_TOPIC_TEMPLATE.format(sensor_id=sensor_id)
                sensor_target_topic = SENSOR_TARGET_TOPIC_TEMPLATE.format(sensor_id=sensor_id)
                self._publish(sensor_count_topic, sensor_def["count"])
                self._publish(sensor_target_topic, sensor_def["target"])
                print(
                    f"[SENSOR_DEF] Published {sensor_count_topic}={sensor_def['count']}, "
                    f"target={sensor_def['target']}"
                )

            # 센서 인터페이스는 항상 현재 상태로 다시 생성해 발행한다.
            # (retained 구버전 JSON payload 재사용 방지)
            self._publish_sensor_interfaces()
            print("[SENSOR_DEF] Published sensor/{id}/{index}/* topics for all sensor counts")
            
            # Vehicle 설정 정보 publish
            if hasattr(self, 'vehicle_data') and self.vehicle_data:
                for key, value in self.vehicle_data.items():
                    topic = f"vehicle/{key}"
                    payload = str(value)
                    self._publish(topic, payload)
                    print(f"[VEHICLE] Published {topic} -> {payload}")
            else:
                print("[SETTINGS] No vehicle_data available to publish")
            
            # 초기 접속 시에는 휠 기준 정보를 전달한다. (주기 발행은 비활성)
            if hasattr(self, 'wheel_data') and self.wheel_data:
                for wheel_id in range(1, 5):
                    for key, value in self.wheel_data.items():
                        topic = f"wheel/{wheel_id}/{key}"
                        payload = str(value)
                        self._publish(topic, payload)
                        print(f"[WHEEL_INIT] Published {topic} -> {payload}")
            else:
                print("[SETTINGS] No wheel_data available to publish")

            for wheel_str_id, wheel_num_id in WHEEL_ID_MAPPING.items():
                topic = WHEEL_ID_TOPIC_TEMPLATE.format(wheel_str_id=wheel_str_id)
                payload = str(wheel_num_id)
                self._publish(topic, payload)
                print(f"[WHEEL_INIT] Published {topic} -> {payload}")

            for wheel_str_id in WHEEL_IDS:
                topic = WHEEL_RADIUS_TOPIC_TEMPLATE.format(wheel_str_id=wheel_str_id)
                payload = str(WHEEL_RADIUS_M)
                self._publish(topic, payload)
                print(f"[WHEEL_INIT] Published {topic} -> {payload}")

            self._publish_initial_connect_topics()
            
            print("[SETTINGS] All settings published successfully")
            
        except Exception as e:
            print(f"[SETTINGS] Error publishing settings: {e}")

    def _publish_initial_connect_topics(self):
        """초기 접속 시 즉시 전달할 핵심 상태 토픽들을 발행한다."""
        for topic, payload_resolver, log_tag in INITIAL_CONNECT_TOPIC_SPECS:
            payload = payload_resolver(self)
            self._publish(topic, payload)
            print(f"[{log_tag}] Published {topic} -> {payload}")
    
    def _check_file_changes(self):
        """파일 변경 감지 및 서비스 재시작"""
        try:
            if os.path.exists(self.script_path):
                current_modified = os.path.getmtime(self.script_path)
                if current_modified > self.last_modified:
                    print(f"[MONITOR] 파일 변경 감지: {self.script_path}")
                    print("[MONITOR] 서비스 재시작을 위해 5초 후 프로세스 종료...")
                    time.sleep(5)  # 5초 대기 후 프로세스 종료
                    self._cleanup()
                    print("[EXIT] systemd 서비스가 자동 재시작할 예정")
                    sys.exit(0)  # 정상 종료로 서비스 재시작 트리거
        except Exception as e:
            print(f"[MONITOR] 파일 모니터링 오류: {e}")
    pass  # _check_file_changes

    def _cleanup(self):
        """리소스 정리"""
        try:
            if hasattr(self, 'client') and self.client:
                print("[CLEANUP] MQTT 클라이언트 연결 종료")
                self.client.loop_stop()
                self.client.disconnect()
        except Exception as e:
            print(f"[CLEANUP] 정리 중 오류: {e}")
    pass  # _cleanup

    # ===== Publish =====
    def _normalize_obstacle_sensor_payload(self, value):
        """obstacle/sensors payload를 [id, index, ...] JSON 배열 데이터로 정규화한다."""
        if value is None:
            return []

        if isinstance(value, str):
            text = value.strip()
            if text == "":
                return []

            try:
                decoded = json.loads(text)
            except (TypeError, ValueError, json.JSONDecodeError):
                tokens = [part.strip() for part in text.split(",") if part.strip() != ""]
                normalized = []
                for idx, token in enumerate(tokens):
                    if idx % 2 == 1:
                        try:
                            normalized.append(int(token))
                        except ValueError:
                            normalized.append(token)
                    else:
                        normalized.append(token)
                return normalized

            return self._normalize_obstacle_sensor_payload(decoded)

        if isinstance(value, dict):
            sensor_id = str(value.get("id", "")).strip()
            sensor_index = value.get("index", "")
            if sensor_id == "":
                return []
            try:
                sensor_index = int(sensor_index)
            except (TypeError, ValueError):
                pass
            return [sensor_id, sensor_index]

        if isinstance(value, (list, tuple)):
            tokens = []
            for item in value:
                if isinstance(item, dict):
                    sensor_id = str(item.get("id", "")).strip()
                    sensor_index = item.get("index", "")
                    if sensor_id == "":
                        continue
                    tokens.append(sensor_id)
                    try:
                        sensor_index = int(sensor_index)
                    except (TypeError, ValueError):
                        pass
                    tokens.append(sensor_index)
                else:
                    tokens.append(item)
            return tokens

        return [value]

    def _publish(self, topic, value):
        # topic과 value만 직접 발행 (JSON 포장 없이)
        if topic == "obstacle/sensors":
            normalized = self._normalize_obstacle_sensor_payload(value)
            payload = json.dumps(normalized, ensure_ascii=False)
        else:
            payload = str(value)
        self.client.publish(topic, payload, retain=True)

        if self._is_sensor_interface_topic(topic):
            self.last_sensor_interface_payloads[topic] = payload

        if topic == "vehicle/linear/speed":
            try:
                self.last_published_vehicle_linear_speed = float(payload)
            except ValueError:
                self.last_published_vehicle_linear_speed = payload
            self.last_published_vehicle_linear_speed_at = time.time()
        
        # Publish 카운트 증가 및 로그 출력
        self.publish_count += 1
        print(f"[{self.publish_count}] [PUB] {topic} -> {payload}")
    pass  # _publish

    def _is_sensor_interface_topic(self, topic):
        if not isinstance(topic, str):
            return False

        if topic in ("obstacle", "obstacle/sensors", "obstacle/confidence"):
            return True

        parts = topic.split("/")
        if len(parts) == 4 and parts[0] == "sensor":
            metric = parts[3]
            return metric in ("state", "value", "obstacle")

        if len(parts) == 5 and parts[0] == "sensor" and parts[3] == "obstacle" and parts[4] == "confidence":
            return True

        return False
    pass  # _is_sensor_interface_topic

    def _publish_last_sensor_interfaces(self):
        for topic, payload in self.last_sensor_interface_payloads.items():
            self._publish(topic, payload)
    pass  # _publish_last_sensor_interfaces

    def _publish_vehicle(self):
        # 배터리 잔량(%) 계산 및 발행
        remain_percent = max(0, min(100, (self.battery_voltage / self.battery_max_voltage) * 100))
        
        # SI 단위계 값들 발행
        # 시간: 초(s), 거리: 미터(m)
        self._publish("vehicle/run/state", self.exec_state.value)
        self._publish("vehicle/drive/elapsed_time", self.elapsed_time)  # 초(s)
        self._publish("vehicle/drive/available_time", max(0, 3600 - self.elapsed_time))  # 초(s)
        self._publish("vehicle/drive/total_distance", self.total_distance)  # 총 주행시간(초)
        self._publish("vehicle/battery/voltage", round(self.battery_voltage, 2))  # 볼트(V)
        
        # 배터리 잔여시간: 전압 기반 추정
        estimated_remain_hours = max(0, (self.battery_voltage - 30) / (48 - 30) * 8)  # 8시간 최대 운행
        remain_seconds = int(estimated_remain_hours * 3600)
        self._publish("vehicle/battery/remain_time", remain_seconds)  # 초(s)
        
        self._publish("vehicle/battery/remain_amount", round(remain_percent, 1))  # 퍼센트(%)
        
        # SI 단위계: 속도(m/s), 각속도(rad/s)
        max_speed_rounded = round(self.max_speed, 2)
        if self.last_vehicle_max_speed_published != max_speed_rounded:
            self._publish("vehicle/linear/max_speed", max_speed_rounded)  # m/s (UI 호환)
            self.last_vehicle_max_speed_published = max_speed_rounded
        self._publish("vehicle/max_angular_speed", 1.0)  # rad/s

        # 동적 상태 정보는 변경 시에만 발행
        if self.last_vehicle_state_published != self.exec_state.value:
            self._publish("vehicle/operation/state", self.exec_state.value)
            self.last_vehicle_state_published = self.exec_state.value
        
        # 주행 관련 정보 발행
        self._publish("vehicle/driving/target_speed", round(self.target_speed, 2))
        self._publish("vehicle/driving/current_speed", round(self.current_speed, 2))
        
        # 시내 주행 전용 정보
        self._publish("vehicle/driving/speed_kmh", round(self.current_speed * 3.6, 1))  # km/h로 변환
        self._publish("vehicle/driving/target_speed_kmh", round(self.target_speed * 3.6, 1))  # km/h로 변환
        self._publish("vehicle/driving/distance_km", round(self.total_distance / 1000, 3))  # 총 주행거리(km)
        
        # 주행 안전 정보
        safety_score = 100  # 기본 안전 점수
        if self.surface_state in [SurfaceState.DIRT_ROAD, SurfaceState.GRAVEL_ROAD]:
            safety_score = max(70, safety_score - 20)  # 위험 노면에서 안전도 하락
        
        self._publish("vehicle/safety/score", safety_score)

        # 교통 혼잡도 시뮬레이션
        self._publish("vehicle/traffic/congestion_level", random.randint(0, 30))
    pass  # _publish_vehicle

    def _publish_position(self):
        # SI 단위계: 위치(m), 속도(m/s), 가속도(m/s²), 각도(rad), 각속도(rad/s), 각가속도(rad/s²)
        self._publish("vehicle/position/x", round(self.pos_x, 3))  # 미터(m)
        self._publish("vehicle/position/y", round(self.pos_y, 3))  # 미터(m)
        self._publish("vehicle/position/z", round(self.pos_z, 3))  # 미터(m)

        self._publish("vehicle/linear/speed", round(self.linear_speed, 3))  # m/s
        self._publish("vehicle/linear/acceleration", round(self.linear_acc, 3))  # m/s²

        self._publish("vehicle/angle", round(self.angle, 4))  # radian
        self._publish("vehicle/angle/speed", round(self.angle_speed, 3))  # rad/s
        self._publish("vehicle/angle/acceleration", round(self.angle_acc, 3))  # rad/s²
    pass  # _publish_position

    def _build_obstacle_sensor_sources(self):
        if self.surface_obstacle == SurfaceObstacle.NONE:
            return []

        sources = []
        for sensor_def in iter_sensor_definitions_in_order():
            sensor_id = sensor_def["id"]
            if not sensor_def["enabled"]:
                continue

            if sensor_id == "ToF":
                for index in range(sensor_def["count"]):
                    sources.append({"id": sensor_id, "index": index})
            elif sensor_id in ("Lidar", "Camera"):
                sources.append({"id": sensor_id, "index": 0})

        return sources

    def _format_obstacle_sensor_sources_payload(self, sources):
        """장애물 검출 센서 목록을 [id, index, id, index, ...] 형태로 변환한다."""
        if not sources:
            return []

        tokens = []
        for source in sources:
            sensor_id = str(source.get("id", "")).strip()
            sensor_index = source.get("index", "")
            if sensor_id == "":
                continue

            tokens.append(sensor_id)
            try:
                tokens.append(int(sensor_index))
            except (TypeError, ValueError):
                tokens.append(sensor_index)

        return tokens

    def _publish_sensor_interfaces(self):
        obstacle_value = int(self.surface_obstacle.value)

        for sensor_def in iter_sensor_definitions_in_order():
            sensor_id = sensor_def["id"]
            sensor_enabled = bool(sensor_def["enabled"])

            for index in range(sensor_def["count"]):
                topic_prefix = f"sensor/{sensor_id}/{index}"
                sensor_state = 1 if sensor_enabled else 0
                if sensor_id == "Camera":
                    sensor_value = obstacle_value
                else:
                    sensor_value = 0

                supports_obstacle = sensor_id in ("ToF", "Lidar", "Camera")
                sensor_obstacle = obstacle_value if (sensor_enabled and supports_obstacle) else SurfaceObstacle.NONE.value
                obstacle_confidence = 0.8 if (sensor_enabled and supports_obstacle and obstacle_value != SurfaceObstacle.NONE.value) else 0.0

                self._publish(f"{topic_prefix}/state", sensor_state)
                self._publish(f"{topic_prefix}/value", sensor_value)
                self._publish(f"{topic_prefix}/obstacle", sensor_obstacle)
                self._publish(f"{topic_prefix}/obstacle/confidence", obstacle_confidence)

        sources = self._build_obstacle_sensor_sources()
        sensor_sources_payload = self._format_obstacle_sensor_sources_payload(sources)
        self._publish("obstacle", obstacle_value)
        self._publish("obstacle/sensors", sensor_sources_payload)

        if self.surface_obstacle == SurfaceObstacle.NONE:
            total_confidence = 0.0
        else:
            total_confidence = 0.8 if sources else 0.0
        self._publish("obstacle/confidence", total_confidence)
    pass  # _publish_sensor_interfaces

    def run(self):
        self.client.connect(self.broker, self.port, 60)
        self.client.loop_start()
        
        print(f"[SIMULATOR] 시작 - PID: {os.getpid()}")
        print(f"[MONITOR] 파일 모니터링: {self.script_path}")
        print("[INFO] 시뮬레이션 상태 갱신 함수는 비활성화됨")
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
                print("\n[SIMULATOR] 사용자 중단 요청")
                break
            except Exception as e:
                print(f"[SIMULATOR] 실행 오류: {e}")
                time.sleep(1)
        
        self._cleanup()
        print("[SIMULATOR] 종료")
    pass  # run

pass # MqttSimulator

# ===== Signal Handlers =====
def signal_handler(signum, frame):
    """Signal handler for graceful shutdown"""
    global _shutdown_flag
    print(f"\n[SIGNAL] Signal {signum} received - Graceful shutdown...")
    _shutdown_flag = True
pass # signal_handler

def setup_signal_handlers():
    """Setup signal handlers for service management"""
    try:
        signal.signal(signal.SIGINT, signal_handler)   # Ctrl+C
        signal.signal(signal.SIGTERM, signal_handler)  # Service stop
        if hasattr(signal, 'SIGHUP'):  # Unix only
            signal.signal(signal.SIGHUP, signal_handler)   # Service reload
        print("[SIGNAL] Signal handlers registered")
    except Exception as e:
        print(f"[SIGNAL] Signal handler setup error: {e}")
pass # setup_signal_handlers

def restart_program():
    """프로그램 종료 - systemd 서비스가 자동 재시작"""
    print("[EXIT] 서비스 재시작을 위해 프로세스 종료...")
    sys.exit(0)
pass # restart_program

def main():
    """메인 함수"""
    global _shutdown_flag
    
    # Signal handler 설정
    setup_signal_handlers()
    
    try:
        # 플래그 초기화
        _shutdown_flag = False
        
        BROKER = "localhost"      # Linux/macOS에서는 localhost 사용
        
        # 운영체제별 브로커 설정
        if platform.system() == "Windows":
            BROKER = "orangepi6plus"  # Windows에서는 orangepi6plus 사용
        pass
        
        PORT = 1883

        print("=" * 50)
        print("Starting WCS MQTT City Driving Simulator")
        print(f"OS: {platform.system()}")
        print(f"MQTT Broker: {BROKER}:{PORT}")
        print(f"PID: {os.getpid()}")
        print("[SERVICE] systemd 서비스 관리 모드")
        print("[CITY] 시내 도로 주행 시뮬레이션 - 신호등, 교차로, 주차, 정체 등")
        print("[SI UNITS] SI 단위계 준수: 시간(s), 거리(m), 속도(m/s), 가속도(m/s²), 각도(rad), 토크(Nm), 전력(W)")
        print("=" * 50)

        simulator = MqttSimulator(BROKER, PORT)
        simulator.run()
        
        # 정상 종료 시 서비스가 재시작하도록 exit(0)
        print("[MAIN] 시뮬레이터 종료 - 서비스 재시작 대기")
        sys.exit(0)

    except KeyboardInterrupt:
        print("\n[MAIN] 사용자 중단 - 서비스 정지")
        sys.exit(0)
    except Exception as e:
        print(f"[MAIN] 오류 발생: {e}")
        print("[MAIN] 서비스 재시작을 위해 종료")
        sys.exit(1)
pass # main

if __name__ == "__main__":
    main()
pass # __name__ == "__main__"