import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import watchlist


NOW = datetime(2026, 9, 11, 4, 0, tzinfo=timezone.utc)


class WatchlistTests(unittest.TestCase):
    def test_polling_frequency_follows_closest_active_stage(self):
        state = {"version": 1, "shipments": {}, "next_poll_at": None}
        watchlist.add_shipment(
            state,
            "KY4000000000001",
            {"status": "other", "event_text": "快件已揽收", "event_time": "2026-09-11 10:00:00"},
            now=NOW,
        )
        self.assertEqual(watchlist.recommended_poll_minutes(state, NOW), 480)
        watchlist.add_shipment(
            state,
            "KY4000000000002",
            {"status": "other", "event_text": "到达目的网点", "event_time": "2026-09-11 11:00:00"},
            now=NOW,
        )
        self.assertEqual(watchlist.recommended_poll_minutes(state, NOW), 15)

    def test_expected_delivery_in_six_hours_raises_attention(self):
        state = {"version": 1, "shipments": {}, "next_poll_at": None}
        watchlist.add_shipment(
            state,
            "KY4000000000001",
            {"status": "other", "event_text": "快件已揽收", "event_time": "2026-09-11 10:00:00"},
            {"expected_delivery_time": "2026-09-11T10:00:00+00:00"},
            now=NOW,
        )
        self.assertEqual(watchlist.recommended_poll_minutes(state, NOW), 30)

    def test_naive_expected_delivery_is_interpreted_as_china_time(self):
        state = {"version": 1, "shipments": {}, "next_poll_at": None}
        watchlist.add_shipment(
            state,
            "KY4000000000001",
            {"status": "other", "event_text": "快件已揽收", "event_time": "2026-09-11 10:00:00"},
            {"expected_delivery_time": "2026-09-11 18:00:00"},
            now=NOW,
        )
        self.assertEqual(watchlist.recommended_poll_minutes(state, NOW), 30)

    def test_delivered_shipment_is_no_longer_active(self):
        state = {"version": 1, "shipments": {}, "next_poll_at": None}
        item = watchlist.add_shipment(state, "KY4000000000001", now=NOW)
        watchlist.apply_classification(
            item,
            {"status": "delivered", "event_text": "已签收", "event_time": "2026-09-11 12:00:00"},
            now=NOW,
        )
        self.assertEqual(watchlist.active_waybills(state), [])
        self.assertIsNotNone(item["completed_at"])

    def test_watchlist_round_trip_and_due_time(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "watchlist.json"
            state = watchlist.load_watchlist(path)
            watchlist.add_shipment(state, "KY4000000000001", now=NOW)
            watchlist.schedule_next_poll(state, 120, now=NOW)
            watchlist.save_watchlist(path, state)
            loaded = watchlist.load_watchlist(path)
            self.assertFalse(watchlist.poll_is_due(loaded, NOW))
            self.assertTrue(
                watchlist.poll_is_due(loaded, datetime(2026, 9, 11, 6, 0, tzinfo=timezone.utc))
            )


if __name__ == "__main__":
    unittest.main()
