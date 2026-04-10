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
    IDLE = 0
    RUNNING = 1


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
        self.exec_state = VehicleExecState.RUNNING
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
            "state": VehicleExecState.IDLE,
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

    # ===== 시내 도로 주행 시뮬레이션 =====
    def _update_driving_scenario(self):
        """시내 도로 주행 시나리오 업데이트 (신호등, 교차로, 정체 등)"""
        self.scenario_timer += 1
        
        # 시나리오 변경 (8~25초마다 - 도시 주행 특성)
        if self.scenario_timer >= random.randint(8, 25):
            # 시내 주행 특화 시나리오
            scenarios = ["city_normal", "traffic_light_stop", "slow_traffic", "accelerating", 
                        "turning_intersection", "pedestrian_caution", "parking_maneuver", "highway_merge"]
            weights = [35, 15, 20, 10, 8, 7, 3, 2]  # 일반 주행이 높고, 주차는 낮은 확률
            self.driving_scenario = random.choices(scenarios, weights=weights)[0]
            self.scenario_timer = 0
            
            # 시내 주행별 목표 속도 설정 (km/h 기준으로 생각한 후 m/s로 변환)
            if self.driving_scenario == "city_normal":
                self.target_speed = random.uniform(8.3, 13.9)  # 30-50km/h → m/s
            elif self.driving_scenario == "traffic_light_stop":
                self.target_speed = 0.0  # 완전 정지
                self.exec_state = VehicleExecState.IDLE
            elif self.driving_scenario == "slow_traffic":
                self.target_speed = random.uniform(2.8, 8.3)  # 10-30km/h → m/s
            elif self.driving_scenario == "accelerating":
                self.target_speed = random.uniform(11.1, 16.7)  # 40-60km/h → m/s
            elif self.driving_scenario == "turning_intersection":
                self.target_speed = random.uniform(2.8, 8.3)  # 회전시 저속
            elif self.driving_scenario == "pedestrian_caution":
                self.target_speed = random.uniform(1.4, 5.6)  # 5-20km/h → m/s
            elif self.driving_scenario == "parking_maneuver":
                self.target_speed = random.uniform(0.3, 1.4)  # 주차시 극저속
            elif self.driving_scenario == "highway_merge":
                self.target_speed = random.uniform(13.9, 19.4)  # 50-70km/h → m/s
            
            print(f"[CITY] 시내 주행 시나리오: {self.driving_scenario} (목표: {self.target_speed:.1f} m/s = {self.target_speed*3.6:.0f} km/h)")
    
    def _update_vehicle(self):
        """시내 도로 주행에 특화된 현실적인 차량 데이터 생성"""
        self.elapsed_time += 1  # 초(s)
        
        # 주행 시나리오 업데이트
        self._update_driving_scenario()
        
        # 노면 상태에 따른 성능 변화 (도시 도로 특성 반영)
        surface_factors = {
            SurfaceState.ROAD: {"speed_factor": 1.0, "power_factor": 1.0, "efficiency": 0.95},
            SurfaceState.GRAVEL: {"speed_factor": 0.7, "power_factor": 1.4, "efficiency": 0.80},
            SurfaceState.ICE: {"speed_factor": 0.4, "power_factor": 1.2, "efficiency": 0.85},
            SurfaceState.POTHOLE: {"speed_factor": 0.5, "power_factor": 2.0, "efficiency": 0.70}
        }
        
        factor = surface_factors[self.surface_state]
        adjusted_target = self.target_speed * factor["speed_factor"]
        
        # 시내 주행 특성: 급가속/급감속이 빈번함
        speed_diff = adjusted_target - self.current_speed
        
        # 가속도를 시나리오별로 차별화
        if self.driving_scenario == "traffic_light_stop":
            max_acceleration = 1.2  # 신호등 급제동
        elif self.driving_scenario == "accelerating" or self.driving_scenario == "highway_merge":
            max_acceleration = 0.8  # 가속 구간
        elif self.driving_scenario == "pedestrian_caution" or self.driving_scenario == "parking_maneuver":
            max_acceleration = 0.3  # 조심스러운 주행
        elif self.driving_scenario == "slow_traffic":
            max_acceleration = 0.4  # 정체 구간
        else:
            max_acceleration = 0.6  # 일반 주행
        
        if abs(speed_diff) > 0.02:  # 속도 차이가 있을 때만 변경
            acceleration = min(max_acceleration, abs(speed_diff)) * (1 if speed_diff > 0 else -1)
            
            # 시내 주행 특성: 약간의 불규칙성 추가
            acceleration += random.uniform(-0.05, 0.05)
            
            self.current_speed += acceleration
            self.current_speed = max(0, self.current_speed)  # 음수 방지
        
        # 거리 계산: 실제 이동 거리
        distance_increment = self.current_speed * 1.0  # 1초 간격
        self.current_session_distance += distance_increment
        self.total_distance += distance_increment  # 실제 주행 거리로 변경
        
        # 위치 업데이트 (시내 도로 주행 패턴)
        if self.current_speed > 0:
            if self.driving_scenario in ["turning_intersection", "parking_maneuver"]:
                # 교차로 회전이나 주차시 곡선 이동
                turn_rate = 0.15 if self.driving_scenario == "parking_maneuver" else 0.08
                self.angle += random.uniform(-turn_rate, turn_rate)
                self.pos_x += self.current_speed * 0.9 * math.cos(self.angle)
                self.pos_y += self.current_speed * 0.9 * math.sin(self.angle)
            elif self.driving_scenario == "highway_merge":
                # 고속도로 합류시 약간의 사선 이동
                self.pos_x += self.current_speed * math.cos(self.angle + 0.1) + random.uniform(-0.05, 0.05)
                self.pos_y += self.current_speed * math.sin(self.angle + 0.1) + random.uniform(-0.05, 0.05)
            else:
                # 일반 직진 (도시 도로의 미세한 조향)
                lane_keeping_noise = random.uniform(-0.08, 0.08)  # 차선 유지 노이즈
                self.pos_x += self.current_speed * math.cos(self.angle) + lane_keeping_noise
                self.pos_y += self.current_speed * math.sin(self.angle) + lane_keeping_noise
        
        # 속도와 가속도 (시내 주행 노이즈 반영)
        city_noise = random.uniform(-0.1, 0.1)  # 도시 주행 노이즈 (엔진 진동, 노면 등)
        self.linear_speed = self.current_speed + city_noise
        self.linear_acc = (adjusted_target - self.current_speed) * 1.5  # 더 민감한 가속도 반응
        
        # 각속도 (시내 주행 특성)
        if self.driving_scenario in ["turning_intersection", "parking_maneuver"]:
            self.angle_speed = self.current_speed * 0.8 + random.uniform(-0.15, 0.15)
            self.angle_acc = random.uniform(-0.3, 0.3)
        elif self.driving_scenario == "highway_merge":
            self.angle_speed = self.current_speed * 0.2 + random.uniform(-0.08, 0.08)
            self.angle_acc = random.uniform(-0.1, 0.1)
        else:
            # 일반 주행시 미세한 조향
            self.angle_speed = random.uniform(-0.05, 0.05)
            self.angle_acc = random.uniform(-0.02, 0.02)
        
        # 배터리 소모 (시내 주행 특성: 잦은 정지-출발로 더 많은 소모)
        base_consumption = 0.003  # 기본 소모량 (도시 주행으로 증가)
        speed_consumption = self.current_speed * 0.0012  # 속도 비례
        accel_consumption = abs(self.linear_acc) * 0.002  # 가속/감속 소모
        surface_consumption = base_consumption * (2.2 - factor["efficiency"])
        
        # 시나리오별 추가 소모
        scenario_factor = {
            "traffic_light_stop": 1.5,  # 정지 상태에서도 소모
            "slow_traffic": 1.3,        # 정체시 에어컨 등 사용
            "parking_maneuver": 1.4,    # 주차시 정밀 조작
            "highway_merge": 0.9        # 고속 주행시 효율적
        }.get(self.driving_scenario, 1.0)
        
        total_consumption = (base_consumption + speed_consumption + accel_consumption + surface_consumption) * factor["power_factor"] * scenario_factor
        
        self.battery_voltage -= total_consumption
        self.battery_voltage = max(30.0, self.battery_voltage)  # 최소 전압 제한
        
        # 배터리 부족 시 성능 저하
        battery_percent = (self.battery_voltage / self.battery_max_voltage) * 100
        if battery_percent < 25:
            self.target_speed *= 0.8  # 성능 저하
            if battery_percent < 15:
                self.exec_state = VehicleExecState.IDLE
                print(f"[CITY] 배터리 부족으로 차량 정지 ({battery_percent:.1f}%)")
        
        # 상태 변경 (15초마다 노면 상태 변경 - 시내 도로 특성)
        if self.elapsed_time % 15 == 0 and self.exec_state == VehicleExecState.RUNNING:
            # 시내 도로 노면 상태 (포트홀과 자갈길 확률 증가)
            surface_weights = [65, 15, 5, 15]  # ROAD, GRAVEL, ICE, POTHOLE
            self.surface_state = random.choices(list(SurfaceState), weights=surface_weights)[0]
            surface_names = ['ROAD', 'GRAVEL', 'ICE', 'POTHOLE']
            surface_name = surface_names[self.surface_state.value]
            print(f"[CITY] 노면 변화: {surface_name} ({self.surface_state.value})")
        
        # 시내 주행 시나리오에 따른 실행 상태 관리 (IDLE/RUNNING만 사용)
        if self.driving_scenario == "traffic_light_stop":
            if self.current_speed < 0.1:
                self.exec_state = VehicleExecState.IDLE
                print(f"[CITY] 신호등 대기로 IDLE 상태 ({self.current_speed:.1f} m/s)")
            else:
                self.exec_state = VehicleExecState.RUNNING
        elif self.driving_scenario == "parking_maneuver":
            if self.current_speed < 0.2:
                self.exec_state = VehicleExecState.IDLE
                print(f"[CITY] 주차 중 IDLE 상태 ({self.current_speed:.1f} m/s)")
            else:
                self.exec_state = VehicleExecState.RUNNING
        elif self.driving_scenario == "pedestrian_caution":
            if self.current_speed < 0.5:
                self.exec_state = VehicleExecState.IDLE
                print(f"[CITY] 보행자 주의로 IDLE 상태 ({self.current_speed:.1f} m/s)")
            else:
                self.exec_state = VehicleExecState.RUNNING
        elif self.driving_scenario == "slow_traffic":
            if self.current_speed < 1.0:
                self.exec_state = VehicleExecState.IDLE
                print(f"[CITY] 교통 정체로 IDLE 상태 ({self.current_speed:.1f} m/s)")
            else:
                self.exec_state = VehicleExecState.RUNNING
        else:
            # 일반 주행: 속도 기반 상태 전환
            if self.current_speed < 0.1:
                self.exec_state = VehicleExecState.IDLE
            else:
                self.exec_state = VehicleExecState.RUNNING
    pass  # _update_vehicle

    def _update_wheels(self):
        """시내 주행과 연동된 현실적인 바퀴 데이터 생성"""
        # 노면 상태에 따른 바퀴별 영향 (시내 도로 특성)
        surface_effects = {
            SurfaceState.ROAD: {"grip": 1.0, "vibration": 0.05, "power_loss": 1.0, "wear": 0.01},
            SurfaceState.GRAVEL: {"grip": 0.6, "vibration": 0.4, "power_loss": 1.5, "wear": 0.03},
            SurfaceState.ICE: {"grip": 0.2, "vibration": 0.1, "power_loss": 1.2, "wear": 0.005},
            SurfaceState.POTHOLE: {"grip": 0.7, "vibration": 1.0, "power_loss": 2.0, "wear": 0.08}
        }
        
        effect = surface_effects[self.surface_state]
        
        # 시내 주행 시나리오별 바퀴 부하 특성
        scenario_effects = {
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
            if self.exec_state == VehicleExecState.RUNNING:
                w["state"] = VehicleExecState.RUNNING
                w["command"] = self.command
            elif self.exec_state == VehicleExecState.IDLE:
                w["state"] = VehicleExecState.IDLE  
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
            
            # 회전시 좌우 바퀴 속도 차이 (디퍼렌셜 효과)
            if self.driving_scenario in ["turning_intersection", "parking_maneuver"]:
                if is_left_wheel:
                    turn_factor = 0.85 if self.angle_speed > 0 else 1.15  # 좌회전시 좌바퀴 느리게
                else:
                    turn_factor = 1.15 if self.angle_speed > 0 else 0.85  # 좌회전시 우바퀴 빠르게
            else:
                turn_factor = 1.0
                
            # 최종 바퀴 속도
            w["speed"] = self.current_speed * base_speed_factor * effect["grip"] * turn_factor
            
            # 노면과 시나리오에 따른 가속도
            w["acc"] = self.linear_acc * random.uniform(0.9, 1.1) * scenario_effect["load_factor"]
            
            # 바퀴 회전각 (속도에 비례하여 증가, 림 사이즈 고려)
            if w["speed"] > 0.01:
                wheel_radius = 0.18  # 18cm 반지름 (시내 주행용 타이어)
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
                
                if self.driving_scenario == "turning_intersection":
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
        elif self.surface_state in [SurfaceState.ICE, SurfaceState.POTHOLE]:
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
        print("[CITY] 🚗🏙️  시내 도로 주행 시뮬레이션 시작")
        print("[INFO] 시내 시나리오: city_normal, traffic_light_stop, slow_traffic, accelerating")
        print("[INFO]               turning_intersection, pedestrian_caution, parking_maneuver, highway_merge")
        print("[INFO] 노면 상태: ROAD(도로), GRAVEL(자갈), ICE(빙판), POTHOLE(포트홀)")
        print("[INFO] 주행 속도: 0-70 km/h (0-19.4 m/s) - 실제 시내 주행 범위")
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
                        VehicleExecState.IDLE: "🔴 정지",
                        VehicleExecState.RUNNING: "🟢 주행중"
                    }
                    state_display = state_icons.get(self.exec_state, "❓ 알수없음")
                    
                    print(f"\n[CITY STATUS] 경과: {self.elapsed_time}s | 시나리오: {self.driving_scenario}")
                    print(f"[CITY STATUS] 속도: {kmh_speed:.1f} km/h ({self.current_speed:.2f} m/s) | 목표: {self.target_speed*3.6:.0f} km/h")
                    print(f"[CITY STATUS] 배터리: {battery_percent:.1f}% ({self.battery_voltage:.1f}V) | 노면: {['ROAD','GRAVEL','ICE','POTHOLE'][self.surface_state.value]}")
                    print(f"[CITY STATUS] 위치: ({self.pos_x:.1f}m, {self.pos_y:.1f}m) | 주행거리: {total_km:.2f}km")
                    print(f"[CITY STATUS] 발행 토픽: {self.publish_count}개 | 상태: {state_display} ({self.exec_state.value})")
                    print("-" * 70)
                
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