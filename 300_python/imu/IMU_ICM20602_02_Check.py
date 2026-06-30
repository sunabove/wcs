from smbus2 import SMBus

bus = SMBus(1)

print( "whoami = ", hex(bus.read_byte_data(0x69, 0x75)))   # WHO_AM_I

input("Press Enter to continue...")

cnt = 1
while True:
    data = bus.read_i2c_block_data(0x69, 0x3B, 14)
    print( f"[{cnt:5d}] {data}")
    cnt += 1
pass 