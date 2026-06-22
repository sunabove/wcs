import time
import board
import busio
from mpu9250_jmdev.registers import *
from mpu9250_jmdev.mpu_9250 import MPU9250

def main():
    # 1. Initialize the Shared I2C Bus using CircuitPython
    # Raspberry Pi hardware I2C uses Board pins SCL and SDA
    i2c_bus = busio.I2C(board.SCL, board.SDA)

    # 2. Initialize the MPU9250 Sensor (Gyro, Accel, Magnetometer)
    # GY-91 usually maps the MPU9250 master address to 0x68
    try:
        mpu_sensor = MPU9250(
            address_ak=AK8963_ADDRESS,          # 0x0C (Internal Magnetometer)
            address_mpu_master=MPU9050_ADDRESS_68, # 0x68 (Master IMU)
            address_mpu_slave=None,
            bus=1,                              # Uses /dev/i2c-1
            gfs=GFS_250,                        # Gyro full scale range (±250 deg/s)
            afs=AFS_2G,                         # Accelerometer scale range (±2g)
            mfs=AK8963_BIT_16,                  # Magnetometer resolution (16-bit)
            mode=AK8963_MODE_C100HZ             # Continuous 100Hz mag sampling
        )
        mpu_sensor.configure()
        print("✅ MPU9250 IMU detected successfully.\n")
    except Exception as e:
        print(f"❌ Failed to initialize MPU9250: {e}")
        return

    print("Reading data... Press Ctrl+C to stop.\n")
    time.sleep(1)

    while True:
        try:
            # --- Fetch MPU9250 Data ---
            accel = mpu_sensor.readAccelerometerMaster() # Returns list [x, y, z]
            gyro  = mpu_sensor.readGyroscopeMaster()     # Returns list [x, y, z]
            mag   = mpu_sensor.readMagnetometerMaster()   # Returns list [x, y, z]

            # --- Scannable Terminal Output ---
            print("="*45)
            print(f"🚀 Accel (G):   X: {accel[0]:.3f} | Y: {accel[1]:.3f} | Z: {accel[2]:.3f}")
            print(f"🔄 Gyro (°/s):  X: {gyro[0]:.2f} | Y: {gyro[1]:.2f} | Z: {gyro[2]:.2f}")
            print(f"🧲 Mag (μT):    X: {mag[0]:.1f} | Y: {mag[1]:.1f} | Z: {mag[2]:.1f}")
            print("="*45)

            time.sleep(0.5) # Refresh rate delay

        except KeyboardInterrupt:
            print("\nExiting program gracefully.")
            break
        except Exception as e:
            print(f"Error reading sensor data: {e}")
            time.sleep(1)

if __name__ == "__main__":
    main()