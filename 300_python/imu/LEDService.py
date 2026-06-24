import paho.mqtt.client as mqtt
import datetime
import time
import threading
import socket
import ipaddress

from .LED import LED

class LEDService:
    BROKER = "localhost"
    PORT = 1883
    TOPIC = "led/text"
    BLINK_COUNT = 2
    BLINK_ON_SEC = 0.2
    BLINK_OFF_SEC = 0.2
    IP_PUBLISH_DELAY_SEC = 3

    def __init__(self, display: LED=None):
        self.display = display if display is not None else LED()

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

    def _blink_and_render(self, lines):
        # Briefly blink when a topic message is received.
        for _ in range(self.BLINK_COUNT):
            self._render(lines)
            time.sleep(self.BLINK_ON_SEC)
            self.display.clear()
            time.sleep(self.BLINK_OFF_SEC)
        self._render(lines)
    pass  # _blink_and_render

    def _normalize_newlines(self, text):
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
        timer = threading.Timer(self.IP_PUBLISH_DELAY_SEC, self._publish_ip_if_ready)
        timer.daemon = True
        timer.start()
    pass  # _on_connect

    def _read_boot_epoch(self):
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

    def _get_primary_ipv4(self):
        candidates = []

        try:
            hostname = socket.gethostname()
            for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
                ip = info[4][0]
                candidates.append(ip)
        except Exception:
            pass

        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect(("8.8.8.8", 80))
                candidates.append(sock.getsockname()[0])
        except Exception:
            pass

        for ip in candidates:
            try:
                ip_obj = ipaddress.ip_address(ip)
                if (
                    ip_obj.version == 4
                    and not ip_obj.is_loopback
                    and not ip_obj.is_link_local
                    and not ip_obj.is_unspecified
                ):
                    return str(ip_obj)
            except ValueError:
                continue

        return None
    pass  # _get_primary_ipv4

    def _publish_ip_if_ready(self):
        ip_addr = self._get_primary_ipv4()
        if not ip_addr:
            print("MQTT pub skip: IP address is not ready")
            return

        payload = f"IP Address:/n{ip_addr}"
        self.client.publish("led/text", payload, qos=0, retain=True)
        print(f"MQTT pub: led/text -> {payload}")
    pass  # _publish_ip_if_ready

    def _on_message(self, client, userdata, msg):
        payload = msg.payload.decode("utf-8", errors="ignore").strip()
        topic = msg.topic
        print(f"MQTT recv: {topic} -> {payload}")

        try:
            if topic == "led/text":
                payload = self._normalize_newlines(payload)
                split_lines = payload.splitlines()
                lines = split_lines if split_lines else [""]
                self._blink_and_render(lines)

        except Exception as exc:
            print("MQTT message error:", exc)
    pass  # _on_message

    def run(self):
        self.display.clear()
        self.display.render_lines(["Connecting..."])
        self.client.connect(self.BROKER, self.PORT, 60)
        self.client.loop_forever()
    pass  # run

pass  # LEDService

def main():
    service = LEDService()
    service.run()
pass  # main


if __name__ == "__main__":
    main()
pass # __main__