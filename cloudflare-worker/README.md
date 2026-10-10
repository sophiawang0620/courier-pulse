# Courier Pulse Worker

This is the standalone Cloudflare Worker for Courier Pulse. The current built-in provider is KYE (跨越速运), exposed through the carrier-specific callback routes below.

Endpoints:

- `POST /kye/callback/sandbox`: KYE sandbox PushRoute callback.
- `POST /kye/callback/prod`: KYE production PushRoute callback.
- `GET /health`: public health check without shipment data. Deployment capabilities are returned only for a request carrying a valid `APP_ACCESS_TOKEN` or `MONITOR_TOKEN`; a credentialed probe is rate limited so the endpoint cannot be used to test guessed tokens.
- `GET /events`: authenticated event retrieval.
- `POST /events/ack`: authenticated deletion after successful notification.

Required bindings and secrets:

- KV binding `KYE_EVENTS`.
- KV binding `KYE_WATCHLIST` for the cloud mobile watchlist.
- Durable Object binding `WATCHLIST_COORDINATOR`, provisioned automatically by `wrangler deploy` from the included SQLite migration.
- Rate Limiting binding `APP_RATE_LIMITER` (60 management requests per minute in the included configuration).
- Secret `KYE_SANDBOX_PLATFORM_FLAG` (optional when the sandbox callback is unused).
- Secret `KYE_PROD_PLATFORM_FLAG`.
- Secret `MONITOR_TOKEN` (optional; required only for the local `/events` consumer). When configured, it must contain at least 32 characters.
- Secret `APP_ACCESS_TOKEN` for the phone web page and watchlist API. It must contain at least 32 characters; shorter configured values are rejected.
- Optional plain-text variable `NOTIFICATION_MODE`. Omit it, or set it to `all_nodes`, while testing so every newly discovered route node is notified. Set it to `critical_only` after the system is stable to notify only pickup assignment and out-for-delivery events that include a courier name.
- Secrets `KYE_APP_KEY`, `KYE_APP_SECRET`, and `KYE_CUSTOMER_CODE` for cloud query/subscribe.
- Secret `TELEGRAM_BOT_TOKEN` (optional; Telegram Bot API token).
- Secret `TELEGRAM_CHAT_ID` (optional; destination chat ID).
- Secret `BARK_DEVICE_KEY` (optional; Bark device key; preferred when set).
- Variable `BARK_SERVER_URL` (optional; defaults to `https://api.day.app`, useful for a self-hosted Bark server).

The callback verifies `X-KYE-TIMESTAMP` and `X-KYE-SIGN` against the exact raw body before parsing a push, and rejects timestamps outside a five-minute freshness window. It persists only the waybill, route text/time, step, and courier name; unused fields such as a courier phone number are discarded. Stored events expire after 14 days and are deduplicated by shipment event identity, even when KYE changes the surrounding callback batch.

When `BARK_DEVICE_KEY` is configured, each accepted callback is sent to Bark in the background. If Bark is not configured, both Telegram secrets are used instead. Notification failures do not cause the KYE callback to fail; the event remains in KV for the monitor to process.

The Worker also serves a mobile watchlist at `/app` (and `/`). The page uses `APP_ACCESS_TOKEN` as a Bearer token. With the included Wrangler configuration, a SQLite-backed `WatchlistCoordinator` Durable Object serializes watchlist updates and mirrors the resulting state to `KYE_WATCHLIST`; its first request automatically imports an existing KV watchlist. If the Durable Object binding is absent, the code remains compatible with KV-only dashboard deployments. The scheduled handler wakes every 15 minutes, batches up to 20 due waybills into one `queryRoute` call, and stays quiet when no shipment is due. Newly placed waybills without a first route are checked every 15 minutes for two hours, then hourly. Pickup assignment is checked every 30 minutes, collected/origin shipments every eight hours, line-haul transit every four hours, unclassified route text every hour, the final 24/6 hours every two hours/30 minutes, and destination or delivery stages every 15 minutes. Destination-area detection compares route locations with administrative names parsed from the receiving address, while ignoring phrases that merely say the shipment is heading toward that destination. Only the derived administrative names are stored; full sender and receiver addresses are discarded. Reading legacy records also strips any previously stored full addresses. Rejected subscriptions use exponential backoff and stop after eight failed attempts. KYE access tokens are cached inside the Worker isolate for their safe lifetime; token-invalid responses clear the cache and retry once. Callback batches check and persist event keys concurrently, while acknowledging only after persistence succeeds. Callback deduplication uses per-event fingerprints, while query-to-callback overlap is suppressed by the shipment's latest event time. Delivered shipments automatically leave the active watchlist. Notification failures are kept in a 100-item outbox and retried without repeating `queryRoute`; entries stop after 32 failed attempts or seven days. Completed and stopped history older than 90 days is pruned. Create the second KV namespace and replace the placeholder ID in `wrangler.jsonc` before deploying. If another Worker in the same Cloudflare account already uses rate-limit namespace `2061720250`, change this project's value to another positive integer before deployment.

For the local consumer, run `scripts/run-cloud-monitor.ps1 -CreateToken` once. It generates a cryptographically random token, protects the local copy with Windows DPAPI, and places the value on the clipboard without printing it. Paste that value into the Worker's `MONITOR_TOKEN` secret and deploy. If a token was created elsewhere, copy it and use `-SaveTokenFromClipboard` instead. The token must be at least 32 characters without whitespace. Run `-EnableAutomation` once after deployment: it creates a current-user DPAPI copy. Existing machine-scope files from older versions are read once and migrated automatically.
