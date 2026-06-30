from icm20602 import ICM20602
from time import sleep
import sys


def fmt_vec3(v):
    if isinstance(v, dict):
        for keys in (("x", "y", "z"), ("ax", "ay", "az"), ("gx", "gy", "gz")):
            if all(k in v for k in keys):
                x, y, z = v[keys[0]], v[keys[1]], v[keys[2]]
                return f"({x: .4f}, {y: .4f}, {z: .4f})"

        numeric_values = [value for value in v.values() if isinstance(value, (int, float))]
        if len(numeric_values) >= 3:
            x, y, z = numeric_values[:3]
            return f"({x: .4f}, {y: .4f}, {z: .4f})"

        return str(v)

    if isinstance(v, (list, tuple)) and len(v) >= 3:
        return f"({v[0]: .4f}, {v[1]: .4f}, {v[2]: .4f})"

    return str(v)
pass


def is_sensor_available(status):
    if isinstance(status, bool):
        return status

    status_text = str(status).lower()
    return "no sensor" not in status_text
pass

# smoothing + low pass filter
mpu = ICM20602()
availability = mpu.check_availability(verbose=True)
print("Availability:", availability)
if not is_sensor_available(availability):
    mpu.close()
    mpu = None
    print("Sensor not detected. Check power, GND, SDA/SCL wiring, and I2C address.")
    sys.exit(1)

input("Press Enter to continue...")

# continious reading
mpu = ICM20602()
# If calibration is done while moving, offsets can become invalid.
# Run calibration only when the device is fully still.
availability = mpu.check_availability(verbose=True)
print("Availability:", availability)
mpu.calibrate_sensor()
mpu.enable_smoothing(smoothing_window=7)
mpu.enable_dlpf(bandwidth=mpu.DLPFBandwidth.BW_20HZ)
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