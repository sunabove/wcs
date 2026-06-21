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
    AK8963_ADDR = 0x0C
    def __init__(self, skip_calibration=False):
        self.bus = SMBus(1)
        self.bus.write_byte_data(self.MPU_ADDR, 0x6B, 0)
        time.sleep(0.1)
        self.ak8963_whoami = None
        self.mag_adj_x = self.mag_adj_y = self.mag_adj_z = 1.0
        self.mx_offset = self.my_offset = self.mz_offset = 0.0
        self._last_mag = (0.0, 0.0, 0.0)
        self._enable_ak8963()
        self.ax_offset = self.ay_offset = self.az_offset = 0.0
        self.gx_offset = self.gy_offset = self.gz_offset = 0.0
        if not skip_calibration:
            self._load_calibration()

    def _enable_ak8963(self):
        try:
            # Disable MPU I2C master mode, then enable bypass to access AK8963 directly.
            self.bus.write_byte_data(self.MPU_ADDR, 0x6A, 0x00)
            self.bus.write_byte_data(self.MPU_ADDR, 0x37, 0x02)
            self.ak8963_whoami = self.bus.read_byte_data(self.AK8963_ADDR, 0x00)
            print(f"[IMU] AK8963 WHO_AM_I=0x{self.ak8963_whoami:02X}")

            # Power down -> Fuse ROM access -> read sensitivity adjustments -> 16-bit continuous mode.
            self.bus.write_byte_data(self.AK8963_ADDR, 0x0A, 0x00)
            time.sleep(0.01)
            self.bus.write_byte_data(self.AK8963_ADDR, 0x0A, 0x0F)
            time.sleep(0.01)
            asa = self.bus.read_i2c_block_data(self.AK8963_ADDR, 0x10, 3)
            self.mag_adj_x = ((asa[0] - 128) / 256.0) + 1.0
            self.mag_adj_y = ((asa[1] - 128) / 256.0) + 1.0
            self.mag_adj_z = ((asa[2] - 128) / 256.0) + 1.0
            self.bus.write_byte_data(self.AK8963_ADDR, 0x0A, 0x00)
            time.sleep(0.01)
            self.bus.write_byte_data(self.AK8963_ADDR, 0x0A, 0x16)
            time.sleep(0.01)
        except Exception as e:
            print(f"[IMU] Warning: AK8963 bypass enable failed: {e}")

    def read_mag(self):
        try:
            st1 = self.bus.read_byte_data(self.AK8963_ADDR, 0x02)
            if (st1 & 0x01) == 0:
                return self._last_mag
            data = self.bus.read_i2c_block_data(self.AK8963_ADDR, 0x03, 7)
            mx = self._signed16((data[1] << 8) | data[0])
            my = self._signed16((data[3] << 8) | data[2])
            mz = self._signed16((data[5] << 8) | data[4])
            st2 = data[6]
            if st2 & 0x08:
                return self._last_mag
            # 16-bit scale (0.15 uT/LSB) with factory sensitivity adjustment.
            mx = mx * 0.15 * self.mag_adj_x
            my = my * 0.15 * self.mag_adj_y
            mz = mz * 0.15 * self.mag_adj_z
            mx += self.mx_offset
            my += self.my_offset
            mz += self.mz_offset
            self._last_mag = (mx, my, mz)
            return self._last_mag
        except Exception:
            return self._last_mag

    def _load_calibration(self):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        cali_path = os.path.join(script_dir, "IMU_cali.txt")

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
                        elif key == "mx_offset_ut":
                            self.mx_offset = val
                        elif key == "my_offset_ut":
                            self.my_offset = val
                        elif key == "mz_offset_ut":
                            self.mz_offset = val
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

    def close(self):
        self.bus.close()


def is_stationary(ax, ay, az, gx, gy, gz):
    accel_norm = math.sqrt(ax * ax + ay * ay + az * az)
    return abs(accel_norm - 1.0) < 0.08 and abs(gx) < 2.0 and abs(gy) < 2.0 and abs(gz) < 2.0


def normalize_angle(angle):
    while angle > 180.0:
        angle -= 360.0
    while angle < -180.0:
        angle += 360.0
    return angle


def blend_angle(current, target, alpha):
    diff = normalize_angle(target - current)
    return normalize_angle(current + alpha * diff)


def calc_yaw_from_mag(roll_deg, pitch_deg, mx, my, mz):
    roll = math.radians(roll_deg)
    pitch = math.radians(pitch_deg)
    xh = mx * math.cos(pitch) + mz * math.sin(pitch)
    yh = mx * math.sin(roll) * math.sin(pitch) + my * math.cos(roll) - mz * math.sin(roll) * math.cos(pitch)
    return normalize_angle(math.degrees(math.atan2(yh, xh)))


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
            mx, my, mz = imu.read_mag()
            now = time.monotonic()
            dt = min(now - prev_time, 0.1)
            prev_time = now
            stationary = is_stationary(ax, ay, az, gx, gy, gz - gz_offset)
            if stationary:
                gz_offset = gz_offset * 0.995 + gz * 0.005
            pitch = pitch_filter.update(p, gx, dt)
            roll = roll_filter.update(r, gy, dt)
            yaw_gyro = normalize_angle(yaw + (gz - gz_offset) * dt)
            yaw_mag = calc_yaw_from_mag(roll, pitch, mx, my, mz)
            yaw = blend_angle(yaw_gyro, yaw_mag, 0.05)
            count += 1
            print(f"[{count:5d}] R={roll:7.2f}° P={pitch:7.2f}° Y={yaw:7.2f}° A=({ax:6.3f},{ay:6.3f},{az:6.3f}) G=({gx:7.2f},{gy:7.2f},{gz:7.2f}) M=({mx:8.2f},{my:8.2f},{mz:8.2f})")
            time.sleep(0.02)
    except KeyboardInterrupt: pass
    finally: imu.close()


if __name__ == "__main__":
    main()