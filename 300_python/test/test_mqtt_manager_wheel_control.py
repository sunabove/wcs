import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mqttManager import MqttConfig, MqttManager


class MqttManagerWheelControlTest(unittest.TestCase):
    def test_vehicle_control_uses_one_ordered_wheel_angle_speed_payload(self):
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

        self.assertEqual(("fr", "fl", "rr", "rl"), MqttConfig.VEHICLE_CONTROL_WHEEL_IDS)
        self.assertEqual("wheel/angle/speed", MqttConfig.WHEEL_ANGLE_SPEED_TOPIC)

        expected_speeds = {"fl": 2.5, "fr": 2.5, "rr": -2.5, "rl": -2.5}
        self.assertTrue(
            manager._store_wheel_message("wheel/angle/speed", "2.5,2.5,-2.5,-2.5")
        )

        self.assertEqual(expected_speeds, manager.wheel_rpm_by_id)
        self.assertEqual("2.5,2.5,-2.5,-2.5", manager._build_wheel_angle_speed_payload())
        self.assertFalse(
            manager._store_vehicle_message("vehicle/linear/speed", "1.0")
        )
        self.assertFalse(
            manager._store_vehicle_message("vehicle/operation/command", "1")
        )

    def test_invalid_aggregate_payload_does_not_partially_update_wheels(self):
        manager = object.__new__(MqttManager)
        manager.wheel_rpm_by_id = {
            wheel_id: 1.0 for wheel_id in MqttConfig.WHEEL_IDS
        }

        self.assertFalse(
            manager._store_wheel_message("wheel/angle/speed", "2.0,invalid,3.0,4.0")
        )
        self.assertEqual(
            {wheel_id: 1.0 for wheel_id in MqttConfig.WHEEL_IDS},
            manager.wheel_rpm_by_id,
        )

    def test_measured_wheel_radius_is_cached_for_initial_publication(self):
        manager = object.__new__(MqttManager)
        manager.wheel_radius_by_id = {
            wheel_id: MqttConfig.WHEEL_RADIUS_M for wheel_id in MqttConfig.WHEEL_IDS
        }

        self.assertTrue(manager._store_wheel_message("wheel/fr/radius", "0.080873311"))
        self.assertEqual(0.080873311, manager.wheel_radius_by_id["fr"])

        radius_getter = next(
            value_getter
            for topic_template, value_getter in MqttConfig.WHEEL_PUBLISH_SPECS
            if topic_template == "wheel/{wheel_str_id}/radius"
        )
        self.assertEqual(0.080873311, radius_getter(manager, "fr"))


if __name__ == "__main__":
    unittest.main()