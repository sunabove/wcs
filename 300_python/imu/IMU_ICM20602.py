from math import trunc

from icm20602 import ICM20602
from time import sleep


mpu = ICM20602()
print(mpu.check_availability(verbose=True))
mpu.close()
mpu=None

input("Press Enter to continue...")

print("---")

print("Raw example")
mpu = ICM20602()
for _ in range(5):
    accel_g = mpu.read_accel_data()
    gyro_g = mpu.read_gyro_data()
    print(f"Accel: {accel_g}, Gyro: {gyro_g}")
    sleep(0.1)
mpu.close()
mpu=None

input("Press Enter to continue...")
print("---")

# smoothing + low pass filter
mpu = ICM20602()
mpu.enable_smoothing(smoothing_window=7)
mpu.enable_dlpf(bandwidth=mpu.DLPFBandwidth.BW_20HZ)
print("Smoothing + DLPF example")
for _ in range(5):
    accel_g = mpu.read_accel_data()
    gyro_g = mpu.read_gyro_data()
    print(f"Accel: {accel_g}, Gyro: {gyro_g}")
    sleep(0.1)
mpu.close()
mpu=None

input("Press Enter to continue...")
print("---")

# calibration example
# beware, calibrations sets all to 0,
# if not placed correctly, the initial readings will not be exactly as expected

mpu = ICM20602()
mpu.calibrate_sensor()
mpu.enable_smoothing(smoothing_window=7)
mpu.enable_dlpf(bandwidth=mpu.DLPFBandwidth.BW_20HZ)
print("Calibration + Smoothing + DLPF example")
for _ in range(5):
    accel_g = mpu.read_accel_data()
    gyro_g = mpu.read_gyro_data()
    print(f"Accel: {accel_g}, Gyro: {gyro_g}")
    sleep(0.1)
mpu.close()
mpu=None

input("Press Enter to continue...")
print("---")

# continious reading
mpu = ICM20602()
print("Continous reading, break to stop")
cnt = 1
while True:
    accel_g = mpu.read_accel_data()
    roll, pitch = mpu.calculate_inclination(accel_g)
    print(f"[{cnt:5d}] roll: {roll:.2f}, pitch: {pitch:.2f}")
    sleep(0.25)
    cnt += 1
mpu.close()
mpu = None