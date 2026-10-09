#!/usr/bin/env python3
"""Local-only dashboard bridge for the KYE delivery alert skill."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
SCRIPTS = ROOT / "scripts"
FRONTEND = ROOT / "frontend" / "index.html"
WATCHLIST = ROOT / ".kuayue-watchlist.json"
WAYBILL_PATTERN = re.compile(r"^(?:KY|KYE)[A-Z0-9]{8,20}$", re.IGNORECASE)
ALLOWED_HOSTS = {"127.0.0.1:8765", "localhost:8765"}
ALLOWED_ORIGINS = {"http://127.0.0.1:8765", "http://localhost:8765"}


def valid_host(value: str | None) -> bool:
    return bool(value) and value.strip().lower() in ALLOWED_HOSTS


def valid_origin(value: str | None) -> bool:
    return value is None or value.strip().lower() in ALLOWED_ORIGINS


def run_powershell(script: str, *arguments: str) -> tuple[int, str, str]:
    command = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(SCRIPTS / script),
        *arguments,
    ]
    completed = subprocess.run(command, capture_output=True, timeout=90)
    return (
        completed.returncode,
        completed.stdout.decode("utf-8", errors="replace"),
        completed.stderr.decode("utf-8", errors="replace"),
    )


def read_watchlist() -> dict[str, Any]:
    if not WATCHLIST.exists():
        return {"version": 1, "shipments": {}, "next_poll_at": None}
    return json.loads(WATCHLIST.read_text(encoding="utf-8"))


class Handler(BaseHTTPRequestHandler):
    server_version = "Courier-Pulse-Local/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self) -> None:
        body = FRONTEND.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 10000:
            raise ValueError("请求内容无效")
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("请求内容无效")
        return value

    def do_GET(self) -> None:
        if not valid_host(self.headers.get("Host")):
            self.send_json({"error": "invalid host"}, HTTPStatus.FORBIDDEN)
            return
        path = urlsplit(self.path).path
        if path == "/":
            self.send_file()
            return
        if path == "/api/watchlist":
            try:
                self.send_json(read_watchlist())
            except (OSError, json.JSONDecodeError, ValueError) as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        if not valid_host(self.headers.get("Host")) or not valid_origin(self.headers.get("Origin")):
            self.send_json({"ok": False, "error": "request origin rejected"}, HTTPStatus.FORBIDDEN)
            return
        path = urlsplit(self.path).path
        if path == "/api/check":
            code, stdout, stderr = run_powershell("run-cloud-monitor.ps1")
            if code != 0:
                print(f"Local monitor failed: {stderr or stdout}", file=sys.stderr)
            self.send_json(
                {"ok": code == 0, "message": "检查完成" if code == 0 else "检查失败，请查看启动窗口"},
                HTTPStatus.OK if code == 0 else HTTPStatus.BAD_GATEWAY,
            )
            return
        try:
            body = self.read_json()
            raw_waybills = body.get("waybills")
            if not isinstance(raw_waybills, list) or not 1 <= len(raw_waybills) <= 20:
                raise ValueError("请输入 1 至 20 个运单号")
            waybills = [str(value).strip().upper() for value in raw_waybills]
            if any(not WAYBILL_PATTERN.fullmatch(value) for value in waybills):
                raise ValueError("运单号格式不正确")
            if path == "/api/add":
                code, stdout, stderr = run_powershell("manage-waybills.ps1", "-Add", *waybills)
            elif path == "/api/remove":
                code, stdout, stderr = run_powershell("manage-waybills.ps1", "-Remove", *waybills)
            else:
                self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
            if code != 0:
                print(f"Local waybill command failed: {stderr or stdout}", file=sys.stderr)
            self.send_json(
                {"ok": code == 0, "message": "操作完成" if code == 0 else "操作失败，请查看启动窗口"},
                HTTPStatus.OK if code == 0 else HTTPStatus.BAD_GATEWAY,
            )
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)


def main() -> int:
    if not FRONTEND.exists():
        print(f"Missing frontend: {FRONTEND}", file=sys.stderr)
        return 1
    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    print("KYE dashboard running at http://127.0.0.1:8765")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
