#!/usr/bin/env python3

import math
import time
from smbus2 import SMBus


class GY91:

    def __init__(self):
        self.bus = SMBus(1)
        self.bus.write_byte_data(0x68, 0x6B, 0)
        time.sleep(0.1)

    def _s(self, v):
        return v - 65536 if v > 32767 else v

    def read(self):
        d = self.bus.read_i2c_block_data(0x68, 0x3B, 14)

        ax = self._s((d[0] << 8) | d[1]) / 16384.0
        ay = self._s((d[2] << 8) | d[3]) / 16384.0
        az = self._s((d[4] << 8) | d[5]) / 16384.0

        gx = self._s((d[8] << 8) | d[9]) / 131.0
        gy = self._s((d[10] << 8) | d[11]) / 131.0
        gz = self._s((d[12] << 8) | d[13]) / 131.0

        pitch = math.degrees(math.atan2(ax, math.sqrt(ay * ay + az * az)))
        roll = math.degrees(math.atan2(ay, math.sqrt(ax * ax + az * az)))

        return pitch, roll, ax, ay, az, gx, gy, gz

    def close(self):
        self.bus.close()


def main():

    imu = GY91()

    try:

        while True:

            p, r, ax, ay, az, gx, gy, gz = imu.read()

            print(
                f"P={p:6.1f}° "
                f"R={r:6.1f}° "
                f"ACC=({ax:5.2f},{ay:5.2f},{az:5.2f}) "
                f"GYR=({gx:6.1f},{gy:6.1f},{gz:6.1f})"
            )

            time.sleep(0.2)

    except KeyboardInterrupt:
        pass

    finally:
        imu.close()


if __name__ == "__main__":
    main()