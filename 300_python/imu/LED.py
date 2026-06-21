import argparse
import time

import board
import busio

from PIL import Image
from PIL import ImageDraw
from PIL import ImageFont

import adafruit_ssd1306


DEFAULT_WIDTH = 128
DEFAULT_HEIGHT = 32


def scan_i2c_addresses(i2c):
    addresses = []
    while not i2c.try_lock():
        time.sleep(0.01)
    try:
        addresses = i2c.scan()
    finally:
        i2c.unlock()
    return addresses


def pick_oled_address(scanned, requested=None):
    if requested is not None:
        return requested
    for candidate in (0x3C, 0x3D):
        if candidate in scanned:
            return candidate
    return 0x3C


def main():
    parser = argparse.ArgumentParser(description="SSD1306 OLED text test")
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH)
    parser.add_argument("--height", type=int, default=DEFAULT_HEIGHT)
    parser.add_argument("--addr", type=lambda x: int(x, 0), default=None)
    parser.add_argument("--line1", default="Raspberry Pi 5")
    parser.add_argument("--line2", default="OLED Test")
    parser.add_argument("--wait", type=float, default=5.0)
    args = parser.parse_args()

    i2c = busio.I2C(board.SCL, board.SDA)
    scanned = scan_i2c_addresses(i2c)
    addr = pick_oled_address(scanned, args.addr)

    print("I2C scan:", [hex(a) for a in scanned])
    print("Using OLED addr:", hex(addr))

    oled = adafruit_ssd1306.SSD1306_I2C(args.width, args.height, i2c, addr=addr)
    oled.fill(0)
    oled.show()

    image = Image.new("1", (args.width, args.height))
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()

    draw.text((0, 0), args.line1, font=font, fill=255)
    draw.text((0, 12), args.line2, font=font, fill=255)

    oled.image(image)
    oled.show()

    if args.wait > 0:
        time.sleep(args.wait)


if __name__ == "__main__":
    main()