#!/usr/bin/env python3

import os
import time
from smbus2 import SMBus

MPU_ADDR = 0x68
AK8963_ADDR = 0x0C


def signed16(v):
    return v - 65536 if v > 32767 else v


bus = SMBus(1)

# MPU9250 Wakeup
bus.write_byte_data(MPU_ADDR, 0x6B, 0x00)
time.sleep(0.1)

# Bypass mode
bus.write_byte_data(MPU_ADDR, 0x6A, 0x00)
bus.write_byte_data(MPU_ADDR, 0x37, 0x02)

# WHO_AM_I
whoami = bus.read_byte_data(AK8963_ADDR, 0x00)
print(f"AK8963 WHO_AM_I = 0x{whoami:02X}")

# Fuse ROM
bus.write_byte_data(AK8963_ADDR, 0x0A, 0x00)
time.sleep(0.01)

bus.write_byte_data(AK8963_ADDR, 0x0A, 0x0F)
time.sleep(0.01)

asa = bus.read_i2c_block_data(AK8963_ADDR, 0x10, 3)

adj_x = ((asa[0] - 128) / 256.0) + 1.0
adj_y = ((asa[1] - 128) / 256.0) + 1.0
adj_z = ((asa[2] - 128) / 256.0) + 1.0

print(
    f"ASA=({adj_x:.3f}, {adj_y:.3f}, {adj_z:.3f})"
)

# Continuous mode 100Hz
bus.write_byte_data(AK8963_ADDR, 0x0A, 0x00)
time.sleep(0.01)

bus.write_byte_data(AK8963_ADDR, 0x0A, 0x16)
time.sleep(0.01)

mx_min = my_min = mz_min = 999999
mx_max = my_max = mz_max = -999999
sample_count = 0

print()
print("Rotate sensor slowly in ALL directions.")
print("Press Ctrl+C when finished.")
print()

try:
    while True:

        st1 = bus.read_byte_data(AK8963_ADDR, 0x02)

        if (st1 & 0x01) == 0:
            continue

        data = bus.read_i2c_block_data(
            AK8963_ADDR,
            0x03,
            7
        )

        mx = signed16((data[1] << 8) | data[0])
        my = signed16((data[3] << 8) | data[2])
        mz = signed16((data[5] << 8) | data[4])

        mx *= 0.15 * adj_x
        my *= 0.15 * adj_y
        mz *= 0.15 * adj_z

        mx_min = min(mx_min, mx)
        my_min = min(my_min, my)
        mz_min = min(mz_min, mz)

        mx_max = max(mx_max, mx)
        my_max = max(my_max, my)
        mz_max = max(mz_max, mz)
        sample_count += 1

        print(
            f"MX[{mx_min:7.1f},{mx_max:7.1f}] "
            f"MY[{my_min:7.1f},{my_max:7.1f}] "
            f"MZ[{mz_min:7.1f},{mz_max:7.1f}]",
            end="\r"
        )

        time.sleep(0.02)

except KeyboardInterrupt:

    print("\n")
    print("Calibration Result")
    print("------------------")

    if sample_count == 0:
        print("No samples collected; IMU_Cali.txt was not updated.")
    else:
        print(f"sample_count = {sample_count}")

        print(f"mx_min = {mx_min:.3f}")
        print(f"mx_max = {mx_max:.3f}")

        print(f"my_min = {my_min:.3f}")
        print(f"my_max = {my_max:.3f}")

        print(f"mz_min = {mz_min:.3f}")
        print(f"mz_max = {mz_max:.3f}")

        mx_offset = -(mx_max + mx_min) / 2.0
        my_offset = -(my_max + my_min) / 2.0
        mz_offset = -(mz_max + mz_min) / 2.0

        print()
        print("Offsets")
        print("-------")

        print(f"mx_offset_ut={mx_offset:.3f}")
        print(f"my_offset_ut={my_offset:.3f}")
        print(f"mz_offset_ut={mz_offset:.3f}")

        cal_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "IMU_Cali.txt")
        cal_map = {}

        if os.path.exists(cal_path):
            with open(cal_path, "r", encoding="utf-8") as fp:
                for line in fp:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    cal_map[k.strip()] = v.strip()

        cal_map["mx_min_ut"] = f"{mx_min:.6f}"
        cal_map["mx_max_ut"] = f"{mx_max:.6f}"
        cal_map["my_min_ut"] = f"{my_min:.6f}"
        cal_map["my_max_ut"] = f"{my_max:.6f}"
        cal_map["mz_min_ut"] = f"{mz_min:.6f}"
        cal_map["mz_max_ut"] = f"{mz_max:.6f}"
        cal_map["mx_offset_ut"] = f"{mx_offset:.6f}"
        cal_map["my_offset_ut"] = f"{my_offset:.6f}"
        cal_map["mz_offset_ut"] = f"{mz_offset:.6f}"
        cal_map["mag_sample_count"] = str(sample_count)
        cal_map["mag_cal_timestamp_unix"] = str(int(time.time()))

        with open(cal_path, "w", encoding="utf-8") as fp:
            fp.write("# IMU calibration values\n")
            for key in sorted(cal_map.keys()):
                fp.write(f"{key}={cal_map[key]}\n")

        print(f"Saved: {cal_path}")

finally:
    bus.close()