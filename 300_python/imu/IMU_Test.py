import time
import board
import busio
from mpu9250_jmdev.registers import *
from mpu9250_jmdev.mpu_9250 import MPU9250

def main():
    # 1. Initialize the Shared I2C Bus using CircuitPython
    # Raspberry Pi hardware I2C uses Board pins SCL and SDA
    i2c_bus = busio.I2C(board.SCL, board.SDA)

    # 2. Initialize the MPU9250 Sensor (Gyro, Accel)
    # GY-91 usually maps the MPU9250 master address to 0x68
    try:
        mpu_sensor = MPU9250(
            address_mpu_master=MPU9050_ADDRESS_68, # 0x68 (Master IMU)
            address_mpu_slave=None,
            bus=1,                              # Uses /dev/i2c-1
            gfs=GFS_250,                        # Gyro full scale range (±250 deg/s)
            afs=AFS_2G                          # Accelerometer scale range (±2g)
        )
        mpu_sensor.configure()
        print("✅ MPU9250 IMU detected successfully.\n")
    except Exception as e:
        print(f"❌ Failed to initialize MPU9250: {e}")
        return

    print("Reading data... Press Ctrl+C to stop.\n")
    time.sleep(1)

    line = "="*80
    label_width = 10
    value_width = 7
    count = 0

    # Estimate stationary gravity magnitude to compensate sensor scale/bias.
    calib_samples = 40
    calib_sum = 0.0
    print(f"Calibrating accel baseline... keep sensor still ({calib_samples} samples)")
    for _ in range(calib_samples):
        accel_c = mpu_sensor.readAccelerometerMaster()
        calib_sum += (accel_c[0]**2 + accel_c[1]**2 + accel_c[2]**2) ** 0.5
        time.sleep(0.02)
    accel_baseline = calib_sum / calib_samples
    print(f"Accel baseline magnitude: {accel_baseline:.3f}\n")
    
    while True:
        try:
            count += 1
            # --- Fetch MPU9250 Data ---
            accel = mpu_sensor.readAccelerometerMaster() # Returns list [x, y, z]
            gyro  = mpu_sensor.readGyroscopeMaster()     # Returns list [x, y, z]

            # --- Scannable Terminal Output ---
            accel_mag = (accel[0]**2 + accel[1]**2 + accel[2]**2) ** 0.5
            gyro_mag  = (gyro[0]**2  + gyro[1]**2  + gyro[2]**2)  ** 0.5
            accel_lin_mag = abs(accel_mag - accel_baseline)
            
            print(line)
            print(f"[{count:4d}] {('Accel (G)'):<{label_width}} : X: {accel[0]:{value_width}.2f} | Y: {accel[1]:{value_width}.2f} | Z: {accel[2]:{value_width}.2f} | RawMag: {accel_mag:{value_width}.2f} | LinMag: {accel_lin_mag:{value_width}.2f}")
            print(f"[{count:4d}] {('Gyro (°/s)'):<{label_width}} : X: {gyro[0]:{value_width}.2f} | Y: {gyro[1]:{value_width}.2f} | Z: {gyro[2]:{value_width}.2f} | Mag: {gyro_mag:{value_width}.2f}")
            print(line)

            time.sleep(0.5) # Refresh rate delay

        except KeyboardInterrupt:
            print("\nExiting program gracefully.")
            break
        except Exception as e:
            print(f"Error reading sensor data: {e}")
            time.sleep(1)

if __name__ == "__main__":
    main()