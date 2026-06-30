from smbus2 import SMBus
import time

bus = SMBus(1)
addr = 0x69

# Wake up
print("Waking up the ICM20602...")
bus.write_byte_data(addr, 0x6B, 0x00)
time.sleep(0.1)

# Clock source = PLL
bus.write_byte_data(addr, 0x6B, 0x01)
time.sleep(0.1)

print("WHO_AM_I =", hex(bus.read_byte_data(addr, 0x75)))
print("PWR_MGMT_1 =", hex(bus.read_byte_data(addr, 0x6B)))

input("Press Enter to continue...")

cnt = 1
while True:
    data = bus.read_i2c_block_data(addr, 0x3B, 14)
    print(f"[{cnt:5d}] {data}")
    cnt += 1
    time.sleep(0.1)