#!/usr/bin/env python3
"""Single-run KYE tracking check with durable, acknowledged alert deduplication."""

from __future__ import annotations

import argparse
import hmac
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from kye_official import KyeOfficialClient


UAPI_ENDPOINT = "https://uapis.cn/api/v1/misc/tracking/query"
KYE_WAYBILL_PATTERN = re.compile(r"^(?:KY|KYE)[A-Z0-9]{8,20}$", re.IGNORECASE)
DISPATCH_WORDS = ("派送中", "派件中", "正在派送", "正在派件", "开始派送", "安排派送", "安排派件")
DELIVERED_WORDS = ("已签收", "签收完毕", "签收成功", "妥投")
TEXT_KEYS = (
    "context",
    "description",
    "desc",
    "info",
    "remark",
    "status_name",
    "statusName",
    "state_name",
    "stateName",
    "action",
    "step",
    "routeStep",
    "routeDescription",
)
TIME_KEYS = (
    "time",
    "ftime",
    "event_time",
    "eventTime",
    "datetime",
    "date",
    "timestamp",
    "uploadDate",
)
NAME_KEYS = (
    "courier_name",
    "courierName",
    "delivery_name",
    "deliveryName",
    "deliveryman",
    "deliveryMan",
    "driver_name",
    "driverName",
    "staff_name",
    "staffName",
)
STATE_KEYS = ("state", "status_code", "statusCode", "logistics_status", "logisticsStatus")
NAME_PATTERNS = (
    re.compile(r"(?:派送员|配送员|派件员|快递员|收派员|司机)(?:姓名)?\s*[：:]\s*([\u4e00-\u9fff·]{2,8})"),
    re.compile(r"(?:派送员|配送员|派件员|快递员|收派员|司机)\s*[【\[]\s*([\u4e00-\u9fff·]{2,8})\s*[】\]]"),
    re.compile(r"(?:由|联系)\s*([\u4e00-\u9fff·]{2,8})\s*(?:为您)?(?:派送|派件)"),
)


def _iter_dicts(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _iter_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_dicts(child)


def _clean_string(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _event_text(item: dict[str, Any]) -> str:
    parts = [_clean_string(item.get(key)) for key in TEXT_KEYS if _clean_string(item.get(key))]
    return " | ".join(dict.fromkeys(parts))


def _event_time(item: dict[str, Any]) -> str:
    for key in TIME_KEYS:
        value = _clean_string(item.get(key))
        if value:
            return value
    return ""


def _time_sort_key(value: str) -> tuple[int, str]:
    if not value:
        return (0, "")
    normalized = value.strip().replace("Z", "+00:00")
    for candidate in (normalized, normalized.replace("/", "-")):
        try:
            return (1, datetime.fromisoformat(candidate).isoformat())
        except ValueError:
            pass
    return (0, value)


def _explicit_name(item: dict[str, Any]) -> str:
    for key in NAME_KEYS:
        value = _clean_string(item.get(key))
        if value and value.lower() not in {"null", "none", "unknown"}:
            return value
    return ""


def _name_from_text(text: str) -> str:
    for pattern in NAME_PATTERNS:
        match = pattern.search(text)
        if match:
            return match.group(1)
    return ""


def _structured_dispatch(item: dict[str, Any]) -> bool:
    for key in STATE_KEYS:
        value = _clean_string(item.get(key)).lower()
        if key == "state" and value == "5":
            return True
        if value in {"out_for_delivery", "out-for-delivery", "dispatching", "delivering", "派送中", "派件中"}:
            return True
    return False


def _candidate_events(payload: Any) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for item in _iter_dicts(payload):
        text = _event_text(item)
        if text and (_event_time(item) or any(key in item for key in STATE_KEYS) or any(key in item for key in NAME_KEYS)):
            candidates.append(item)
    return candidates


def classify(payload: Any, waybill: str) -> dict[str, Any]:
    events = _candidate_events(payload)
    timed = [item for item in events if _event_time(item)]
    latest = max(timed, key=lambda item: _time_sort_key(_event_time(item))) if timed else (events[0] if events else {})
    text = _event_text(latest)

    is_delivered = any(word in text for word in DELIVERED_WORDS)
    root_summary_dispatch = isinstance(payload, dict) and _structured_dispatch(payload)
    is_dispatch = not is_delivered and (
        _structured_dispatch(latest)
        or any(word in text for word in DISPATCH_WORDS)
        or root_summary_dispatch
    )

    root_name = _explicit_name(payload) if isinstance(payload, dict) else ""
    courier_name = _explicit_name(latest) or _name_from_text(text) or root_name

    status = "delivered" if is_delivered else ("out_for_delivery" if is_dispatch else "other")
    event_time = _event_time(latest)
    fingerprint_input = json.dumps(
        {"waybill": waybill, "status": status, "courier_name": courier_name, "event_time": event_time, "text": text},
        ensure_ascii=False,
        sort_keys=True,
    )
    event_fingerprint = hashlib.sha256(fingerprint_input.encode("utf-8")).hexdigest()[:24]
    return {
        "waybill": waybill,
        "status": status,
        "courier_name": courier_name or None,
        "event_time": event_time or None,
        "event_text": text or None,
        "event_fingerprint": event_fingerprint,
        "matched": bool(is_dispatch and courier_name),
    }


def classify_kye_query_route(payload: Any, waybill: str) -> dict[str, Any]:
    """Classify one waybill from a KYE queryRoute response.

    A query may contain up to 20 waybills. Restricting classification to the
    matching esWaybill object prevents another shipment's latest event from
    influencing this result.
    """
    normalized_waybill = waybill.strip().upper()
    if not isinstance(payload, dict):
        result = classify({}, normalized_waybill)
        result["error"] = "KYE queryRoute response must be an object"
        return result
    response_code = payload.get("code")
    if payload.get("success") is False or (response_code is not None and str(response_code) != "10000"):
        result = classify({}, normalized_waybill)
        result["error"] = f"KYE queryRoute failed: code={response_code}, msg={_clean_string(payload.get('msg'))}"
        return result
    for item in _iter_dicts(payload):
        item_waybill = _clean_string(item.get("waybillNumber")).upper()
        if item_waybill == normalized_waybill:
            return classify(item, normalized_waybill)
    result = classify({}, normalized_waybill)
    result["error"] = "Waybill not present in KYE queryRoute response"
    return result


def classify_kye_push(payload: Any) -> list[dict[str, Any]]:
    """Classify KYE PushRoute array items without trusting their shape."""
    if not isinstance(payload, list):
        raise ValueError("KYE PushRoute payload must be a JSON array")
    results: list[dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            raise ValueError("Every KYE PushRoute item must be an object")
        waybill = _clean_string(item.get("mailno")).upper()
        if not KYE_WAYBILL_PATTERN.fullmatch(waybill):
            raise ValueError("KYE PushRoute item has an invalid mailno")
        results.append(classify(item, waybill))
    return results


def verify_kye_push_signature(
    platform_flag: str,
    timestamp: str,
    raw_body: bytes,
    provided_signature: str,
) -> bool:
    """Verify X-KYE-SIGN using the algorithm shown in KYE PushRoute docs."""
    if not platform_flag or not re.fullmatch(r"\d{13}", timestamp):
        return False
    expected = hashlib.md5(  # nosec B324: protocol-required integrity check
        platform_flag.encode("utf-8") + timestamp.encode("ascii") + raw_body
    ).hexdigest().upper()
    return hmac.compare_digest(expected, provided_signature.strip().upper())


def fetch_uapi(waybill: str, carrier_code: str = "", timeout: int = 25) -> tuple[Any, dict[str, str]]:
    query: dict[str, str] = {"tracking_number": waybill, "refresh": "true"}
    if carrier_code:
        query["carrier_code"] = carrier_code
    url = f"{UAPI_ENDPOINT}?{urllib.parse.urlencode(query)}"
    headers = {"Accept": "application/json", "User-Agent": "courier-pulse/0.1"}
    api_key = os.environ.get("UAPI_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            metadata = {
                key: value
                for key, value in {
                    "rate_limit": response.headers.get("RateLimit"),
                    "rate_limit_policy": response.headers.get("RateLimit-Policy"),
                    "request_id": response.headers.get("X-Request-ID"),
                }.items()
                if value
            }
            return json.loads(response.read().decode("utf-8")), metadata
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"UAPI HTTP {exc.code}: {body[:500]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"UAPI connection failed: {exc.reason}") from exc


def _load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "pending": {}, "acknowledged": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot read state file {path}: {exc}") from exc
    data.setdefault("version", 1)
    data.setdefault("pending", {})
    data.setdefault("acknowledged", {})
    return data


def _save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _register_alert(state: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    alert_id = hashlib.sha256(
        f"{result['waybill']}|{result['event_fingerprint']}".encode("utf-8")
    ).hexdigest()[:24]
    result["alert_id"] = alert_id if result["matched"] else None
    if not result["matched"]:
        result["should_notify"] = False
        return result
    if alert_id in state["acknowledged"]:
        result["should_notify"] = False
        return result
    state["pending"][alert_id] = {
        "waybill": result["waybill"],
        "event_fingerprint": result["event_fingerprint"],
        "courier_name": result["courier_name"],
        "event_time": result["event_time"],
        "event_text": result["event_text"],
        **({"provider": result["provider"]} if result.get("provider") else {}),
    }
    result["should_notify"] = True
    return result


def check(args: argparse.Namespace) -> int:
    state_path = Path(args.state_file).resolve()
    state = _load_state(state_path)
    results: list[dict[str, Any]] = []
    kye_client: KyeOfficialClient | None = None
    kye_config_error: str | None = None
    if args.provider == "kye":
        try:
            kye_client = KyeOfficialClient(
                os.environ.get("KYE_APP_KEY", ""),
                os.environ.get("KYE_APP_SECRET", ""),
                os.environ.get("KYE_CUSTOMER_CODE", ""),
                os.environ.get("KYE_PLATFORM_FLAG", ""),
                args.environment,
                args.timeout,
            )
        except (ValueError, RuntimeError) as exc:
            kye_config_error = str(exc)
    for waybill in args.waybills:
        try:
            waybill = waybill.strip().upper()
            if not KYE_WAYBILL_PATTERN.fullmatch(waybill):
                raise RuntimeError("Invalid KYE waybill format")
            if args.provider == "uapi":
                payload, provider_metadata = fetch_uapi(waybill, args.carrier_code, args.timeout)
                result = classify(payload, waybill)
            else:
                if kye_config_error:
                    raise RuntimeError(kye_config_error)
                assert kye_client is not None
                payload = kye_client.query_route([waybill])
                provider_metadata = {"environment": args.environment}
                result = classify_kye_query_route(payload, waybill)
            result["provider"] = args.provider
            result["provider_metadata"] = provider_metadata
            results.append(_register_alert(state, result))
        except Exception as exc:  # concise JSON error for schedulers
            results.append({
                "waybill": waybill,
                "provider": args.provider,
                "should_notify": False,
                "error": str(exc),
            })
    _save_state(state_path, state)
    print(json.dumps({"results": results}, ensure_ascii=False, indent=2))
    return 1 if all("error" in result for result in results) else 0


def acknowledge(args: argparse.Namespace) -> int:
    state_path = Path(args.state_file).resolve()
    state = _load_state(state_path)
    pending = state["pending"].pop(args.alert_id, None)
    if pending is None:
        print(json.dumps({"acknowledged": False, "alert_id": args.alert_id, "reason": "not_pending"}))
        return 1
    state["acknowledged"][args.alert_id] = pending
    _save_state(state_path, state)
    print(json.dumps({"acknowledged": True, "alert_id": args.alert_id}))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    check_parser = subparsers.add_parser("check", help="query and classify one or more waybills")
    check_parser.add_argument("waybills", nargs="+")
    check_parser.add_argument("--provider", default="kye", choices=("uapi", "kye"))
    check_parser.add_argument("--environment", default="sandbox", choices=("sandbox", "prod"))
    check_parser.add_argument("--carrier-code", default="")
    check_parser.add_argument("--state-file", default=".kuayue-tracking-state.json")
    check_parser.add_argument("--timeout", type=int, default=25)
    check_parser.set_defaults(func=check)

    ack_parser = subparsers.add_parser("ack", help="acknowledge a successfully delivered alert")
    ack_parser.add_argument("--alert-id", required=True)
    ack_parser.add_argument("--state-file", default=".kuayue-tracking-state.json")
    ack_parser.set_defaults(func=acknowledge)
    return parser


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
