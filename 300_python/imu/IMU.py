import os
import time

import board
import busio
from mpu9250_jmdev.mpu_9250 import MPU9250
from mpu9250_jmdev.registers import *


class IMU_MPU9250:
    def __init__(self, calib_duration_sec=10.0, calib_delay=0.02, loop_delay=0.5):
        self.calib_duration_sec = float(calib_duration_sec)
        self.calib_delay = float(calib_delay)
        self.loop_delay = float(loop_delay)

        self._i2c_bus = None
        self.sensor = None

        self.line = "=" * 100
        self.label_width = 10
        self.count = 0

        self.accel_baseline = [0.0, 0.0, 0.0]
        self.gyro_baseline = [0.0, 0.0, 0.0]
        self.accel_ref_1g = [0.0, 0.0, 1.0]
        self.rot_to_z = [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ]

    def vec_norm(self, v):
        return (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) ** 0.5

    def vec_dot(self, a, b):
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

    def vec_cross(self, a, b):
        return [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]

    def vec_normalize(self, v):
        n = self.vec_norm(v)
        if n < 1e-9:
            return [0.0, 0.0, 0.0]
        return [v[0] / n, v[1] / n, v[2] / n]

    def mat_vec_mul(self, m, v):
        return [
            m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
        ]

    def rotation_align_to_z(self, from_vec):
        # Build rotation matrix that aligns from_vec direction to +Z.
        u = self.vec_normalize(from_vec)
        z = [0.0, 0.0, 1.0]
        c = self.vec_dot(u, z)

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

        axis = self.vec_cross(u, z)
        s = self.vec_norm(axis)
        k = [axis[0] / s, axis[1] / s, axis[2] / s]
        kx, ky, kz = k[0], k[1], k[2]
        one_minus_c = 1.0 - c

        return [
            [
                c + kx * kx * one_minus_c,
                kx * ky * one_minus_c - kz * s,
                kx * kz * one_minus_c + ky * s,
            ],
            [
                ky * kx * one_minus_c + kz * s,
                c + ky * ky * one_minus_c,
                ky * kz * one_minus_c - kx * s,
            ],
            [
                kz * kx * one_minus_c - ky * s,
                kz * ky * one_minus_c + kx * s,
                c + kz * kz * one_minus_c,
            ],
        ]

    def initialize_sensor(self):
        self._i2c_bus = busio.I2C(board.SCL, board.SDA)
        self.sensor = MPU9250(
            address_mpu_master=MPU9050_ADDRESS_68,
            address_mpu_slave=None,
            bus=1,
            gfs=GFS_250,
            afs=AFS_2G,
        )
        self.sensor.configure()

    def collect_plane_pose(self, plane_name):
        accel_sum_x = 0.0
        accel_sum_y = 0.0
        accel_sum_z = 0.0
        gyro_sum_x = 0.0
        gyro_sum_y = 0.0
        gyro_sum_z = 0.0
        sample_count = 0
        start_time = time.monotonic()
        end_time = start_time + max(0.0, self.calib_duration_sec)
        progress_interval = 0.2
        last_progress_print = -progress_interval

        print(self.line)
        print(f"[{plane_name}] plane calibration start ({self.calib_duration_sec:.1f} sec)")
        print(f"Keep {plane_name} plane still and press Enter to start.")
        input()

        while True:
            now = time.monotonic()
            if sample_count > 0 and now >= end_time:
                break

            accel_s = self.sensor.readAccelerometerMaster()
            gyro_s = self.sensor.readGyroscopeMaster()
            accel_sum_x += accel_s[0]
            accel_sum_y += accel_s[1]
            accel_sum_z += accel_s[2]
            gyro_sum_x += gyro_s[0]
            gyro_sum_y += gyro_s[1]
            gyro_sum_z += gyro_s[2]
            sample_count += 1

            elapsed = now - start_time
            should_print_progress = (
                elapsed - last_progress_print >= progress_interval
                or sample_count == 1
                or now >= end_time
            )
            if should_print_progress:
                accel_baseline_now = [
                    accel_sum_x / sample_count,
                    accel_sum_y / sample_count,
                    accel_sum_z / sample_count,
                ]
                gyro_baseline_now = [
                    gyro_sum_x / sample_count,
                    gyro_sum_y / sample_count,
                    gyro_sum_z / sample_count,
                ]
                accel_baseline_mag_now = self.vec_norm(accel_baseline_now)

                if accel_baseline_mag_now >= 1e-9:
                    accel_ref_1g_now = [
                        accel_baseline_now[0] / accel_baseline_mag_now,
                        accel_baseline_now[1] / accel_baseline_mag_now,
                        accel_baseline_now[2] / accel_baseline_mag_now,
                    ]
                    rot_to_z_now = self.rotation_align_to_z(accel_ref_1g_now)
                    accel_c_now = [
                        accel_s[0] - accel_baseline_now[0] + accel_ref_1g_now[0],
                        accel_s[1] - accel_baseline_now[1] + accel_ref_1g_now[1],
                        accel_s[2] - accel_baseline_now[2] + accel_ref_1g_now[2],
                    ]
                    gyro_c_now = [
                        gyro_s[0] - gyro_baseline_now[0],
                        gyro_s[1] - gyro_baseline_now[1],
                        gyro_s[2] - gyro_baseline_now[2],
                    ]
                    accel_c_axis_now = self.mat_vec_mul(rot_to_z_now, accel_c_now)
                    gyro_c_axis_now = self.mat_vec_mul(rot_to_z_now, gyro_c_now)

                    accel_r_mag_now = self.vec_norm(accel_s)
                    gyro_r_mag_now = self.vec_norm(gyro_s)
                    accel_c_mag_now = self.vec_norm(accel_c_axis_now)
                    gyro_c_mag_now = self.vec_norm(gyro_c_axis_now)
                    
                    print( self.line)

                    print(
                        f"[{plane_name} {elapsed:5.2f}s] {('Acce-R'):<{self.label_width}} : "
                        f"X: {accel_s[0]:6.2f}   g | Y: {accel_s[1]:6.2f}   g | Z: {accel_s[2]:6.2f}   g | "
                        f"Mag-R: {accel_r_mag_now:6.2f}   g"
                    )
                    print(
                        f"[{plane_name} {elapsed:5.2f}s] {('Acce-C'):<{self.label_width}} : "
                        f"X: {accel_c_axis_now[0]:6.2f}   g | Y: {accel_c_axis_now[1]:6.2f}   g | "
                        f"Z: {accel_c_axis_now[2]:6.2f}   g | Mag-C: {accel_c_mag_now:6.2f}   g"
                    )
                    print(
                        f"[{plane_name} {elapsed:5.2f}s] {('Gyro-R'):<{self.label_width}} : "
                        f"X: {gyro_s[0]:6.2f} d/s | Y: {gyro_s[1]:6.2f} d/s | Z: {gyro_s[2]:6.2f} d/s | "
                        f"Mag-R: {gyro_r_mag_now:6.2f} d/s"
                    )
                    print(
                        f"[{plane_name} {elapsed:5.2f}s] {('Gyro-C'):<{self.label_width}} : "
                        f"X: {gyro_c_axis_now[0]:6.2f} d/s | Y: {gyro_c_axis_now[1]:6.2f} d/s | "
                        f"Z: {gyro_c_axis_now[2]:6.2f} d/s | Mag-C: {gyro_c_mag_now:6.2f} d/s"
                    )
                    last_progress_print = elapsed

            if self.calib_delay > 0.0:
                remaining = end_time - time.monotonic()
                if remaining <= 0.0:
                    break
                time.sleep(min(self.calib_delay, remaining))

        if sample_count < 1:
            raise ValueError(f"No samples collected during {plane_name} calibration.")

        accel_mean = [
            accel_sum_x / sample_count,
            accel_sum_y / sample_count,
            accel_sum_z / sample_count,
        ]
        gyro_mean = [
            gyro_sum_x / sample_count,
            gyro_sum_y / sample_count,
            gyro_sum_z / sample_count,
        ]
        print(self.line)
        print(
            f"[{plane_name}] mean accel: X={accel_mean[0]:.3f} g, "
            f"Y={accel_mean[1]:.3f} g, Z={accel_mean[2]:.3f} g"
        )
        print(
            f"[{plane_name}] mean gyro : X={gyro_mean[0]:.3f} d/s, "
            f"Y={gyro_mean[1]:.3f} d/s, Z={gyro_mean[2]:.3f} d/s"
        )
        return accel_mean, gyro_mean

    def calibrate(self):
        z_accel, z_gyro = self.collect_plane_pose("Z-PLANE")
        x_accel, x_gyro = self.collect_plane_pose("X-PLANE")
        y_accel, y_gyro = self.collect_plane_pose("Y-PLANE")

        self.accel_baseline = [
            (z_accel[0] + x_accel[0] + y_accel[0]) / 3.0,
            (z_accel[1] + x_accel[1] + y_accel[1]) / 3.0,
            (z_accel[2] + x_accel[2] + y_accel[2]) / 3.0,
        ]
        self.gyro_baseline = [
            (z_gyro[0] + x_gyro[0] + y_gyro[0]) / 3.0,
            (z_gyro[1] + x_gyro[1] + y_gyro[1]) / 3.0,
            (z_gyro[2] + x_gyro[2] + y_gyro[2]) / 3.0,
        ]

        accel_baseline_mag = self.vec_norm(z_accel)
        if accel_baseline_mag < 1e-6:
            raise ValueError("Invalid Z-plane accel magnitude. Retry calibration.")

        # Use Z-plane gravity direction as the 1g reference for axis alignment.
        self.accel_ref_1g = [
            z_accel[0] / accel_baseline_mag,
            z_accel[1] / accel_baseline_mag,
            z_accel[2] / accel_baseline_mag,
        ]
        self.rot_to_z = self.rotation_align_to_z(self.accel_ref_1g)

        print(self.line)
        cali_path = self.save_calibration()
        print(f"Calibration saved: {cali_path}")
        self.print_calibration_values()
        return cali_path

    def save_calibration(self, file_name="IMU_Cali.txt"):
        if self.accel_baseline is None or self.gyro_baseline is None or self.rot_to_z is None:
            raise ValueError("Calibration values are not ready.")

        script_dir = os.path.dirname(os.path.abspath(__file__))
        cali_path = os.path.join(script_dir, file_name)

        lines = [
            "# IMU calibration generated by IMU.py",
            f"accel_baseline_x_g={self.accel_baseline[0]:.10f}",
            f"accel_baseline_y_g={self.accel_baseline[1]:.10f}",
            f"accel_baseline_z_g={self.accel_baseline[2]:.10f}",
            f"accel_ref_1g_x={self.accel_ref_1g[0]:.10f}",
            f"accel_ref_1g_y={self.accel_ref_1g[1]:.10f}",
            f"accel_ref_1g_z={self.accel_ref_1g[2]:.10f}",
            f"gyro_baseline_x_dps={self.gyro_baseline[0]:.10f}",
            f"gyro_baseline_y_dps={self.gyro_baseline[1]:.10f}",
            f"gyro_baseline_z_dps={self.gyro_baseline[2]:.10f}",
            f"rot_to_z_r00={self.rot_to_z[0][0]:.10f}",
            f"rot_to_z_r01={self.rot_to_z[0][1]:.10f}",
            f"rot_to_z_r02={self.rot_to_z[0][2]:.10f}",
            f"rot_to_z_r10={self.rot_to_z[1][0]:.10f}",
            f"rot_to_z_r11={self.rot_to_z[1][1]:.10f}",
            f"rot_to_z_r12={self.rot_to_z[1][2]:.10f}",
            f"rot_to_z_r20={self.rot_to_z[2][0]:.10f}",
            f"rot_to_z_r21={self.rot_to_z[2][1]:.10f}",
            f"rot_to_z_r22={self.rot_to_z[2][2]:.10f}",
            "",
        ]

        with open(cali_path, "w", encoding="utf-8") as fp:
            fp.write("\n".join(lines))

        return cali_path

    def load_calibration(self, file_name="IMU_Cali.txt"):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        cali_path = os.path.join(script_dir, file_name)

        if not os.path.exists(cali_path):
            return False

        values = {}
        with open(cali_path, "r", encoding="utf-8") as fp:
            for line in fp:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                try:
                    values[key] = float(value)
                except ValueError:
                    continue

        required_keys = [
            "accel_baseline_x_g",
            "accel_baseline_y_g",
            "accel_baseline_z_g",
            "accel_ref_1g_x",
            "accel_ref_1g_y",
            "accel_ref_1g_z",
            "gyro_baseline_x_dps",
            "gyro_baseline_y_dps",
            "gyro_baseline_z_dps",
            "rot_to_z_r00",
            "rot_to_z_r01",
            "rot_to_z_r02",
            "rot_to_z_r10",
            "rot_to_z_r11",
            "rot_to_z_r12",
            "rot_to_z_r20",
            "rot_to_z_r21",
            "rot_to_z_r22",
        ]
        for key in required_keys:
            if key not in values:
                raise ValueError(f"Invalid calibration file. Missing key: {key}")

        self.accel_baseline = [
            values["accel_baseline_x_g"],
            values["accel_baseline_y_g"],
            values["accel_baseline_z_g"],
        ]
        self.accel_ref_1g = [
            values["accel_ref_1g_x"],
            values["accel_ref_1g_y"],
            values["accel_ref_1g_z"],
        ]
        self.gyro_baseline = [
            values["gyro_baseline_x_dps"],
            values["gyro_baseline_y_dps"],
            values["gyro_baseline_z_dps"],
        ]
        self.rot_to_z = [
            [values["rot_to_z_r00"], values["rot_to_z_r01"], values["rot_to_z_r02"]],
            [values["rot_to_z_r10"], values["rot_to_z_r11"], values["rot_to_z_r12"]],
            [values["rot_to_z_r20"], values["rot_to_z_r21"], values["rot_to_z_r22"]],
        ]
        return True

    def print_calibration_values(self):
        print(
            f"Accel baseline vector: X={self.accel_baseline[0]:.3f} g, "
            f"Y={self.accel_baseline[1]:.3f} g, Z={self.accel_baseline[2]:.3f} g"
        )
        print(
            f"Gyro baseline vector : X={self.gyro_baseline[0]:.3f} d/s, "
            f"Y={self.gyro_baseline[1]:.3f} d/s, Z={self.gyro_baseline[2]:.3f} d/s"
        )
        print(
            f"Accel ref 1g vector  : X={self.accel_ref_1g[0]:.3f}, "
            f"Y={self.accel_ref_1g[1]:.3f}, Z={self.accel_ref_1g[2]:.3f}"
        )
        print(
            "Rotation matrix (rot_to_z): "
            f"[{self.rot_to_z[0][0]:.3f}, {self.rot_to_z[0][1]:.3f}, {self.rot_to_z[0][2]:.3f}] "
            f"[{self.rot_to_z[1][0]:.3f}, {self.rot_to_z[1][1]:.3f}, {self.rot_to_z[1][2]:.3f}] "
            f"[{self.rot_to_z[2][0]:.3f}, {self.rot_to_z[2][1]:.3f}, {self.rot_to_z[2][2]:.3f}]"
        )

    def read_compensated(self):
        accel = self.sensor.readAccelerometerMaster()
        gyro = self.sensor.readGyroscopeMaster()

        accel_mag = self.vec_norm(accel)
        gyro_mag = self.vec_norm(gyro)

        accel_c = [
            accel[0] - self.accel_baseline[0] + self.accel_ref_1g[0],
            accel[1] - self.accel_baseline[1] + self.accel_ref_1g[1],
            accel[2] - self.accel_baseline[2] + self.accel_ref_1g[2],
        ]
        gyro_c = [
            gyro[0] - self.gyro_baseline[0],
            gyro[1] - self.gyro_baseline[1],
            gyro[2] - self.gyro_baseline[2],
        ]

        accel_c_axis = self.mat_vec_mul(self.rot_to_z, accel_c)
        gyro_c_axis = self.mat_vec_mul(self.rot_to_z, gyro_c)

        return {
            "accel": accel,
            "gyro": gyro,
            "accel_mag": accel_mag,
            "gyro_mag": gyro_mag,
            "accel_c_axis": accel_c_axis,
            "gyro_c_axis": gyro_c_axis,
            "accel_c_mag": self.vec_norm(accel_c_axis),
            "gyro_c_mag": self.vec_norm(gyro_c_axis),
        }

    def print_reading(self, reading):
        self.count += 1
        accel = reading["accel"]
        gyro = reading["gyro"]

        print(self.line)
        print(
            f"[{self.count:4d}] {('Acce-R'):<{self.label_width}} : "
            f"X: {accel[0]:6.2f}   g | Y: {accel[1]:6.2f}   g | Z: {accel[2]:6.2f}   g | "
            f"Mag-R: {reading['accel_mag']:6.2f}   g"
        )
        print(
            f"[{self.count:4d}] {('Acce-C'):<{self.label_width}} : "
            f"X: {reading['accel_c_axis'][0]:6.2f}   g | Y: {reading['accel_c_axis'][1]:6.2f}   g | "
            f"Z: {reading['accel_c_axis'][2]:6.2f}   g | Mag-C: {reading['accel_c_mag']:6.2f}   g"
        )
        print(
            f"[{self.count:4d}] {('Gyro-R'):<{self.label_width}} : "
            f"X: {gyro[0]:6.2f} d/s | Y: {gyro[1]:6.2f} d/s | Z: {gyro[2]:6.2f} d/s | "
            f"Mag-R: {reading['gyro_mag']:6.2f} d/s"
        )
        print(
            f"[{self.count:4d}] {('Gyro-C'):<{self.label_width}} : "
            f"X: {reading['gyro_c_axis'][0]:6.2f} d/s | Y: {reading['gyro_c_axis'][1]:6.2f} d/s | "
            f"Z: {reading['gyro_c_axis'][2]:6.2f} d/s | Mag-C: {reading['gyro_c_mag']:6.2f} d/s"
        )
        print(self.line)

    def run(self):
        cali_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "IMU_Cali.txt")
        has_cali_file = os.path.exists(cali_path)
        if not has_cali_file:
            print("[WARN] IMU_Cali.txt not found. Calibration is required.")

        self.initialize_sensor()
        print("Reading data... Press Ctrl+C to stop.")
        print(self.line)
        time.sleep(1)

        if has_cali_file:
            self.load_calibration()
            print(f"Calibration loaded: {cali_path}")
            self.print_calibration_values()
        else:
            self.calibrate()
            input("Press Enter to continue to monitoring the calibrated data...")

        while True:
            try:
                reading = self.read_compensated()
                self.print_reading(reading)
                time.sleep(self.loop_delay)
            except KeyboardInterrupt:
                print("\nExiting program gracefully.")
                break
            except Exception as e:
                print(f"Error reading sensor data: {e}")
                time.sleep(1)


def main():
    try:
        monitor = IMU_MPU9250()
        monitor.run()
    except Exception as e:
        print(f"Failed to initialize MPU9250: {e}")


if __name__ == "__main__":
    main()
