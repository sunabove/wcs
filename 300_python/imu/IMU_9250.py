import argparse
import time

from mpu9250_jmdev.mpu_9250 import MPU9250
from mpu9250_jmdev.registers import *


def create_sensor(i2c_bus=1, mpu_addr=MPU9050_ADDRESS_68):
    sensor = MPU9250(
        address_mpu_master=mpu_addr,
        address_mpu_slave=None,
        bus=i2c_bus,
        gfs=GFS_250,
        afs=AFS_2G,
        mfs=AK8963_BIT_16,
        mode=AK8963_MODE_C100HZ,
    )
    sensor.configure()
    return sensor


def main():
    parser = argparse.ArgumentParser(description="Raspberry Pi 5 MPU9250 reader")
    parser.add_argument("--bus", type=int, default=1, help="I2C bus number (default: 1)")
    parser.add_argument("--interval", type=float, default=0.5, help="Read interval in seconds")
    args = parser.parse_args()

    try:
        sensor = create_sensor(i2c_bus=args.bus)
    except Exception as e:
        print(f"Failed to initialize MPU9250: {e}")
        print("Check wiring, I2C enable state, and sensor power on Raspberry Pi 5.")
        return

    print("MPU9250 ready. Press Ctrl+C to stop.")

    while True:
        try:
            accel = sensor.readAccelerometerMaster()
            gyro = sensor.readGyroscopeMaster()
            mag = sensor.readMagnetometerMaster()

            print(
                f"ACC[g] X:{accel[0]:7.3f} Y:{accel[1]:7.3f} Z:{accel[2]:7.3f} | "
                f"GYR[d/s] X:{gyro[0]:7.3f} Y:{gyro[1]:7.3f} Z:{gyro[2]:7.3f} | "
                f"MAG[uT] X:{mag[0]:7.3f} Y:{mag[1]:7.3f} Z:{mag[2]:7.3f}"
            )
            time.sleep(max(0.0, args.interval))
        except KeyboardInterrupt:
            print("\nStopped.")
            break
        except Exception as e:
            print(f"Read error: {e}")
            time.sleep(1.0)


if __name__ == "__main__":
    main()
