from icm20602 import ICM20602
from time import sleep
import sys

IMU_DURATION = 0.01
VALUE_WIDTH = 9
VALUE_PRECISION = 4
ACC_UNIT = "g"
GYRO_UNIT = "°/s"
ANGLE_UNIT = "°"


def is_sensor_available(status):
    if isinstance(status, bool):
        return status

    status_text = str(status).lower()
    return "no sensor" not in status_text
pass

mpu = ICM20602()
availability = mpu.check_availability(verbose=True)
print("Availability:", availability)
if not is_sensor_available(availability):
    mpu.close()
    mpu = None
    print("Sensor not detected. Check power, GND, SDA/SCL wiring, and I2C address.")
    sys.exit(1)

input("Press Enter to continue...")

print("calibrating sensor...")
mpu.calibrate_sensor()
print("Calibration done. Now reading data...")

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
        acc_x = accel_g.get("x", 0.0)
        acc_y = accel_g.get("y", 0.0)
        acc_z = accel_g.get("z", 0.0)
        gyro_x = gyro_g.get("x", 0.0)
        gyro_y = gyro_g.get("y", 0.0)
        gyro_z = gyro_g.get("z", 0.0)
        
        if prev_accel_g == accel_g and prev_gyro_g == gyro_g:
            stale_count += 1
        else:
            stale_count = 0

        if stale_count == 20:
            print("Warning: accel/gyro unchanged for 20 samples (possible stale I2C/sample stream)")

        print(
            f"[{cnt:5d}] Accel: "
            f"({acc_x:{VALUE_WIDTH}.{VALUE_PRECISION}f}, {acc_y:{VALUE_WIDTH}.{VALUE_PRECISION}f}, {acc_z:{VALUE_WIDTH}.{VALUE_PRECISION}f}){ACC_UNIT}, "
            f"Gyro: "
            f"({gyro_x:{VALUE_WIDTH}.{VALUE_PRECISION}f}, {gyro_y:{VALUE_WIDTH}.{VALUE_PRECISION}f}, {gyro_z:{VALUE_WIDTH}.{VALUE_PRECISION}f}){GYRO_UNIT}, "
            f"roll: {roll:.2f} {ANGLE_UNIT}, pitch: {pitch:.2f} {ANGLE_UNIT}"
        )
        prev_accel_g = accel_g
        prev_gyro_g = gyro_g
        sleep(IMU_DURATION)
        cnt += 1
except KeyboardInterrupt:
    print("Stopped by user")
finally:
    mpu.close()
    mpu = None
    print("Done")
pass