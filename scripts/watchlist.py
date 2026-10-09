"""Persistent KYE watchlist and stage-aware polling policy."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


EARLY_WORDS = ("已揽收", "揽件", "收件", "已取件", "始发")
TRANSIT_WORDS = ("运输中", "运输途中", "发往", "离开", "转运")
NEAR_DESTINATION_WORDS = (
    "到达目的",
    "目的网点",
    "目的站点",
    "派送网点",
    "派件网点",
    "派送站点",
    "派件站点",
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def load_watchlist(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "shipments": {}, "next_poll_at": None}
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot read watchlist {path}: {exc}") from exc
    if not isinstance(state, dict) or not isinstance(state.get("shipments", {}), dict):
        raise RuntimeError(f"Invalid watchlist structure: {path}")
    state.setdefault("version", 1)
    state.setdefault("shipments", {})
    state.setdefault("next_poll_at", None)
    return state


def save_watchlist(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def add_shipment(
    state: dict[str, Any],
    waybill: str,
    classification: dict[str, Any] | None = None,
    profile: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    current = now or utc_now()
    normalized = waybill.strip().upper()
    item = state["shipments"].get(normalized, {})
    item.update(
        {
            "waybill": normalized,
            "status": "active",
            "added_at": item.get("added_at") or _iso(current),
            "completed_at": None,
        }
    )
    if profile:
        item["profile"] = {key: value for key, value in profile.items() if value not in (None, "")}
    if classification:
        apply_classification(item, classification, current)
    state["shipments"][normalized] = item
    state["next_poll_at"] = _iso(current)
    return item


def apply_classification(
    shipment: dict[str, Any], result: dict[str, Any], now: datetime | None = None
) -> None:
    current = now or utc_now()
    shipment["last_status"] = result.get("status", "other")
    shipment["last_event_time"] = result.get("event_time")
    shipment["last_event_text"] = result.get("event_text")
    shipment["courier_name"] = result.get("courier_name")
    shipment["updated_at"] = _iso(current)
    if result.get("status") == "delivered":
        shipment["status"] = "completed"
        shipment["completed_at"] = _iso(current)


def active_waybills(state: dict[str, Any]) -> list[str]:
    return sorted(
        waybill
        for waybill, shipment in state["shipments"].items()
        if isinstance(shipment, dict) and shipment.get("status") == "active"
    )


def _expected_delivery(shipment: dict[str, Any]) -> datetime | None:
    profile = shipment.get("profile")
    value = profile.get("expected_delivery_time") if isinstance(profile, dict) else None
    if not value:
        return None
    normalized = str(value).strip().replace("Z", "+00:00").replace("/", "-")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    # KYE business timestamps without an offset are China Standard Time.
    return parsed.replace(tzinfo=timezone(timedelta(hours=8))) if parsed.tzinfo is None else parsed


def recommended_poll_minutes(
    state: dict[str, Any], now: datetime | None = None
) -> int | None:
    current = (now or utc_now()).astimezone(timezone.utc)
    intervals: list[int] = []
    for waybill in active_waybills(state):
        shipment = state["shipments"][waybill]
        status = shipment.get("last_status")
        text = str(shipment.get("last_event_text") or "")
        if status == "out_for_delivery":
            interval = 5
        elif any(word in text for word in NEAR_DESTINATION_WORDS):
            interval = 15
        elif any(word in text for word in TRANSIT_WORDS):
            interval = 240
        elif any(word in text for word in EARLY_WORDS):
            interval = 480
        else:
            interval = 360
        expected = _expected_delivery(shipment)
        if expected is not None:
            hours_remaining = (expected.astimezone(timezone.utc) - current).total_seconds() / 3600
            if hours_remaining <= 6:
                interval = min(interval, 30)
            elif hours_remaining <= 24:
                interval = min(interval, 120)
        intervals.append(interval)
    return min(intervals) if intervals else None


def poll_is_due(state: dict[str, Any], now: datetime | None = None) -> bool:
    value = state.get("next_poll_at")
    if not value:
        return True
    try:
        due = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if due.tzinfo is None:
            due = due.replace(tzinfo=timezone.utc)
    except ValueError:
        return True
    return (now or utc_now()).astimezone(timezone.utc) >= due.astimezone(timezone.utc)


def schedule_next_poll(
    state: dict[str, Any], minutes: int | None, now: datetime | None = None
) -> None:
    state["next_poll_at"] = None if minutes is None else _iso((now or utc_now()) + timedelta(minutes=minutes))
