from gpiozero import DigitalInputDevice
from signal import pause

sensor = DigitalInputDevice(14)

sensor.when_activated = lambda: print("감지")
sensor.when_deactivated = lambda: print("해제")

input("Enter to quit! ")
