from icm20602 import ICM20602
from time import sleep


def fmt_vec3(v):
    return f"({v[0]: .4f}, {v[1]: .4f}, {v[2]: .4f})"
pass

# smoothing + low pass filter
mpu = ICM20602()
print("Availability:", mpu.check_availability(verbose=True))
mpu.enable_smoothing(smoothing_window=7)
mpu.enable_dlpf(bandwidth=mpu.DLPFBandwidth.BW_20HZ)
print("Smoothing + DLPF example")
try:
    cnt = 1
    while True:
        accel_g = mpu.read_accel_data()
        gyro_g = mpu.read_gyro_data()
        print(f"[{cnt:5d}] Accel: {fmt_vec3(accel_g)}, Gyro: {fmt_vec3(gyro_g)}")
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
# If calibration is done while moving, offsets can become invalid.
# Run calibration only when the device is fully still.
print("Availability:", mpu.check_availability(verbose=True))
# mpu.calibrate_sensor()
#mpu.enable_smoothing(smoothing_window=7)
#mpu.enable_dlpf(bandwidth=mpu.DLPFBandwidth.BW_20HZ)
print("Continous reading, break to stop")
cnt = 1
prev_accel_g = None
prev_gyro_g = None
stale_count = 0
try:
    while True:
        accel_g = mpu.read_accel_data()
        gyro_g = mpu.read_gyro_data()
        roll, pitch = mpu.calculate_inclination(accel_g)
        if prev_accel_g == accel_g and prev_gyro_g == gyro_g:
            stale_count += 1
        else:
            stale_count = 0

        if stale_count == 20:
            print("Warning: accel/gyro unchanged for 20 samples (possible stale I2C/sample stream)")

        print( f"[{cnt:5d}] Accel: {fmt_vec3(accel_g)}, Gyro: {fmt_vec3(gyro_g)}" 
               f", roll: {roll:.2f}, pitch: {pitch:.2f}"
              )
        prev_accel_g = accel_g
        prev_gyro_g = gyro_g
        sleep(0.25)
        cnt += 1
except KeyboardInterrupt:
    print("Stopped by user")
finally:
    mpu.close()
    mpu = None
    print("Done")
pass