from icm20602 import ICM20602
from time import sleep
import sys
from smbus2 import SMBus

def makeICM20602_WakeUp():
    bus = SMBus(1)
    
    # Wake up
    print("Waking up the ICM20602...")
    bus.write_byte_data(0x69, 0x6B, 0x00)
    sleep(0.1)

    # Clock source = PLL
    bus.write_byte_data(0x69, 0x6B, 0x01)
    sleep(0.1)
    
    bus.close()
pass # makeICM20602_WakeUp

def is_sensor_available(status):
    if isinstance(status, bool):
        return status

    status_text = str(status).lower()
    return "no sensor" not in status_text
pass

makeICM20602_WakeUp()

mpu = ICM20602()
availability = mpu.check_availability(verbose=True)
print("Availability:", availability)
if not is_sensor_available(availability):
    mpu.close()
    mpu = None
    print("Sensor not detected. Check power, GND, SDA/SCL wiring, and I2C address.")
    sys.exit(1)

print("Calibrating sensor...")
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
            f"({acc_x:5.2f}, {acc_y:5.2f}, {acc_z:5.2f}) g, "
            f"Gyro: "
            f"({gyro_x:6.2f}, {gyro_y:6.2f}, {gyro_z:6.2f}) °/s, "
            f"roll: {roll:6.2f} °, pitch: {pitch:6.2f} °"
        )
        prev_accel_g = accel_g
        prev_gyro_g = gyro_g
        sleep( 0.10 )
        cnt += 1
except KeyboardInterrupt:
    print("Stopped by user")
finally:
    mpu.close()
    mpu = None
    print("Done")
pass