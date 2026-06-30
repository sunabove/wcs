from icm20602 import ICM20602
from time import sleep
import sys
import time
from collections import deque
from smbus2 import SMBus
import pyqtgraph as pg
from pyqtgraph.Qt import QtCore, QtWidgets

class IMU_ICM20602_Service:
    
    def __init__(self, bus_num=1, wakeup_addr=0x69):
        self.bus_num = bus_num
        self.wakeup_addr = wakeup_addr
        self.mpu = None
        self.qt_app = None
        self.win = None
        self.timer = None
        self.start_time = 0.0
        self.history_len = 300
        self.t_data = deque(maxlen=self.history_len)
        self.accel_x_data = deque(maxlen=self.history_len)
        self.accel_y_data = deque(maxlen=self.history_len)
        self.accel_z_data = deque(maxlen=self.history_len)
        self.gyro_x_data = deque(maxlen=self.history_len)
        self.gyro_y_data = deque(maxlen=self.history_len)
        self.gyro_z_data = deque(maxlen=self.history_len)
        self.accel_curves = {}
        self.gyro_curves = {}

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
        self.setup_chart()
        self.start_time = time.time()

        self.timer = QtCore.QTimer()
        self.timer.timeout.connect(self.update_chart)
        self.timer.start(100)

        print("Starting real-time chart. Close the chart window to stop.")
        self.qt_app.exec()

    def setup_chart(self):
        self.qt_app = QtWidgets.QApplication.instance() or QtWidgets.QApplication(sys.argv)
        pg.setConfigOption("background", "w")
        pg.setConfigOption("foreground", "k")

        self.win = pg.GraphicsLayoutWidget(title="ICM20602 Real-Time Monitor")
        self.win.resize(1200, 800)

        accel_plot = self.win.addPlot(title="Accelerometer (g)")
        accel_plot.showGrid(x=True, y=True)
        accel_plot.setLabel("left", "g")
        accel_plot.setLabel("bottom", "Time", units="s")
        self.accel_curves["x"] = accel_plot.plot(pen=pg.mkPen("r", width=2), name="ax")
        self.accel_curves["y"] = accel_plot.plot(pen=pg.mkPen("g", width=2), name="ay")
        self.accel_curves["z"] = accel_plot.plot(pen=pg.mkPen("b", width=2), name="az")

        self.win.nextRow()
        gyro_plot = self.win.addPlot(title="Gyroscope (deg/s)")
        gyro_plot.showGrid(x=True, y=True)
        gyro_plot.setLabel("left", "deg/s")
        gyro_plot.setLabel("bottom", "Time", units="s")
        self.gyro_curves["x"] = gyro_plot.plot(pen=pg.mkPen("r", width=2), name="gx")
        self.gyro_curves["y"] = gyro_plot.plot(pen=pg.mkPen("g", width=2), name="gy")
        self.gyro_curves["z"] = gyro_plot.plot(pen=pg.mkPen("b", width=2), name="gz")

        self.win.show()

    def update_chart(self):
        accel_g = self.mpu.read_accel_data()
        gyro_g = self.mpu.read_gyro_data()

        t = time.time() - self.start_time
        self.t_data.append(t)
        self.accel_x_data.append(accel_g.accel_x)
        self.accel_y_data.append(accel_g.accel_y)
        self.accel_z_data.append(accel_g.accel_z)
        self.gyro_x_data.append(gyro_g.gyro_x)
        self.gyro_y_data.append(gyro_g.gyro_y)
        self.gyro_z_data.append(gyro_g.gyro_z)

        x = list(self.t_data)
        self.accel_curves["x"].setData(x, list(self.accel_x_data))
        self.accel_curves["y"].setData(x, list(self.accel_y_data))
        self.accel_curves["z"].setData(x, list(self.accel_z_data))
        self.gyro_curves["x"].setData(x, list(self.gyro_x_data))
        self.gyro_curves["y"].setData(x, list(self.gyro_y_data))
        self.gyro_curves["z"].setData(x, list(self.gyro_z_data))

    def close(self):
        if self.timer is not None:
            self.timer.stop()
            self.timer = None

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