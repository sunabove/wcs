#!/usr/bin/env python3

from gpiozero import DigitalInputDevice
from signal import pause

from GpioNo import GpioNo

class Encoder: 
    
	def __init__(self, gpio_no, name="Encoder"):
		self.name = name
		self.count = 0
		self.inputDevice = DigitalInputDevice(gpio_no, bounce_time=0.005)
		self.inputDevice.when_activated = self._when_activated
		self.inputDevice.when_deactivated = self._when_deactivated
		print(f"{self.name} monitor started")
		self.print_status()
	pass # __init__

	def _when_activated(self):
		self.count += 1
		print(f"{self.name} detected (count={self.count})")
	pass # _when_activated

	def _when_deactivated(self):
		print(f"{self.name} released")
	pass # _when_deactivated

	def print_status(self):
		print(f"{self.name}: {'ACTIVE' if self.inputDevice.is_active else 'INACTIVE'}")
	pass # print_status

	def close(self):
		self.inputDevice.close()
	pass # close

pass # Encoder


def main():
	monitor = Encoder(GpioNo.ENCODER_FR, "FR")
	try:
		pause()
	except KeyboardInterrupt:
		pass
	finally:
		monitor.close()
	pass # main


if __name__ == "__main__":
	main()
pass # __main__
