import argparse
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import waybill_manager


WAYBILL = "KY4000000000001"


class FakeClient:
    def __init__(self, subscription_success=True):
        self.subscription_success = subscription_success

    def query_route(self, waybills):
        return {
            "code": 10000,
            "success": True,
            "data": {
                "esWaybill": [
                    {
                        "waybillNumber": WAYBILL,
                        "expectedDeliveryTime": "2026-09-13 18:00:00",
                        "mailingAddress": "北京市朝阳区某路 1 号",
                        "receivingAddress": "上海市奉贤区某路 2 号",
                        "routeList": [
                            {
                                "uploadDate": "2026-09-11 10:00:00",
                                "routeDescription": "快件已揽收",
                            }
                        ],
                    }
                ]
            },
        }

    def subscribe_route(self, waybills):
        if self.subscription_success:
            return {"code": 10000, "success": True}
        return {"code": 27003, "success": False, "msg": "denied"}


class WaybillManagerTests(unittest.TestCase):
    def setUp(self):
        self.original_client = waybill_manager._client
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "watchlist.json"

    def tearDown(self):
        waybill_manager._client = self.original_client
        self.temporary.cleanup()

    def args(self):
        return argparse.Namespace(waybills=[WAYBILL], watchlist_file=str(self.path))

    def test_add_commits_only_after_successful_subscription(self):
        waybill_manager._client = lambda: FakeClient()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(waybill_manager.add(self.args()), 0)
        state = json.loads(self.path.read_text(encoding="utf-8"))
        item = state["shipments"][WAYBILL]
        self.assertEqual(item["status"], "active")
        self.assertEqual(item["profile"]["expected_delivery_time"], "2026-09-13 18:00:00")
        self.assertEqual(item["profile"]["destination_regions"], ["上海", "奉贤"])
        self.assertNotIn("mailingAddress", item["profile"])
        self.assertNotIn("receivingAddress", item["profile"])

    def test_failed_subscription_does_not_add_waybill(self):
        waybill_manager._client = lambda: FakeClient(subscription_success=False)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(waybill_manager.add(self.args()), 1)
        self.assertFalse(self.path.exists())

    def test_remove_marks_history_as_stopped(self):
        self.path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "shipments": {WAYBILL: {"waybill": WAYBILL, "status": "active"}},
                    "next_poll_at": None,
                }
            ),
            encoding="utf-8",
        )
        args = argparse.Namespace(waybills=[WAYBILL], watchlist_file=str(self.path))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(waybill_manager.remove(args), 0)
        state = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(state["shipments"][WAYBILL]["status"], "stopped")


if __name__ == "__main__":
    unittest.main()
