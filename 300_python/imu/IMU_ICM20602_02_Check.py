from smbus2 import SMBus

bus = SMBus(1)

print(hex(bus.read_byte_data(0x69, 0x75)))   # WHO_AM_I

while True:
    data = bus.read_i2c_block_data(0x69, 0x3B, 14)
    print(data)
pass 