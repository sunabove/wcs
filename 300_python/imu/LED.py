import board
import busio

from PIL import Image
from PIL import ImageDraw
from PIL import ImageFont

import adafruit_ssd1306

class LEDDisplay:
    WIDTH = 128
    HEIGHT = 32
    MARGIN_X = 4
    MARGIN_Y = 3
    LINE_GAP = 11
    ADDR = 0x3C
    
    def __init__(self):
        self.width = self.WIDTH
        self.height = self.HEIGHT
        self.margin_x = self.MARGIN_X
        self.margin_y = self.MARGIN_Y
        self.line_gap = self.LINE_GAP 

        self.i2c = busio.I2C(board.SCL, board.SDA)
        self.oled = adafruit_ssd1306.SSD1306_I2C(
            self.width,
            self.height,
            self.i2c,
            addr=self.ADDR,
        )
        self.font = ImageFont.load_default()

    def clear(self):
        self.oled.fill(0)
        self.oled.show()

    def render_text(self, line1, line2):
        image = Image.new("1", (self.width, self.height))
        draw = ImageDraw.Draw(image)

        # Draw a white outer border and keep text inside with margins.
        draw.rectangle((0, 0, self.width - 1, self.height - 1), outline=255, fill=0)
        draw.text((self.margin_x, self.margin_y), line1, font=self.font, fill=255)
        draw.text(
            (self.margin_x, self.margin_y + self.line_gap),
            line2,
            font=self.font,
            fill=255,
        )

        self.oled.image(image)
        self.oled.show()
    pass

pass


def main():
    display = LEDDisplay()
    display.clear()
    display.render_text("Raspberry Pi 5", "0.91 OLED Test")
    input("Enter to quit! ")
pass 

if __name__ == "__main__":
    main()
pass