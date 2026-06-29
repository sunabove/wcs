import argparse
import json
import math
import os
import time
from mpu9250_jmdev.registers import *
from mpu9250_jmdev.mpu_9250 import MPU9250

class IMU9250App:
    def __init__(
        self,
        calibration_file="IMU_Cali.json",
        interval_sec=0.2,
        force_calibration=False,
    ):
        self.calibration_file = calibration_file
        self.interval_sec = float(interval_sec)
        self.force_calibration = bool(force_calibration)
        self.imu = None

    def initialize_sensor(self):
        self.imu = MPU9250(
            address_ak=AK8963_ADDRESS,
            address_mpu_master=MPU9050_ADDRESS_68,
            address_mpu_slave=None,
            bus=1,
            gfs=GFS_250,
            afs=AFS_2G,
            mfs=AK8963_BIT_16,
            mode=AK8963_MODE_C100HZ,
        )
        
        who = self.imu.readMaster(WHO_AM_I)
        print(hex(who))
        
        input( "Enter를 누르면 IMU 센서를 초기화합니다...")

        self.imu.configure()

    def is_valid_bias(self, values):
        if not isinstance(values, list) or len(values) != 3:
            return False
        return all(isinstance(v, (int, float)) for v in values)

    def load_calibration(self):
        if not os.path.exists(self.calibration_file):
            return None
        try:
            with open(self.calibration_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return None

        if not isinstance(data, dict):
            return None

        accel_bias = data.get("accel_bias")
        gyro_bias = data.get("gyro_bias")
        if not self.is_valid_bias(accel_bias) or not self.is_valid_bias(gyro_bias):
            return None
        return data

    def save_calibration(self):
        data = {
            "accel_bias": list(self.imu.abias),
            "gyro_bias": list(self.imu.gbias),
        }
        with open(self.calibration_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4)

    def run_calibration(self):
        print("IMU를 움직이지 말고 평평한 곳에 놓으세요.")
        input("Enter를 누르면 캘리브레이션을 시작합니다...")

        self.imu.calibrateMPU6500()

        print("\n=== Calibration Result ===")
        print("Accel Bias :", self.imu.abias)
        print("Gyro Bias  :", self.imu.gbias)

        self.save_calibration()
        print("캘리브레이션 저장 완료")

    def ensure_calibration(self):
        if self.force_calibration:
            print("강제 캘리브레이션 옵션이 활성화되었습니다.")
            self.run_calibration()
            return

        data = self.load_calibration()
        if data is None:
            print("IMU_Cali.json 파일이 없거나 JSON 포맷이 올바르지 않습니다.")
            self.run_calibration()
        else:
            self.imu.abias = data["accel_bias"]
            self.imu.gbias = data["gyro_bias"]
            print("기존 캘리브레이션 로드 완료")

    def run(self):
        self.initialize_sensor()
        self.ensure_calibration()

        print("\n실시간 출력 시작 (Ctrl+C 종료)")
        try:
            while True:
                accel_raw = self.imu.readAccelerometerMaster()
                gyro_raw = self.imu.readGyroscopeMaster()
                accel_c = [accel_raw[i] - self.imu.abias[i] for i in range(3)]
                gyro_c = [gyro_raw[i] - self.imu.gbias[i] for i in range(3)]

                roll_deg = math.degrees(math.atan2(accel_c[1], accel_c[2]))
                pitch_deg = math.degrees(
                    math.atan2(-accel_c[0], (accel_c[1] ** 2 + accel_c[2] ** 2) ** 0.5)
                )

                print(
                    f"Acce-C[g] X:{accel_c[0]:7.3f} Y:{accel_c[1]:7.3f} Z:{accel_c[2]:7.3f} | "
                    f"Gyro-C[d/s] X:{gyro_c[0]:7.3f} Y:{gyro_c[1]:7.3f} Z:{gyro_c[2]:7.3f} | "
                    f"Ang-C[d] Roll:{roll_deg:7.2f} Pitch:{pitch_deg:7.2f}"
                )
                time.sleep(self.interval_sec)
        except KeyboardInterrupt:
            print("\n종료")


def main():
    parser = argparse.ArgumentParser(description="MPU9250 calibration and monitor")
    parser.add_argument(
        "--calibration",
        action="store_true",
        help="캘리브레이션 수행",
    )
    args = parser.parse_args()

    app = IMU9250App(force_calibration=args.calibration)
    app.run()


if __name__ == "__main__":
    main()

