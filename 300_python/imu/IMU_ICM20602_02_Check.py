from smbus2 import SMBus
from time import sleep

bus = SMBus(1)
addr = 0x69

wakeUp = False
if wakeUp:
    # Wake up
    print("Waking up the ICM20602...")
    bus.write_byte_data(addr, 0x6B, 0x00)
    sleep(0.1)

    # Clock source = PLL
    bus.write_byte_data(addr, 0x6B, 0x01)
    sleep(0.1)
else :
    print("ICM20602 is in sleep mode. To wake up, set wakeUp=True.")
pass

print("WHO_AM_I =", hex(bus.read_byte_data(addr, 0x75)))
print("PWR_MGMT_1 =", hex(bus.read_byte_data(addr, 0x6B)))

input("Press Enter to continue...")

cnt = 1
while True:
    data = bus.read_i2c_block_data(addr, 0x3B, 14)
    print(f"[{cnt:5d}] {data}")
    cnt += 1
    time.sleep(0.1)