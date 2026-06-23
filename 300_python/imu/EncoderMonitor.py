#!/usr/bin/env python3

from Encoder import Encoder
from GpioNo import GpioNo


class EncoderMonitor:
	def __init__(self, device_specs=None):
		self.encoders = []
		self.device_specs = device_specs or [
			(GpioNo.ENCODER_FR, "FR"),
			(GpioNo.ENCODER_FL, "FL"),
			(GpioNo.ENCODER_RR, "RR"),
			(GpioNo.ENCODER_RL, "RL"),
		]
	pass # __init__

	def initialize(self):
		for gpio_no, name in self.device_specs:
			try:
				self.encoders.append(Encoder(gpio_no, name))
			except Exception as error:
				print(f"{name} (gpio = {gpio_no}) initialization failed: {error}")
			pass
		pass

		if len(self.encoders) == 0:
			print("No encoder initialized. Check GPIO conflicts or permissions.")
			return False
		else:
			print(f"{len(self.encoders)} encoders initialized successfully.")
		pass

		return True
	pass # initialize

	def wait_for_quit(self):
		input("Enter to quit!\n")
	pass # wait_for_quit

	def close_all(self):
		for encoder in self.encoders:
			try:
				encoder.close()
			except Exception as close_error:
				print(f"Close failed for {encoder.name}: {close_error}")
			pass
		pass
	pass # close_all

	def run(self):
		try:
			if self.initialize() == False:
				return
			pass 
		except KeyboardInterrupt:
			pass
		finally:
			self.close_all()
		pass
	pass # run

pass # EncoderMonitor


def main():
	monitor = EncoderMonitor()
	monitor.run()
	monitor.wait_for_quit()
pass # main


if __name__ == "__main__":
	main()
pass # __main__
