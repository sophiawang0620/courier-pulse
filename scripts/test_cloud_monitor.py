import argparse
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

import cloud_monitor


class CloudMonitorTests(unittest.TestCase):
    def setUp(self):
        self.original_request = cloud_monitor._request_json
        self.original_token = os.environ.get("KYE_MONITOR_TOKEN")
        os.environ["KYE_MONITOR_TOKEN"] = "test-token"
        self.temporary = tempfile.TemporaryDirectory()
        self.state_file = str(Path(self.temporary.name) / "state.json")

    def tearDown(self):
        cloud_monitor._request_json = self.original_request
        if self.original_token is None:
            os.environ.pop("KYE_MONITOR_TOKEN", None)
        else:
            os.environ["KYE_MONITOR_TOKEN"] = self.original_token
        self.temporary.cleanup()

    def args(self):
        return argparse.Namespace(
            waybills=["KY4000000000001"],
            base_url="https://example.test",
            state_file=self.state_file,
            watchlist_file=str(Path(self.temporary.name) / "watchlist.json"),
            timeout=5,
            max_pages=100,
            force=True,
        )

    def test_matching_push_is_persisted_before_remote_ack(self):
        calls = []

        def fake_request(base_url, token, path, method="GET", payload=None, timeout=25):
            calls.append((path, method, payload))
            if path == "/events":
                return {
                    "events": [
                        {
                            "key": "push:prod:1:abc",
                            "payload": [
                                {
                                    "mailno": "KY4000000000001",
                                    "step": "派送中",
                                    "desc": "快件正在派送",
                                    "time": "2026-09-11 12:00:00",
                                    "deliveryName": "李四",
                                }
                            ],
                        }
                    ],
                    "cursor": None,
                }
            state = json.loads(Path(self.state_file).read_text(encoding="utf-8"))
            self.assertEqual(len(state["pending"]), 1)
            return {"acknowledged": 1}

        cloud_monitor._request_json = fake_request
        self.assertEqual(cloud_monitor.check(self.args()), 0)
        state = json.loads(Path(self.state_file).read_text(encoding="utf-8"))
        self.assertEqual(len(state["pending"]), 1)
        self.assertEqual(calls[-1][0], "/events/ack")

    def test_pending_alert_survives_fetch_failure(self):
        state = {
            "version": 1,
            "pending": {
                "alert1": {
                    "waybill": "KY4000000000001",
                    "event_fingerprint": "fingerprint",
                    "courier_name": "张三",
                    "event_time": "2026-09-11 12:00:00",
                    "event_text": "派送中",
                    "provider": "kye_push",
                }
            },
            "acknowledged": {},
        }
        Path(self.state_file).write_text(json.dumps(state), encoding="utf-8")

        def fail(*args, **kwargs):
            raise RuntimeError("temporary failure")

        cloud_monitor._request_json = fail
        self.assertEqual(cloud_monitor.check(self.args()), 1)
        after = json.loads(Path(self.state_file).read_text(encoding="utf-8"))
        self.assertIn("alert1", after["pending"])

    def test_pending_alert_is_emitted_even_when_cloud_poll_is_not_due(self):
        state = {
            "version": 1,
            "pending": {
                "alert1": {
                    "waybill": "KY4000000000001",
                    "event_fingerprint": "fingerprint",
                    "courier_name": "张三",
                    "event_time": "2026-09-11 12:00:00",
                    "event_text": "派送中",
                    "provider": "kye_push",
                }
            },
            "acknowledged": {},
        }
        Path(self.state_file).write_text(json.dumps(state), encoding="utf-8")
        Path(self.args().watchlist_file).write_text(
            json.dumps(
                {
                    "version": 1,
                    "shipments": {
                        "KY4000000000001": {
                            "waybill": "KY4000000000001",
                            "status": "active",
                        }
                    },
                    "next_poll_at": "2999-01-01T00:00:00+00:00",
                }
            ),
            encoding="utf-8",
        )
        args = self.args()
        args.force = False
        calls = []
        cloud_monitor._request_json = lambda *values, **kwargs: calls.append(values)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(cloud_monitor.check(args), 0)
        self.assertEqual(calls, [])
        self.assertTrue(json.loads(output.getvalue())["results"][0]["should_notify"])

    def test_nonmatching_push_is_acknowledged_without_pending_alert(self):
        acknowledged = []

        def fake_request(base_url, token, path, method="GET", payload=None, timeout=25):
            if path == "/events":
                return {
                    "events": [
                        {
                            "key": "push:prod:1:def",
                            "payload": [
                                {
                                    "mailno": "KY4000000000001",
                                    "step": "运输中",
                                    "desc": "运输途中",
                                    "time": "2026-09-11 10:00:00",
                                }
                            ],
                        }
                    ],
                    "cursor": None,
                }
            acknowledged.extend(payload["keys"])
            return {"acknowledged": len(payload["keys"])}

        cloud_monitor._request_json = fake_request
        self.assertEqual(cloud_monitor.check(self.args()), 0)
        state = json.loads(Path(self.state_file).read_text(encoding="utf-8"))
        self.assertEqual(state["pending"], {})
        self.assertEqual(acknowledged, ["push:prod:1:def"])

    def test_pagination_cursor_is_url_encoded(self):
        paths = []

        def fake_request(base_url, token, path, method="GET", payload=None, timeout=25):
            paths.append(path)
            if len(paths) == 1:
                return {"events": [], "cursor": "a+/="}
            return {"events": [], "cursor": None}

        cloud_monitor._request_json = fake_request
        self.assertEqual(cloud_monitor.check(self.args()), 0)
        self.assertEqual(paths, ["/events", "/events?cursor=a%2B%2F%3D"])

    def test_worker_base_url_requires_https_except_for_loopback(self):
        self.assertEqual(cloud_monitor._validated_base_url("https://worker.example/"), "https://worker.example")
        self.assertEqual(cloud_monitor._validated_base_url("http://127.0.0.1:8787"), "http://127.0.0.1:8787")
        with self.assertRaisesRegex(RuntimeError, "HTTPS"):
            cloud_monitor._validated_base_url("http://worker.example")
        with self.assertRaisesRegex(RuntimeError, "credentials"):
            cloud_monitor._validated_base_url("https://token@worker.example")


if __name__ == "__main__":
    unittest.main()
