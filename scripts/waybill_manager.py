#!/usr/bin/env python3
"""Add, list, or remove KYE waybills from the managed watchlist."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from kye_official import KyeOfficialClient
from monitor import KYE_WAYBILL_PATTERN, _clean_string, _iter_dicts, classify_kye_query_route
from watchlist import active_waybills, add_shipment, load_watchlist, save_watchlist


PROFILE_KEYS = ("mailingTime", "serviceModeName")
EXPECTED_TIME_KEYS = (
    "expectedDeliveryTime",
    "estimatedDeliveryTime",
    "estimateArrivalTime",
    "expectedArrivalTime",
    "planDeliveryTime",
)
REGION_PATTERN = re.compile(
    r"([\u3400-\u9fff]{2,8}?)(特别行政区|自治区|自治州|省|市|盟|区|县|旗|镇)"
)
GENERIC_REGIONS = {"中国", "城区", "市辖", "辖区"}


def _destination_regions(address: Any) -> list[str]:
    names: list[str] = []
    for match in REGION_PATTERN.finditer(_clean_string(address)):
        name = match.group(1).strip()
        if len(name) >= 2 and name not in GENERIC_REGIONS and name not in names:
            names.append(name)
        if match.group(2) == "区" and name.endswith("新") and len(name) > 2:
            shortened = name[:-1]
            if shortened not in names:
                names.append(shortened)
    return names


def _profile(payload: Any, waybill: str) -> dict[str, Any]:
    for item in _iter_dicts(payload):
        if _clean_string(item.get("waybillNumber")).upper() == waybill:
            profile = {
                key: _clean_string(item.get(key))
                for key in PROFILE_KEYS
                if _clean_string(item.get(key))
            }
            regions = _destination_regions(
                item.get("receivingAddress") or item.get("receiving_address")
            )
            if regions:
                profile["destination_regions"] = regions
            for key in EXPECTED_TIME_KEYS:
                value = _clean_string(item.get(key))
                if value:
                    profile["expected_delivery_time"] = value
                    break
            return profile
    return {}


def _client() -> KyeOfficialClient:
    names = ("KYE_APP_KEY", "KYE_APP_SECRET", "KYE_CUSTOMER_CODE", "KYE_PLATFORM_FLAG")
    values = [os.environ.get(name, "").strip() for name in names]
    if any(not value for value in values):
        raise RuntimeError("Production KYE credentials are required in the process environment")
    return KyeOfficialClient(*values, environment="prod")


def add(args: argparse.Namespace) -> int:
    waybills = list(dict.fromkeys(value.strip().upper() for value in args.waybills))
    invalid = [value for value in waybills if not KYE_WAYBILL_PATTERN.fullmatch(value)]
    if invalid or not waybills or len(waybills) > 20:
        raise RuntimeError("Supply 1 to 20 valid KY/KYE waybills")
    client = _client()
    query = client.query_route(waybills)
    classifications = {waybill: classify_kye_query_route(query, waybill) for waybill in waybills}
    failures = {waybill: result["error"] for waybill, result in classifications.items() if "error" in result}
    if failures:
        print(json.dumps({"ok": False, "query_errors": failures}, ensure_ascii=False, indent=2))
        return 1

    subscribable = [waybill for waybill, result in classifications.items() if result["status"] != "delivered"]
    subscription: Any = None
    if subscribable:
        subscription = client.subscribe_route(subscribable)
        if not (
            isinstance(subscription, dict)
            and str(subscription.get("code")) == "10000"
            and subscription.get("success") is not False
        ):
            print(json.dumps({"ok": False, "subscription_response": subscription}, ensure_ascii=False, indent=2))
            return 1

    path = Path(args.watchlist_file).resolve()
    state = load_watchlist(path)
    for waybill in waybills:
        add_shipment(state, waybill, classifications[waybill], _profile(query, waybill))
    save_watchlist(path, state)
    print(
        json.dumps(
            {
                "ok": True,
                "added": waybills,
                "subscribed": subscribable,
                "already_delivered": [waybill for waybill in waybills if waybill not in subscribable],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def list_items(args: argparse.Namespace) -> int:
    state = load_watchlist(Path(args.watchlist_file).resolve())
    print(json.dumps({"shipments": list(state["shipments"].values()), "active": active_waybills(state)}, ensure_ascii=False, indent=2))
    return 0


def remove(args: argparse.Namespace) -> int:
    path = Path(args.watchlist_file).resolve()
    state = load_watchlist(path)
    removed = []
    for value in args.waybills:
        waybill = value.strip().upper()
        shipment = state["shipments"].get(waybill)
        if isinstance(shipment, dict) and shipment.get("status") == "active":
            shipment["status"] = "stopped"
            shipment["completed_at"] = datetime.now(timezone.utc).isoformat()
            removed.append(waybill)
    save_watchlist(path, state)
    print(json.dumps({"removed": removed}, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--watchlist-file", default=".kuayue-watchlist.json")
    subparsers = parser.add_subparsers(dest="command", required=True)
    add_parser = subparsers.add_parser("add")
    add_parser.add_argument("waybills", nargs="+")
    add_parser.set_defaults(func=add)
    list_parser = subparsers.add_parser("list")
    list_parser.set_defaults(func=list_items)
    remove_parser = subparsers.add_parser("remove")
    remove_parser.add_argument("waybills", nargs="+")
    remove_parser.set_defaults(func=remove)
    return parser


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
