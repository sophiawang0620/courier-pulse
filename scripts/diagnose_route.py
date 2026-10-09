from __future__ import annotations

import argparse
import json
import os
import re
from typing import Any

from kye_official import KyeOfficialClient


WAYBILL_RE = re.compile(r"^KY\d{10,24}$", re.IGNORECASE)


def _route_lists(value: Any):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {"exteriorRouteList", "routeList", "routes"} and isinstance(child, list):
                yield child
            yield from _route_lists(child)
    elif isinstance(value, list):
        for child in value:
            yield from _route_lists(child)


def main() -> int:
    parser = argparse.ArgumentParser(description="Read one production KYE route without exposing credentials")
    parser.add_argument("waybill")
    args = parser.parse_args()
    waybill = args.waybill.strip().upper()
    if not WAYBILL_RE.fullmatch(waybill):
        raise SystemExit("Invalid KYE waybill number")

    client = KyeOfficialClient(
        app_key=os.environ["KYE_APP_KEY"],
        app_secret=os.environ["KYE_APP_SECRET"],
        customer_code=os.environ["KYE_CUSTOMER_CODE"],
        platform_flag=os.environ["KYE_PLATFORM_FLAG"],
        environment="prod",
    )
    payload = client.query_route([waybill])
    events: list[dict[str, Any]] = []
    for route_list in _route_lists(payload):
        for event in route_list:
            if not isinstance(event, dict):
                continue
            sanitized = {
                "time": event.get("uploadDate") or event.get("routeTime") or event.get("time"),
                "step": event.get("routeStep") or event.get("status"),
                "text": event.get("routeDescription") or event.get("description") or event.get("content"),
                "courier": event.get("deliveryName") or event.get("courierName"),
            }
            if any(value not in (None, "") for value in sanitized.values()):
                events.append(sanitized)

    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for event in events:
        key = json.dumps(event, ensure_ascii=False, sort_keys=True)
        if key not in seen:
            seen.add(key)
            unique.append(event)

    print(
        json.dumps(
            {
                "waybill": waybill,
                "success": payload.get("success") if isinstance(payload, dict) else None,
                "code": payload.get("code") if isinstance(payload, dict) else None,
                "message": payload.get("msg") if isinstance(payload, dict) else None,
                "events": unique,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
