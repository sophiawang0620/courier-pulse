#!/usr/bin/env python3
"""Consume verified KYE push events from the Cloudflare callback Worker."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from monitor import KYE_WAYBILL_PATTERN, _load_state, _register_alert, _save_state, acknowledge, classify_kye_push
from watchlist import (
    active_waybills,
    apply_classification,
    load_watchlist,
    poll_is_due,
    recommended_poll_minutes,
    save_watchlist,
    schedule_next_poll,
)


DEFAULT_BASE_URL = os.environ.get("KYE_WORKER_BASE_URL", "").strip()


def _validated_base_url(base_url: str) -> str:
    value = base_url.strip().rstrip("/")
    parsed = urllib.parse.urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError("Worker base URL must not contain credentials, a query, or a fragment")
    local_http = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}
    if parsed.scheme != "https" and not local_http:
        raise RuntimeError("Worker base URL must use HTTPS (HTTP is allowed only for localhost)")
    if not parsed.hostname:
        raise RuntimeError("Worker base URL is invalid")
    return value


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect rejected", headers, fp)


def _request_json(
    base_url: str,
    token: str,
    path: str,
    method: str = "GET",
    payload: Any | None = None,
    timeout: int = 25,
) -> Any:
    body = None
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "courier-pulse/0.3",
    }
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"{_validated_base_url(base_url)}{path}", data=body, headers=headers, method=method
    )
    try:
        with urllib.request.build_opener(_RejectRedirects).open(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Cloudflare callback HTTP {exc.code}: {error_body[:500]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Cloudflare callback connection failed: {exc.reason}") from exc


def _pending_results(state: dict[str, Any]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for alert_id, item in state["pending"].items():
        results.append(
            {
                "alert_id": alert_id,
                "waybill": item["waybill"],
                "status": "out_for_delivery",
                "courier_name": item["courier_name"],
                "event_time": item["event_time"],
                "event_text": item["event_text"],
                "event_fingerprint": item["event_fingerprint"],
                "provider": item.get("provider", "kye_push"),
                "matched": True,
                "should_notify": True,
            }
        )
    return results


def _drop_pending_for_waybill(state: dict[str, Any], waybill: str) -> None:
    stale = [
        alert_id
        for alert_id, item in state["pending"].items()
        if item.get("waybill") == waybill
    ]
    for alert_id in stale:
        state["pending"].pop(alert_id, None)


def check(args: argparse.Namespace) -> int:
    watchlist_path = Path(args.watchlist_file).resolve()
    watch_state = load_watchlist(watchlist_path)
    state_path = Path(args.state_file).resolve()
    state = _load_state(state_path)
    managed_waybills = active_waybills(watch_state)
    selected_waybills = args.waybills or managed_waybills
    if not selected_waybills:
        print(
            json.dumps(
                {
                    "results": _pending_results(state),
                    "active_waybills": [],
                    "monitoring_complete": True,
                },
                ensure_ascii=False,
            )
        )
        return 0
    if not args.force and not poll_is_due(watch_state):
        print(
            json.dumps(
                {
                    "results": _pending_results(state),
                    "active_waybills": managed_waybills,
                    "skipped": True,
                    "next_poll_at": watch_state.get("next_poll_at"),
                }
            )
        )
        return 0

    token = os.environ.get("KYE_MONITOR_TOKEN", "").strip()
    if not token:
        print(json.dumps({"ok": False, "error": "KYE_MONITOR_TOKEN is required"}))
        return 1

    watched = {value.strip().upper() for value in selected_waybills}
    invalid = sorted(value for value in watched if not KYE_WAYBILL_PATTERN.fullmatch(value))
    if invalid:
        print(json.dumps({"ok": False, "error": f"Invalid KYE waybill: {invalid[0]}"}))
        return 1

    fresh_nonmatches: list[dict[str, Any]] = []
    processed_keys: list[str] = []
    errors: list[dict[str, str]] = []
    cursor: str | None = None
    page_count = 0
    completed_waybills: set[str] = set()

    try:
        while True:
            page_count += 1
            if page_count > args.max_pages:
                raise RuntimeError(f"Cloudflare callback exceeded {args.max_pages} event pages")
            suffix = f"?{urllib.parse.urlencode({'cursor': cursor})}" if cursor else ""
            page = _request_json(args.base_url, token, f"/events{suffix}", timeout=args.timeout)
            events = page.get("events") if isinstance(page, dict) else None
            if not isinstance(events, list):
                raise RuntimeError("Cloudflare callback returned an invalid event list")

            for event in events:
                key = event.get("key") if isinstance(event, dict) else None
                payload = event.get("payload") if isinstance(event, dict) else None
                if not isinstance(key, str) or not key.startswith("push:"):
                    errors.append({"error": "Cloudflare event has an invalid key"})
                    continue
                try:
                    classified = classify_kye_push(payload)
                except (TypeError, ValueError) as exc:
                    errors.append({"event_key": key, "error": str(exc)})
                    continue
                for result in classified:
                    if result["waybill"] not in watched:
                        continue
                    managed = watch_state["shipments"].get(result["waybill"])
                    if isinstance(managed, dict):
                        apply_classification(managed, result)
                    if result["status"] == "delivered":
                        completed_waybills.add(result["waybill"])
                        _drop_pending_for_waybill(state, result["waybill"])
                    result["provider"] = "kye_push"
                    registered = _register_alert(state, result)
                    if not registered["matched"]:
                        fresh_nonmatches.append(registered)
                processed_keys.append(key)

            cursor = page.get("cursor")
            if not cursor:
                break

        interval = recommended_poll_minutes(watch_state)
        schedule_next_poll(watch_state, interval)
        # Persist lifecycle and notification candidates before deleting their remote source.
        save_watchlist(watchlist_path, watch_state)
        _save_state(state_path, state)
        acknowledged_count = 0
        for offset in range(0, len(processed_keys), 100):
            batch = processed_keys[offset : offset + 100]
            acknowledgement = _request_json(
                args.base_url,
                token,
                "/events/ack",
                method="POST",
                payload={"keys": batch},
                timeout=args.timeout,
            )
            if not isinstance(acknowledgement, dict) or acknowledgement.get("acknowledged") != len(batch):
                raise RuntimeError("Cloudflare callback returned an invalid acknowledgement")
            acknowledged_count += len(batch)
        output = {
            "results": _pending_results(state) + fresh_nonmatches,
            "cloud_events_acknowledged": acknowledged_count,
            "errors": errors,
            "completed_waybills": sorted(completed_waybills),
            "active_waybills": active_waybills(watch_state),
            "recommended_poll_minutes": interval,
            "next_poll_at": watch_state.get("next_poll_at"),
            "monitoring_complete": not active_waybills(watch_state),
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 1 if errors and not output["results"] else 0
    except Exception as exc:
        # Existing pending alerts remain visible even during a transient fetch failure.
        output = {"results": _pending_results(state), "error": str(exc)}
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    check_parser = subparsers.add_parser("check")
    check_parser.add_argument("waybills", nargs="*")
    check_parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help="Worker origin, or set KYE_WORKER_BASE_URL",
    )
    check_parser.add_argument("--state-file", default=".kuayue-push-state.json")
    check_parser.add_argument("--watchlist-file", default=".kuayue-watchlist.json")
    check_parser.add_argument("--timeout", type=int, default=25)
    check_parser.add_argument("--max-pages", type=int, default=100)
    check_parser.add_argument("--force", action="store_true")
    check_parser.set_defaults(func=check)

    ack_parser = subparsers.add_parser("ack")
    ack_parser.add_argument("--alert-id", required=True)
    ack_parser.add_argument("--state-file", default=".kuayue-push-state.json")
    ack_parser.set_defaults(func=acknowledge)
    return parser


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = build_parser().parse_args()
    if args.command == "check" and not args.base_url:
        raise RuntimeError("--base-url or KYE_WORKER_BASE_URL is required")
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
