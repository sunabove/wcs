import argparse
import json
import math
import os
import time
from mpu9250_jmdev.registers import *
from mpu9250_jmdev.mpu_9250 import MPU9250
from mpu9250_jmdev.registers import WHO_AM_I
from mpu9250_jmdev.registers import AK8963_CNTL1 

class IMU_9250:
    def __init__(
        self,
        calibration_file="IMU_Cali.json",
        interval_sec=0.2,
        calibration_duration_sec=10.0,
        calibration_delay_sec=0.02,
        force_calibration=False,
    ):
        self.calibration_file = calibration_file
        self.interval_sec = float(interval_sec)
        self.calibration_duration_sec = float(calibration_duration_sec)
        self.calibration_delay_sec = float(calibration_delay_sec)
        self.force_calibration = bool(force_calibration)
        self.imu = None
        self.accel_target_g = [0.0, 0.0, -1.0]
        self.accel_bias = [0.0, 0.0, 0.0]
        self.gyro_bias = [0.0, 0.0, 0.0]

    def initialize_sensor(self):
        self.imu = MPU9250(
            address_mpu_master=MPU9050_ADDRESS_68,
            address_mpu_slave=None,
            bus=1,
            gfs=GFS_250,
            afs=AFS_2G,
        )
        
        self.imu.writeAK(AK8963_CNTL1, 0x00)
        
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
            "accel_bias": list(self.accel_bias),
            "gyro_bias": list(self.gyro_bias),
            "accel_target_g": list(self.accel_target_g),
        }
        with open(self.calibration_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4)

    def collect_stationary_average(self):
        accel_sum = [0.0, 0.0, 0.0]
        gyro_sum = [0.0, 0.0, 0.0]
        sample_count = 0
        start_time = time.monotonic()
        end_time = start_time + self.calibration_duration_sec
        last_print_time = -1.0

        print("IMU를 움직이지 말고 평평한 곳에 놓으세요.")
        print(f"캘리브레이션 수집 시간: {self.calibration_duration_sec:.1f}초")
        input("Enter를 누르면 캘리브레이션을 시작합니다...")

        while True:
            now = time.monotonic()
            if sample_count > 0 and now >= end_time:
                break

            accel_raw = self.imu.readAccelerometerMaster()
            gyro_raw = self.imu.readGyroscopeMaster()

            for index in range(3):
                accel_sum[index] += accel_raw[index]
                gyro_sum[index] += gyro_raw[index]
            sample_count += 1

            current_accel_avg = [value / sample_count for value in accel_sum]
            current_gyro_avg = [value / sample_count for value in gyro_sum]
            current_accel_bias = [current_accel_avg[i] - self.accel_target_g[i] for i in range(3)]
            current_gyro_bias = list(current_gyro_avg)
            accel_c_now = [accel_raw[i] - current_accel_bias[i] for i in range(3)]
            gyro_c_now = [gyro_raw[i] - current_gyro_bias[i] for i in range(3)]

            now = time.monotonic()
            if last_print_time < 0.0 or now - last_print_time >= 0.2 or now >= end_time:
                print(
                    f"[CAL] Cali Acce[g] X:{accel_c_now[0]:7.3f} Y:{accel_c_now[1]:7.3f} Z:{accel_c_now[2]:7.3f} | "
                    f"Gyro[d/s] X:{gyro_c_now[0]:7.3f} Y:{gyro_c_now[1]:7.3f} Z:{gyro_c_now[2]:7.3f}"
                )
                last_print_time = now

            if self.calibration_delay_sec > 0.0:
                remaining = end_time - time.monotonic()
                if remaining <= 0.0:
                    break
                time.sleep(min(self.calibration_delay_sec, remaining))

        if sample_count < 1:
            raise RuntimeError("캘리브레이션 샘플을 수집하지 못했습니다.")

        accel_avg = [value / sample_count for value in accel_sum]
        gyro_avg = [value / sample_count for value in gyro_sum]
        return accel_avg, gyro_avg

    def run_calibration(self):
        accel_avg, gyro_avg = self.collect_stationary_average()

        self.accel_bias = [accel_avg[i] - self.accel_target_g[i] for i in range(3)]
        self.gyro_bias = list(gyro_avg)

        print("\n=== Calibration Result ===")
        print("Accel Bias :", self.accel_bias)
        print("Gyro Bias  :", self.gyro_bias)

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
            self.accel_bias = data["accel_bias"]
            self.gyro_bias = data["gyro_bias"]
            self.accel_target_g = data.get("accel_target_g", self.accel_target_g)
            print("기존 캘리브레이션 로드 완료")

    def run(self):
        self.initialize_sensor()
        self.ensure_calibration()

        print("\n실시간 출력 시작 (Ctrl+C 종료)")
        try:
            while True:
                accel_raw = self.imu.readAccelerometerMaster()
                gyro_raw = self.imu.readGyroscopeMaster()
                accel_c = [accel_raw[i] - self.accel_bias[i] for i in range(3)]
                gyro_c = [gyro_raw[i] - self.gyro_bias[i] for i in range(3)]

                target_error = math.sqrt(
                    sum((accel_c[i] - self.accel_target_g[i]) ** 2 for i in range(3))
                )
                if target_error <= 0.15:
                    roll_deg = 0.0
                    pitch_deg = 0.0
                else:
                    target_z = self.accel_target_g[2] if self.accel_target_g[2] != 0.0 else -1.0
                    roll_deg = math.degrees(math.atan2(accel_c[1], accel_c[2] * target_z))
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

    app = IMU_9250(force_calibration=args.calibration)
    app.run()


if __name__ == "__main__":
    main()

