import time
import board
import busio
from mpu9250_jmdev.registers import *
from mpu9250_jmdev.mpu_9250 import MPU9250


class IMU_MPU9050:
    def __init__(self, calib_duration_sec=10.0, calib_delay=0.02, loop_delay=0.5):
        self.calib_duration_sec = float(calib_duration_sec)
        self.calib_delay = float(calib_delay)
        self.loop_delay = float(loop_delay)

        self._i2c_bus = None
        self.sensor = None
        self.line = "=" * 90
        self.label_width = 10

        self.accel_baseline = [0.0, 0.0, 0.0]
        self.gyro_baseline = [0.0, 0.0, 0.0]
        self.accel_ref_1g = [0.0, 0.0, 1.0]
        self.rot_to_z = [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ]
        self.count = 0

    def vec_norm(self, v):
        return (v[0]**2 + v[1]**2 + v[2]**2) ** 0.5

    def vec_dot(self, a, b):
        return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]

    def vec_cross(self, a, b):
        return [
            a[1]*b[2] - a[2]*b[1],
            a[2]*b[0] - a[0]*b[2],
            a[0]*b[1] - a[1]*b[0],
        ]

    def vec_normalize(self, v):
        n = self.vec_norm(v)
        if n < 1e-9:
            return [0.0, 0.0, 0.0]
        return [v[0] / n, v[1] / n, v[2] / n]

    def mat_vec_mul(self, m, v):
        return [
            m[0][0]*v[0] + m[0][1]*v[1] + m[0][2]*v[2],
            m[1][0]*v[0] + m[1][1]*v[1] + m[1][2]*v[2],
            m[2][0]*v[0] + m[2][1]*v[1] + m[2][2]*v[2],
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
            [c + kx*kx*one_minus_c, kx*ky*one_minus_c - kz*s, kx*kz*one_minus_c + ky*s],
            [ky*kx*one_minus_c + kz*s, c + ky*ky*one_minus_c, ky*kz*one_minus_c - kx*s],
            [kz*kx*one_minus_c - ky*s, kz*ky*one_minus_c + kx*s, c + kz*kz*one_minus_c],
        ]

    def initialize_sensor(self):
        # Initialize the shared I2C bus and MPU9250 sensor.
        self._i2c_bus = busio.I2C(board.SCL, board.SDA)
        self.sensor = MPU9250(
            address_mpu_master=MPU9050_ADDRESS_68,
            address_mpu_slave=None,
            bus=1,
            gfs=GFS_250,
            afs=AFS_2G,
        )
        self.sensor.configure()
        print("✅ MPU9250 IMU detected successfully.\n")

    def calibrate(self):
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

        print(f"Calibrating accel/gyro baseline... keep sensor still ({self.calib_duration_sec:.1f} sec)")
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
                    accel_c_mag_now = self.vec_norm(accel_c_axis_now)
                    gyro_c_mag_now = self.vec_norm(gyro_c_axis_now)

                    print(
                        f"[CALI {elapsed:5.2f}s] {('Acce-R'):<{self.label_width}} : "
                        f"X: {accel_s[0]:6.2f}   g | Y: {accel_s[1]:6.2f}   g | Z: {accel_s[2]:6.2f}   g"
                    )
                    print(
                        f"[CALI {elapsed:5.2f}s] {('Acce-C'):<{self.label_width}} : "
                        f"X: {accel_c_axis_now[0]:6.2f}   g | Y: {accel_c_axis_now[1]:6.2f}   g | "
                        f"Z: {accel_c_axis_now[2]:6.2f}   g | Mag-C: {accel_c_mag_now:6.2f}   g"
                    )
                    print(
                        f"[CALI {elapsed:5.2f}s] {('Gyro-R'):<{self.label_width}} : "
                        f"X: {gyro_s[0]:6.2f} °/s | Y: {gyro_s[1]:6.2f} °/s | Z: {gyro_s[2]:6.2f} °/s"
                    )
                    print(
                        f"[CALI {elapsed:5.2f}s] {('Gyro-C'):<{self.label_width}} : "
                        f"X: {gyro_c_axis_now[0]:6.2f} °/s | Y: {gyro_c_axis_now[1]:6.2f} °/s | "
                        f"Z: {gyro_c_axis_now[2]:6.2f} °/s | Mag-C: {gyro_c_mag_now:6.2f} °/s"
                    )
                    print(self.line)
                    last_progress_print = elapsed

            if self.calib_delay > 0.0:
                remaining = end_time - time.monotonic()
                if remaining <= 0.0:
                    break
                time.sleep(min(self.calib_delay, remaining))

        if sample_count < 1:
            raise ValueError("No samples collected during calibration.")

        self.accel_baseline = [
            accel_sum_x / sample_count,
            accel_sum_y / sample_count,
            accel_sum_z / sample_count,
        ]
        self.gyro_baseline = [
            gyro_sum_x / sample_count,
            gyro_sum_y / sample_count,
            gyro_sum_z / sample_count,
        ]
        accel_baseline_mag = (
            self.accel_baseline[0]**2 + self.accel_baseline[1]**2 + self.accel_baseline[2]**2
        ) ** 0.5

        if accel_baseline_mag < 1e-6:
            raise ValueError("Invalid accel baseline magnitude. Retry calibration.")

        self.accel_ref_1g = [
            self.accel_baseline[0] / accel_baseline_mag,
            self.accel_baseline[1] / accel_baseline_mag,
            self.accel_baseline[2] / accel_baseline_mag,
        ]
        self.rot_to_z = self.rotation_align_to_z(self.accel_ref_1g)

        print(
            f"Accel baseline vector: X={self.accel_baseline[0]:.3f} g, "
            f"Y={self.accel_baseline[1]:.3f} g, Z={self.accel_baseline[2]:.3f} g "
            f"(Mag={accel_baseline_mag:.3f} g)\n"
        )
        print(
            f"Gyro baseline vector : X={self.gyro_baseline[0]:.3f} °/s, "
            f"Y={self.gyro_baseline[1]:.3f} °/s, Z={self.gyro_baseline[2]:.3f} °/s\n"
        )

    def read_compensated(self):
        accel = self.sensor.readAccelerometerMaster()
        gyro = self.sensor.readGyroscopeMaster()

        accel_mag = (accel[0]**2 + accel[1]**2 + accel[2]**2) ** 0.5
        gyro_mag = (gyro[0]**2 + gyro[1]**2 + gyro[2]**2) ** 0.5

        accel_c = [
            accel[0] - self.accel_baseline[0] + self.accel_ref_1g[0],
            accel[1] - self.accel_baseline[1] + self.accel_ref_1g[1],
            accel[2] - self.accel_baseline[2] + self.accel_ref_1g[2],
        ]
        accel_c_mag = (accel_c[0]**2 + accel_c[1]**2 + accel_c[2]**2) ** 0.5

        gyro_c = [
            gyro[0] - self.gyro_baseline[0],
            gyro[1] - self.gyro_baseline[1],
            gyro[2] - self.gyro_baseline[2],
        ]
        gyro_c_mag = (gyro_c[0]**2 + gyro_c[1]**2 + gyro_c[2]**2) ** 0.5

        accel_c_axis = self.mat_vec_mul(self.rot_to_z, accel_c)
        gyro_c_axis = self.mat_vec_mul(self.rot_to_z, gyro_c)

        return {
            "accel": accel,
            "gyro": gyro,
            "accel_mag": accel_mag,
            "gyro_mag": gyro_mag,
            "accel_c_axis": accel_c_axis,
            "gyro_c_axis": gyro_c_axis,
            "accel_c_mag": accel_c_mag,
            "gyro_c_mag": gyro_c_mag,
        }

    def print_reading(self, reading):
        self.count += 1
        accel = reading["accel"]
        gyro = reading["gyro"]

        print(self.line)
        print(f"[{self.count:4d}] {('Acce-R'):<{self.label_width}} : X: {accel[0]:6.2f}   g | Y: {accel[1]:6.2f}   g | Z: {accel[2]:6.2f}   g | Mag-R: {reading['accel_mag']:6.2f}   g")
        print(f"[{self.count:4d}] {('Acce-C'):<{self.label_width}} : X: {reading['accel_c_axis'][0]:6.2f}   g | Y: {reading['accel_c_axis'][1]:6.2f}   g | Z: {reading['accel_c_axis'][2]:6.2f}   g | Mag-C: {reading['accel_c_mag']:6.2f}   g")
        print(f"[{self.count:4d}] {('Gyro-R'):<{self.label_width}} : X: {gyro[0]:6.2f} °/s | Y: {gyro[1]:6.2f} °/s | Z: {gyro[2]:6.2f} °/s | Mag-R: {reading['gyro_mag']:6.2f} °/s")
        print(f"[{self.count:4d}] {('Gyro-C'):<{self.label_width}} : X: {reading['gyro_c_axis'][0]:6.2f} °/s | Y: {reading['gyro_c_axis'][1]:6.2f} °/s | Z: {reading['gyro_c_axis'][2]:6.2f} °/s | Mag-C: {reading['gyro_c_mag']:6.2f} °/s")
        print(self.line)

    def run(self):
        self.initialize_sensor()
        print("Reading data... Press Ctrl+C to stop.\n")
        time.sleep(1)
        self.calibrate()

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
        monitor = IMU_MPU9050()
        monitor.run()
    except Exception as e:
        print(f"❌ Failed to initialize MPU9250: {e}")

if __name__ == "__main__":
    main()