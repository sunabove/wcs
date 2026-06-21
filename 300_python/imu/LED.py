import board, busio
import paho.mqtt.client as mqtt
import adafruit_ssd1306
import datetime
import time

from PIL import Image, ImageDraw, ImageFont

# mosquitto_pub -t led/text -m "Hello OLED/nWorld"
# mosquitto_pub -t led/text -m "Hello OLED/nWorld"

class LEDDisplay:
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
pass # LEDDisplay

class MqttOledService:
    BROKER = "localhost"
    PORT = 1883
    TOPIC = "led/text"

    def __init__(self):
        self.display = LEDDisplay()

        # paho-mqtt version compatibility
        try:
            self.client = mqtt.Client(
                callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                client_id="oled_display_service",
            )
        except (TypeError, AttributeError):
            self.client = mqtt.Client(client_id="oled_display_service")

        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
    pass  # __init__

    def _render(self, lines):
        self.display.render_lines(lines)
    pass  # _render

    @staticmethod
    def _normalize_newlines(text):
        normalized = str(text)
        # Handle slash-style and escaped newline representations.
        normalized = normalized.replace("/r/n", "\n")
        normalized = normalized.replace("/n", "\n").replace("/r", "\r")
        normalized = normalized.replace("\\r\\n", "\n")
        normalized = normalized.replace("\\n", "\n").replace("\\r", "\r")
        return normalized
    pass  # _normalize_newlines

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        print("MQTT connected:", reason_code)
        client.subscribe(self.TOPIC)
        self._render(["Waiting MQTT"])
        self._publish_boot_time()
    pass  # _on_connect

    @staticmethod
    def _read_boot_epoch():
        try:
            with open("/proc/stat", "r", encoding="utf-8") as fp:
                for line in fp:
                    if line.startswith("btime "):
                        return int(line.split()[1])
        except Exception:
            pass
        return int(time.time())
    pass  # _read_boot_epoch

    def _publish_boot_time(self):
        boot_epoch = self._read_boot_epoch()
        boot_iso = datetime.datetime.fromtimestamp(boot_epoch).isoformat(sep=" ")
        payload = str(boot_iso)
        payload = "Booting success!/n" + payload
        self.client.publish("led/text", payload, qos=0, retain=True)
        print(f"MQTT pub: led/text -> {payload}")
    pass  # _publish_boot_time

    def _on_message(self, client, userdata, msg):
        payload = msg.payload.decode("utf-8", errors="ignore").strip()
        topic = msg.topic
        print(f"MQTT recv: {topic} -> {payload}")

        try:
            if topic == "led/text":
                payload = self._normalize_newlines(payload)
                split_lines = payload.splitlines()
                lines = split_lines if split_lines else [""]
                self._render(lines)

        except Exception as exc:
            print("MQTT message error:", exc)
    pass  # _on_message

    def run(self):
        self.display.clear()
        self.display.render_lines(["Connecting..."])
        self.client.connect(self.BROKER, self.PORT, 60)
        self.client.loop_forever()
    pass  # run

pass # MqttOledService

def main():
    service = MqttOledService()
    service.run()
pass  # main


if __name__ == "__main__":
    main()
pass # __main__