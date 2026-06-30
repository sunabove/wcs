import spidev
import time
import logging
from enum import Enum
import math
from collections import deque
import threading


class ICM20602:
    class AccelSensitivity(Enum):
        SENS_2G = (0x00, 16384.0)  # 16384 LSB/g
        SENS_4G = (0x08, 8192.0)  # 8192 LSB/g
        SENS_8G = (0x10, 4096.0)  # 4096 LSB/g
        SENS_16G = (0x18, 2048.0)  # 2048 LSB/g

    class GyroSensitivity(Enum):
        SENS_250DPS = (0x00, 131.0)  # 131 LSB/°/s
        SENS_500DPS = (0x08, 65.5)  # 65.5 LSB/°/s
        SENS_1000DPS = (0x10, 32.8)  # 32.8 LSB/°/s
        SENS_2000DPS = (0x18, 16.4)  # 16.4 LSB/°/s

    # DLPF configuration values for different bandwidths
    class DLPFBandwidth(Enum):
        BW_250HZ = 0x00
        BW_184HZ = 0x01
        BW_92HZ = 0x02
        BW_41HZ = 0x03
        BW_20HZ = 0x04
        BW_10HZ = 0x05
        BW_5HZ = 0x06

    def __init__(self, bus=0, device=0, max_speed_hz=1000000, dlpf_bandwidth=DLPFBandwidth.BW_250HZ):

        self.bus = bus
        self.device = device
        self.max_speed_hz = max_speed_hz
        self.smoothing = False
        self.accel_data_buffer = {'x': deque(), 'y': deque(), 'z': deque()}
        self.dlpf_bandwidth = dlpf_bandwidth
        self.smoothing_window = 0
        self.spi = spidev.SpiDev()

        # Threading variables
        self.running = False
        self.data_thread = None
        self.latest_data = {'accel': None, 'gyro': None, 'inclination': None}

        # Calibration offsets
        self.accel_offsets = {'x': 0.0, 'y': 0.0, 'z': 0.0}
        self.gyro_offsets = {'x': 0.0, 'y': 0.0, 'z': 0.0}

        try:
            self.spi.open(self.bus, self.device)
            self.spi.max_speed_hz = self.max_speed_hz
            self.spi.mode = 0b11  # Set SPI mode 3
        except IOError as e:
            print(f"Error opening SPI bus: {e}")
            raise

        # ICM-20602 registers
        self.PWR_MGMT_1 = 0x6B
        self.WHO_AM_I = 0x75
        self.CONFIG = 0x1A
        self.ACCEL_XOUT_H = 0x3B
        self.GYRO_XOUT_H = 0x43
        self.ACCEL_CONFIG = 0x1C
        self.ACCEL_CONFIG2 = 0x1D
        self.GYRO_CONFIG = 0x1B

        # Initialize ICM-20602
        self.accel_sensitivity = self.AccelSensitivity.SENS_2G
        self.gyro_sensitivity = self.GyroSensitivity.SENS_250DPS
        self.initialize()
        self.enable_dlpf(self.dlpf_bandwidth)

    def initialize(self):
        """
        Initialize the ICM-20602 sensor by waking it up and setting default configurations.
        """
        try:
            # Wake up the ICM-20602 since it starts in sleep mode
            self.write_register(self.PWR_MGMT_1, 0x00)
            time.sleep(0.1)  # Delay to ensure the sensor is ready
        except Exception as e:
            print(f"Error initializing ICM-20602: {e}")
            raise

    def write_register(self, reg, data):
        """
        Write data to a specific register on the ICM-20602 sensor.
        """
        try:
            self.spi.xfer2([reg & 0x7F, data])
        except Exception as e:
            print(f"Error writing to register {reg}: {e}")
            raise

    def read_register(self, reg, length=1):
        """
        Read data from a specific register on the ICM-20602 sensor.
        """
        try:
            result = self.spi.xfer2([reg | 0x80] + [0x00] * length)[1:]
            return result
        except Exception as e:
            print(f"Error reading from register {reg}: {e}")
            raise

    def check_availability(self, verbose=False):
        """
        Check if the ICM-20602 sensor is available and correctly connected.
        """
        try:
            who_am_i = self.read_register(self.WHO_AM_I)[0]
            icm20602 = who_am_i == 0x12 or who_am_i == 0xA9
            mpu6500 = who_am_i == 0x75 or who_am_i == 0x70
            if verbose:
                return 'icm20602 sensor is available' \
                    if icm20602 else 'mpu6500 sensor is available' \
                    if mpu6500 else 'no sensor is available'
            return icm20602 or mpu6500
        except Exception as e:
            print(f"Error checking availability: {e}")
            return False

    def set_accel_sensitivity(self, sensitivity=AccelSensitivity.SENS_2G):
        """
        Set the accelerometer sensitivity.
        sensitivity: Should be an instance of AccelSensitivity Enum
        """
        if not isinstance(sensitivity, self.AccelSensitivity):
            raise ValueError("sensitivity must be an instance of AccelSensitivity Enum")
        try:
            self.write_register(self.ACCEL_CONFIG, sensitivity.value[0])
            self.accel_sensitivity = sensitivity
        except Exception as e:
            print(f"Error setting accelerometer sensitivity: {e}")
            raise

    def set_gyro_sensitivity(self, sensitivity: GyroSensitivity.SENS_250DPS):
        """
        Set the gyroscope sensitivity.
        sensitivity: Should be an instance of GyroSensitivity Enum
        """
        if not isinstance(sensitivity, self.GyroSensitivity):
            raise ValueError("Invalid gyroscope sensitivity value")
        self.gyro_sensitivity = sensitivity
        self.write_register(self.GYRO_CONFIG, sensitivity.value[0])

    def set_dlpf_bandwidth(self, bandwidth):
        """
        Set the Digital Low Pass Filter (DLPF) bandwidth for the sensor.
        """
        accel_config2_value = (0 << 3) | (bandwidth.value & 0x07)  # ACCEL_FCHOICE_B = 0, A_DLPF_CFG = accel_bandwidth

        if not isinstance(bandwidth, self.DLPFBandwidth):
            raise ValueError("Invalid DLPF bandwidth value")
        try:
            self.write_register(self.ACCEL_CONFIG2, accel_config2_value)
            self.write_register(self.GYRO_CONFIG, accel_config2_value)
            self.dlpf_bandwidth = bandwidth
        except Exception as e:
            print(f"Error setting DLPF bandwidth: {e}")
            raise

    def is_dlpf_active(self):
        """
        Check if the DLPF is active for both the accelerometer and gyroscope.

        :return: Tuple (accel_dlpf_active, gyro_dlpf_active)
        """
        # Read ACCEL_CONFIG2 register
        accel_config2_value = self.read_register(self.ACCEL_CONFIG2)[0]
        # Check ACCEL_FCHOICE_B bit (bit 3)
        accel_dlpf_active = (accel_config2_value & 0x08) == 0  # 0 = DLPF enabled, 1 = DLPF disabled

        # Read CONFIG register
        config_value = self.read_register(self.GYRO_CONFIG)[0]
        # Check FCHOICE_B bits (bits 1:0)
        gyro_dlpf_active = (config_value & 0x03) == 0  # 00 = DLPF enabled, 01/10/11 = DLPF disabled

        return accel_dlpf_active, gyro_dlpf_active

    def enable_dlpf(self, bandwidth):
        """
        Enable the Digital Low Pass Filter (DLPF) with the specified bandwidth.
        """
        self.set_dlpf_bandwidth(bandwidth)

    def disable_dlpf(self):
        """
        Disable the Digital Low Pass Filter (DLPF) by setting the highest bandwidth.
        """
        self.set_dlpf_bandwidth(self.DLPFBandwidth.BW_250HZ)
        #self.write_register(self.ACCEL_CONFIG2, 0x08)
        self.write_register(self.ACCEL_CONFIG2, 0x0C)
        self.write_register(self.GYRO_CONFIG, 0x03)


    def read_accel_data(self):
        accel_data = self.read_register(self.ACCEL_XOUT_H, 6)
        accel_x = (self.convert_to_signed(accel_data[0] << 8 | accel_data[1])) / self.accel_sensitivity.value[1]
        accel_y = (self.convert_to_signed(accel_data[2] << 8 | accel_data[3])) / self.accel_sensitivity.value[1]
        accel_z = (self.convert_to_signed(accel_data[4] << 8 | accel_data[5])) / self.accel_sensitivity.value[1]

        # Apply calibration offsets
        accel_x -= self.accel_offsets['x']
        accel_y -= self.accel_offsets['y']
        accel_z -= self.accel_offsets['z']

        if self.smoothing:
            accel_x, accel_y, accel_z = self.smooth_accel_data(accel_x, accel_y, accel_z)

        return {'x': accel_x, 'y': accel_y, 'z': accel_z}

    def read_gyro_data(self):
        gyro_data = self.read_register(self.GYRO_XOUT_H, 6)
        gyro_x = (self.convert_to_signed(gyro_data[0] << 8 | gyro_data[1])) / self.gyro_sensitivity.value[1]
        gyro_y = (self.convert_to_signed(gyro_data[2] << 8 | gyro_data[3])) / self.gyro_sensitivity.value[1]
        gyro_z = (self.convert_to_signed(gyro_data[4] << 8 | gyro_data[5])) / self.gyro_sensitivity.value[1]

        # Apply calibration offsets
        gyro_x -= self.gyro_offsets['x']
        gyro_y -= self.gyro_offsets['y']
        gyro_z -= self.gyro_offsets['z']

        return {'x': gyro_x, 'y': gyro_y, 'z': gyro_z}

    def smooth_accel_data(self, accel_x, accel_y, accel_z):
        """
        Apply moving average smoothing to accelerometer data.
        """
        self.accel_data_buffer['x'].append(accel_x)
        self.accel_data_buffer['y'].append(accel_y)
        self.accel_data_buffer['z'].append(accel_z)

        smoothed_x = sum(self.accel_data_buffer['x']) / len(self.accel_data_buffer['x'])
        smoothed_y = sum(self.accel_data_buffer['y']) / len(self.accel_data_buffer['y'])
        smoothed_z = sum(self.accel_data_buffer['z']) / len(self.accel_data_buffer['z'])

        return smoothed_x, smoothed_y, smoothed_z

    def enable_smoothing(self, smoothing_window=7):
        """
        Enable moving average smoothing for accelerometer data.
        """
        self.smoothing = True
        self.smoothing_window = smoothing_window
        self.accel_data_buffer = {'x': deque(maxlen=smoothing_window), 'y': deque(maxlen=smoothing_window),
                                  'z': deque(maxlen=smoothing_window)}

    def disable_smoothing(self):
        """
        Disable moving average smoothing for accelerometer data.
        """
        self.smoothing = False
        self.accel_data_buffer = {'x': deque(), 'y': deque(), 'z': deque()}

    def _calibrate_accelerometer(self, samples=100):
        """
        Calibrate the accelerometer by calculating offsets for each axis.
        """
        # print("Calibrating accelerometer... Keep the sensor stationary.")
        x_sum = 0.0
        y_sum = 0.0
        z_sum = 0.0

        for _ in range(samples):
            accel_data = self.read_accel_data()
            x_sum += accel_data['x']
            y_sum += accel_data['y']
            z_sum += accel_data['z']
            time.sleep(0.01)  # 10ms delay between samples

        self.accel_offsets['x'] = x_sum / samples
        self.accel_offsets['y'] = y_sum / samples
        self.accel_offsets['z'] = (z_sum / samples) - 1.0  # Subtract 1g for Z axis

        #print(f"Accelerometer calibration complete. Offsets: {self.accel_offsets}")

    def _calibrate_gyroscope(self, samples=100):
        """
        Calibrate the gyroscope by calculating offsets for each axis.
        """
        # print("Calibrating gyroscope... Keep the sensor stationary.")
        x_sum = 0.0
        y_sum = 0.0
        z_sum = 0.0

        for _ in range(samples):
            gyro_data = self.read_gyro_data()
            x_sum += gyro_data['x']
            y_sum += gyro_data['y']
            z_sum += gyro_data['z']
            time.sleep(0.01)  # 10ms delay between samples

        self.gyro_offsets['x'] = x_sum / samples
        self.gyro_offsets['y'] = y_sum / samples
        self.gyro_offsets['z'] = z_sum / samples

        # print(f"Gyroscope calibration complete. Offsets: {self.gyro_offsets}")

    def calibrate_sensor(self, samples=100):
        self._calibrate_gyroscope(samples)
        self._calibrate_accelerometer(samples)

    def uncalibrate_sensors(self):
        self.accel_offsets = {'x': 0.0, 'y': 0.0, 'z': 0.0}
        self.gyro_offsets = {'x': 0.0, 'y': 0.0, 'z': 0.0}


    @staticmethod
    def convert_to_signed(val):
        if val > 32767:
            val -= 65536
        return val

    def calculate_inclination(self, accel_data=None):
        """
        Calculate the vertical (pitch) and horizontal (roll) inclination angles.
        """
        if accel_data is None:
            accel_data = self.read_accel_data()
        accel_x = accel_data['x']
        accel_y = accel_data['y']
        accel_z = accel_data['z']

        # Calculate pitch and roll
        pitch = math.atan2(accel_y, math.sqrt(accel_x ** 2 + accel_z ** 2)) * 180 / math.pi
        roll = math.atan2(-accel_x, accel_z) * 180 / math.pi

        return pitch, roll

    def start_data_thread(self):
        """
        Start a background thread to continuously read and process sensor data.
        """
        self.running = True
        self.data_thread = threading.Thread(target=self._data_loop)
        self.data_thread.start()

    def stop_data_thread(self):
        """
        Stop the background data thread.
        """
        self.running = False
        if self.data_thread:
            self.data_thread.join()

    def _data_loop(self):
        """
        Background thread loop to read and process sensor data.
        """
        while self.running:
            accel_data = self.read_accel_data()
            gyro_data = self.read_gyro_data()
            inclination = self.calculate_inclination(accel_data)

            # Update latest data
            self.latest_data = {
                'accel': accel_data,
                'gyro': gyro_data,
                'inclination': inclination
            }

            time.sleep(0.01)  # 100Hz

    def get_latest_data(self):
        """
        Get the latest sensor data from the background thread.
        """
        return self.latest_data

    def close(self):
        """
        Close the SPI connection and stop the data thread.
        """
        self.stop_data_thread()
        self.spi.close()
