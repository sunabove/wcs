import time
import board
import busio
from mpu9250_jmdev.registers import *
from mpu9250_jmdev.mpu_9250 import MPU9250


def vec_norm(v):
    return (v[0]**2 + v[1]**2 + v[2]**2) ** 0.5


def vec_dot(a, b):
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]


def vec_cross(a, b):
    return [
        a[1]*b[2] - a[2]*b[1],
        a[2]*b[0] - a[0]*b[2],
        a[0]*b[1] - a[1]*b[0],
    ]


def vec_normalize(v):
    n = vec_norm(v)
    if n < 1e-9:
        return [0.0, 0.0, 0.0]
    return [v[0] / n, v[1] / n, v[2] / n]


def mat_vec_mul(m, v):
    return [
        m[0][0]*v[0] + m[0][1]*v[1] + m[0][2]*v[2],
        m[1][0]*v[0] + m[1][1]*v[1] + m[1][2]*v[2],
        m[2][0]*v[0] + m[2][1]*v[1] + m[2][2]*v[2],
    ]


def rotation_align_to_z(from_vec):
    # Build rotation matrix that aligns from_vec direction to +Z.
    u = vec_normalize(from_vec)
    z = [0.0, 0.0, 1.0]
    c = vec_dot(u, z)

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

    axis = vec_cross(u, z)
    s = vec_norm(axis)
    k = [axis[0] / s, axis[1] / s, axis[2] / s]
    kx, ky, kz = k[0], k[1], k[2]
    one_minus_c = 1.0 - c

    return [
        [c + kx*kx*one_minus_c, kx*ky*one_minus_c - kz*s, kx*kz*one_minus_c + ky*s],
        [ky*kx*one_minus_c + kz*s, c + ky*ky*one_minus_c, ky*kz*one_minus_c - kx*s],
        [kz*kx*one_minus_c - ky*s, kz*ky*one_minus_c + kx*s, c + kz*kz*one_minus_c],
    ]

def main():
    # 1. Initialize the Shared I2C Bus using CircuitPython
    # Raspberry Pi hardware I2C uses Board pins SCL and SDA
    i2c_bus = busio.I2C(board.SCL, board.SDA)

    # 2. Initialize the MPU9250 Sensor (Gyro, Accel)
    # GY-91 usually maps the MPU9250 master address to 0x68
    try:
        mpu_sensor = MPU9250(
            address_mpu_master=MPU9050_ADDRESS_68, # 0x68 (Master IMU)
            address_mpu_slave=None,
            bus=1,                              # Uses /dev/i2c-1
            gfs=GFS_250,                        # Gyro full scale range (±250 deg/s)
            afs=AFS_2G                          # Accelerometer scale range (±2g)
        )
        mpu_sensor.configure()
        print("✅ MPU9250 IMU detected successfully.\n")
    except Exception as e:
        print(f"❌ Failed to initialize MPU9250: {e}")
        return

    print("Reading data... Press Ctrl+C to stop.\n")
    time.sleep(1)

    line = "="*80
    label_width = 10
    value_width = 7
    count = 0

    # Estimate stationary accel/gyro baseline vectors to compensate sensor bias.
    calib_samples = 40
    accel_sum_x = 0.0
    accel_sum_y = 0.0
    accel_sum_z = 0.0
    gyro_sum_x = 0.0
    gyro_sum_y = 0.0
    gyro_sum_z = 0.0
    print(f"Calibrating accel/gyro baseline... keep sensor still ({calib_samples} samples)")
    for _ in range(calib_samples):
        accel_s = mpu_sensor.readAccelerometerMaster()
        gyro_s = mpu_sensor.readGyroscopeMaster()
        accel_sum_x += accel_s[0]
        accel_sum_y += accel_s[1]
        accel_sum_z += accel_s[2]
        gyro_sum_x += gyro_s[0]
        gyro_sum_y += gyro_s[1]
        gyro_sum_z += gyro_s[2]
        time.sleep(0.02)
    accel_baseline = [
        accel_sum_x / calib_samples,
        accel_sum_y / calib_samples,
        accel_sum_z / calib_samples,
    ]
    gyro_baseline = [
        gyro_sum_x / calib_samples,
        gyro_sum_y / calib_samples,
        gyro_sum_z / calib_samples,
    ]
    accel_baseline_mag = (
        accel_baseline[0]**2 + accel_baseline[1]**2 + accel_baseline[2]**2
    ) ** 0.5
    if accel_baseline_mag < 1e-6:
        print("❌ Invalid accel baseline magnitude. Retry calibration.")
        return

    # 1g reference vector aligned to the calibration posture.
    accel_ref_1g = [
        accel_baseline[0] / accel_baseline_mag,
        accel_baseline[1] / accel_baseline_mag,
        accel_baseline[2] / accel_baseline_mag,
    ]
    rot_to_z = rotation_align_to_z(accel_ref_1g)
    print(
        f"Accel baseline vector: X={accel_baseline[0]:.3f}, "
        f"Y={accel_baseline[1]:.3f}, Z={accel_baseline[2]:.3f} "
        f"(Mag={accel_baseline_mag:.3f})\n"
    )
    print(
        f"Gyro baseline vector : X={gyro_baseline[0]:.3f}, "
        f"Y={gyro_baseline[1]:.3f}, Z={gyro_baseline[2]:.3f}\n"
    )
    
    while True:
        try:
            count += 1
            # --- Fetch MPU9250 Data ---
            accel = mpu_sensor.readAccelerometerMaster() # Returns list [x, y, z]
            gyro  = mpu_sensor.readGyroscopeMaster()     # Returns list [x, y, z]

            # --- Scannable Terminal Output ---
            accel_mag = (accel[0]**2 + accel[1]**2 + accel[2]**2) ** 0.5
            gyro_mag  = (gyro[0]**2  + gyro[1]**2  + gyro[2]**2)  ** 0.5
            # accel_c keeps gravity and removes baseline bias.
            accel_c = [
                accel[0] - accel_baseline[0] + accel_ref_1g[0],
                accel[1] - accel_baseline[1] + accel_ref_1g[1],
                accel[2] - accel_baseline[2] + accel_ref_1g[2],
            ]
            accel_c_mag = (
                accel_c[0]**2 + accel_c[1]**2 + accel_c[2]**2
            ) ** 0.5
            gyro_c = [
                gyro[0] - gyro_baseline[0],
                gyro[1] - gyro_baseline[1],
                gyro[2] - gyro_baseline[2],
            ]
            gyro_c_mag = (
                gyro_c[0]**2 + gyro_c[1]**2 + gyro_c[2]**2
            ) ** 0.5
            accel_c_axis = mat_vec_mul(rot_to_z, accel_c)
            gyro_c_axis = mat_vec_mul(rot_to_z, gyro_c)
            
            print(line)
            print(f"[{count:4d}] {('Accel-C'):<{label_width}} : X: {accel_c_axis[0]:{value_width}.2f} | Y: {accel_c_axis[1]:{value_width}.2f} | Z: {accel_c_axis[2]:{value_width}.2f} | CMag: {accel_c_mag:{value_width}.2f}")
            print(f"[{count:4d}] {('Accel Raw'):<{label_width}} : X: {accel[0]:{value_width}.2f} | Y: {accel[1]:{value_width}.2f} | Z: {accel[2]:{value_width}.2f} | RawMag: {accel_mag:{value_width}.2f}")
            print(f"[{count:4d}] {('Gyro-C'):<{label_width}} : X: {gyro_c_axis[0]:{value_width}.2f} | Y: {gyro_c_axis[1]:{value_width}.2f} | Z: {gyro_c_axis[2]:{value_width}.2f} | CMag: {gyro_c_mag:{value_width}.2f}")
            print(f"[{count:4d}] {('Gyro Raw'):<{label_width}} : X: {gyro[0]:{value_width}.2f} | Y: {gyro[1]:{value_width}.2f} | Z: {gyro[2]:{value_width}.2f} | RawMag: {gyro_mag:{value_width}.2f}")
            print(line)

            time.sleep(0.5) # Refresh rate delay

        except KeyboardInterrupt:
            print("\nExiting program gracefully.")
            break
        except Exception as e:
            print(f"Error reading sensor data: {e}")
            time.sleep(1)

if __name__ == "__main__":
    main()