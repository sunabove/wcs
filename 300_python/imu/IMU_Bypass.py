from smbus2 import SMBus

bus = SMBus(1)

# MPU9250 I2C Master 비활성화
bus.write_byte_data(0x68, 0x6A, 0x00)

# Bypass Enable, AK8963 활성화
bus.write_byte_data(0x68, 0x37, 0x02)

# AK8963 WHO_AM_I
who = bus.read_byte_data(0x0C, 0x00)

print(hex(who))