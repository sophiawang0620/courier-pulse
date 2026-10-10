# Courier Pulse Worker

This is the standalone Cloudflare Worker for Courier Pulse. It serves every registered carrier adapter through the routes below; two adapters ship with it, KYE (跨越速运) and a generic webhook for any logistics system that can translate its own events into the unified shape. See [carrier adapters](../docs/carrier-adapters.md) for the contract.

Endpoints:

- `POST /carrier/<id>/callback` and `/carrier/<id>/callback/sandbox`: the callback for any installed adapter, verified by that adapter.
- `POST /kye/callback/sandbox` and `/kye/callback/prod`: aliases of the KYE adapter's routes, kept so existing provider configurations do not have to be re-pointed.
- `GET /api/carriers`: authenticated list of installed adapters and their capabilities.
- `GET /health`: public health check without shipment data. Deployment capabilities are returned only for a request carrying a valid `APP_ACCESS_TOKEN` or `MONITOR_TOKEN`; a credentialed probe is rate limited so the endpoint cannot be used to test guessed tokens.
- `GET /events`: authenticated event retrieval.
- `POST /events/ack`: authenticated deletion after successful notification.

Required bindings and secrets:

Every deployment:

- KV binding `KYE_EVENTS` and KV binding `KYE_WATCHLIST` for the cloud mobile watchlist. Both names predate carrier support and are shared by every adapter; renaming them would orphan an existing deployment's data.
- Durable Object binding `WATCHLIST_COORDINATOR`, provisioned automatically by `wrangler deploy` from the included SQLite migration.
- Rate Limiting binding `APP_RATE_LIMITER` (60 management requests per minute in the included configuration).
- Secret `APP_ACCESS_TOKEN` for the phone web page and watchlist API. It must contain at least 32 characters; shorter configured values are rejected.

At least one notification channel:

- Secret `BARK_DEVICE_KEY` (Bark device key; preferred when both are set), with optional variable `BARK_SERVER_URL` (defaults to `https://api.day.app`, useful for a self-hosted Bark server).
- Secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

Only when the KYE adapter is in use — a deployment serving the generic webhook alone needs none of these:

- Secrets `KYE_APP_KEY`, `KYE_APP_SECRET`, `KYE_CUSTOMER_CODE` and `KYE_PROD_PLATFORM_FLAG`.
- Secret `KYE_SANDBOX_PLATFORM_FLAG`, only when the sandbox callback is used.

Only when the generic webhook adapter is in use:

- Secret `GENERIC_WEBHOOK_SECRET`, at least 32 characters. A shorter value leaves the adapter unconfigured and its callback returns 503.

Optional in any deployment:

- Secret `MONITOR_TOKEN`, required only for the local `/events` consumer. When configured, it must contain at least 32 characters.
- Plain-text variable `NOTIFICATION_MODE`. Omit it, or set it to `all_nodes`, while testing so every newly discovered route node is notified. Set it to `critical_only` after the system is stable to notify only pickup assignment and out-for-delivery events that include a courier name.

Verification is each adapter's own responsibility: the Worker hands `verifyCallback` the request and the raw body and does not impose a scheme of its own. Both bundled adapters sign the exact raw request bytes, verify before any JSON parsing, and reject timestamps outside a five-minute window.

- **KYE** — headers `X-KYE-TIMESTAMP` and `X-KYE-SIGN`, an uppercase MD5 of `platformFlag + timestamp + body` as the provider specifies.
- **Generic webhook** — headers `x-courier-pulse-timestamp` and `x-courier-pulse-signature`, a hex HMAC-SHA256 of `<timestamp>.<body>` keyed with `GENERIC_WEBHOOK_SECRET`.

An accepted callback persists only the waybill, carrier, stage, event text, time, location and courier name; unused fields such as a courier phone number are discarded. The KYE adapter additionally strips full addresses, but the Worker cannot tell which text is an address, so a sender using the generic webhook is responsible for keeping addresses and other sensitive values out of the unified event fields. Stored events expire after 14 days and are deduplicated by shipment event identity, even when a carrier changes the surrounding callback batch. Each stored event keeps both the neutral record this Worker uses and a copy under the legacy field names that `scripts/cloud_monitor.py` parses.

When `BARK_DEVICE_KEY` is configured, each accepted callback is sent to Bark in the background. If Bark is not configured, both Telegram secrets are used instead. Notification failures do not cause a carrier callback to fail; the event remains in KV and the alert is retried from the outbox.

The Worker also serves a mobile watchlist at `/app` (and `/`). The page uses `APP_ACCESS_TOKEN` as a Bearer token. With the included Wrangler configuration, a SQLite-backed `WatchlistCoordinator` Durable Object serializes watchlist updates and mirrors the resulting state to `KYE_WATCHLIST`; its first request automatically imports an existing KV watchlist. If the Durable Object binding is absent, the code remains compatible with KV-only dashboard deployments. The scheduled handler wakes every 15 minutes, groups the due shipments by carrier and asks each adapter for at most its own `maxBatch` waybills in one request — 20 for the bundled KYE adapter. A carrier without `queryRoute` is skipped entirely, and the handler stays quiet when no shipment is due. Newly placed waybills without a first route are checked every 15 minutes for two hours, then hourly. Pickup assignment is checked every 30 minutes, collected/origin shipments every eight hours, line-haul transit every four hours, unclassified route text every hour, the final 24/6 hours every two hours/30 minutes, and destination or delivery stages every 15 minutes. Destination-area detection compares route locations with administrative names parsed from the receiving address, while ignoring phrases that merely say the shipment is heading toward that destination. For the KYE adapter only the derived administrative names are stored and the full sender and receiver addresses are discarded; reading legacy records also strips any previously stored full addresses. Rejected subscriptions use exponential backoff and stop after eight failed attempts. KYE access tokens are cached inside the Worker isolate for their safe lifetime; token-invalid responses clear the cache and retry once. Callback batches check and persist event keys concurrently, while acknowledging only after persistence succeeds. Callback deduplication uses per-event fingerprints, while query-to-callback overlap is suppressed by the shipment's latest event time. Delivered shipments automatically leave the active watchlist. Notification failures are kept in a 100-item outbox and retried without repeating `queryRoute`; entries stop after 32 failed attempts or seven days. Completed and stopped history older than 90 days is pruned. Create the second KV namespace and replace the placeholder ID in `wrangler.jsonc` before deploying. If another Worker in the same Cloudflare account already uses rate-limit namespace `2061720250`, change this project's value to another positive integer before deployment.

For the local consumer, run `scripts/run-cloud-monitor.ps1 -CreateToken` once. It generates a cryptographically random token, protects the local copy with Windows DPAPI, and places the value on the clipboard without printing it. Paste that value into the Worker's `MONITOR_TOKEN` secret and deploy. If a token was created elsewhere, copy it and use `-SaveTokenFromClipboard` instead. The token must be at least 32 characters without whitespace. Run `-EnableAutomation` once after deployment: it creates a current-user DPAPI copy. Existing machine-scope files from older versions are read once and migrated automatically.
