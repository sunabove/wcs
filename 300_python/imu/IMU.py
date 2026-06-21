#!/usr/bin/env python3

import math
import time

from smbus2 import SMBus


class GY91:

    MPU_ADDR = 0x68
    AK8963_ADDR = 0x0C

    REG_WHO_AM_I = 0x75
    REG_PWR_MGMT_1 = 0x6B

    REG_ACCEL_XOUT_H = 0x3B
    REG_TEMP_OUT_H = 0x41
    REG_GYRO_XOUT_H = 0x43

    REG_INT_PIN_CFG = 0x37

    REG_AK8963_WIA = 0x00
    REG_AK8963_CNTL1 = 0x0A

    def __init__(self, bus_num=1):
        self.bus = SMBus(bus_num)
        who = self.bus.read_byte_data(self.MPU_ADDR, self.REG_WHO_AM_I)
        print(f"MPU WHO_AM_I = 0x{who:02X}")
        self.bus.write_byte_data(self.MPU_ADDR, self.REG_PWR_MGMT_1, 0x00)
        time.sleep(0.1)
        self.bus.write_byte_data(self.MPU_ADDR, self.REG_INT_PIN_CFG, 0x02)
        time.sleep(0.05)
        self.has_mag = self.detect_mag()

    def detect_mag(self):
        try:
            wia = self.bus.read_byte_data(self.AK8963_ADDR, self.REG_AK8963_WIA)
            if wia == 0x48:
                self.bus.write_byte_data(self.AK8963_ADDR, self.REG_AK8963_CNTL1, 0x16)
                print("AK8963 detected")
                return True
        except Exception:
            pass
        print("AK8963 not found")
        return False

    @staticmethod
    def _signed(v):
        return v - 65536 if v >= 32768 else v

    def read_accel(self):
        data = self.bus.read_i2c_block_data(self.MPU_ADDR, self.REG_ACCEL_XOUT_H, 6)
        ax = self._signed((data[0] << 8) | data[1])
        ay = self._signed((data[2] << 8) | data[3])
        az = self._signed((data[4] << 8) | data[5])
        return ax / 16384.0, ay / 16384.0, az / 16384.0

    def read_gyro(self):
        data = self.bus.read_i2c_block_data(self.MPU_ADDR, self.REG_GYRO_XOUT_H, 6)
        gx = self._signed((data[0] << 8) | data[1])
        gy = self._signed((data[2] << 8) | data[3])
        gz = self._signed((data[4] << 8) | data[5])
        return gx / 131.0, gy / 131.0, gz / 131.0

    def read_temp(self):
        data = self.bus.read_i2c_block_data(self.MPU_ADDR, self.REG_TEMP_OUT_H, 2)
        temp_raw = self._signed((data[0] << 8) | data[1])
        return (temp_raw / 333.87) + 21.0

    def read_mag(self):
        if not self.has_mag:
            return None
        try:
            data = self.bus.read_i2c_block_data(self.AK8963_ADDR, 0x03, 6)
            mx = self._signed((data[1] << 8) | data[0])
            my = self._signed((data[3] << 8) | data[2])
            mz = self._signed((data[5] << 8) | data[4])
            return mx * 0.15, my * 0.15, mz * 0.15
        except Exception:
            return None

    @staticmethod
    def calc_pitch_roll(ax, ay, az):
        pitch = math.degrees(math.atan2(ax, math.sqrt(ay * ay + az * az)))
        roll = math.degrees(math.atan2(ay, az))
        return pitch, roll

    def close(self):
        self.bus.close()


def main():
    imu = GY91()
    try:
        while True:
            ax, ay, az = imu.read_accel()
            gx, gy, gz = imu.read_gyro()
            temp = imu.read_temp()
            pitch, roll = imu.calc_pitch_roll(ax, ay, az)
            print(f"T={temp:5.1f}C  P={pitch:6.1f}°  R={roll:6.1f}°")
            print(f"ACC  {ax:6.2f} {ay:6.2f} {az:6.2f}")
            print(f"GYR  {gx:7.2f} {gy:7.2f} {gz:7.2f}")
            mag = imu.read_mag()
            if mag:
                print(f"MAG  {mag[0]:7.1f} {mag[1]:7.1f} {mag[2]:7.1f}")
            print("-" * 60)
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    finally:
        imu.close()


if __name__ == "__main__":
    main()