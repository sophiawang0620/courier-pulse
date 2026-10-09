#!/usr/bin/env python3
"""Interactive KYE query using sandbox or production endpoints."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys

from kye_official import KyeOfficialClient
from monitor import KYE_WAYBILL_PATTERN, classify_kye_query_route


def hidden(label: str) -> str:
    value = getpass.getpass(f"{label}（输入不会显示）: ").strip()
    if not value:
        raise RuntimeError(f"{label} 不能为空")
    return value


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from-env", action="store_true", help="read credentials from this process environment")
    parser.add_argument("--environment", choices=("sandbox", "prod"), default="sandbox")
    parser.add_argument("--subscribe", action="store_true", help="subscribe the queried waybills to route pushes")
    parser.add_argument("--raw", action="store_true", help="include the complete provider response, which may contain personal data")
    args = parser.parse_args()

    environment_name = "沙盒" if args.environment == "sandbox" else "正式"
    print(f"跨越{environment_name}环境 queryRoute 测试。")
    if args.from_env:
        names = {
            "app_key": "KYE_APP_KEY",
            "app_secret": "KYE_APP_SECRET",
            "customer_code": "KYE_CUSTOMER_CODE",
            "platform_flag": "KYE_PLATFORM_FLAG",
        }
        values = {key: os.environ.get(env_name, "").strip() for key, env_name in names.items()}
        missing = [env_name for key, env_name in names.items() if not values[key]]
        if missing:
            raise RuntimeError(f"当前进程缺少环境变量: {', '.join(missing)}")
        app_key = values["app_key"]
        app_secret = values["app_secret"]
        customer_code = values["customer_code"]
        platform_flag = values["platform_flag"]
    else:
        app_key = hidden("AppKey")
        app_secret = hidden("AppSecret")
        customer_code = hidden("customerCode")
        platform_flag = hidden("platformFlag")
    raw_waybills = input(f"{environment_name}环境运单号（多个用空格分隔）: ").strip().upper()
    waybills = [value for value in re.split(r"[\s,，]+", raw_waybills) if value]
    if not waybills or any(not KYE_WAYBILL_PATTERN.fullmatch(value) for value in waybills):
        raise RuntimeError("运单号格式不符合 KY/KYE 规则")
    if len(waybills) > 20:
        raise RuntimeError("一次最多查询 20 个运单号")

    client = KyeOfficialClient(app_key, app_secret, customer_code, platform_flag, args.environment)
    payload = client.query_route(waybills)
    results = [classify_kye_query_route(payload, waybill) for waybill in waybills]
    output = {"classifications": results}
    if args.raw:
        print("警告：--raw 输出可能包含手机号和完整地址，请勿粘贴到 Issue 或聊天中。", file=sys.stderr)
        output["raw_response"] = payload
    succeeded = all("error" not in result for result in results)
    if args.subscribe and succeeded:
        subscription = client.subscribe_route(waybills)
        output["subscription_response"] = subscription if args.raw else {
            "success": subscription.get("success") if isinstance(subscription, dict) else False,
            "code": subscription.get("code") if isinstance(subscription, dict) else None,
            "msg": subscription.get("msg") if isinstance(subscription, dict) else "invalid response",
        }
        succeeded = (
            isinstance(subscription, dict)
            and str(subscription.get("code")) == "10000"
            and subscription.get("success") is not False
        )
    elif args.subscribe:
        output["subscription_skipped"] = "queryRoute failed"
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if succeeded else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n已取消。", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
