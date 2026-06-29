import json
import os
import time
from mpu9250_jmdev.registers import *
from mpu9250_jmdev.mpu_9250 import MPU9250

# IMU 초기화
imu = MPU9250(
    address_ak=AK8963_ADDRESS,
    address_mpu_master=MPU9050_ADDRESS_68,
    address_mpu_slave=None,
    bus=1,
    gfs=GFS_250,
    afs=AFS_2G,
    mfs=AK8963_BIT_16,
    mode=AK8963_MODE_C100HZ
)

imu.configure()

imu_calibration_file = "IMU_Cali.json"


def is_valid_bias(values):
    if not isinstance(values, list) or len(values) != 3:
        return False
    return all(isinstance(v, (int, float)) for v in values)


def load_calibration(file_path):
    if not os.path.exists(file_path):
        return None
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None

    if not isinstance(data, dict):
        return None

    accel_bias = data.get("accel_bias")
    gyro_bias = data.get("gyro_bias")
    if not is_valid_bias(accel_bias) or not is_valid_bias(gyro_bias):
        return None
    return data


def save_calibration(file_path, accel_bias, gyro_bias):
    data = {
        "accel_bias": list(accel_bias),
        "gyro_bias": list(gyro_bias),
    }
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)


data = load_calibration(imu_calibration_file)
if data is None:
    print("IMU_Cali.json 파일이 없거나 JSON 포맷이 올바르지 않습니다.")
    print("IMU를 움직이지 말고 평평한 곳에 놓으세요.")
    input("Enter를 누르면 캘리브레이션을 시작합니다...")

    imu.calibrateMPU6500()

    print("\n=== Calibration Result ===")
    print("Accel Bias :", imu.abias)
    print("Gyro Bias  :", imu.gbias)

    save_calibration(imu_calibration_file, imu.abias, imu.gbias)
    print("캘리브레이션 저장 완료")
else:
    imu.abias = data["accel_bias"]
    imu.gbias = data["gyro_bias"]
    print("기존 캘리브레이션 로드 완료")

print("\n실시간 출력 시작 (Ctrl+C 종료)")
try:
    while True:
        accel_raw = imu.readAccelerometerMaster()
        gyro_raw = imu.readGyroscopeMaster()

        print(
            f"Acce-C[g] X:{accel_raw[0]:7.3f} Y:{accel_raw[1]:7.3f} Z:{accel_raw[2]:7.3f} | "
            f"Gyro-C[d/s] X:{gyro_raw[0]:7.3f} Y:{gyro_raw[1]:7.3f} Z:{gyro_raw[2]:7.3f} | "  
        )
        time.sleep(0.2)
except KeyboardInterrupt:
    print("\n종료")

