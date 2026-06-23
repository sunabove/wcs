#!/usr/bin/env python3

from gpiozero import DigitalInputDevice
from signal import pause

from GpioNo import GpioNo

class Encoder:
	WHEEL_COUNTS = 40
	DEGREES_PER_COUNT = 360 / WHEEL_COUNTS
 
	PRINT_COUNT = 0 
    
	def __init__(self, gpio_no, name="Encoder"):
		self.name = name
		self.count = 0
  
		self.inputDevice = DigitalInputDevice(gpio_no, bounce_time=0.005)
		self.inputDevice.when_activated = self._when_activated
		self.inputDevice.when_deactivated = self._when_deactivated
  
		print(f"{self.name} (gpio = {gpio_no}) encoder started")
  
		self.print_status()
	pass # __init__

	def _when_activated(self):
		self.count += 1
		angle_total = self.count * self.DEGREES_PER_COUNT
		angle = angle_total % 360
  
		print(f"{self.name} encoder detected (count={self.count:4d}, angle_total={angle_total:6.1f}°, angle={angle:4.1f}°)")
	pass # _when_activated

	def _when_deactivated(self):
		self.count += 1
		angle_total = self.count * self.DEGREES_PER_COUNT
		angle = angle_total % 360
  
		print(f"{self.name} encoder released (count={self.count:4d}, angle_total={angle_total:6.1f}°, angle={angle:4.1f}°)")
	pass # _when_deactivated

	def print_status(self):
		angle_total = self.count * self.DEGREES_PER_COUNT
		angle = angle_total % 360
		print(f"{self.name} encoder: {'ACTIVE' if self.inputDevice.is_active else 'INACTIVE'} (count={self.count:4d}, angle_total={angle_total:6.1f}°, angle={angle:4.1f}°)")
	pass # print_status

	def close(self):
		print(f"Closing {self.name} encoder..." )
		self.inputDevice.close()
		print( f"{self.name} encoder closed" )
	pass # close

pass # Encoder


def main():
	encoders = []
	device_specs = [
		(GpioNo.ENCODER_FR, "FR"),
		(GpioNo.ENCODER_FL, "FL"),
		(GpioNo.ENCODER_RR, "RR"),
		(GpioNo.ENCODER_RL, "RL"),
	]

	try:
		for gpio_no, name in device_specs:
			try:
				encoders.append(Encoder(gpio_no, name))
			except Exception as error:
				print(f"{name} (gpio = {gpio_no}) initialization failed: {error}")
			pass
		pass

		if len(encoders) == 0:
			print("No encoder initialized. Check GPIO conflicts or permissions.")
			return
		pass

		input("Enter to quit!\n")
	except KeyboardInterrupt:
		pass
	finally:
		for encoder in encoders:
			try:
				encoder.close()
			except Exception as close_error:
				print(f"Close failed for {encoder.name}: {close_error}")
	pass 
pass # main


if __name__ == "__main__":
	main()
pass # __main__
