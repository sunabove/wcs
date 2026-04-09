import time
import random
import json
import threading
import platform
import sys
import os
import signal
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
        self.exec_state = ExecState.RUNNING
        self.command = OperationCommand.FORWARD

        # 위치 상태
        self.pos_x = 0.0
        self.pos_y = 0.0
        self.pos_z = 0.0

        self.linear_speed = 0.0
        self.linear_acc = 0.0

        self.angle = 0.0
        self.angular_speed = 0.0
        self.angular_acc = 0.0

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
            "ang_speed": 0.0,
            "ang_acc": 0.0,
            "torque": 0.0,
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

    # ===== 데이터 생성 =====
    def _update_vehicle(self):
        self.elapsed_time += 1
        self.distance += random.uniform(0.1, 0.5)
        self.battery_voltage -= random.uniform(0.001, 0.01)

        # 위치
        self.pos_x += random.uniform(-0.5, 0.5)
        self.pos_y += random.uniform(-0.5, 0.5)

        self.linear_speed = random.uniform(0, 2)
        self.linear_acc = random.uniform(-0.5, 0.5)

        self.angle += random.uniform(-5, 5)
        self.angular_speed = random.uniform(0, 2)
        self.angular_acc = random.uniform(-1, 1)
    pass  # _update_vehicle

    def _update_wheels(self):
        for wid, w in self.wheels.items():
            w["x"] += random.uniform(-0.1, 0.1)
            w["y"] += random.uniform(-0.1, 0.1)

            w["speed"] = random.uniform(0, 2)
            w["acc"] = random.uniform(-0.5, 0.5)

            w["angle"] = random.uniform(0, 360)
            w["ang_speed"] = random.uniform(0, 2)
            w["ang_acc"] = random.uniform(-1, 1)

            w["torque"] = random.uniform(0, 10)

            w["pid_p"] = random.uniform(0, 1)
            w["pid_i"] = random.uniform(0, 1)
            w["pid_d"] = random.uniform(0, 1)

            w["tof_distance"] = random.uniform(0, 5)
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
        self._publish("vehicle/run/state", self.exec_state.value)
        self._publish("vehicle/drive/elapsed_time", self.elapsed_time)
        self._publish("vehicle/drive/available_time", max(0, 3600 - self.elapsed_time))
        self._publish("vehicle/drive/distance", round(self.distance, 2))
        self._publish("vehicle/battery/voltage", round(self.battery_voltage, 2))
        self._publish("vehicle/battery/remain_time", int(self.battery_voltage * 60))
        self._publish("vehicle/surface/state", random.choice(list(SurfaceState)).value)

        self._publish("vehicle/max_speed", 2.0)
        self._publish("vehicle/max_angular_speed", 1.0)

        self._publish("vehicle/operation/command", self.command.value)
        self._publish("vehicle/operation/state", self.exec_state.value)
    pass  # _publish_vehicle

    def _publish_position(self):
        self._publish("vehicle/position/x", self.pos_x)
        self._publish("vehicle/position/y", self.pos_y)
        self._publish("vehicle/position/z", self.pos_z)

        self._publish("vehicle/linear/speed", self.linear_speed)
        self._publish("vehicle/linear/acceleration", self.linear_acc)

        self._publish("vehicle/angle/degree", self.angle)
        self._publish("vehicle/angle/speed", self.angular_speed)
        self._publish("vehicle/angle/acceleration", self.angular_acc)
    pass  # _publish_position

    def _publish_wheels(self):
        for wid, w in self.wheels.items():
            base = f"wheel/{wid}"

            self._publish(f"{base}/position/x", w["x"])
            self._publish(f"{base}/position/y", w["y"])
            self._publish(f"{base}/position/z", w["z"])

            self._publish(f"{base}/linear/speed", w["speed"])
            self._publish(f"{base}/linear/acceleration", w["acc"])

            self._publish(f"{base}/angle/degree", w["angle"])
            self._publish(f"{base}/angle/speed", w["ang_speed"])
            self._publish(f"{base}/angle/acceleration", w["ang_acc"])

            self._publish(f"{base}/torque", w["torque"])

            self._publish(f"{base}/pid/p", w["pid_p"])
            self._publish(f"{base}/pid/i", w["pid_i"])
            self._publish(f"{base}/pid/d", w["pid_d"])

            self._publish(f"{base}/tof/distance", w["tof_distance"])
            self._publish(f"{base}/tof/calibration", w["tof_calib"])

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