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
    ICE = 1
    POT_HOLE = 2


WHEEL_IDS = ["fl", "fr", "rr", "rl"]

# 일반 승용차(16~18인치급) 외경 기준 반지름: 약 0.31~0.33m
PASSENGER_CAR_WHEEL_RADIUS_M = 0.32

# 바퀴 ID 매핑 (문자열 -> 숫자)
WHEEL_ID_MAPPING = {
    "fl": 1,  # Front Left
    "fr": 2,  # Front Right  
    "rr": 3,  # Rear Right
    "rl": 4   # Rear Left
}

# ===== 전역 변수 =====
_shutdown_flag = False


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
        
        # 시뮬레이션 제어 변수
        self.driving_scenario = "circular_hill_loop"  # 원형 고저차 도로 주행
        self.scenario_timer = 0
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
        self.max_speed = 30.0  # 최고 속도 제한 초기값 (m/s, 약 108 km/h)

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
        self.last_vehicle_command_published = None
        self.last_vehicle_state_published = None
        self.last_vehicle_max_speed_published = None
        
        # 재시작 및 모니터링
        self.running = True
        self.simulation_running = True  # 시뮬레이션 실행 여부
        self.manual_wheel_test_active = False
        self.manual_wheel_test_wheel = None
        self.manual_wheel_test_command = OperationCommand.STOP
        self.manual_wheel_test_angular_speed = 8.0  # rad/s
        self.ignore_wheel_command_until = 0.0
        self.last_published_vehicle_linear_speed = None
        self.last_published_vehicle_linear_speed_at = 0.0
        self.allow_publish_while_stopped = False
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
        client.subscribe("vehicle/max_speed")
        client.subscribe("simulation/start")
        client.subscribe("simulation/stop")
        client.subscribe("vehicle/operation/command")
        client.subscribe("vehicle/surface/state")
        client.subscribe("vehicle/surface/obstacle")
        
        # wheel ID 요청 및 설정 구독 (fl, fr, rr, rl 각각)
        for wheel_id in WHEEL_IDS:
            client.subscribe(f"wheel/{wheel_id}/id_request")  # ID 요청
            client.subscribe(f"wheel/{wheel_id}/id")          # ID 설정
            client.subscribe(f"wheel/{wheel_id}/operation/command")
            
        print("[MQTT] Subscribed to client/connect, vehicle/linear/speed, vehicle/max_speed, simulation/start, simulation/stop, vehicle/operation/command, vehicle/surface/state, vehicle/surface/obstacle, wheel/*/id_request, wheel/*/id, wheel/*/operation/command topics")
    
    def _on_message(self, client, userdata, msg):
        """MQTT 메시지 수신 처리"""
        try:
            topic = msg.topic
            payload = msg.payload.decode('utf-8')
            
            print(f"[MQTT] Received: {topic} -> {payload}")
            
            if topic == "simulation/start":
                # start 명령은 수동 바퀴 테스트 모드를 해제하고 항상 시뮬레이션 시작으로 처리
                if self.manual_wheel_test_active and self.manual_wheel_test_command != OperationCommand.STOP:
                    print("[SIM] 수동 바퀴 테스트 모드 종료 후 시뮬레이션 시작")

                self.simulation_running = True
                self.manual_wheel_test_active = False
                self.manual_wheel_test_wheel = None
                self.manual_wheel_test_command = OperationCommand.STOP
                self._publish("simulation/state", "start")
                print("[SIM] 시뮬레이션 시작")
            elif topic == "simulation/stop":
                self.simulation_running = False
                self.manual_wheel_test_active = False
                self.manual_wheel_test_wheel = None
                self.manual_wheel_test_command = OperationCommand.STOP
                self.command = OperationCommand.STOP
                self.exec_state = VehicleExecState.STOP
                self._publish_vehicle_command_wheels_when_paused()
                self._publish("simulation/state", "stop")
                print("[SIM] 시뮬레이션 중지")
            elif topic == "vehicle/operation/command":
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

                        self.command = OperationCommand(command_value)
                        if self.command == OperationCommand.STOP:
                            self.exec_state = VehicleExecState.STOP
                            self.current_speed = 0.0
                            self.linear_speed = 0.0
                            self.linear_acc = 0.0
                            self.angle_speed = 0.0
                            self.angle_acc = 0.0

                            for wid, wheel in self.wheels.items():
                                wheel["command"] = OperationCommand.STOP
                                wheel["state"] = VehicleExecState.STOP
                                wheel["speed"] = 0.0
                                wheel["acc"] = 0.0
                                wheel["angle_speed"] = 0.0
                                wheel["angle_acc"] = 0.0

                                base = f"wheel/{wid}"
                                self._publish(f"{base}/linear/speed", 0)
                                self._publish(f"{base}/linear/acceleration", 0)
                                self._publish(f"{base}/angle/speed", 0)
                                self._publish(f"{base}/angle/acceleration", 0)
                                self._publish(f"{base}/operation/command", OperationCommand.STOP.value)
                                self._publish(f"{base}/operation/state", VehicleExecState.STOP.value)
                        else:
                            self.exec_state = VehicleExecState.RUN
                            if not self.simulation_running:
                                self._publish_vehicle_command_wheels_when_paused()

                        # operation/command는 수신 토픽과 동일하므로 여기서 재발행하면 self-echo 루프가 생길 수 있다.
                        # 상태 토픽만 즉시 반영한다.
                        self._publish("vehicle/operation/state", self.exec_state.value)

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
                try:
                    parts = topic.split("/")
                    if len(parts) == 4 and parts[0] == "wheel" and parts[2] == "operation" and parts[3] == "command":
                        wheel_id = parts[1].lower()
                        if wheel_id not in WHEEL_IDS:
                            print(f"[WHEEL_TEST] 알 수 없는 wheel ID: {wheel_id}")
                        else:
                            command_value = int(payload)

                            # 내부 상태 반영을 위해 simulator가 직접 발행한 wheel command의 self-echo는 잠시 무시한다.
                            if time.time() < self.ignore_wheel_command_until:
                                print(f"[WHEEL_TEST] self-echo wheel 명령 무시: {topic} = {command_value}")
                                return

                            # 시뮬레이션 실행 중에는 wheel operation/command 토픽을 수동 테스트 명령으로 처리하지 않는다.
                            # (정기 발행되는 동일 토픽의 self-echo로 인해 simulation/stop으로 전환되는 루프 방지)
                            if self.simulation_running:
                                print(f"[WHEEL_TEST] simulation 실행 중 wheel 명령 무시: {topic} = {command_value}")
                                return

                            if command_value not in [OperationCommand.STOP.value, OperationCommand.FORWARD.value, OperationCommand.REVERSE.value]:
                                print(f"[WHEEL_TEST] 지원하지 않는 바퀴 테스트 명령: {command_value}")
                            else:
                                command = OperationCommand(command_value)
                                self.simulation_running = False
                                self._publish("simulation/state", "stop")

                                if command == OperationCommand.STOP:
                                    self.manual_wheel_test_active = False
                                    self.manual_wheel_test_wheel = None
                                    self.manual_wheel_test_command = OperationCommand.STOP
                                    self._publish_vehicle_command_wheels_when_paused()
                                    print(f"[WHEEL_TEST] 수동 바퀴 테스트 정지: {wheel_id.upper()}")
                                else:
                                    self.manual_wheel_test_active = True
                                    self.manual_wheel_test_wheel = wheel_id
                                    self.manual_wheel_test_command = command
                                    self._publish_manual_wheel_simulation()

                                    command_name = {
                                        OperationCommand.FORWARD: "정회전",
                                        OperationCommand.REVERSE: "역회전"
                                    }[self.manual_wheel_test_command]
                                    print(f"[WHEEL_TEST] 수동 바퀴 테스트 모드: {wheel_id.upper()} {command_name}")
                    else:
                        print(f"[WHEEL_TEST] 잘못된 토픽 형식: {topic}")
                except ValueError:
                    print(f"[WHEEL_TEST] 잘못된 operation/command 형식: {payload}")
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
                    if 0 <= new_surface_obstacle <= 2:
                        self.surface_obstacle = SurfaceObstacle(new_surface_obstacle)
                        obstacle_names = ['NONE', 'ICE', 'POT_HOLE']
                        obstacle_name = obstacle_names[new_surface_obstacle]
                        print(f"[OBSTACLE] 장애물 상태 설정: {obstacle_name} ({new_surface_obstacle})")
                    else:
                        print(f"[OBSTACLE] 잘못된 장애물 상태 값: {new_surface_obstacle} (허용: 0-2)")
                except ValueError:
                    print(f"[OBSTACLE] 잘못된 장애물 상태 형식: {payload}")
            elif topic == "client/connect":
                print("[CONNECT] Client connection detected - Publishing settings...")
                self._publish_all_settings()
            elif topic == "vehicle/linear/speed" or topic == "vehicle/max_speed":
                try:
                    # vehicle/linear/speed는 시뮬레이터가 상태 토픽으로도 발행하므로,
                    # 직전에 스스로 발행한 값의 self-echo는 속도 설정 명령으로 처리하지 않는다.
                    if topic == "vehicle/linear/speed":
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

                    new_max_speed = float(payload)
                    if 0.0 <= new_max_speed <= 27.8:  # 0~100 km/h 범위 제한
                        old_speed = self.max_speed
                        self.max_speed = new_max_speed
                        print(f"[SPEED] 최고 속도 변경({topic}): {old_speed:.1f} -> {new_max_speed:.1f} m/s ({new_max_speed*3.6:.0f} km/h)")
                        
                        # 현재 목표 속도가 새 최고 속도를 초과하면 조정
                        if self.target_speed > self.max_speed:
                            self.target_speed = self.max_speed * 0.9  # 최고 속도의 90%로 조정
                            print(f"[SPEED] 목표 속도 조정: {self.target_speed:.1f} m/s")

                        # 시뮬레이션 정지 상태에서 차량 방향 명령이 활성화되어 있으면,
                        # 최고 속도 변경을 즉시 바퀴 속도에 반영한다.
                        if (
                            not self.simulation_running
                            and self.command in [
                                OperationCommand.FORWARD,
                                OperationCommand.REVERSE,
                                OperationCommand.TURN_LEFT,
                                OperationCommand.TURN_RIGHT,
                            ]
                        ):
                            # 속도 설정은 차량 주행 컨텍스트를 우선한다.
                            self.manual_wheel_test_active = False
                            self.manual_wheel_test_wheel = None
                            self.manual_wheel_test_command = OperationCommand.STOP
                            self._publish_vehicle_command_wheels_when_paused()
                    else:
                        print(f"[SPEED] 잘못된 최고 속도 범위: {new_max_speed:.1f} m/s (허용: 0.0-27.8 m/s, 0-100 km/h)")
                except ValueError:
                    print(f"[SPEED] 잘못된 최고 속도 형식: {payload}")
            elif topic.endswith("/id_request"):
                # wheel/{id}/id_request 처리
                try:
                    # 토픽에서 wheel ID 추출 (wheel/fl/id_request -> fl)
                    parts = topic.split("/")
                    if len(parts) == 3 and parts[0] == "wheel" and parts[2] == "id_request":
                        wheel_str_id = parts[1]
                        if wheel_str_id in WHEEL_ID_MAPPING:
                            wheel_num_id = WHEEL_ID_MAPPING[wheel_str_id]
                            response_topic = f"wheel/{wheel_str_id}/id"
                            self._publish(response_topic, wheel_num_id)
                            print(f"[WHEEL_ID_REQ] Wheel ID 요청 응답: {topic} -> {response_topic} = {wheel_num_id}")
                        else:
                            print(f"[WHEEL_ID_REQ] 알 수 없는 wheel ID: {wheel_str_id}")
                    else:
                        print(f"[WHEEL_ID_REQ] 잘못된 토픽 형식: {topic}")
                except Exception as e:
                    print(f"[WHEEL_ID_REQ] Wheel ID 요청 처리 오류: {e}")
            elif topic.split("/")[-1] == "id" and topic.startswith("wheel/"):
                # wheel/{id}/id 처리 (수신)
                try:
                    # 토픽에서 wheel ID 추출 (wheel/fl/id -> fl)
                    parts = topic.split("/")
                    if len(parts) == 3 and parts[0] == "wheel" and parts[2] == "id":
                        wheel_str_id = parts[1]
                        if wheel_str_id in WHEEL_ID_MAPPING:
                            try:
                                new_wheel_num_id = int(payload)
                                if 1 <= new_wheel_num_id <= 4:  # 1~4 범위 제한
                                    old_id = WHEEL_ID_MAPPING[wheel_str_id]
                                    if old_id != new_wheel_num_id:  # 실제로 값이 변경된 경우만 처리
                                        WHEEL_ID_MAPPING[wheel_str_id] = new_wheel_num_id
                                        print(f"[WHEEL_ID_SET] Wheel ID 변경: {wheel_str_id} {old_id} -> {new_wheel_num_id}")
                                        print(f"[WHEEL_ID_SET] 새로운 ID는 다음 정기 발행에서 반영됩니다.")
                                    else:
                                        print(f"[WHEEL_ID_SET] Wheel ID 동일함: {wheel_str_id} = {new_wheel_num_id} (변경 없음)")
                                else:
                                    print(f"[WHEEL_ID_SET] 잘못된 ID 범위: {new_wheel_num_id} (허용: 1-4)")
                            except ValueError:
                                print(f"[WHEEL_ID_SET] 잘못된 ID 형식: {payload}")
                        else:
                            print(f"[WHEEL_ID_SET] 알 수 없는 wheel ID: {wheel_str_id}")
                    else:
                        print(f"[WHEEL_ID_SET] 잘못된 토픽 형식: {topic}")
                except Exception as e:
                    print(f"[WHEEL_ID_SET] Wheel ID 설정 처리 오류: {e}")
                
        except Exception as e:
            print(f"[MQTT] Message processing error: {e}")
    pass  # _on_message
    
    def _publish_all_settings(self):
        """클라이언트 연결 시 모든 vehicle과 wheel 설정 정보를 publish"""
        try:
            print("[SETTINGS] Publishing all vehicle and wheel settings...")
            
            # Vehicle 설정 정보 publish
            if hasattr(self, 'vehicle_data') and self.vehicle_data:
                for key, value in self.vehicle_data.items():
                    topic = f"vehicle/{key}"
                    payload = str(value)
                    self._publish(topic, payload)
                    print(f"[VEHICLE] Published {topic} -> {payload}")
            else:
                print("[SETTINGS] No vehicle_data available to publish")
            
            # Wheel 설정 정보 publish (1~4번 각각)
            if hasattr(self, 'wheel_data') and self.wheel_data:
                for wheel_id in range(1, 5):  # 1부터 4까지
                    for key, value in self.wheel_data.items():
                        topic = f"wheel/{wheel_id}/{key}"
                        payload = str(value)
                        self._publish(topic, payload)
                        print(f"[WHEEL] Published {topic} -> {payload}")
            else:
                print("[SETTINGS] No wheel_data available to publish")
            
            # Wheel ID 설정 정보 우선 발행 (fl=1, fr=2, rr=3, rl=4)
            print("[SETTINGS] Publishing wheel ID mappings...")
            for wheel_str_id, wheel_num_id in WHEEL_ID_MAPPING.items():
                topic = f"wheel/{wheel_str_id}/id"
                payload = str(wheel_num_id)
                self._publish(topic, payload)
                print(f"[WHEEL_ID] Published {topic} -> {payload}")
            
            # 현재 시뮬레이션 상태 발행
            sim_state = "start" if self.simulation_running else "stop"
            self._publish("simulation/state", sim_state)
            print(f"[SIM] Published simulation/state -> {sim_state}")
            
            print("[SETTINGS] All settings published successfully")
            
        except Exception as e:
            print(f"[SETTINGS] Error publishing settings: {e}")
    
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

    def _wrap_angle_delta(self, delta):
        return (delta + math.pi) % (2 * math.pi) - math.pi

    def _get_circular_hill_route_pose(self, distance_m):
        route_distance = distance_m % self.route_loop_length_m
        theta = (route_distance / self.route_loop_length_m) * (2 * math.pi)

        wobble = self.route_wobble_m * math.sin(3 * theta)
        radius = self.route_radius_m + wobble
        x = self.route_center_x + radius * math.cos(theta)
        y = self.route_center_y + radius * math.sin(theta)
        z = self.route_hill_amplitude_m * math.sin(2 * theta)

        wobble_derivative = 3 * self.route_wobble_m * math.cos(3 * theta)
        dx_dtheta = (-radius * math.sin(theta)) + (wobble_derivative * math.cos(theta))
        dy_dtheta = (radius * math.cos(theta)) + (wobble_derivative * math.sin(theta))
        heading = math.atan2(dy_dtheta, dx_dtheta)

        sector = int(theta / (math.pi / 2)) % 4
        slope = (2 * self.route_hill_amplitude_m * math.cos(2 * theta)) / max(self.route_radius_m, 0.001)

        return x, y, z, heading, sector, slope

    # ===== 시내 도로 주행 시뮬레이션 =====
    def _update_driving_scenario(self):
        """원형 고저차 루프 주행 시나리오 고정"""
        self.scenario_timer += 1
        self.driving_scenario = "circular_hill_loop"
        base_target_speed = min(self.route_base_speed_mps, self.max_speed, self.route_max_speed_mps)

        if self.command == OperationCommand.STOP:
            self.target_speed = 0.0
        else:
            self.target_speed = base_target_speed
            if self.scenario_timer == 1:
                print(
                    f"[ROUTE] 원형 고저차 도로 주행 시작: "
                    f"반지름 {self.route_radius_m:.0f}m, "
                    f"고저차 ±{self.route_hill_amplitude_m:.0f}m, "
                    f"목표 속도 {self.target_speed:.1f} m/s = {self.target_speed * 3.6:.0f} km/h"
                )
    
    def _update_vehicle(self):
        """원형 고저차 경로를 따라 움직이는 차량 데이터 생성"""
        self.elapsed_time += 1  # 초(s)
        
        # 주행 시나리오 업데이트
        self._update_driving_scenario()
        previous_speed = self.current_speed
        previous_angle_speed = self.angle_speed
        previous_heading = self.angle

        route_target_speed = self.target_speed

        command_speed_scale = {
            OperationCommand.STOP: 0.0,
            OperationCommand.FORWARD: 1.0,
            OperationCommand.REVERSE: 0.8,
            OperationCommand.TURN_LEFT: 0.6,
            OperationCommand.TURN_RIGHT: 0.6,
        }
        route_target_speed *= command_speed_scale.get(self.command, 1.0)

        route_distance = self.route_distance_m % self.route_loop_length_m
        _, _, _, _, _, slope = self._get_circular_hill_route_pose(route_distance)
        uphill_penalty = max(0.0, slope) * 1.2
        downhill_bonus = max(0.0, -slope) * 0.6
        route_target_speed = route_target_speed * (1.0 - min(uphill_penalty, 0.28) + min(downhill_bonus, 0.12))
        if self.command == OperationCommand.STOP:
            route_target_speed = 0.0
        else:
            route_target_speed = max(self.route_min_speed_mps, min(route_target_speed, self.route_max_speed_mps))

        speed_diff = route_target_speed - self.current_speed
        max_acceleration = 0.50 if speed_diff > 0 else 0.70
        acceleration = max(-max_acceleration, min(max_acceleration, speed_diff))
        acceleration += random.uniform(-0.04, 0.04)
        acceleration += -slope * 0.12  # 오르막 감속, 내리막 가속

        self.current_speed = max(0.0, self.current_speed + acceleration)
        self.current_speed = min(self.current_speed, max(route_target_speed, 0.0))
        self.current_session_distance += self.current_speed
        self.total_distance += self.current_speed

        self.route_distance_m = (self.route_distance_m + self.current_speed) % self.route_loop_length_m
        self.pos_x, self.pos_y, self.pos_z, self.angle, route_sector_index, slope = self._get_circular_hill_route_pose(self.route_distance_m)
        heading_delta = self._wrap_angle_delta(self.angle - previous_heading)

        self.linear_speed = self.current_speed + random.uniform(-0.05, 0.05)
        self.linear_acc = self.current_speed - previous_speed
        self.angle_speed = heading_delta
        self.angle_acc = self.angle_speed - previous_angle_speed

        # 배터리 소모 (원형 경사로 주행 특성)
        base_consumption = 0.0025
        speed_consumption = self.current_speed * 0.0010
        accel_consumption = abs(self.linear_acc) * 0.0015
        turn_consumption = abs(heading_delta) / math.pi * 0.0012
        slope_consumption = abs(slope) * 0.0015
        total_consumption = base_consumption + speed_consumption + accel_consumption + turn_consumption + slope_consumption
        
        self.battery_voltage -= total_consumption
        self.battery_voltage = max(30.0, self.battery_voltage)  # 최소 전압 제한
        
        # 배터리 부족 시 성능 저하
        battery_percent = (self.battery_voltage / self.battery_max_voltage) * 100
        if battery_percent < 25:
            self.target_speed *= 0.8  # 성능 저하
            if battery_percent < 15:
                self.exec_state = VehicleExecState.STOP
                print(f"[CITY] 배터리 부족으로 차량 정지 ({battery_percent:.1f}%)")
        
        # 노면은 기본적으로 ASPHALT를 유지한다.
        self.surface_state = SurfaceState.ASPHALT
        
        if self.command == OperationCommand.STOP:
            self.exec_state = VehicleExecState.STOP if self.current_speed < 0.05 else VehicleExecState.RUN
        else:
            self.exec_state = VehicleExecState.RUN
    pass  # _update_vehicle

    def _update_wheels(self):
        """시내 주행과 연동된 현실적인 바퀴 데이터 생성"""
        wheel_radius = PASSENGER_CAR_WHEEL_RADIUS_M

        # 노면 상태에 따른 바퀴별 영향 (시내 도로 특성)
        surface_effects = {
            SurfaceState.ASPHALT: {"grip": 1.0, "vibration": 0.05, "power_loss": 1.0, "wear": 0.01},
            SurfaceState.BLOCK: {"grip": 0.8, "vibration": 0.2, "power_loss": 1.2, "wear": 0.02},
            SurfaceState.DIRT_ROAD: {"grip": 0.65, "vibration": 0.35, "power_loss": 1.4, "wear": 0.03},
            SurfaceState.GRAVEL_ROAD: {"grip": 0.6, "vibration": 0.5, "power_loss": 1.5, "wear": 0.04}
        }
        
        effect = surface_effects[self.surface_state]
        
        # 시내 주행 시나리오별 바퀴 부하 특성
        scenario_effects = {
            "circular_hill_loop": {"load_factor": 1.0, "steering_demand": 0.0},
            "city_normal": {"load_factor": 1.0, "steering_demand": 0.1},
            "traffic_light_stop": {"load_factor": 0.3, "steering_demand": 0.0},
            "slow_traffic": {"load_factor": 0.7, "steering_demand": 0.05},
            "accelerating": {"load_factor": 1.4, "steering_demand": 0.08},
            "turning_intersection": {"load_factor": 1.1, "steering_demand": 0.8},
            "pedestrian_caution": {"load_factor": 0.6, "steering_demand": 0.2},
            "parking_maneuver": {"load_factor": 0.5, "steering_demand": 1.0},
            "highway_merge": {"load_factor": 1.2, "steering_demand": 0.3}
        }
        
        scenario_effect = scenario_effects.get(self.driving_scenario, {"load_factor": 1.0, "steering_demand": 0.1})
        
        for wid, w in self.wheels.items():
            # 차량의 제어 상태를 바퀴에 정확히 반영
            if self.exec_state == VehicleExecState.RUN:
                w["state"] = VehicleExecState.RUN
                w["command"] = self.command
            elif self.exec_state == VehicleExecState.STOP:
                w["state"] = VehicleExecState.STOP  
                w["command"] = OperationCommand.STOP
            
            # 바퀴별 위치 차이 (전후좌우 배치 반영)
            wheel_positions = {
                "fl": {"x_offset": 0.75, "y_offset": 0.4},   # Front Left (휠베이스 증가)
                "fr": {"x_offset": 0.75, "y_offset": -0.4},  # Front Right  
                "rl": {"x_offset": -0.75, "y_offset": 0.4},   # Rear Left
                "rr": {"x_offset": -0.75, "y_offset": -0.4}   # Rear Right
            }
            
            # 바퀴 위치를 차체 중심에서 오프셋 (시내 주행의 진동 반영)
            pos = wheel_positions[wid]
            vibration = effect["vibration"] * scenario_effect["load_factor"]
            
            w["x"] = self.pos_x + pos["x_offset"] + random.uniform(-vibration, vibration)
            w["y"] = self.pos_y + pos["y_offset"] + random.uniform(-vibration, vibration)
            w["z"] += random.uniform(-vibration/3, vibration/3)
            
            # 바퀴별 속도 차이 (시내 주행 특성: 좌우 속도 차이, 미끄러짐 등)
            is_front_wheel = wid in ["fl", "fr"]
            is_left_wheel = wid in ["fl", "rl"]
            
            # 기본 속도 연동
            base_speed_factor = random.uniform(0.96, 1.04)  # 바퀴별 속도 차이

            # 차량 명령에 따른 전/후진 부호
            direction_sign = -1.0 if self.command == OperationCommand.REVERSE else 1.0

            # 차량 명령에 따른 좌/우 회전 가중치
            if self.command == OperationCommand.TURN_LEFT:
                command_turn_factor = 0.75 if is_left_wheel else 1.25
            elif self.command == OperationCommand.TURN_RIGHT:
                command_turn_factor = 1.25 if is_left_wheel else 0.75
            else:
                command_turn_factor = 1.0
            
            # 회전시 좌우 바퀴 속도 차이 (디퍼렌셜 효과)
            if self.driving_scenario in ["turning_intersection", "parking_maneuver"]:
                if is_left_wheel:
                    turn_factor = 0.85 if self.angle_speed > 0 else 1.15  # 좌회전시 좌바퀴 느리게
                else:
                    turn_factor = 1.15 if self.angle_speed > 0 else 0.85  # 좌회전시 우바퀴 빠르게
            elif self.driving_scenario == "circular_hill_loop" and abs(self.angle_speed) > 0.001:
                turn_factor = 0.88 if self.angle_speed > 0 else 1.12
            else:
                turn_factor = 1.0
                
            # 최종 바퀴 속도
            w["speed"] = self.current_speed * base_speed_factor * effect["grip"] * turn_factor * command_turn_factor * direction_sign
            
            # 노면과 시나리오에 따른 가속도
            w["acc"] = self.linear_acc * random.uniform(0.9, 1.1) * scenario_effect["load_factor"]
            
            # 바퀴 회전각 (속도에 비례하여 증가, 림 사이즈 고려)
            if abs(w["speed"]) > 0.01:
                rotation_speed = w["speed"] / wheel_radius  # rad/s
                
                # 미끄러짐 효과 (노면 상태에 따라)
                slip_factor = 1.0 - (1.0 - effect["grip"]) * 0.1
                w["angle"] += rotation_speed * slip_factor + random.uniform(-0.08, 0.08)
                w["angle"] = w["angle"] % (2 * math.pi)  # 0~2π 범위로 정규화
                w["angle_speed"] = rotation_speed * slip_factor
            else:
                w["angle_speed"] = 0
            
            w["angle_acc"] = w["acc"] / wheel_radius if wheel_radius > 0 else 0  # 각가속도
            
            # 스티어링 각도 (전륜에만 적용, 시내 주행 특성)
            if is_front_wheel:
                base_steering = scenario_effect["steering_demand"]

                if self.command == OperationCommand.TURN_LEFT:
                    w["axis_angle"] = math.pi / 8
                elif self.command == OperationCommand.TURN_RIGHT:
                    w["axis_angle"] = -math.pi / 8
                elif self.command == OperationCommand.STOP:
                    w["axis_angle"] = 0
                elif self.command in [OperationCommand.FORWARD, OperationCommand.REVERSE]:
                    w["axis_angle"] = random.uniform(-math.pi/48, math.pi/48)
                
                elif self.driving_scenario == "circular_hill_loop":
                    turn_ratio = min(abs(self.angle_speed) / math.pi, 1.0)
                    w["axis_angle"] = (math.pi / 4) * turn_ratio * (1 if self.angle_speed >= 0 else -1)
                elif self.driving_scenario == "turning_intersection":
                    # 교차로 회전: -45° ~ +45°
                    w["axis_angle"] = random.uniform(-math.pi/4, math.pi/4) * base_steering
                elif self.driving_scenario == "parking_maneuver":
                    # 주차: 최대 조향각 사용
                    w["axis_angle"] = random.uniform(-math.pi/3, math.pi/3) * base_steering
                elif self.driving_scenario == "highway_merge":
                    # 고속도로 합류: 미세 조향
                    w["axis_angle"] = random.uniform(-math.pi/18, math.pi/18) * base_steering
                else:
                    # 일반 시내 주행: 차선 유지 조향
                    w["axis_angle"] = random.uniform(-math.pi/24, math.pi/24) + random.uniform(-0.02, 0.02)
            else:
                w["axis_angle"] = 0  # 후륜은 고정
            
            # 토크와 전력 (시내 주행 특성 반영)
            # 기본 토크: 가속도와 속도에 비례
            base_torque = abs(w["speed"]) * 3.5 + abs(w["acc"]) * 2.0
            
            # 시나리오별 토크 조정
            if self.driving_scenario == "traffic_light_stop" and w["speed"] < 0.1:
                base_torque *= 0.2  # 정지시 토크 감소
            elif self.driving_scenario == "accelerating":
                base_torque *= 1.4  # 가속시 토크 증가
            elif self.driving_scenario == "parking_maneuver":
                base_torque *= 0.8  # 주차시 저토크
            
            # 노면 저항과 전륜/후륜 차이
            drive_factor = 1.2 if is_front_wheel else 0.8  # 전륜구동 특성
            w["torque"] = base_torque * effect["power_loss"] * drive_factor + random.uniform(-1.0, 1.0)
            w["torque"] = max(0, w["torque"])  # 음수 방지
            
            # 전력 = 토크 × 각속도 (W)
            w["power"] = w["torque"] * abs(w["angle_speed"]) * 0.8  # 효율성 고려
            w["power"] += random.uniform(-8, 8)  # 전력 변동
            w["power"] = max(0, min(300, w["power"]))  # 0-300W 범위 (도시형 차량)
            
            # PID 제어 값 (노면 상태에 따라 조정)
            target_speed_diff = self.target_speed - w["speed"]
            w["pid_p"] = abs(target_speed_diff) * 0.5  # 비례 제어
            w["pid_i"] += target_speed_diff * 0.01     # 적분 제어 (툄적)
            w["pid_d"] = w["acc"] * 0.1                # 미분 제어
            
            # PID 값 제한
            w["pid_p"] = max(0, min(1, w["pid_p"]))
            w["pid_i"] = max(-0.5, min(0.5, w["pid_i"]))
            w["pid_d"] = max(-1, min(1, w["pid_d"]))
            
            # ToF 센서 (전방 거리 감지, 현실적인 비선형 변화)
            base_distance = random.uniform(0.5, 2.0)  # 기본 거리
            
            # 속도가 빠를수록 전방 감지 배리어 감소 (가상의 장애물 효과)
            if self.current_speed > 1.5:
                base_distance *= random.uniform(0.7, 1.0)
            elif self.current_speed > 1.0:
                base_distance *= random.uniform(0.8, 1.0)
                
            w["tof_distance"] = base_distance + random.uniform(-0.1, 0.1)
            w["tof_calib"] = random.uniform(0.95, 1.05)  # 보정 계수
    pass  # _update_wheels

    # ===== Publish =====
    def _publish(self, topic, value):
        # 시뮬레이션 중지 상태에서는 동적 토픽의 연속 발행을 차단한다.
        if not self.simulation_running and not self.allow_publish_while_stopped:
            blocked_while_stopped = (
                topic.startswith("wheel/")
                or topic.startswith("vehicle/linear/")
                or topic.startswith("vehicle/angle/")
                or topic.startswith("vehicle/position/")
                or topic == "vehicle/driving/current_speed"
                or topic == "vehicle/driving/speed_kmh"
                or topic == "vehicle/driving/target_speed"
                or topic == "vehicle/driving/target_speed_kmh"
            )
            if blocked_while_stopped:
                return

        # topic과 value만 직접 발행 (JSON 포장 없이)
        payload = str(value)
        self.client.publish(topic, payload, retain=True)

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
        
        self._publish("vehicle/surface/state", self.surface_state.value)
        self._publish("vehicle/surface/obstacle", self.surface_obstacle.value)

        # SI 단위계: 속도(m/s), 각속도(rad/s)
        max_speed_rounded = round(self.max_speed, 2)
        if self.last_vehicle_max_speed_published != max_speed_rounded:
            self._publish("vehicle/max_speed", max_speed_rounded)  # m/s (동적 값)
            self.last_vehicle_max_speed_published = max_speed_rounded
        self._publish("vehicle/max_angular_speed", 1.0)  # rad/s

        # 동적 상태 정보는 변경 시에만 발행
        if self.last_vehicle_command_published != self.command.value:
            self._publish("vehicle/operation/command", self.command.value)
            self.last_vehicle_command_published = self.command.value

        if self.last_vehicle_state_published != self.exec_state.value:
            self._publish("vehicle/operation/state", self.exec_state.value)
            self.last_vehicle_state_published = self.exec_state.value
        
        # 주행 시나리오 정보 및 시내 주행 특성 추가
        self._publish("vehicle/driving/scenario", self.driving_scenario)
        self._publish("vehicle/driving/target_speed", round(self.target_speed, 2))
        self._publish("vehicle/driving/current_speed", round(self.current_speed, 2))
        
        # 시내 주행 전용 정보
        self._publish("vehicle/driving/speed_kmh", round(self.current_speed * 3.6, 1))  # km/h로 변환
        self._publish("vehicle/driving/target_speed_kmh", round(self.target_speed * 3.6, 1))  # km/h로 변환
        self._publish("vehicle/driving/distance_km", round(self.total_distance / 1000, 3))  # 총 주행거리(km)
        
        # 시내 주행 안전 정보
        safety_score = 100  # 기본 안전 점수
        if self.driving_scenario == "pedestrian_caution":
            safety_score = 95  # 보행자 주의시 안전도 하락
        elif self.driving_scenario == "traffic_light_stop":
            safety_score = 100  # 신호 준수시 만점
        elif self.surface_state in [SurfaceState.DIRT_ROAD, SurfaceState.GRAVEL_ROAD]:
            safety_score = max(70, safety_score - 20)  # 위험 노면에서 안전도 하락
        
        self._publish("vehicle/safety/score", safety_score)
        
        # 시내 교통 상황 시뮬레이션
        if self.driving_scenario == "slow_traffic":
            self._publish("vehicle/traffic/congestion_level", random.randint(60, 90))  # 정체도 %
        else:
            self._publish("vehicle/traffic/congestion_level", random.randint(0, 30))   # 원활함
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

    def _publish_wheels(self):
        # SI 단위계: 각 바퀴별 데이터 발행
        for wid, w in self.wheels.items():
            base = f"wheel/{wid}"
            
            # 바퀴 ID 번호는 정기 발행에서 제외 (요청 시 또는 변경 시에만 발행)
            # wheel_id_num = WHEEL_ID_MAPPING.get(wid, 0)
            # self._publish(f"{base}/id", wheel_id_num)

            # 위치: 미터(m)
            self._publish(f"{base}/position/x", round(w["x"], 3))  # m
            self._publish(f"{base}/position/y", round(w["y"], 3))  # m  
            self._publish(f"{base}/position/z", round(w["z"], 3))  # m

            # 선속도: m/s, 가속도: m/s²
            self._publish(f"{base}/linear/speed", round(w["speed"], 3))  # m/s
            self._publish(f"{base}/linear/acceleration", round(w["acc"], 3))  # m/s²

            # 각도: radian, 각속도: rad/s, 각가속도: rad/s²
            self._publish(f"{base}/angle/radian", round(w["angle"], 4))  # rad (바퀴 회전각)
            self._publish(f"{base}/angle/speed", round(w["angle_speed"], 3))  # rad/s
            self._publish(f"{base}/angle/acceleration", round(w["angle_acc"], 3))  # rad/s²
            self._publish(f"{base}/axis/angle", round(w["axis_angle"], 4))  # rad (스티어링 각도)

            # 토크: Nm, 전력: W
            self._publish(f"{base}/torque", round(w["torque"], 2))  # Nm (뉴턴미터)
            self._publish(f"{base}/power", round(w["power"], 1))  # W (와트)

            # PID 제어값 (무차원)
            self._publish(f"{base}/pid/p", round(w["pid_p"], 3))
            self._publish(f"{base}/pid/i", round(w["pid_i"], 3))
            self._publish(f"{base}/pid/d", round(w["pid_d"], 3))

            # ToF 센서: 거리(m), 보정값(무차원)
            self._publish(f"{base}/tof/distance", round(w["tof_distance"], 3))  # m
            self._publish(f"{base}/tof/calibration", round(w["tof_calib"], 3))

            # 운영 상태
            self._publish(f"{base}/operation/command", w["command"].value)
            self._publish(f"{base}/operation/state", w["state"].value)
    pass  # _publish_wheels

    def _publish_manual_wheel_simulation(self):
        target_wheel = self.manual_wheel_test_wheel
        if not self.manual_wheel_test_active or target_wheel not in self.wheels:
            return

        self.allow_publish_while_stopped = True
        try:
            cmd = self.manual_wheel_test_command
            if cmd == OperationCommand.FORWARD:
                angular_speed = self.manual_wheel_test_angular_speed
                state = VehicleExecState.RUN
            elif cmd == OperationCommand.REVERSE:
                angular_speed = -self.manual_wheel_test_angular_speed
                state = VehicleExecState.RUN
            else:
                angular_speed = 0.0
                state = VehicleExecState.STOP

            for wid, wheel in self.wheels.items():
                if wid == target_wheel:
                    wheel["command"] = cmd
                    wheel["state"] = state
                    wheel["angle_speed"] = angular_speed
                    wheel["angle_acc"] = 0.0
                    wheel["speed"] = 0.0
                    wheel["acc"] = 0.0
                    wheel["angle"] = (wheel["angle"] + angular_speed) % (2 * math.pi)
                else:
                    wheel["command"] = OperationCommand.STOP
                    wheel["state"] = VehicleExecState.STOP
                    wheel["angle_speed"] = 0.0
                    wheel["angle_acc"] = 0.0
                    wheel["speed"] = 0.0
                    wheel["acc"] = 0.0

                base = f"wheel/{wid}"
                self._publish(f"{base}/angle/radian", round(wheel["angle"], 4))
                self._publish(f"{base}/angle/speed", round(wheel["angle_speed"], 3))
                self._publish(f"{base}/angle/acceleration", round(wheel["angle_acc"], 3))
                self._publish(f"{base}/linear/speed", round(wheel["speed"], 3))
                self._publish(f"{base}/linear/acceleration", round(wheel["acc"], 3))
                self._publish(f"{base}/operation/command", wheel["command"].value)
                self._publish(f"{base}/operation/state", wheel["state"].value)

            print(
                f"[WHEEL_TEST] 발행: {target_wheel.upper()} command={cmd.value} "
                f"angle_speed={angular_speed:.3f} rad/s"
            )
        finally:
            self.allow_publish_while_stopped = False
    pass  # _publish_manual_wheel_simulation

    def _publish_vehicle_command_wheels_when_paused(self):
        """시뮬레이션 재개 없이 차량 명령에 맞춰 휠 속도만 즉시 반영"""
        self.allow_publish_while_stopped = True
        try:
            wheel_radius = PASSENGER_CAR_WHEEL_RADIUS_M
            base_speed = max(0.0, self.max_speed)
            command_speed_scale = {
                OperationCommand.STOP: 0.0,
                OperationCommand.FORWARD: 1.0,
                OperationCommand.REVERSE: 0.8,
                OperationCommand.TURN_LEFT: 0.6,
                OperationCommand.TURN_RIGHT: 0.6,
            }
            effective_speed = base_speed * command_speed_scale.get(self.command, 1.0)
            direction_sign = -1.0 if self.command == OperationCommand.REVERSE else 1.0
            self.ignore_wheel_command_until = time.time() + 2.0

            for wid, wheel in self.wheels.items():
                is_left_wheel = wid in ["fl", "rl"]
                is_front_wheel = wid in ["fl", "fr"]

                if self.command == OperationCommand.STOP:
                    wheel_speed = 0.0
                    axis_angle = 0.0
                    wheel_state = VehicleExecState.STOP
                elif self.command == OperationCommand.TURN_LEFT:
                    wheel_speed = effective_speed * (0.7 if is_left_wheel else 1.3)
                    axis_angle = math.pi / 8 if is_front_wheel else 0.0
                    wheel_state = VehicleExecState.RUN
                elif self.command == OperationCommand.TURN_RIGHT:
                    wheel_speed = effective_speed * (1.3 if is_left_wheel else 0.7)
                    axis_angle = -math.pi / 8 if is_front_wheel else 0.0
                    wheel_state = VehicleExecState.RUN
                else:
                    wheel_speed = effective_speed
                    axis_angle = 0.0
                    wheel_state = VehicleExecState.RUN

                wheel_speed *= direction_sign
                wheel_angle_speed = wheel_speed / wheel_radius if wheel_radius > 0 else 0.0

                wheel["command"] = self.command
                wheel["state"] = wheel_state
                wheel["speed"] = wheel_speed
                wheel["acc"] = 0.0
                wheel["angle_speed"] = wheel_angle_speed
                wheel["angle_acc"] = 0.0
                wheel["axis_angle"] = axis_angle

                base = f"wheel/{wid}"
                self._publish(f"{base}/linear/speed", round(wheel["speed"], 3))
                self._publish(f"{base}/linear/acceleration", 0)
                self._publish(f"{base}/angle/speed", round(wheel["angle_speed"], 3))
                self._publish(f"{base}/angle/acceleration", 0)
                self._publish(f"{base}/axis/angle", round(wheel["axis_angle"], 4))
                self._publish(f"{base}/operation/command", wheel["command"].value)
                self._publish(f"{base}/operation/state", wheel["state"].value)

            self.current_speed = 0.0 if self.command == OperationCommand.STOP else abs(effective_speed)
            self.linear_speed = self.current_speed
            self.linear_acc = 0.0
            self.angle_speed = 0.0
            self.angle_acc = 0.0

            # 시뮬레이션 정지 모드에서도 차량 속도/상태 토픽을 즉시 발행해
            # 프론트엔드의 "속도 0 -> 정지 버튼 자동 클릭" 로직이 동작하도록 한다.
            self._publish("vehicle/driving/current_speed", round(self.current_speed, 3))
            self._publish("vehicle/driving/speed_kmh", round(self.current_speed * 3.6, 1))
            self._publish("vehicle/linear/speed", round(self.linear_speed, 3))
            self._publish("vehicle/operation/state", self.exec_state.value)
        finally:
            self.allow_publish_while_stopped = False
    pass  # _publish_vehicle_command_wheels_when_paused

    def run(self):
        self.client.connect(self.broker, self.port, 60)
        self.client.loop_start()
        
        print(f"[SIMULATOR] 시작 - PID: {os.getpid()}")
        print(f"[MONITOR] 파일 모니터링: {self.script_path}")
        print("[ROUTE] 🛣️  원형 고저차 도로 주행 시뮬레이션 시작")
        print(f"[INFO] 중심 반경: {self.route_radius_m:.0f}m")
        print(f"[INFO] 좌우 굴곡: ±{self.route_wobble_m:.0f}m")
        print(f"[INFO] 오르막/내리막: ±{self.route_hill_amplitude_m:.0f}m")
        print(f"[INFO] 경로 길이(근사): {self.route_loop_length_m:.0f}m")
        print("[INFO] 경로: 원형 루프를 따라 좌회전/우회전이 반복되고, 고저차가 함께 변함")
        print("[INFO] 노면 상태: ASPHALT(0), BLOCK(1), DIRT_ROAD(2), GRAVEL_ROAD(3)")
        print("[INFO] 장애물 상태: NONE(0), ICE(1), POT_HOLE(2)")
        print("[INFO] 주행 속도: 0-70 km/h (0-19.4 m/s)")
        print("[INFO] 실행 상태: IDLE(0)=정지, RUNNING(1)=주행")
        print("[INFO] 데이터: vehicle/ 및 wheel/ 토픽만 발행 (기존 토픽 구조 유지)")
        print("-" * 70)
        
        loop_count = 0
        while self.running and not _shutdown_flag:
            try:
                # 매 10주기마다 파일 변경 확인 (10초마다)
                if loop_count % 10 == 0:
                    self._check_file_changes()
                
                # 매 30초마다 상태 요약 출력 (시내 주행 정보)
                if loop_count % 30 == 0 and loop_count > 0:
                    battery_percent = (self.battery_voltage / self.battery_max_voltage) * 100
                    kmh_speed = self.current_speed * 3.6  # km/h 변환
                    total_km = self.total_distance / 1000  # 총 주행거리(km)
                    
                    # 상태별 아이콘과 설명
                    state_icons = {
                        VehicleExecState.STOP: "🔴 정지",
                        VehicleExecState.RUN: "🟢 주행중"
                    }
                    state_display = state_icons.get(self.exec_state, "❓ 알수없음")
                    
                    print(f"\n[ROUTE STATUS] 경과: {self.elapsed_time}s | 경로: {self.driving_scenario}")
                    print(f"[ROUTE STATUS] 속도: {kmh_speed:.1f} km/h ({self.current_speed:.2f} m/s) | 목표: {self.target_speed*3.6:.0f} km/h")
                    print(f"[ROUTE STATUS] 배터리: {battery_percent:.1f}% ({self.battery_voltage:.1f}V) | 노면: {self.surface_state.name} | 장애물: {self.surface_obstacle.name}")
                    print(f"[ROUTE STATUS] 위치: ({self.pos_x:.1f}m, {self.pos_y:.1f}m, {self.pos_z:.1f}m) | 주행거리: {total_km:.2f}km")
                    print(f"[ROUTE STATUS] 발행 토픽: {self.publish_count}개 | 상태: {state_display} ({self.exec_state.value})")
                    print("-" * 70)
                
                if self.simulation_running:
                    self._update_vehicle()
                    self._update_wheels()
        
                    self._publish_vehicle()
                    self._publish_position()
                    self._publish_wheels()
                else:
                    print("[SIM] 시뮬레이션 일시정지 중...")
    
                loop_count += 1
                time.sleep(1)
                
            except KeyboardInterrupt:
                print("\n[SIMULATOR] 사용자 중단 요청")
                break
            except Exception as e:
                print(f"[SIMULATOR] 실행 오류: {e}")
                time.sleep(1)
        
        self._cleanup()
        print("[CITY] 🏁 시내 도로 주행 시뮬레이션 종료")
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