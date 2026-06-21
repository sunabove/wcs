#!/usr/bin/env python3

import math
import time
from smbus2 import SMBus


class KalmanAngle:

    def __init__(self, q_angle=0.003, q_bias=0.01, r_measure=0.03):
        self.q_angle = q_angle
        self.q_bias = q_bias
        self.r_measure = r_measure
        self.angle = 0.0
        self.bias = 0.0
        self.rate = 0.0
        self.p00 = 0.0
        self.p01 = 0.0
        self.p10 = 0.0
        self.p11 = 0.0
    pass # __init__

    def update(self, measured_angle, measured_rate, dt):
        self.rate = measured_rate - self.bias
        self.angle += dt * self.rate

        self.p00 += dt * (dt * self.p11 - self.p01 - self.p10 + self.q_angle)
        self.p01 -= dt * self.p11
        self.p10 -= dt * self.p11
        self.p11 += self.q_bias * dt

        s = self.p00 + self.r_measure
        k0 = self.p00 / s
        k1 = self.p10 / s
        y = measured_angle - self.angle

        self.angle += k0 * y
        self.bias += k1 * y

        p00 = self.p00
        p01 = self.p01
        self.p00 -= k0 * p00
        self.p01 -= k0 * p01
        self.p10 -= k1 * p00
        self.p11 -= k1 * p01

        return self.angle
    pass # update

pass # KalmanAngle


class IMU:

    def __init__(self):
        self.bus = SMBus(1)
        self.bus.write_byte_data(0x68, 0x6B, 0)
        time.sleep(0.1)
    pass #  

    def _s(self, v):
        # to signed 16-bit integer
        return v - 65536 if v > 32767 else v
    pass #

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
    pass # read

    def close(self):
        self.bus.close()
    pass # close

pass # IMU


def is_stationary(ax, ay, az, gx, gy, gz):
    accel_norm = math.sqrt(ax * ax + ay * ay + az * az)
    return abs(accel_norm - 1.0) < 0.08 and abs(gx) < 2.0 and abs(gy) < 2.0 and abs(gz) < 2.0
pass # is_stationary


def main():

    imu = IMU()
    pitch_filter = KalmanAngle(q_angle=0.003, q_bias=0.01, r_measure=0.05)
    roll_filter = KalmanAngle(q_angle=0.003, q_bias=0.01, r_measure=0.05)
    yaw_rate_filter = KalmanAngle(q_angle=0.02, q_bias=0.08, r_measure=0.2)
    yaw = 0.0
    gz_offset = 0.0
    prev_time = time.monotonic()

    try:
        print("Calibrating yaw... keep IMU still")
        for _ in range(20):
            _, _, _, _, _, _, _, gz = imu.read()
            gz_offset += gz
            time.sleep(0.05)
        gz_offset /= 20.0

        while True:
            p, r, ax, ay, az, gx, gy, gz = imu.read()
            now = time.monotonic()
            dt = now - prev_time
            stationary = is_stationary(ax, ay, az, gx, gy, gz - gz_offset)
            if stationary:
                gz_offset = gz_offset * 0.98 + gz * 0.02
            filtered_p = pitch_filter.update(p, gy, dt)
            filtered_r = roll_filter.update(r, gx, dt)
            filtered_gz = yaw_rate_filter.update(gz - gz_offset, gz - gz_offset, dt)
            if stationary:
                filtered_gz = 0.0
            yaw = (yaw + filtered_gz * dt) % 360.0
            yaw_display = yaw - 360.0 if yaw >= 275.0 else yaw
            prev_time = now

            print(
                f"R={filtered_r:6.1f}°({r:6.1f}) "
                f"P={filtered_p:6.1f}°({p:6.1f}) "
                f"Y={yaw_display:7.1f}° "
                f"ACC=({ax:5.2f},{ay:5.2f},{az:5.2f}) "
                f"GYRO=({gx:6.1f},{gy:6.1f},{gz:6.1f})"
            )

            time.sleep(0.2)
        pass
    except KeyboardInterrupt:
        pass
    finally:
        imu.close()
    pass
pass # main


if __name__ == "__main__":
    main()
pass # __main__