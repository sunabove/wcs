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


def apply_bias(raw_values, bias_values):
    return [raw_values[i] - bias_values[i] for i in range(3)]


def calc_angles_from_accel(accel):
    ax, ay, az = accel
    roll_deg = math.degrees(math.atan2(ay, az))
    pitch_deg = math.degrees(math.atan2(-ax, (ay * ay + az * az) ** 0.5))
    return roll_deg, pitch_deg


print("\n실시간 출력 시작 (Ctrl+C 종료)")
try:
    while True:
        accel_raw = imu.readAccelerometerMaster()
        gyro_raw = imu.readGyroscopeMaster()

        accel_c = apply_bias(accel_raw, imu.abias)
        gyro_c = apply_bias(gyro_raw, imu.gbias)
        roll_deg, pitch_deg = calc_angles_from_accel(accel_c)

        print(
            f"Acce-C[g] X:{accel_c[0]:7.3f} Y:{accel_c[1]:7.3f} Z:{accel_c[2]:7.3f} | "
            f"Gyro-C[d/s] X:{gyro_c[0]:7.3f} Y:{gyro_c[1]:7.3f} Z:{gyro_c[2]:7.3f} | "
            f"Ang-C[d] Roll:{roll_deg:7.2f} Pitch:{pitch_deg:7.2f}",
            end="\r",
            flush=True,
        )
        time.sleep(0.2)
except KeyboardInterrupt:
    print("\n종료")

