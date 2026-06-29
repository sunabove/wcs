from mpu9250_jmdev.registers import *
from mpu9250_jmdev.mpu_9250 import MPU9250
import time

# MPU9250 초기화
mpu = MPU9250(
    address_ak=AK8963_ADDRESS,
    address_mpu_master=MPU9050_ADDRESS_68,   # AD0=GND
    address_mpu_slave=None,
    bus=1,
    gfs=GFS_250,
    afs=AFS_2G,
    mfs=AK8963_BIT_16,
    mode=AK8963_MODE_C100HZ
)

mpu.configure()

print("센서를 평평한 곳에 놓고 움직이지 마십시오.")
time.sleep(3)

# --------------------------
# Calibration
# --------------------------
print("Gyroscope Calibration...")
mpu.calibrateGyro(1000)

print("Accelerometer Calibration...")
mpu.calibrateAccel(1000)

print("\nCalibration Result")
print("---------------------------")
print("Gyro Bias")
print(mpu.gbias)

print("Accel Bias")
print(mpu.abias)

print("\nReading calibrated values...\n")

while True:
    accel = mpu.readAccelerometerMaster()
    gyro = mpu.readGyroscopeMaster()

    print(f"Accel : {accel}")
    print(f"Gyro  : {gyro}")
    print()

    time.sleep(0.2)