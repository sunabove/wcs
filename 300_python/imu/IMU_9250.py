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