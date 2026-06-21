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
        if not skip_calibration:
            self._load_calibration()

    def _load_calibration(self):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        cali_path = os.path.join(script_dir, "imu_cali.txt")

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
        pitch = math.degrees(math.atan2(-ax, math.sqrt(ay * ay + az * az)))
        roll = math.degrees(math.atan2(ay, az))
        return pitch, roll, ax, ay, az, ax + self.ax_offset, ay + self.ay_offset, az + self.az_offset, gx, gy, gz, gx + self.gx_offset, gy + self.gy_offset, gz + self.gz_offset

    def close(self):
        self.bus.close()


def is_stationary(ax, ay, az, gx, gy, gz):
    accel_norm = math.sqrt(ax * ax + ay * ay + az * az)
    return abs(accel_norm - 1.0) < 0.08 and abs(gx) < 2.0 and abs(gy) < 2.0 and abs(gz) < 2.0


def main():
    imu = IMU()
    print("Calibrating gyro offset...")
    gz_offset = 0.0
    for _ in range(100): gz_offset += imu.read()[10]; time.sleep(0.01)
    gz_offset /= 100.0
    p, r = imu.read()[:2]
    _, _, _, _, _, ax_cal, ay_cal, az_cal, _, _, _, _, _, _ = imu.read()
    p_cal = math.degrees(math.atan2(-ax_cal, math.sqrt(ay_cal*ay_cal+az_cal*az_cal)))
    r_cal = math.degrees(math.atan2(ay_cal, az_cal))
    pitch_filter, roll_filter = KalmanAngle(), KalmanAngle()
    pitch_filter.angle, roll_filter.angle = p_cal, r_cal
    yaw, prev_time, count = 0.0, time.monotonic(), 0
    try:
        while True:
            p, r, ax_raw, ay_raw, az_raw, ax, ay, az, gx_raw, gy_raw, gz_raw, gx, gy, gz = imu.read()
            now = time.monotonic()
            dt = min(now - prev_time, 0.1)
            prev_time = now
            stationary = is_stationary(ax, ay, az, gx, gy, gz - gz_offset)
            if stationary:
                gz_offset = gz_offset * 0.995 + gz * 0.005
            p_cal = math.degrees(math.atan2(-ax, math.sqrt(ay*ay+az*az)))
            r_cal = math.degrees(math.atan2(ay, az))
            pitch = pitch_filter.update(p_cal, gx, dt)
            roll = roll_filter.update(r_cal, gy, dt)
            yaw += (gz - gz_offset) * dt
            while yaw > 180: 
                yaw -= 360
            while yaw < -180: 
                yaw += 360
            count += 1
            p_raw = math.degrees(math.atan2(-ax_raw, math.sqrt(ay_raw*ay_raw+az_raw*az_raw)))
            r_raw = math.degrees(math.atan2(ay_raw, az_raw))
            print(f"[{count:5d}] RAW: R={r_raw:7.2f}° P={p_raw:7.2f}°            A=({ax_raw:6.3f},{ay_raw:6.3f},{az_raw:6.3f}) G=({gx_raw:7.2f},{gy_raw:7.2f},{gz_raw:7.2f})")
            print(     f"        CAL: R={roll:7.2f}° P={pitch:7.2f}° Y={yaw:7.2f}° A=({ax:6.3f},{ay:6.3f},{az:6.3f}) G=({gx:7.2f},{gy:7.2f},{gz:7.2f})")
            time.sleep(0.02)
    except KeyboardInterrupt: pass
    finally: imu.close()


if __name__ == "__main__":
    main()