"""Minimal KYE Open Platform client implemented from the official Java SDK protocol."""

from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any


TOKEN_URLS = {
    "sandbox": "https://open.ky-express.com/security/sandbox/accessToken",
    "prod": "https://open.ky-express.com/security/token",
}
REST_URLS = {
    "sandbox": "https://open.ky-express.com/sandbox/router/rest",
    "prod": "https://open.ky-express.com/router/rest",
}
TOKEN_INVALID_CODES = {6000, 6001, 6002, 6003}
QUERY_ROUTE_METHOD = "open.api.openCommon.queryRoute"
SUBSCRIBE_ROUTE_METHOD = "open.api.openCommon.subscribeRoute"


def format_timestamp(now: datetime | None = None) -> str:
    value = now or datetime.now(timezone.utc)
    shanghai = value.astimezone(timezone(timedelta(hours=8)))
    return shanghai.strftime("%Y-%m-%d %H:%M:%S")


def sign_request(app_secret: str, timestamp: str, body: bytes) -> str:
    digest_input = app_secret.encode("utf-8") + timestamp.encode("ascii") + body
    return hashlib.md5(digest_input).hexdigest().upper()  # nosec B324: KYE protocol requirement


def _decode_json_response(response: Any) -> Any:
    raw = response.read()
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("KYE returned a non-JSON response") from exc


def _post_json(url: str, body: bytes, headers: dict[str, str], timeout: int) -> Any:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return _decode_json_response(response)
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"KYE HTTP {exc.code}: {error_body[:500]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"KYE connection failed: {exc.reason}") from exc


def _token_from_response(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise RuntimeError("KYE token response must be an object")
    data = payload.get("data")
    if isinstance(data, str):
        try:
            decoded = json.loads(data)
        except json.JSONDecodeError:
            decoded = {"token": data}
        data = decoded
    token = data.get("token") if isinstance(data, dict) else None
    if not isinstance(token, str) or not token.strip():
        code = payload.get("code")
        message = str(payload.get("msg") or "unknown error")
        raise RuntimeError(f"KYE token request failed: code={code}, msg={message}")
    return token.strip()


class KyeOfficialClient:
    def __init__(
        self,
        app_key: str,
        app_secret: str,
        customer_code: str,
        platform_flag: str,
        environment: str = "sandbox",
        timeout: int = 25,
    ) -> None:
        if environment not in TOKEN_URLS:
            raise ValueError("KYE environment must be sandbox or prod")
        values = (app_key, app_secret, customer_code, platform_flag)
        if any(not value.strip() for value in values):
            raise ValueError("KYE app key, app secret, customer code, and platform flag are required")
        self.app_key = app_key.strip()
        self._app_secret = app_secret.strip()
        self.customer_code = customer_code.strip()
        self.platform_flag = platform_flag.strip()
        self.environment = environment
        self.timeout = timeout
        self._token: str | None = None

    def _access_token(self, force: bool = False) -> str:
        if self._token and not force:
            return self._token
        body = json.dumps(
            {"appkey": self.app_key, "appsecret": self._app_secret},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        payload = _post_json(
            TOKEN_URLS[self.environment],
            body,
            {
                "Accept": "application/json",
                "Content-Type": "application/json;charset=UTF-8",
                "User-Agent": "courier-pulse/0.2",
            },
            self.timeout,
        )
        self._token = _token_from_response(payload)
        return self._token

    def _call(self, method: str, business: dict[str, Any], retry_token: bool = True) -> Any:
        body = json.dumps(business, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        timestamp = format_timestamp()
        payload = _post_json(
            REST_URLS[self.environment],
            body,
            {
                "Accept": "application/json",
                "Content-Type": "application/json;charset=UTF-8",
                "appkey": self.app_key,
                "token": self._access_token(),
                "sign": sign_request(self._app_secret, timestamp, body),
                "timestamp": timestamp,
                "method": method,
                "format": "json",
                "User-Agent": "courier-pulse/0.2",
            },
            self.timeout,
        )
        code = payload.get("code") if isinstance(payload, dict) else None
        if retry_token and code in TOKEN_INVALID_CODES:
            self._access_token(force=True)
            return self._call(method, business, retry_token=False)
        return payload

    def query_route(self, waybills: list[str]) -> Any:
        if not 1 <= len(waybills) <= 20:
            raise ValueError("KYE queryRoute accepts 1 to 20 waybills")
        return self._call(
            QUERY_ROUTE_METHOD,
            {
                "customerCode": self.customer_code,
                "waybillNumbers": waybills,
                "platformFlag": self.platform_flag,
            },
        )

    def subscribe_route(self, waybills: list[str]) -> Any:
        if not 1 <= len(waybills) <= 20:
            raise ValueError("KYE subscribeRoute accepts 1 to 20 waybills")
        return self._call(
            SUBSCRIBE_ROUTE_METHOD,
            {
                "waybillNumber": waybills,
                "orderChannel": self.platform_flag,
                "type": ["10"],
                "customerCode": self.customer_code,
            },
        )
