import board, busio
import adafruit_ssd1306

from PIL import Image, ImageDraw, ImageFont
from LEDService import LEDService

# mosquitto_pub -t led/text -m "Hello OLED/nWorld"
# mosquitto_pub -t led/text -m "Hello OLED/nWorld"

class LED :
    WIDTH = 128
    HEIGHT = 32
    MARGIN_X = 6
    MARGIN_Y = 3
    LINE_GAP = 13
    I2C_ADDR = 0x3C

    def __init__(self):
        self.width = self.WIDTH
        self.height = self.HEIGHT
        self.margin_x = self.MARGIN_X
        self.margin_y = self.MARGIN_Y
        self.line_gap = self.LINE_GAP
        self.addr = self.I2C_ADDR

        self.i2c = busio.I2C(board.SCL, board.SDA)
        self.oled = adafruit_ssd1306.SSD1306_I2C(
            self.width,
            self.height,
            self.i2c,
            addr=self.addr,
        )
        self.font = ImageFont.load_default()
    pass  # __init__

    def clear(self):
        self.oled.fill(0)
        self.oled.show()
    pass  # clear

    def render_lines(self, lines):
        image = Image.new("1", (self.width, self.height))
        draw = ImageDraw.Draw(image)

        # Draw a white outer border and keep text inside with margins.
        draw.rectangle((0, 0, self.width - 1, self.height - 1), outline=255, fill=0)

        max_lines = max(1, (self.height - (2 * self.margin_y)) // self.line_gap)
        for i, line in enumerate(lines[:max_lines]):
            y = self.margin_y + (i * self.line_gap)
            draw.text((self.margin_x, y), str(line)[:20], font=self.font, fill=255)

        self.oled.image(image)
        self.oled.show()
    pass  # render_lines
pass # LED

def main():
    display = LED()
    service = LEDService(display)
    service.run()
pass  # main


if __name__ == "__main__":
    main()
pass # __main__