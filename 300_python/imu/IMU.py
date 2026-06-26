#!/usr/bin/env python3

import math
import os
import time

from smbus2 import SMBus


class KalmanAngle:
    def __init__(self, q_angle=0.003, q_bias=0.01, r_measure=0.05):
        self.q_angle, self.q_bias, self.r_measure = q_angle, q_bias, r_measure
        self.angle = self.bias = self.rate = 0.0
        self.p00 = self.p01 = self.p10 = self.p11 = 0.0

    def update(self, measured_angle, measured_rate, dt):
        self.rate = measured_rate - self.bias
        self.angle += dt * self.rate
        self.p00 += dt * (dt * self.p11 - self.p01 - self.p10 + self.q_angle)
        self.p01 -= dt * self.p11
        self.p10 -= dt * self.p11
        self.p11 += self.q_bias * dt
        s = self.p00 + self.r_measure
        k0, k1 = self.p00 / s, self.p10 / s
        y = measured_angle - self.angle
        self.angle += k0 * y
        self.bias += k1 * y
        p00, p01 = self.p00, self.p01
        self.p00 -= k0 * p00
        self.p01 -= k0 * p01
        self.p10 -= k1 * p00
        self.p11 -= k1 * p01
        return self.angle


class IMU:
    MPU_ADDR = 0x68
    def __init__(self, skip_calibration=False):
        self.bus = SMBus(1)
        self.bus.write_byte_data(self.MPU_ADDR, 0x6B, 0)
        time.sleep(0.1)
        self.ax_offset = self.ay_offset = self.az_offset = 0.0
        self.gx_offset = self.gy_offset = self.gz_offset = 0.0
        self.level_accel_baseline = None
        self.level_accel_ref_1g = None
        self.level_gyro_baseline = None
        self.level_rotation = None
        if not skip_calibration:
            self._load_calibration()

    @staticmethod
    def vec_norm(v):
        return math.sqrt((v[0] * v[0]) + (v[1] * v[1]) + (v[2] * v[2]))

    @staticmethod
    def vec_dot(a, b):
        return (a[0] * b[0]) + (a[1] * b[1]) + (a[2] * b[2])

    @staticmethod
    def vec_cross(a, b):
        return [
            (a[1] * b[2]) - (a[2] * b[1]),
            (a[2] * b[0]) - (a[0] * b[2]),
            (a[0] * b[1]) - (a[1] * b[0]),
        ]

    @classmethod
    def vec_normalize(cls, v):
        n = cls.vec_norm(v)
        if n < 1e-9:
            return [0.0, 0.0, 0.0]
        return [v[0] / n, v[1] / n, v[2] / n]

    @staticmethod
    def mat_vec_mul(m, v):
        return [
            (m[0][0] * v[0]) + (m[0][1] * v[1]) + (m[0][2] * v[2]),
            (m[1][0] * v[0]) + (m[1][1] * v[1]) + (m[1][2] * v[2]),
            (m[2][0] * v[0]) + (m[2][1] * v[1]) + (m[2][2] * v[2]),
        ]

    @classmethod
    def rotation_align_to_z(cls, from_vec):
        u = cls.vec_normalize(from_vec)
        z = [0.0, 0.0, 1.0]
        c = cls.vec_dot(u, z)

        if c > 1.0 - 1e-9:
            return [
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ]

        if c < -1.0 + 1e-9:
            return [
                [1.0, 0.0, 0.0],
                [0.0, -1.0, 0.0],
                [0.0, 0.0, -1.0],
            ]

        axis = cls.vec_cross(u, z)
        s = cls.vec_norm(axis)
        if s < 1e-9:
            return [
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ]

        kx, ky, kz = axis[0] / s, axis[1] / s, axis[2] / s
        one_minus_c = 1.0 - c

        return [
            [c + (kx * kx * one_minus_c), (kx * ky * one_minus_c) - (kz * s), (kx * kz * one_minus_c) + (ky * s)],
            [(ky * kx * one_minus_c) + (kz * s), c + (ky * ky * one_minus_c), (ky * kz * one_minus_c) - (kx * s)],
            [(kz * kx * one_minus_c) - (ky * s), (kz * ky * one_minus_c) + (kx * s), c + (kz * kz * one_minus_c)],
        ]

    @staticmethod
    def is_stationary(ax, ay, az, gx, gy, gz):
        accel_norm = math.sqrt(ax * ax + ay * ay + az * az)
        return abs(accel_norm - 1.0) < 0.08 and abs(gx) < 2.0 and abs(gy) < 2.0 and abs(gz) < 2.0

    @staticmethod
    def normalize_angle(angle):
        while angle > 180.0:
            angle -= 360.0
        while angle < -180.0:
            angle += 360.0
        return angle

    @classmethod
    def blend_angle(cls, current, target, alpha):
        diff = cls.normalize_angle(target - current)
        return cls.normalize_angle(current + alpha * diff)

    def _load_calibration(self):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        cali_path = os.path.join(script_dir, "IMU_Cali.txt")

        if not os.path.exists(cali_path):
            return

        try:
            with open(cali_path, "r", encoding="utf-8") as fp:
                for line in fp:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" not in line:
                        continue
                    key, value = line.split("=", 1)
                    key = key.strip()
                    try:
                        val = float(value)
                        if key == "ax_offset_g":
                            self.ax_offset = val
                        elif key == "ay_offset_g":
                            self.ay_offset = val
                        elif key == "az_offset_g":
                            self.az_offset = val
                        elif key == "gx_offset_dps":
                            self.gx_offset = val
                        elif key == "gy_offset_dps":
                            self.gy_offset = val
                        elif key == "gz_offset_dps":
                            self.gz_offset = val
                    except ValueError:
                        pass
            print(f"[IMU] Calibration loaded from {cali_path}")
        except Exception as e:
            print(f"[IMU] Warning: Failed to load calibration: {e}")

    def _signed16(self, value):
        return value - 65536 if value > 32767 else value

    def read(self):
        d = self.bus.read_i2c_block_data(self.MPU_ADDR, 0x3B, 14)
        ax = self._signed16((d[0] << 8) | d[1]) / 16384.0
        ay = self._signed16((d[2] << 8) | d[3]) / 16384.0
        az = self._signed16((d[4] << 8) | d[5]) / 16384.0
        gx = self._signed16((d[8] << 8) | d[9]) / 131.0
        gy = self._signed16((d[10] << 8) | d[11]) / 131.0
        gz = self._signed16((d[12] << 8) | d[13]) / 131.0
        ax += self.ax_offset
        ay += self.ay_offset
        az += self.az_offset
        gx += self.gx_offset
        gy += self.gy_offset
        gz += self.gz_offset
        pitch = math.degrees(math.atan2(-ax, math.sqrt(ay * ay + az * az)))
        roll = math.degrees(math.atan2(ay, az))
        return pitch, roll, ax, ay, az, gx, gy, gz

    def calibrate_level(self, samples=40, delay=0.02):
        samples = max(1, int(samples))
        accel_sum = [0.0, 0.0, 0.0]
        gyro_sum = [0.0, 0.0, 0.0]

        for _ in range(samples):
            _, _, ax, ay, az, gx, gy, gz = self.read()
            accel_sum[0] += ax
            accel_sum[1] += ay
            accel_sum[2] += az
            gyro_sum[0] += gx
            gyro_sum[1] += gy
            gyro_sum[2] += gz
            time.sleep(max(0.0, float(delay)))

        accel_baseline = [component / samples for component in accel_sum]
        gyro_baseline = [component / samples for component in gyro_sum]
        accel_baseline_mag = self.vec_norm(accel_baseline)
        if accel_baseline_mag < 1e-6:
            raise ValueError("Invalid accel baseline magnitude. Retry level calibration.")

        accel_ref_1g = [component / accel_baseline_mag for component in accel_baseline]
        self.level_accel_baseline = accel_baseline
        self.level_accel_ref_1g = accel_ref_1g
        self.level_gyro_baseline = gyro_baseline
        self.level_rotation = self.rotation_align_to_z(accel_ref_1g)

        return {
            "accel_baseline": tuple(accel_baseline),
            "accel_ref_1g": tuple(accel_ref_1g),
            "gyro_baseline": tuple(gyro_baseline),
        }

    def apply_leveling(self, ax, ay, az, gx, gy, gz):
        if self.level_rotation is None or self.level_accel_baseline is None or self.level_accel_ref_1g is None:
            return ax, ay, az, gx, gy, gz

        accel_c = [
            float(ax) - self.level_accel_baseline[0] + self.level_accel_ref_1g[0],
            float(ay) - self.level_accel_baseline[1] + self.level_accel_ref_1g[1],
            float(az) - self.level_accel_baseline[2] + self.level_accel_ref_1g[2],
        ]

        gyro_baseline = self.level_gyro_baseline or [0.0, 0.0, 0.0]
        gyro_c = [
            float(gx) - gyro_baseline[0],
            float(gy) - gyro_baseline[1],
            float(gz) - gyro_baseline[2],
        ]

        accel_axis = self.mat_vec_mul(self.level_rotation, accel_c)
        gyro_axis = self.mat_vec_mul(self.level_rotation, gyro_c)
        return accel_axis[0], accel_axis[1], accel_axis[2], gyro_axis[0], gyro_axis[1], gyro_axis[2]

    def read_leveled(self):
        _, _, ax, ay, az, gx, gy, gz = self.read()
        ax_l, ay_l, az_l, gx_l, gy_l, gz_l = self.apply_leveling(ax, ay, az, gx, gy, gz)
        pitch = math.degrees(math.atan2(-ax_l, math.sqrt((ay_l * ay_l) + (az_l * az_l))))
        roll = math.degrees(math.atan2(ay_l, az_l))
        return pitch, roll, ax_l, ay_l, az_l, gx_l, gy_l, gz_l

    def close(self):
        self.bus.close()


def main():
    imu = IMU()
    print("Calibrating gyro offset...")
    gz_offset = 0.0
    for _ in range(100): gz_offset += imu.read()[7]; time.sleep(0.01)
    gz_offset /= 100.0
    p, r = imu.read()[:2]
    pitch_filter, roll_filter = KalmanAngle(), KalmanAngle()
    pitch_filter.angle, roll_filter.angle = p, r
    yaw, prev_time, count = 0.0, time.monotonic(), 0
    try:
        while True:
            p, r, ax, ay, az, gx, gy, gz = imu.read()
            now = time.monotonic()
            dt = min(now - prev_time, 0.1)
            prev_time = now
            stationary = imu.is_stationary(ax, ay, az, gx, gy, gz - gz_offset)
            if stationary:
                gz_offset = gz_offset * 0.995 + gz * 0.005
            pitch = pitch_filter.update(p, gx, dt)
            roll = roll_filter.update(r, gy, dt)
            yaw = imu.normalize_angle(yaw + (gz - gz_offset) * dt)
            count += 1
            print(f"[{count:5d}] R={roll:7.2f}° P={pitch:7.2f}° Y={yaw:7.2f}° A=({ax:6.3f},{ay:6.3f},{az:6.3f}) G=({gx:7.2f},{gy:7.2f},{gz:7.2f})")
            time.sleep(0.02)
    except KeyboardInterrupt: pass
    finally: imu.close()


if __name__ == "__main__":
    main()