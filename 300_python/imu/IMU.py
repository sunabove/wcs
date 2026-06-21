#!/usr/bin/env python3

import math
import time

from smbus2 import SMBus


class KalmanAngle:

    def __init__(self, q_angle=0.003, q_bias=0.01, r_measure=0.05):

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

    def update(self, measured_angle, measured_rate, dt):

        self.rate = measured_rate - self.bias
        self.angle += dt * self.rate

        self.p00 += dt * (
            dt * self.p11
            - self.p01
            - self.p10
            + self.q_angle
        )

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


class IMU:

    MPU_ADDR = 0x68

    def __init__(self):

        self.bus = SMBus(1)

        self.bus.write_byte_data(
            self.MPU_ADDR,
            0x6B,
            0
        )

        time.sleep(0.1)

    def _signed16(self, value):

        if value > 32767:
            value -= 65536

        return value

    def read(self):

        d = self.bus.read_i2c_block_data(
            self.MPU_ADDR,
            0x3B,
            14
        )

        ax = self._signed16(
            (d[0] << 8) | d[1]
        ) / 16384.0

        ay = self._signed16(
            (d[2] << 8) | d[3]
        ) / 16384.0

        az = self._signed16(
            (d[4] << 8) | d[5]
        ) / 16384.0

        gx = self._signed16(
            (d[8] << 8) | d[9]
        ) / 131.0

        gy = self._signed16(
            (d[10] << 8) | d[11]
        ) / 131.0

        gz = self._signed16(
            (d[12] << 8) | d[13]
        ) / 131.0

        pitch = math.degrees(
            math.atan2(
                -ax,
                math.sqrt(
                    ay * ay +
                    az * az
                )
            )
        )

        roll = math.degrees(
            math.atan2(
                ay,
                az
            )
        )

        return (
            pitch,
            roll,
            ax,
            ay,
            az,
            gx,
            gy,
            gz
        )

    def close(self):

        self.bus.close()


def is_stationary(ax, ay, az, gx, gy, gz):

    accel_norm = math.sqrt(
        ax * ax +
        ay * ay +
        az * az
    )

    return (
        abs(accel_norm - 1.0) < 0.08 and
        abs(gx) < 2.0 and
        abs(gy) < 2.0 and
        abs(gz) < 2.0
    )


def main():

    imu = IMU()

    print("Calibrating gyro offset...")

    gz_offset = 0.0

    for _ in range(100):

        _, _, _, _, _, _, _, gz = imu.read()

        gz_offset += gz

        time.sleep(0.01)

    gz_offset /= 100.0

    p, r, *_ = imu.read()

    pitch_filter = KalmanAngle()
    roll_filter = KalmanAngle()

    pitch_filter.angle = p
    roll_filter.angle = r

    yaw = 0.0

    prev_time = time.monotonic()

    try:

        while True:

            p, r, ax, ay, az, gx, gy, gz = imu.read()

            now = time.monotonic()

            dt = min(
                now - prev_time,
                0.1
            )

            prev_time = now

            stationary = is_stationary(
                ax,
                ay,
                az,
                gx,
                gy,
                gz - gz_offset
            )

            if stationary:

                gz_offset = (
                    gz_offset * 0.995 +
                    gz * 0.005
                )

            #
            # Pitch / Roll Kalman
            #

            pitch = pitch_filter.update(
                p,
                gx,
                dt
            )

            roll = roll_filter.update(
                r,
                gy,
                dt
            )

            #
            # Yaw Integration
            #

            yaw += (
                gz - gz_offset
            ) * dt

            while yaw > 180:
                yaw -= 360

            while yaw < -180:
                yaw += 360

            print(
                f"R={roll:7.2f}° "
                f"P={pitch:7.2f}° "
                f"Y={yaw:7.2f}° "  
                f"ACC=({ax:6.3f},"
                f"{ay:6.3f}, "
                f"{az:6.3f}) "  
                f"GYR=({gx:7.2f}, "
                f"{gy:7.2f}, "
                f"{gz:7.2f}) "
            )

            print("-" * 60)

            time.sleep(0.02)

    except KeyboardInterrupt:

        pass

    finally:

        imu.close()


if __name__ == "__main__":

    main()