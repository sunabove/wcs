from math import trunc

from icm20602 import ICM20602
from time import sleep

# smoothing + low pass filter
mpu = ICM20602()
mpu.enable_smoothing(smoothing_window=7)
mpu.enable_dlpf(bandwidth=mpu.DLPFBandwidth.BW_20HZ)
print("Smoothing + DLPF example")
try:
    cnt = 1
    while True:
        accel_g = mpu.read_accel_data()
        gyro_g = mpu.read_gyro_data()
        print(f"[{cnt:5d}] Accel: {accel_g}, Gyro: {gyro_g}")
        sleep(0.1)
        cnt += 1
except KeyboardInterrupt:
    print("Stopped by user")
mpu.close()
mpu=None

input("Press Enter to continue...")
print("---")

# continious reading
mpu = ICM20602()
mpu.calibrate_sensor()
#mpu.enable_smoothing(smoothing_window=7)
#mpu.enable_dlpf(bandwidth=mpu.DLPFBandwidth.BW_20HZ)
print("Continous reading, break to stop")
cnt = 1
try:
    while True:
        accel_g = mpu.read_accel_data()
        gyro_g = mpu.read_gyro_data()
        roll, pitch = mpu.calculate_inclination(accel_g)
        print( f"[{cnt:5d}] Accel: {accel_g}, Gyro: {gyro_g}" 
               f", roll: {roll:.2f}, pitch: {pitch:.2f}"
              )
        sleep(0.25)
        cnt += 1
except KeyboardInterrupt:
    print("Stopped by user")
finally:
    mpu.close()
    mpu = None
    print("Done")
pass