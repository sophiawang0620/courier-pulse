---
name: courier-pulse
description: Self-hosted, extensible shipment tracking and notification framework. The current built-in provider tracks KYE (跨越速运) waybills. Use for one-off checks or recurring delivery alerts. Do not use third-party tracking providers until the user approves the named provider and disclosure of the waybill data.
---

# Courier Pulse

Track one or more KYE waybills and emit a notification candidate only when the latest event is both out for delivery and associated with a courier name.

## Provider boundary

- Prefer the KYE official API when the user has authorized credentials and current API documentation supplied for their own account. Do not redistribute vendor manuals, SDK archives, portal screenshots, credentials, or raw shipment responses.
- KYE's public website requires interactive verification and a sender/recipient phone suffix, so do not treat it as an unattended polling API.
- The bundled script implements UAPI and KYE official `queryRoute` adapters plus KYE `PushRoute` normalization and push-signature verification. Verify the official adapter against the provider documentation available to the deploying account because endpoints and fields can change.
- Before the first UAPI request for a user's real waybill, explicitly tell the user that the waybill will be disclosed to `uapis.cn` and obtain approval for that destination.
- Read `UAPI_API_KEY` from the environment when available. Never request that a key be pasted into chat or pass it in command-line arguments.

## Check workflow

Run a single check from the user's working directory:

```powershell
python <skill-folder>/scripts/monitor.py check KY4000000000000 --provider uapi --state-file .kuayue-tracking-state.json
```

Multiple waybills may be supplied in one invocation. Add `--carrier-code kuayue` only after confirming that the provider accepts that carrier code; otherwise use auto-detection.

For the first official sandbox test, use the interactive command so credentials are not echoed or stored:

```powershell
python <skill-folder>/scripts/kye_sandbox_test.py
```

On Windows, prefer `scripts/run-sandbox-test.ps1`. Open Windows PowerShell and run it with `-ExecutionPolicy Bypass -File`. On first use, copy each requested value from the provider page, return to PowerShell, and press Enter without pasting; the wrapper reads the clipboard directly and converts the value to a secure string. It deliberately does not modify the clipboard because Windows may temporarily lock it. This avoids terminal multiline-paste interception. It stores only Windows DPAPI-encrypted values under `%LOCALAPPDATA%\KyeDeliveryAlert`. Later runs reuse them for the same Windows account and ask only for the waybill. Pass `-Environment prod` to reuse those credentials against the production token and REST endpoints. Use `-ResetCredentials` only when the saved values must be replaced. Plain values exist only briefly in memory and the child process environment and are cleared afterward.

KYE may issue different sandbox and production customer codes. The Windows wrapper retains the original sandbox `customerCode` and, on the first production run, asks only for a separate production value. Use `-UpdateProductionCustomerCode` to replace that production value without re-entering the app key, app secret, platform flag, or sandbox customer code.

For unattended official checks, supply `KYE_APP_KEY`, `KYE_APP_SECRET`, `KYE_CUSTOMER_CODE`, and `KYE_PLATFORM_FLAG` through a user-approved secret store or process environment, then run `check` with `--provider kye --environment sandbox|prod`. Never put credentials in command arguments, tracked files, logs, or chat.

The command returns JSON. For each result:

- `should_notify: false`: stay quiet unless the user asked for a status report or `error` is present.
- `should_notify: true`: notify the user with the waybill, event time, raw event text, and courier name. After the notification is successfully delivered, acknowledge it:

```powershell
python <skill-folder>/scripts/monitor.py ack --alert-id <alert_id> --state-file .kuayue-tracking-state.json
```

Do not acknowledge before notification succeeds. An unacknowledged alert remains pending and is emitted again on the next check, preventing a transient notification failure from losing the alert.

## Recurring monitoring

Do not create recurring monitoring on UAPI visitor/anonymous quota; use it only for an explicitly requested emergency check. The official PushRoute workflow uses `.kuayue-watchlist.json` as the lifecycle registry. A lightweight heartbeat may invoke the local consumer every 15 minutes, but `cloud_monitor.py` must honor `next_poll_at` and avoid any Cloudflare request until the shipment-specific interval is due. The default policy is 8 hours at collection/origin, 4 hours in line-haul transit, 15 minutes at a destination/depot node, and 5 minutes after out-for-delivery; an official expected-delivery time tightens this to 2 hours in the final 24 hours and 30 minutes in the final 6 hours. The heartbeat should:

1. Stay quiet while no alert matches.
2. Notify only on `should_notify: true`, then run `ack` after delivery.
3. Surface repeated provider/authentication failures only when user action is required.
4. Mark each waybill complete after a delivered event and stop monitoring that shipment. The shared dispatcher may remain idle so newly added waybills are picked up without recreating automation.

## Managing waybills

On Windows, `add-waybill.cmd` is the user entry point. It accepts one or more KY/KYE waybills separated by spaces or commas, queries the production API, subscribes active shipments to PushRoute, and only then adds them to the managed watchlist. Already-delivered shipments are recorded as complete and are not subscribed. The manager reads the existing user-DPAPI KYE credentials; it never places them in command arguments or the repository.

For scripted management, run `scripts/manage-waybills.ps1 -Add <waybill>`, `-Remove <waybill>`, or `-List`. Removing a waybill marks it `stopped` in the local history (so it remains visible) but does not cancel the provider subscription because no verified unsubscribe API is currently implemented.

The optional local dashboard is started by double-clicking `run-dashboard.cmd`, then opening `http://127.0.0.1:8765`. It displays the local watchlist and provides the same add/remove workflow through a localhost-only bridge. The browser never receives KYE credentials or the Cloudflare monitor token.

To keep the dashboard available after a reboot without moving credentials to the public internet, run `scripts/install-dashboard-startup.ps1` once in Windows PowerShell. It registers a current-user, least-privilege logon task and keeps the server bound to `127.0.0.1`. Use `scripts/uninstall-dashboard-startup.ps1` to remove that startup task.

Inspect `provider_metadata.rate_limit` after each UAPI request. Stop further automatic calls when any relevant remaining bucket reaches 1 unless the user explicitly allocates the last request.

The state file contains waybill numbers and normalized event details. Keep it in the user's project or another location they approve; do not commit it.

## Matching rules

The script gives structured fields priority and uses conservative Chinese text patterns as a fallback. Never notify on “派送中” without a non-empty courier name. Treat a courier change as a new alert event. Do not infer a person's name from an unlabelled two- or three-character substring.

For an official `PushRoute` webhook, verify `X-KYE-SIGN` against the exact raw request bytes before parsing JSON. KYE documents duplicate pushes for the same waybill/node, so pass classified results through the same pending/acknowledged state flow before notifying.

The standalone Cloudflare implementation is in `cloudflare-worker/`. It must be deployed as its own Worker named `courier-pulse`; never attach it to or modify an unrelated Pages/Workers application. Before deployment, provision the `KYE_EVENTS` and `KYE_WATCHLIST` KV bindings and set the Worker secrets documented in `cloudflare-worker/README.md`. Do not claim that a callback URL exists until deployment and its `/health` endpoint have both been verified.

After deployment, consume verified push events with `scripts/cloud_monitor.py`. On Windows, use `scripts/run-cloud-monitor.ps1`; it reads `MONITOR_TOKEN` from a Windows DPAPI-encrypted local file, never from command arguments. Set `KYE_WORKER_BASE_URL` or pass `-BaseUrl` with the deployed Worker origin. The consumer uses active entries in `.kuayue-watchlist.json` unless explicit waybills are supplied. Save the shared token once with `-SaveTokenFromClipboard`, then run `-EnableAutomation` once so a local automation can decrypt a machine-DPAPI copy kept under the current user's LocalAppData ACL. Run the script without switches for a check. The consumer writes matching alerts to `.kuayue-push-state.json` before deleting their source events from Cloudflare KV. A pending alert is emitted again until notification succeeds and its `alert_id` is acknowledged with `-AckAlertId`.
