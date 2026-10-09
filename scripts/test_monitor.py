import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("monitor.py")
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC = importlib.util.spec_from_file_location("kuayue_monitor", MODULE_PATH)
monitor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(monitor)


class ClassifyTests(unittest.TestCase):
    def test_dispatch_text_and_labelled_name_match(self):
        payload = {
            "state": "5",
            "data": [
                {
                    "time": "2026-09-09 10:00:00",
                    "context": "快件派送中，快递员：张三，请保持电话畅通",
                }
            ],
        }
        result = monitor.classify(payload, "KY1")
        self.assertTrue(result["matched"])
        self.assertEqual(result["status"], "out_for_delivery")
        self.assertEqual(result["courier_name"], "张三")

    def test_name_without_dispatch_does_not_match(self):
        payload = {
            "data": [
                {
                    "time": "2026-09-09 09:00:00",
                    "context": "快件运输中",
                    "courierName": "李四",
                }
            ]
        }
        self.assertFalse(monitor.classify(payload, "KY2")["matched"])

    def test_old_dispatch_does_not_override_new_delivered_event(self):
        payload = {
            "data": [
                {"time": "2026-09-09 08:00:00", "context": "派件中，派件员：王五"},
                {"time": "2026-09-09 12:00:00", "context": "已签收"},
            ]
        }
        result = monitor.classify(payload, "KY3")
        self.assertEqual(result["status"], "delivered")
        self.assertFalse(result["matched"])

    def test_old_dispatch_does_not_override_new_in_transit_event(self):
        payload = {
            "data": [
                {"time": "2026-09-09 08:00:00", "statusCode": "out_for_delivery", "context": "派件员：王五"},
                {"time": "2026-09-09 12:00:00", "context": "快件运输中"},
            ]
        }
        result = monitor.classify(payload, "KY6")
        self.assertEqual(result["status"], "other")
        self.assertFalse(result["matched"])

    def test_old_courier_name_does_not_fill_current_dispatch_event(self):
        payload = {
            "data": [
                {"time": "2026-09-09 08:00:00", "context": "运输中", "courierName": "王五"},
                {"time": "2026-09-09 12:00:00", "context": "快件派送中"},
            ]
        }
        result = monitor.classify(payload, "KY7")
        self.assertIsNone(result["courier_name"])
        self.assertFalse(result["matched"])

    def test_unlabelled_chinese_name_is_not_inferred(self):
        payload = {
            "data": [
                {"time": "2026-09-09 10:00:00", "context": "张三正在处理，快件派送中"}
            ]
        }
        result = monitor.classify(payload, "KY4")
        self.assertIsNone(result["courier_name"])
        self.assertFalse(result["matched"])

    def test_pending_alert_requires_acknowledgement(self):
        result = monitor.classify(
            {"data": [{"time": "2026-09-09 10:00:00", "statusName": "派送中", "courierName": "赵六"}]},
            "KY5",
        )
        state = {"version": 1, "pending": {}, "acknowledged": {}}
        first = monitor._register_alert(state, dict(result))
        second = monitor._register_alert(state, dict(result))
        self.assertTrue(first["should_notify"])
        self.assertTrue(second["should_notify"])
        alert_id = first["alert_id"]
        state["acknowledged"][alert_id] = state["pending"].pop(alert_id)
        third = monitor._register_alert(state, dict(result))
        self.assertFalse(third["should_notify"])

    def test_kye_query_route_selects_only_requested_waybill(self):
        payload = {
            "code": 10000,
            "success": True,
            "data": {
                "esWaybill": [
                    {
                        "waybillNumber": "KY4000000000001",
                        "exteriorRouteList": [
                            {
                                "routeStep": "派送中",
                                "routeDescription": "快件正在派送，派送员：张三",
                                "uploadDate": "2026-09-09 10:00:00",
                            }
                        ],
                    },
                    {
                        "waybillNumber": "KY4000000000002",
                        "exteriorRouteList": [
                            {
                                "routeStep": "运输中",
                                "routeDescription": "快件运输中",
                                "uploadDate": "2026-09-09 11:00:00",
                            }
                        ],
                    },
                ]
            },
        }
        first = monitor.classify_kye_query_route(payload, "KY4000000000001")
        second = monitor.classify_kye_query_route(payload, "KY4000000000002")
        self.assertTrue(first["matched"])
        self.assertEqual(first["courier_name"], "张三")
        self.assertFalse(second["matched"])

    def test_kye_query_route_rejects_failed_response(self):
        result = monitor.classify_kye_query_route(
            {"code": 40101, "success": False, "msg": "token失效", "data": {}},
            "KY4000000000001",
        )
        self.assertFalse(result["matched"])
        self.assertIn("token失效", result["error"])

    def test_kye_push_uses_delivery_name_and_is_deterministic(self):
        payload = [
            {
                "mailno": "KY4000000000001",
                "node": 80,
                "step": "派送中",
                "desc": "快件正在派送，请保持电话畅通",
                "time": "2026-09-09 12:00:00",
                "deliveryName": "李四",
                "deliveryPhone": "13800000000",
            }
        ]
        first = monitor.classify_kye_push(payload)[0]
        second = monitor.classify_kye_push(payload)[0]
        self.assertTrue(first["matched"])
        self.assertEqual(first["courier_name"], "李四")
        self.assertEqual(first["event_fingerprint"], second["event_fingerprint"])

    def test_kye_push_requires_courier_name(self):
        result = monitor.classify_kye_push(
            [{"mailno": "KY4000000000001", "step": "派送中", "desc": "正在派送", "time": "2026-09-09 12:00:00"}]
        )[0]
        self.assertFalse(result["matched"])

    def test_kye_push_signature(self):
        body = '[{"mailno":"KY4000000000001"}]'.encode("utf-8")
        timestamp = "1788926400000"
        expected = monitor.hashlib.md5(b"SZYG" + timestamp.encode("ascii") + body).hexdigest().upper()
        self.assertTrue(monitor.verify_kye_push_signature("SZYG", timestamp, body, expected))
        self.assertFalse(monitor.verify_kye_push_signature("SZYG", timestamp, body, "0" * 32))
        self.assertFalse(monitor.verify_kye_push_signature("SZYG", "bad", body, expected))


if __name__ == "__main__":
    unittest.main()
