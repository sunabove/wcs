import board, busio
import adafruit_ssd1306
import time

from PIL import Image, ImageDraw, ImageFont 

# mosquitto_pub -t led/text -m "Hello OLED/nWorld"
# mosquitto_pub -t led/text -m "Hello OLED/nWorld"

class LED :
    WIDTH = 128
    HEIGHT = 32
    MARGIN_X = 6
    MARGIN_Y = 1
    LINE_GAP = 4 
    

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
            addr=0x3C,
        )
        self.font = ImageFont.load_default()
        self.large_font = self._load_large_font(18)
        self.scroll_gap = 24
        self.scroll_speed_px_per_sec = self.width / 2
        self.scroll_text = ""
        self.scroll_offset = 0.0
        self.last_scroll_time = time.monotonic()
    pass  # __init__

    def _load_large_font(self, size):
        font_candidates = [
            "DejaVuSans.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
        ]

        for font_path in font_candidates:
            try:
                return ImageFont.truetype(font_path, size=size)
            except OSError:
                continue

        return self.font
    pass  # _load_large_font

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
        visible_lines = [str(line) for line in lines[:max_lines]]

        line_count = len(visible_lines)

        if line_count == 1:
            line = visible_lines[0]
            box = draw.textbbox((0, 0), line, font=self.large_font)
            line_width = box[2] - box[0]
            max_text_width = max(1, self.width - (2 * self.margin_x))
            line_height = box[3] - box[1]
            usable_height = max(1, self.height - (2 * self.margin_y))
            y = self.margin_y + max(0, (usable_height - line_height) // 2)

            if line_width <= max_text_width:
                self.scroll_text = ""
                self.scroll_offset = 0.0
                self.last_scroll_time = time.monotonic()

                x = max(self.margin_x, (self.width - line_width) // 2)
                draw.text((x, y - box[1]), line, font=self.large_font, fill=255)
            else:
                now = time.monotonic()
                if self.scroll_text != line:
                    self.scroll_text = line
                    self.scroll_offset = 0.0
                    self.last_scroll_time = now

                elapsed = max(0.0, now - self.last_scroll_time)
                self.last_scroll_time = now
                self.scroll_offset += elapsed * self.scroll_speed_px_per_sec

                cycle_width = line_width + self.scroll_gap
                offset = int(self.scroll_offset % cycle_width)
                x1 = self.margin_x - offset
                x2 = x1 + cycle_width

                draw.text((x1, y - box[1]), line, font=self.large_font, fill=255)
                draw.text((x2, y - box[1]), line, font=self.large_font, fill=255)

            self.oled.image(image)
            self.oled.show()
            return

        line_boxes = [draw.textbbox((0, 0), line, font=self.font) for line in visible_lines]
        line_heights = [box[3] - box[1] for box in line_boxes]
        usable_height = max(1, self.height - (2 * self.margin_y))

        if line_count > 1:
            max_gap = max(0, (usable_height - sum(line_heights)) // (line_count - 1))
            effective_gap = min(self.line_gap, max_gap)
        else:
            effective_gap = 0

        total_text_height = sum(line_heights) + ((line_count - 1) * effective_gap)
        start_y = self.margin_y + max(0, (usable_height - total_text_height) // 2)

        y = start_y
        for line, box, line_height in zip(visible_lines, line_boxes, line_heights):
            if line_count == 1:
                line_width = box[2] - box[0]
                x = max(self.margin_x, (self.width - line_width) // 2)
            else:
                x = self.margin_x

            draw.text((x, y - box[1]), line, font=self.font, fill=255)
            y += line_height + effective_gap

        self.oled.image(image)
        self.oled.show()
    pass  # render_lines
pass # LED

if __name__ == "__main__":
    from LEDService import main as led_service_main
    
    led_service_main()
pass