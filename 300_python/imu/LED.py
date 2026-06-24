import board, busio
import adafruit_ssd1306

from PIL import Image, ImageDraw, ImageFont 

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
        visible_lines = [str(line)[:20] for line in lines[:max_lines]]

        line_boxes = [draw.textbbox((0, 0), line, font=self.font) for line in visible_lines]
        line_heights = [box[3] - box[1] for box in line_boxes]
        line_count = len(visible_lines)
        usable_height = self.height - (2 * self.margin_y)
        if line_count > 1:
            available_gap = usable_height - sum(line_heights)
            line_spacing = min(self.line_gap, max(0, available_gap // (line_count - 1)))
        else:
            line_spacing = 0

        total_text_height = sum(line_heights)
        if line_count > 1:
            total_text_height += (line_count - 1) * line_spacing

        start_y = max(self.margin_y, (self.height - total_text_height) // 2)

        y = start_y
        for line, box, line_height in zip(visible_lines, line_boxes, line_heights):
            draw.text((self.margin_x, y - box[1]), line, font=self.font, fill=255)
            y += line_height + line_spacing

        self.oled.image(image)
        self.oled.show()
    pass  # render_lines
pass # LED

if __name__ == "__main__":
    from LEDService import main as led_service_main
    
    led_service_main()
pass