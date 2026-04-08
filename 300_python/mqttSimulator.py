import time
import random
import json
import platform
import paho.mqtt.client as mqtt
from paho.mqtt.client import CallbackAPIVersion
from enum import IntEnum 

# ===== Enum 정의 =====
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

# ===== 차량 시뮬레이터 클래스 =====
class VehicleSimulator:
    def __init__(self, broker="localhost", port=1883):
        self.broker = broker
        self.port = port
        
        # 상태 변수들
        self.elapsed_time = 0
        self.distance = 0.0
        self.battery_voltage = 48.0
        self.current_exec_state = ExecState.RUNNING  # 시뮬레이션으로 RUNNING 상태 시작
        self.current_command = OperationCommand.FORWARD
        self.publish_count = 0  # publish 카운터 추가
        
        # MQTT 클라이언트 설정
        self.client = mqtt.Client(
            callback_api_version=CallbackAPIVersion.VERSION1,
            client_id="wcs_simulator"
        )
        self.client.on_connect = self._on_connect
    pass
    
    def _on_connect(self, client, userdata, flags, rc):
        """MQTT 연결 콜백"""
        print("MQTT Connected:", rc)
    pass
    
    def _generate_data(self):
        """시뮬레이션 데이터 생성"""
        # 시뮬레이션: 주기적으로 명령어와 상태 변경
        if random.random() < 0.1:  # 10% 확률로 명령어 변경
            self.current_command = random.choice(list(OperationCommand))
        
        if self.current_exec_state == ExecState.RUNNING:
            self.elapsed_time += 1
            self.distance += random.uniform(0.1, 0.5)
            self.battery_voltage -= random.uniform(0.001, 0.01)

            if random.random() < 0.05:
                self.current_exec_state = random.choice([
                    ExecState.SUCCESS,
                    ExecState.FAIL
                ])
            pass
        elif self.current_exec_state in [ExecState.SUCCESS, ExecState.FAIL]:
            # SUCCESS/FAIL 후 다시 RUNNING으로 전환
            if random.random() < 0.3:  # 30% 확률로 다시 RUNNING
                self.current_exec_state = ExecState.RUNNING
            pass
        pass

        return {
            "vehicle/operation/command": self.current_command.value,
            "vehicle/operation/state": self.current_exec_state.value,
            "vehicle/drive/elapsed_time": self.elapsed_time,
            "vehicle/drive/distance": round(self.distance, 2),
            "vehicle/battery/voltage": round(self.battery_voltage, 2),
            "vehicle/surface/state": random.choice(list(SurfaceState)).value,
        }
    pass
    
    def _publish_data(self):
        """데이터 발행"""
        data = self._generate_data()
        current_time = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        
        self.publish_count += 1  # 카운터 증가

        for topic, value in data.items():
            payload = json.dumps(value)  # value만 전송
            
            self.client.publish(topic, payload, retain=True)
            print(f"[{self.publish_count}] [{current_time}] [PUB] {topic} -> {payload}")
        pass
    pass
    
    def connect(self):
        """MQTT 브로커에 연결"""
        self.client.connect(self.broker, self.port, 60)
        self.client.loop_start()
    pass
    
    def connect_with_retry(self, max_retries=10, delay=5):
        """MQTT 브로커에 재시도 로직으로 연결"""
        print(f"Attempting to connect to MQTT broker at {self.broker}:{self.port}")
        
        for attempt in range(max_retries):
            try:
                print(f"Connection attempt {attempt + 1}/{max_retries}...")
                self.client.connect(self.broker, self.port, 60)
                self.client.loop_start()
                print(f"Successfully connected to MQTT broker")
                return True
            except Exception as e:
                print(f"Connection attempt {attempt + 1} failed: {e}")
                if attempt < max_retries - 1:
                    print(f"Retrying in {delay} seconds...")
                    time.sleep(delay)
                else:
                    print(f"All {max_retries} connection attempts failed")
                pass
            pass
        
        print(f"Failed to connect to MQTT broker after {max_retries} attempts")
        return False
    pass
    
    def disconnect(self):
        """MQTT 브로커 연결 해제"""
        self.client.loop_stop()
        self.client.disconnect()
    pass
    
    def run_simulation(self):
        """시뮬레이션 실행"""
        try:
            print("Starting vehicle simulation...")
            while True:
                self._publish_data()
                time.sleep(1)
            pass
        except KeyboardInterrupt:
            print("\nSimulation stopped by user")
        finally:
            self.disconnect()
        pass
    pass

def main():
    """메인 함수"""
    # 설정값 - 운영체제별로 브로커 호스트 설정
    BROKER_HOST = "localhost"
    
    if platform.system() == "Windows":
        BROKER_HOST = "orangepi6plus"
    pass
    
    PORT = 1883
    
    print(f"Operating System: {platform.system()}")
    print(f"MQTT Broker Host: {BROKER_HOST}")
    
    # 시뮬레이터 생성 및 연결
    simulator = VehicleSimulator(BROKER_HOST, PORT)
    
    # 재시도 로직으로 MQTT 연결 시도
    if simulator.connect_with_retry(max_retries=10, delay=5):
        simulator.run_simulation()
    else:
        print("Failed to establish MQTT connection. Exiting...")
        exit(1)
    pass
pass

if __name__ == "__main__":
    main()
pass