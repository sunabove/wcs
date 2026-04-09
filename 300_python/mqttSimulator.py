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
            # paho-mqtt 2.0+ 버전용 - callback_api_version을 첫 번째 인수로
            self.client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION1, client_id="wcs_simulator")
            print("[MQTT] Using paho-mqtt 2.0+ with callback API version 1")
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
        self.distance = 0.0
        self.battery_voltage = 48.0
        self.battery_max_voltage = 48.0  # 배터리 최대 전압 (100% 기준)
        self.exec_state = ExecState.RUNNING
        self.command = OperationCommand.FORWARD
        self.surface_state = SurfaceState.ROAD  # 초기 노면 상태

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

    def _on_connect(self, client, userdata, flags, rc):
        print("MQTT Connected:", rc)
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

    # ===== 데이터 생성 (SI 단위계 준수) =====
    def _update_vehicle(self):
        # SI 단위계: 시간(초), 거리(미터), 속도(m/s), 가속도(m/s²), 각도(rad)
        self.elapsed_time += 1  # 초(s)
        self.distance += random.uniform(0.1, 0.5)  # 미터(m) 단위를 추가
        self.battery_voltage -= random.uniform(0.001, 0.01)  # 볼트(V)

        # 위치: 미터(m)
        self.pos_x += random.uniform(-0.5, 0.5)  # m
        self.pos_y += random.uniform(-0.5, 0.5)  # m

        # 선속도: m/s, 선가속도: m/s²
        self.linear_speed = random.uniform(0, 2)  # m/s
        self.linear_acc = random.uniform(-0.5, 0.5)  # m/s²

        # 각도: radian, 각속도: rad/s, 각가속도: rad/s²
        self.angle += random.uniform(-math.pi/36, math.pi/36)  # 약 -5도~5도 (radian)
        self.angle_speed = random.uniform(0, 2)  # rad/s
        self.angle_acc = random.uniform(-1, 1)  # rad/s²
        
        # 실행 상태를 주기적으로 변경 (10초마다)
        if self.elapsed_time % 10 == 0:
            self.exec_state = random.choice([ExecState.IDLE, ExecState.RUNNING])
            print(f"[SIMULATOR] 차량 상태 변경: {self.exec_state.name} ({self.exec_state.value})")
            
            # 노면 상태를 주기적으로 변경 (10초마다)
            self.surface_state = random.choice(list(SurfaceState))
            surface_names = ['ROAD', 'GRAVEL', 'ICE', 'POTHOLE']
            surface_name = surface_names[self.surface_state.value]
            print(f"[SIMULATOR] 노면 상태 변경: {surface_name} ({self.surface_state.value})")
    pass  # _update_vehicle

    def _update_wheels(self):
        # SI 단위계: 각 바퀄별 물리량 업데이트
        for wid, w in self.wheels.items():
            # 위치: 미터(m)
            w["x"] += random.uniform(-0.1, 0.1)  # m
            w["y"] += random.uniform(-0.1, 0.1)  # m

            # 선속도: m/s, 선가속도: m/s²
            w["speed"] = random.uniform(0, 2)  # m/s
            w["acc"] = random.uniform(-0.5, 0.5)  # m/s²

            # 각도: radian (0~2π), 각속도: rad/s, 각가속도: rad/s²
            w["angle"] = random.uniform(0, 2 * math.pi)  # 0~2π radian (0~360도)
            w["angle_speed"] = random.uniform(0, 2)  # rad/s
            w["angle_acc"] = random.uniform(-1, 1)  # rad/s²
            w["axis_angle"] = random.uniform(-math.pi/4, math.pi/4)  # -π/4~π/4 radian (-45~45도)

            # 토크: Nm, 전력: W
            w["torque"] = random.uniform(0, 10)  # Nm (뉴턴미터)
            w["power"] = random.uniform(0, 150)  # 전력 0-150W 범위

            w["pid_p"] = random.uniform(0, 1)
            w["pid_i"] = random.uniform(0, 1)
            w["pid_d"] = random.uniform(0, 1)

            # SI 단위계: 거리는 미터(m) 단위
            w["tof_distance"] = random.uniform(0.0, 2.0)  # 0-2m (ToF 센서 측정 범위)
            w["tof_calib"] = random.uniform(0, 1)

            w["state"] = random.choice(list(ExecState))
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
        self._publish("vehicle/drive/total_distance", round(self.distance, 3))  # 미터(m)
        self._publish("vehicle/battery/voltage", round(self.battery_voltage, 2))  # 볼트(V)
        self._publish("vehicle/battery/remain_time", int(self.battery_voltage * 60))  # 초(s)
        self._publish("vehicle/battery/remain_amount", round(remain_percent, 1))  # 퍼센트(%)
        
        self._publish("vehicle/surface/state", self.surface_state.value)

        # SI 단위계: 속도(m/s), 각속도(rad/s)
        self._publish("vehicle/max_speed", 2.0)  # m/s
        self._publish("vehicle/max_angular_speed", 1.0)  # rad/s

        self._publish("vehicle/operation/command", self.command.value)
        self._publish("vehicle/operation/state", self.exec_state.value)
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
        
        loop_count = 0
        while self.running and not _shutdown_flag:
            try:
                # 매 10주기마다 파일 변경 확인 (10초마다)
                if loop_count % 10 == 0:
                    self._check_file_changes()
                
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