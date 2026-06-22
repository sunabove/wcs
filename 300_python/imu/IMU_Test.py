#!/usr/bin/env python3

import time
from smbus2 import SMBus

MPU_ADDR = 0x68
PWR_MGMT_1 = 0x6B
ACCEL_XOUT_H = 0x3B
GYRO_XOUT_H  = 0x43
ACCEL_SCALE = 16384.0
GYRO_SCALE  = 131.0
MEASURE_PERIOD_SEC = 0.05


class MPU9250:
    def __init__(self, bus_num=1, addr=MPU_ADDR):
        self.bus = SMBus(bus_num); self.addr = addr
        self.bus.write_byte_data(self.addr, PWR_MGMT_1, 0x00)
        time.sleep(0.1)

    def read_word(self, reg):
        high = self.bus.read_byte_data(self.addr, reg); low = self.bus.read_byte_data(self.addr, reg + 1)
        value = (high << 8) | low
        return value - 65536 if value >= 32768 else value

    def read_accel(self):
        ax = self.read_word(ACCEL_XOUT_H); ay = self.read_word(ACCEL_XOUT_H + 2); az = self.read_word(ACCEL_XOUT_H + 4)
        return (ax / ACCEL_SCALE, ay / ACCEL_SCALE, az / ACCEL_SCALE)

    def read_gyro(self):
        gx = self.read_word(GYRO_XOUT_H); gy = self.read_word(GYRO_XOUT_H + 2); gz = self.read_word(GYRO_XOUT_H + 4)
        return (gx / GYRO_SCALE, gy / GYRO_SCALE, gz / GYRO_SCALE)

    def close(self):
        self.bus.close()

def main():
    imu = MPU9250()
    count = 0
    prev_ts = None
    print("GY-91 MPU9250 Test")
    print()
    try:
        while True:
            count += 1
            now_ts = time.monotonic(); dt = 0.0 if prev_ts is None else (now_ts - prev_ts); prev_ts = now_ts
            ax, ay, az = imu.read_accel()
            gx, gy, gz = imu.read_gyro()
            print(f"[{count:5d}] dt[s]={dt:6.3f} ACC[g] ({ax:7.3f}, {ay:7.3f}, {az:7.3f}), |ACC| ({abs(ax):7.3f}, {abs(ay):7.3f}, {abs(az):7.3f})")
            print(f"          GYR[°/s] ({gx:8.2f}, {gy:8.2f}, {gz:8.2f}), |GYR| ({abs(gx):8.2f}, {abs(gy):8.2f}, {abs(gz):8.2f})")
            time.sleep(MEASURE_PERIOD_SEC)
    except KeyboardInterrupt:
        pass
    finally:
        imu.close()


if __name__ == "__main__":
    main()