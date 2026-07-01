from icm20602 import ICM20602
from time import sleep
import sys
import time
import argparse
import signal
from collections import deque
from smbus2 import SMBus

class IMU_ICM20602_Service:
    
    def __init__(self, bus_num=1, wakeup_addr=0x69):
        self.bus_num = bus_num
        self.wakeup_addr = wakeup_addr
        self.mpu = None
        self.qt_app = None
        self.win = None
        self.timer = None
        self.signal_timer = None
        self.start_time = 0.0
        self.sampling_hz = 100.0
        self.sample_interval_sec = 1.0 / self.sampling_hz
        self.x_window_sec = 20.0
        self.history_len = int(self.x_window_sec * self.sampling_hz)
        self.time_data = deque(maxlen=self.history_len)
        self.accel_x_data = deque(maxlen=self.history_len)
        self.accel_y_data = deque(maxlen=self.history_len)
        self.accel_z_data = deque(maxlen=self.history_len)
        self.gyro_x_data = deque(maxlen=self.history_len)
        self.gyro_y_data = deque(maxlen=self.history_len)
        self.gyro_z_data = deque(maxlen=self.history_len)
        self.accel_curves = {}
        self.gyro_curves = {}
        self.pg = None
        self.QtCore = None
        self.QtWidgets = None
        self.accel_plot = None
        self.gyro_plot = None
        self._prev_sigint_handler = None

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

    def run_loop(self, show_chart=False):
        if show_chart:
            self.setup_chart()
            self.start_time = time.time()

            self.timer = self.QtCore.QTimer()
            self.timer.timeout.connect(self.on_chart_timer)
            self.timer.start(int(self.sample_interval_sec * 1000))

            self._prev_sigint_handler = signal.getsignal(signal.SIGINT)
            signal.signal(signal.SIGINT, self.on_sigint)
            self.signal_timer = self.QtCore.QTimer()
            self.signal_timer.timeout.connect(lambda: None)
            self.signal_timer.start(100)

            print(f"Starting real-time chart at {self.sampling_hz:.0f} Hz. Close the chart window to stop.")
            try:
                self.qt_app.exec()
            finally:
                if self.signal_timer is not None:
                    self.signal_timer.stop()
                    self.signal_timer = None
                if self._prev_sigint_handler is not None:
                    signal.signal(signal.SIGINT, self._prev_sigint_handler)
                    self._prev_sigint_handler = None
        else :
            print(f"Continous reading at {self.sampling_hz:.0f} Hz, break to stop")
            cnt = 1
            while True:
                accel_g, gyro_g, roll, pitch = self.collect_sensor_data(collect_chart_data=False)

                print(
                    f"[{cnt:5d}] Accel: "
                    f"({accel_g.accel_x:5.2f}, {accel_g.accel_y:5.2f}, {accel_g.accel_z:5.2f}) g, "
                    f"Gyro: "
                    f"({gyro_g.gyro_x:6.2f}, {gyro_g.gyro_y:6.2f}, {gyro_g.gyro_z:6.2f}) °/s, "
                    f"Roll: {roll:6.2f} °, Pitch: {pitch:6.2f} °"
                )

                sleep(self.sample_interval_sec)
                cnt += 1
            pass
        pass
    pass # run_loop

    def collect_sensor_data(self, collect_chart_data=False):
        accel_g = self.mpu.read_accel_data()
        gyro_g = self.mpu.read_gyro_data()
        roll, pitch = self.mpu.calculate_inclination(accel_g)

        if collect_chart_data:
            t = time.time() - self.start_time
            self.time_data.append(t)
            self.accel_x_data.append(accel_g.accel_x)
            self.accel_y_data.append(accel_g.accel_y)
            self.accel_z_data.append(accel_g.accel_z)
            self.gyro_x_data.append(gyro_g.gyro_x)
            self.gyro_y_data.append(gyro_g.gyro_y)
            self.gyro_z_data.append(gyro_g.gyro_z)
        pass

        return accel_g, gyro_g, roll, pitch
    pass

    def on_chart_timer(self):
        self.collect_sensor_data(collect_chart_data=True)
        self.update_chart()

    def on_sigint(self, signum, frame):
        print("Ctrl+C received. Closing chart...")
        if self.timer is not None:
            self.timer.stop()
        if self.qt_app is not None:
            self.qt_app.quit()

    def setup_chart(self):
        import pyqtgraph as pg
        from pyqtgraph.Qt import QtCore, QtWidgets

        self.pg = pg
        self.QtCore = QtCore
        self.QtWidgets = QtWidgets

        self.qt_app = self.QtWidgets.QApplication.instance() or self.QtWidgets.QApplication(sys.argv)
        self.pg.setConfigOption("background", "w")
        self.pg.setConfigOption("foreground", "k")

        self.win = self.pg.GraphicsLayoutWidget(title="ICM20602 Real-Time Monitor")
        self.win.resize(1200, 800)

        self.accel_plot = self.win.addPlot(title="Accelerometer")
        self.accel_plot.showGrid(x=True, y=True)
        self.accel_plot.setLabel("left", "g")
        self.accel_plot.setLabel("bottom", "Time", units="s")
        self.accel_plot.addLegend()
        self.accel_plot.setXRange(0.0, self.x_window_sec, padding=0)
        self.accel_curves["x"] = self.accel_plot.plot(pen=self.pg.mkPen("r", width=2), name="ax")
        self.accel_curves["y"] = self.accel_plot.plot(pen=self.pg.mkPen("g", width=2), name="ay")
        self.accel_curves["z"] = self.accel_plot.plot(pen=self.pg.mkPen("b", width=2), name="az")

        self.win.nextRow()
        self.gyro_plot = self.win.addPlot(title="Gyroscope")
        self.gyro_plot.showGrid(x=True, y=True)
        self.gyro_plot.setLabel("left", "deg/s")
        self.gyro_plot.setLabel("bottom", "Time", units="s")
        self.gyro_plot.addLegend()
        self.gyro_plot.setXRange(0.0, self.x_window_sec, padding=0)
        self.gyro_curves["x"] = self.gyro_plot.plot(pen=self.pg.mkPen("r", width=2), name="gx")
        self.gyro_curves["y"] = self.gyro_plot.plot(pen=self.pg.mkPen("g", width=2), name="gy")
        self.gyro_curves["z"] = self.gyro_plot.plot(pen=self.pg.mkPen("b", width=2), name="gz")

        self.win.show()

    def update_chart(self):
        if self.time_data:

            x = list(self.time_data)
            self.accel_curves["x"].setData(x, list(self.accel_x_data))
            self.accel_curves["y"].setData(x, list(self.accel_y_data))
            self.accel_curves["z"].setData(x, list(self.accel_z_data))
            self.gyro_curves["x"].setData(x, list(self.gyro_x_data))
            self.gyro_curves["y"].setData(x, list(self.gyro_y_data))
            self.gyro_curves["z"].setData(x, list(self.gyro_z_data))

            x_end = x[-1]
            x_start = max(0.0, x_end - self.x_window_sec)
            if x_end < self.x_window_sec:
                x_end = self.x_window_sec

            if self.accel_plot is not None:
                self.accel_plot.setXRange(x_start, x_end, padding=0)
            if self.gyro_plot is not None:
                self.gyro_plot.setXRange(x_start, x_end, padding=0)
        pass
    pass # update_chart

    def close(self):
        if self.signal_timer is not None:
            self.signal_timer.stop()
            self.signal_timer = None

        if self.timer is not None:
            self.timer.stop()
            self.timer = None

        if self.win is not None:
            self.win.close()
            self.win = None

        if self.mpu is not None:
            self.mpu.close()
            self.mpu = None

    def run(self, show_chart=False):
        try:
            self.setup_sensor()
            self.run_loop(show_chart=show_chart)
        except KeyboardInterrupt:
            print("Stopped by user")
        finally:
            self.close()
            print("Done")
        pass
    pass # run

pass # IMU_ICM20602_Service


def main():
    parser = argparse.ArgumentParser(description="IMU ICM20602 service")
    parser.add_argument("--show-chart", action="store_true", help="Show real-time pyqtgraph chart")
    args = parser.parse_args()

    app = IMU_ICM20602_Service()
    app.run(show_chart=args.show_chart)
pass # main

if __name__ == "__main__":
    main()
pass # __main__