import json
import math
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

print("IMU를 움직이지 말고 평평한 곳에 놓으세요.")
input("Enter를 누르면 캘리브레이션을 시작합니다...")

imu.calibrateMPU6500()

print("\n=== Calibration Result ===")
print("Accel Bias :", imu.abias)
print("Gyro Bias  :", imu.gbias)

data = {
    "accel_bias": imu.abias,
    "gyro_bias": imu.gbias
}

imu_calibration_file = "IMU_Cali.json"

with open(imu_calibration_file, "w") as f:
    json.dump(data, f, indent=4)

print("저장 완료")

with open(imu_calibration_file) as f:
    data = json.load(f)

imu.abias = data["accel_bias"]
imu.gbias = data["gyro_bias"]

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

