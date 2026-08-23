import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mqttManager import MqttConfig, MqttManager


class MqttManagerWheelControlTest(unittest.TestCase):
    def test_vehicle_control_topics_are_wheel_angle_speeds_only(self):
        initial_vehicle_topics = {
            topic
            for topic, _payload_resolver, _log_tag in MqttConfig.INITIAL_CONNECT_TOPIC_SPECS
        }

        self.assertNotIn("vehicle/linear/speed", initial_vehicle_topics)
        self.assertNotIn("vehicle/operation/command", initial_vehicle_topics)

        manager = object.__new__(MqttManager)
        manager.wheel_rpm_by_id = {
            wheel_id: 0.0 for wheel_id in MqttConfig.WHEEL_IDS
        }

        expected_speeds = {"fr": 2.5, "fl": 2.5, "rr": -2.5, "rl": -2.5}
        for wheel_id, speed in expected_speeds.items():
            self.assertTrue(
                manager._store_wheel_message(
                    f"wheel/{wheel_id}/angle/speed", str(speed)
                )
            )

        self.assertEqual(expected_speeds, manager.wheel_rpm_by_id)
        self.assertFalse(
            manager._store_vehicle_message("vehicle/linear/speed", "1.0")
        )
        self.assertFalse(
            manager._store_vehicle_message("vehicle/operation/command", "1")
        )


if __name__ == "__main__":
    unittest.main()