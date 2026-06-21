import board
import busio

from PIL import Image
from PIL import ImageDraw
from PIL import ImageFont

import adafruit_ssd1306


WIDTH = 128
HEIGHT = 32

i2c = busio.I2C(board.SCL, board.SDA)

oled = adafruit_ssd1306.SSD1306_I2C(
    WIDTH,
    HEIGHT,
    i2c,
    addr=0x3C
)

oled.fill(0)
oled.show()

image = Image.new("1", (WIDTH, HEIGHT))
draw = ImageDraw.Draw(image)

font = ImageFont.load_default()

draw.text((0, 0), "Raspberry Pi 5", font=font, fill=255)
draw.text((0, 12), "0.91 OLED Test", font=font, fill=255)

oled.image(image)
oled.show()

input("Enter to quit! ")