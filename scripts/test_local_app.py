from __future__ import annotations

import unittest

import local_app


class LocalDashboardBoundaryTests(unittest.TestCase):
    def test_host_is_limited_to_loopback_dashboard_names(self) -> None:
        self.assertTrue(local_app.valid_host("127.0.0.1:8765"))
        self.assertTrue(local_app.valid_host("LOCALHOST:8765"))
        self.assertFalse(local_app.valid_host("attacker.example"))
        self.assertFalse(local_app.valid_host(None))

    def test_cross_origin_posts_are_rejected(self) -> None:
        self.assertTrue(local_app.valid_origin(None))
        self.assertTrue(local_app.valid_origin("http://127.0.0.1:8765"))
        self.assertFalse(local_app.valid_origin("https://attacker.example"))


if __name__ == "__main__":
    unittest.main()
