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


class ExecState(IntEnum):
    IDLE = 0
    RUNNING = 1
    SUCCESS = 2
    FAIL = 3


class SurfaceState(IntEnum):
    ROAD = 0
    GRAVEL = 1
    ICE = 2
    POTHOLE = 3


WHEEL_IDS = ["fl", "fr", "rr", "rl"]

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

        self.broker = broker
        self.port = port

        # vehicle 상태
        self.elapsed_time = 0
        self.total_distance = 0.0  # 총 주행시간(초)을 거리처럼 사용
        self.current_session_distance = 0.0  # 현재 세션 거리
        self.battery_voltage = 48.0
        self.battery_max_voltage = 48.0  # 배터리 최대 전압 (100% 기준)
        self.exec_state = ExecState.RUNNING
        self.command = OperationCommand.FORWARD
        self.surface_state = SurfaceState.ROAD  # 초기 노면 상태
        
        # 시뮬레이션 제어 변수
        self.driving_scenario = "normal"  # normal, accelerating, decelerating, turning
        self.scenario_timer = 0
        self.target_speed = 1.5  # 목표 속도 (m/s)
        self.current_speed = 0.0  # 현재 실제 속도

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
        
        # 재시작 및 모니터링
        self.running = True
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
            "state": ExecState.IDLE,
        }
    pass  # _init_wheel

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        print("MQTT Connected:", reason_code)
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

    # ===== 현실적인 차량 주행 시뮬레이션 =====
    def _update_driving_scenario(self):
        """주행 시나리오 업데이트 (가속, 감속, 회전, 정상주행)"""
        self.scenario_timer += 1
        
        # 시나리오 변경 (15~30초마다)
        if self.scenario_timer >= random.randint(15, 30):
            scenarios = ["normal", "accelerating", "decelerating", "turning", "stopping"]
            weights = [40, 20, 20, 15, 5]  # 정상주행이 가장 높은 확률
            self.driving_scenario = random.choices(scenarios, weights=weights)[0]
            self.scenario_timer = 0
            
            # 시나리오별 목표 속도 설정
            if self.driving_scenario == "normal":
                self.target_speed = random.uniform(1.0, 2.0)
            elif self.driving_scenario == "accelerating":
                self.target_speed = random.uniform(1.8, 2.5)
            elif self.driving_scenario == "decelerating":
                self.target_speed = random.uniform(0.3, 1.0)
            elif self.driving_scenario == "turning":
                self.target_speed = random.uniform(0.5, 1.2)
            elif self.driving_scenario == "stopping":
                self.target_speed = 0.0
                self.exec_state = ExecState.IDLE
            
            print(f"[SIMULATOR] 주행 시나리오 변경: {self.driving_scenario} (목표속도: {self.target_speed:.2f} m/s)")
    
    def _update_vehicle(self):
        """물리법칙을 반영한 현실적인 차량 데이터 생성"""
        self.elapsed_time += 1  # 초(s)
        
        # 주행 시나리오 업데이트
        self._update_driving_scenario()
        
        # 노면 상태에 따른 성능 변화
        surface_factors = {
            SurfaceState.ROAD: {"speed_factor": 1.0, "power_factor": 1.0, "efficiency": 0.95},
            SurfaceState.GRAVEL: {"speed_factor": 0.8, "power_factor": 1.3, "efficiency": 0.85},
            SurfaceState.ICE: {"speed_factor": 0.6, "power_factor": 1.1, "efficiency": 0.90},
            SurfaceState.POTHOLE: {"speed_factor": 0.4, "power_factor": 1.8, "efficiency": 0.75}
        }
        
        factor = surface_factors[self.surface_state]
        adjusted_target = self.target_speed * factor["speed_factor"]
        
        # 실제 속도를 목표 속도에 점진적으로 접근 (관성 시뮬레이션)
        speed_diff = adjusted_target - self.current_speed
        max_acceleration = 0.5  # 최대 가속도 m/s²
        
        if abs(speed_diff) > 0.01:  # 속도 차이가 있을 때만 변경
            acceleration = min(max_acceleration, abs(speed_diff)) * (1 if speed_diff > 0 else -1)
            self.current_speed += acceleration
            self.current_speed = max(0, self.current_speed)  # 음수 방지
        
        # 물리법칙: 거리 = 속도 × 시간
        distance_increment = self.current_speed * 1.0  # 1초 간격
        self.current_session_distance += distance_increment
        self.total_distance += 1  # 총 주행시간(초)을 distance로 사용
        
        # 위치 업데이트 (실제 이동 반영)
        if self.current_speed > 0:
            # 주행 방향에 따른 위치 변화
            if self.driving_scenario == "turning":
                # 회전 시 곡선 이동
                self.pos_x += self.current_speed * 0.8 * math.cos(self.angle)
                self.pos_y += self.current_speed * 0.8 * math.sin(self.angle)
                self.angle += random.uniform(-0.1, 0.1)  # 회전각 변화
            else:
                # 직진 이동
                self.pos_x += self.current_speed * math.cos(self.angle) + random.uniform(-0.1, 0.1)
                self.pos_y += self.current_speed * math.sin(self.angle) + random.uniform(-0.1, 0.1)
        
        # 속도와 가속도 계산
        self.linear_speed = self.current_speed + random.uniform(-0.05, 0.05)  # 약간의 노이즈
        self.linear_acc = (adjusted_target - self.current_speed) * 2  # 목표 속도와의 차이 기반 가속도
        
        # 각속도 (회전 상황에서만 발생)
        if self.driving_scenario == "turning":
            self.angle_speed = self.current_speed * 0.5 + random.uniform(-0.1, 0.1)
            self.angle_acc = random.uniform(-0.2, 0.2)
        else:
            self.angle_speed = random.uniform(-0.1, 0.1)
            self.angle_acc = random.uniform(-0.05, 0.05)
        
        # 배터리 소모 (속도, 노면상태, 전력 사용량에 따라)
        base_consumption = 0.002  # 기본 소모량
        speed_consumption = self.current_speed * 0.001  # 속도에 비례
        surface_consumption = base_consumption * (2.0 - factor["efficiency"])  # 노면 효율성
        total_consumption = (base_consumption + speed_consumption + surface_consumption) * factor["power_factor"]
        
        self.battery_voltage -= total_consumption
        self.battery_voltage = max(30.0, self.battery_voltage)  # 최소 전압 제한
        
        # 배터리 부족 시 성능 저하
        battery_percent = (self.battery_voltage / self.battery_max_voltage) * 100
        if battery_percent < 20:
            self.target_speed *= 0.7  # 성능 저하
            if battery_percent < 10:
                self.exec_state = ExecState.IDLE
                print(f"[SIMULATOR] 배터리 부족으로 차량 정지 ({battery_percent:.1f}%)")
        
        # 상태 변경 (20초마다 노면 상태 변경)
        if self.elapsed_time % 20 == 0 and self.exec_state == ExecState.RUNNING:
            # 노면 상태 변경 (현실적인 확률)
            surface_weights = [60, 20, 10, 10]  # ROAD가 가장 높은 확률
            self.surface_state = random.choices(list(SurfaceState), weights=surface_weights)[0]
            surface_names = ['ROAD', 'GRAVEL', 'ICE', 'POTHOLE']
            surface_name = surface_names[self.surface_state.value]
            print(f"[SIMULATOR] 노면 상태 변경: {surface_name} ({self.surface_state.value})")
        
        # 실행 상태 관리
        if self.driving_scenario == "stopping":
            if self.current_speed < 0.1:
                self.exec_state = ExecState.IDLE
        else:
            self.exec_state = ExecState.RUNNING
    pass  # _update_vehicle

    def _update_wheels(self):
        """차량 상태와 연동된 현실적인 바퀴 데이터 생성"""
        # 노면 상태에 따른 바퀴별 영향
        surface_effects = {
            SurfaceState.ROAD: {"grip": 1.0, "vibration": 0.1, "power_loss": 1.0},
            SurfaceState.GRAVEL: {"grip": 0.7, "vibration": 0.3, "power_loss": 1.4},
            SurfaceState.ICE: {"grip": 0.3, "vibration": 0.1, "power_loss": 1.1},
            SurfaceState.POTHOLE: {"grip": 0.8, "vibration": 0.8, "power_loss": 1.6}
        }
        
        effect = surface_effects[self.surface_state]
        
        for wid, w in self.wheels.items():
            # 차량의 제어 상태를 바퀴에 반영
            if self.exec_state == ExecState.RUNNING:
                w["state"] = ExecState.RUNNING
                w["command"] = self.command
            else:
                w["state"] = ExecState.IDLE  
                w["command"] = OperationCommand.STOP
            
            # 바퀴별 위치 차이 (전후좌우 배치 반영)
            wheel_positions = {
                "fl": {"x_offset": 0.6, "y_offset": 0.4},   # Front Left
                "fr": {"x_offset": 0.6, "y_offset": -0.4},  # Front Right  
                "rl": {"x_offset": -0.6, "y_offset": 0.4},   # Rear Left
                "rr": {"x_offset": -0.6, "y_offset": -0.4}   # Rear Right
            }
            
            # 바퀴 위치를 차체 중심에서 오프셋
            pos = wheel_positions[wid]
            w["x"] = self.pos_x + pos["x_offset"] + random.uniform(-effect["vibration"], effect["vibration"])
            w["y"] = self.pos_y + pos["y_offset"] + random.uniform(-effect["vibration"], effect["vibration"])
            w["z"] += random.uniform(-effect["vibration"]/2, effect["vibration"]/2)
            
            # 바퀴 속도를 차량 속도와 연동 (차량 속도 ± 5% 오차)
            speed_variation = random.uniform(0.95, 1.05)  # 바퀴별 약간의 속도 차이
            w["speed"] = self.current_speed * speed_variation * effect["grip"]
            
            # 가속도는 차량 가속도와 비슷하게
            w["acc"] = self.linear_acc + random.uniform(-0.1, 0.1)
            
            # 바퀴 회전각 (속도에 비례하여 증가)
            if w["speed"] > 0:
                wheel_circumference = 0.2 * math.pi  # 바퀴 둘레 (0.2m 지름 가정)
                rotation_speed = w["speed"] / wheel_circumference  # rad/s
                w["angle"] += rotation_speed + random.uniform(-0.1, 0.1)
                w["angle"] = w["angle"] % (2 * math.pi)  # 0~2π 범위로 정규화
                w["angle_speed"] = rotation_speed
            else:
                w["angle_speed"] = 0
            
            w["angle_acc"] = w["acc"] / 0.1  # 바퀴 관성 고려
            
            # 스티어링 각도 (전륜 바퀴에만 적용)
            if wid in ["fl", "fr"]:
                if self.driving_scenario == "turning":
                    base_steering = random.uniform(-math.pi/6, math.pi/6)  # ±30도 범위
                    w["axis_angle"] = base_steering + random.uniform(-0.05, 0.05)
                else:
                    w["axis_angle"] = random.uniform(-math.pi/36, math.pi/36)  # ±5도 (공도 보정량)
            else:
                w["axis_angle"] = 0  # 후륜 바퀴는 고정
            
            # 토크와 전력 (속도와 노면 상태에 비례)
            base_torque = abs(w["speed"]) * 2.0 + abs(w["acc"]) * 1.5  # 기본 토크
            w["torque"] = base_torque * effect["power_loss"] + random.uniform(-0.5, 0.5)
            w["torque"] = max(0, w["torque"])  # 음수 방지
            
            # 전력 = 토크 × 각속도
            w["power"] = w["torque"] * abs(w["angle_speed"]) + random.uniform(-5, 5)
            w["power"] = max(0, min(200, w["power"]))  # 0-200W 범위
            
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
        # topic과 value만 직접 발행 (JSON 포장 없이)
        payload = str(value)
        self.client.publish(topic, payload, retain=True)
        
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

        # SI 단위계: 속도(m/s), 각속도(rad/s)
        self._publish("vehicle/max_speed", 2.0)  # m/s
        self._publish("vehicle/max_angular_speed", 1.0)  # rad/s

        # 동적 상태 정보
        self._publish("vehicle/operation/command", self.command.value)
        self._publish("vehicle/operation/state", self.exec_state.value)
        
        # 주행 시나리오 정보 추가
        self._publish("vehicle/driving/scenario", self.driving_scenario)
        self._publish("vehicle/driving/target_speed", round(self.target_speed, 2))
        self._publish("vehicle/driving/current_speed", round(self.current_speed, 2))
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

    def run(self):
        self.client.connect(self.broker, self.port, 60)
        self.client.loop_start()
        
        print(f"[SIMULATOR] 시작 - PID: {os.getpid()}")
        print(f"[MONITOR] 파일 모니터링: {self.script_path}")
        print("[SIMULATOR] 🚗 현실적인 차량 주행 시뮬레이션 시작")
        print("[INFO] 주행 시나리오: normal, accelerating, decelerating, turning, stopping")
        print("[INFO] 노면 상태: ROAD, GRAVEL, ICE, POTHOLE")
        print("[INFO] 데이터: vehicle/ 및 wheel/ 토픽만 발행")
        print("-" * 60)
        
        loop_count = 0
        while self.running and not _shutdown_flag:
            try:
                # 매 10주기마다 파일 변경 확인 (10초마다)
                if loop_count % 10 == 0:
                    self._check_file_changes()
                
                # 매 30초마다 상태 요약 출력
                if loop_count % 30 == 0 and loop_count > 0:
                    battery_percent = (self.battery_voltage / self.battery_max_voltage) * 100
                    print(f"\n[STATUS] 경과시간: {self.elapsed_time}s | 시나리오: {self.driving_scenario} | 속도: {self.current_speed:.2f}m/s")
                    print(f"[STATUS] 배터리: {battery_percent:.1f}% ({self.battery_voltage:.1f}V) | 노면: {['ROAD','GRAVEL','ICE','POTHOLE'][self.surface_state.value]}")
                    print(f"[STATUS] 위치: ({self.pos_x:.1f}, {self.pos_y:.1f}) | 총 발행: {self.publish_count}개")
                    print("-" * 60)
                
                self._update_vehicle()
                self._update_wheels()
    
                self._publish_vehicle()
                self._publish_position()
                self._publish_wheels()
    
                loop_count += 1
                time.sleep(1)
                
            except KeyboardInterrupt:
                print("\n[SIMULATOR] 사용자 중단 요청")
                break
            except Exception as e:
                print(f"[SIMULATOR] 실행 오류: {e}")
                time.sleep(1)
        
        self._cleanup()
        print("[SIMULATOR] 🏁 시뮬레이션 종료")
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
        print("Starting WCS MQTT Full Simulator")
        print(f"OS: {platform.system()}")
        print(f"MQTT Broker: {BROKER}:{PORT}")
        print(f"PID: {os.getpid()}")
        print("[SERVICE] systemd 서비스 관리 모드")
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