from icm20602 import ICM20602
from time import sleep
import sys
from smbus2 import SMBus

class IMU_ICM20602_Service:
    
    def __init__(self, bus_num=1, wakeup_addr=0x69):
        self.bus_num = bus_num
        self.wakeup_addr = wakeup_addr
        self.mpu = None

    def is_sensor_available(self, status):
        if isinstance(status, bool):
            return status

        status_text = str(status).lower()
        return "no sensor" not in status_text

    def make_icm20602_wakeup(self):
        bus = SMBus(self.bus_num)

        # Wake up
        print("Waking up the ICM20602...")
        bus.write_byte_data(self.wakeup_addr, 0x6B, 0x00)
        sleep(0.1)

        # Clock source = PLL
        bus.write_byte_data(self.wakeup_addr, 0x6B, 0x01)
        sleep(0.1)

        bus.close()

    def setup_sensor(self):
        self.make_icm20602_wakeup()

        self.mpu = ICM20602()
        availability = self.mpu.check_availability(verbose=True)
        print("Availability:", availability)
        if not self.is_sensor_available(availability):
            self.close()
            print("Sensor not detected. Check power, GND, SDA/SCL wiring, and I2C address.")
            sys.exit(1)

        print("Calibrating sensor...")
        self.mpu.calibrate_sensor()
        print("Calibration done. Now reading data...")

        self.mpu.enable_smoothing(smoothing_window=7)
        self.mpu.enable_dlpf(bandwidth=self.mpu.DLPFBandwidth.BW_20HZ)

    def run_loop(self):
        print("Continous reading, break to stop")
        cnt = 1
        while True:
            accel_g = self.mpu.read_accel_data()
            gyro_g = self.mpu.read_gyro_data()
            roll, pitch = self.mpu.calculate_inclination(accel_g)

            acc_x = accel_g.accel_x
            acc_y = accel_g.accel_y
            acc_z = accel_g.accel_z
            gyro_x = gyro_g.gyro_x
            gyro_y = gyro_g.gyro_y
            gyro_z = gyro_g.gyro_z

            print(
                f"[{cnt:5d}] Accel: "
                f"({acc_x:5.2f}, {acc_y:5.2f}, {acc_z:5.2f}) g, "
                f"Gyro: "
                f"({gyro_x:6.2f}, {gyro_y:6.2f}, {gyro_z:6.2f}) °/s, "
                f"Roll: {roll:6.2f} °, Pitch: {pitch:6.2f} °"
            )

            sleep(0.10)
            cnt += 1

    def close(self):
        if self.mpu is not None:
            self.mpu.close()
            self.mpu = None

    def run(self):
        try:
            self.setup_sensor()
            self.run_loop()
        except KeyboardInterrupt:
            print("Stopped by user")
        finally:
            self.close()
            print("Done")


def main():
    app = IMU_ICM20602_Service()
    app.run()


if __name__ == "__main__":
    main()