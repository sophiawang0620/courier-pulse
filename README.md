# Courier Pulse

Courier Pulse 提供可自行部署的多快递适配器框架。任何具备合法查询 API 或 Webhook 授权的快递服务，都可以通过编写一个适配器、或经由内置的通用 Webhook 中转接入。

仓库内置两个适配器：**跨越速运（KYE）**使用其开放平台正式接口查询和订阅物流节点；**通用 Webhook** 供任意物流系统把自己的事件转换后推送进来。核心逻辑在 Cloudflare Workers 上定时运行，通过 Bark 或 Telegram 推送提醒。手机网页可选择快递公司、添加、查看和停止追踪运单，电脑关机后仍可工作。

> 本项目不是任何一家快递公司的官方产品。使用者必须自行取得所接入快递服务的合法账号、接口权限和凭证，并遵守该快递公司以及 Cloudflare、Bark 与 Telegram 的服务条款。仓库不提供、共享或绕过任何平台凭证，也不通过爬取快递公司的公开查询页面获取数据。

第三方名称、文档和 SDK 不属于本项目的 MIT 许可范围，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。准备公开自己的派生仓库前，请执行 [公开发布检查清单](docs/public-release-checklist.md)。

## 功能

- 多快递适配器框架：调度、去重、通知只处理统一事件结构，接入新快递只需写一个适配器（见[快递适配器](docs/carrier-adapters.md)）
- 内置跨越速运适配器，以及可供任意物流系统接入的通用 Webhook 适配器
- 手机网页可选择快递公司或自动识别
- 手机网页管理云端运单清单
- 接收并验签各适配器的回调；跨越使用其 PushRoute 签名，通用 Webhook 使用 HMAC-SHA256
- 以 Cloudflare Cron 主动查询作为回调缺失时的保障；只推送、不支持查询的快递会被自动跳过
- Bark 优先、Telegram 备用的节点通知
- 测试模式提醒每个新节点；稳定模式只提醒关键节点
- 签收后自动停止查询
- 自适应查询频率，并在进入收件目的地区域后缩短为约 15 分钟
- KV 去重，避免同一节点反复通知
- Durable Object 串行化清单更新，避免手机操作、回调和 Cron 同时写入时互相覆盖
- 管理 API 限流，降低访问码猜测和接口滥用风险

## 工作方式

~~~text
手机网页 ──> Worker API ──> WatchlistCoordinator Durable Object
                         │             └─> KYE_WATCHLIST KV 镜像/迁移源
                         └─> 承运商适配器 ──> 上游快递 API（查询 / 订阅）

Cloudflare Cron ──> 按承运商分组、批量查询到期运单 ──> Bark / Telegram
承运商回调 ──> 适配器验签 ──> KYE_EVENTS KV ──> Bark / Telegram
~~~

以内置的跨越适配器为例，上游调用是 `queryRoute` 与 `subscribeRoute`，回调是 PushRoute；
通用 Webhook 适配器没有上游查询，只接收推送。

Cron 每 15 分钟唤醒一次，但只有到达该运单自己的 `next_poll_at` 才会向上游发起查询。
没有活动运单、没有到期运单，或该运单所属适配器不支持查询时，都不会产生任何上游请求。

## 前置条件

所有部署都需要：

- Cloudflare 账号
- Node.js 22 或更高版本（部署和 Worker 测试）
- 至少一种通知渠道：Bark iOS App 或 Telegram Bot

按你要启用的适配器，另外需要：

- **跨越速运适配器**：跨越开放平台应用及生产环境权限
- **通用 Webhook 适配器**：一个能把自家物流事件转换成统一结构并签名推送的系统

只用通用 Webhook 的部署**不需要跨越的任何凭证**。

可选：

- Python 3.11 或更高版本（本地诊断与旧版 Windows 辅助工具，目前仅支持跨越）

## 部署

### 1. 创建两个 KV Namespace

在 Cloudflare 控制台创建两个 KV：

- 事件库，对应绑定名 KYE_EVENTS
- 云端清单，对应绑定名 KYE_WATCHLIST

这两个绑定名是早期版本留下的，与快递公司无关，所有适配器共用；改名会让已部署的实例读不到既有数据，因此保持原样。

把它们的 namespace ID 填入 cloudflare-worker/wrangler.jsonc。绑定名不要修改。

`wrangler.jsonc` 还会在首次部署时自动创建 SQLite-backed Durable Object，用于串行处理云端清单写入；不需要手工创建数据库或填写 ID。配置中的 `APP_RATE_LIMITER` 用于限制管理 API，每分钟默认允许 60 次请求。若同一 Cloudflare 账号内已有其他 Worker 使用 namespace_id `2061720250`，请把它改成另一个正整数，避免两个项目共享计数器。

### 2. 配置 Worker Secrets

先在 `cloudflare-worker` 目录安装仓库锁定的工具版本：

~~~powershell
corepack enable
pnpm install --frozen-lockfile
~~~

然后运行下列命令，并在提示后粘贴各自的值：

~~~powershell
pnpm exec wrangler secret put KYE_APP_KEY
pnpm exec wrangler secret put KYE_APP_SECRET
pnpm exec wrangler secret put KYE_CUSTOMER_CODE
pnpm exec wrangler secret put KYE_PROD_PLATFORM_FLAG
pnpm exec wrangler secret put APP_ACCESS_TOKEN
~~~

上面四个 `KYE_*` 是**跨越适配器专用**的；只用通用 Webhook 的部署不需要它们，跳过即可。启用通用 Webhook 请配置 `GENERIC_WEBHOOK_SECRET`（至少 32 个字符，用法见[快递适配器](docs/carrier-adapters.md)）。使用跨越沙盒回调再加 `KYE_SANDBOX_PLATFORM_FLAG`；使用本地事件消费者再加 `MONITOR_TOKEN`。APP_ACCESS_TOKEN 是手机网页的访问码；MONITOR_TOKEN 只供本地消费者读取。两者必须使用不同的随机值，且至少 32 个字符；Worker 会拒绝使用过短访问码的管理请求。不要把任何 secret 写进配置、源码、Issue 或聊天记录。

通知渠道至少配置一种。配置 Bark：

~~~powershell
pnpm exec wrangler secret put BARK_DEVICE_KEY
~~~

或配置 Telegram：

~~~powershell
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_CHAT_ID
~~~

如果同时配置，Worker 优先发送 Bark。自建 Bark 服务可在 wrangler.jsonc 的 vars 中增加非秘密变量 BARK_SERVER_URL。

### 3. 选择通知模式

默认 all_nodes 会提醒主动查询发现的每个新节点，适合首次测试。稳定后可在 wrangler.jsonc 中添加：

~~~jsonc
"vars": {
  "NOTIFICATION_MODE": "critical_only"
}
~~~

critical_only 只提醒“已分配揽收员但尚未揽收”和“派送中且有快递员姓名”。

### 4. 部署

~~~powershell
cd cloudflare-worker
corepack enable
pnpm install --frozen-lockfile
pnpm exec wrangler deploy
~~~

仓库将 Wrangler 固定在 lockfile 记录的版本；请勿删除 lockfile 后直接拉取未经验证的最新版。

访问 https://你的-Worker-域名/health，应返回 ok: true。带上 `Authorization: Bearer <APP_ACCESS_TOKEN>` 再访问同一地址，才会额外返回 capabilities，应能看到 watchlist_storage: durable_object 与 rate_limiting: true；不带访问码的健康检查不会暴露这些部署细节。手机访问根地址或 /app，输入 APP_ACCESS_TOKEN 后即可管理运单。

从旧版升级时无需手工搬运：Durable Object 第一次收到请求会从 `KYE_WATCHLIST` 导入现有清单，之后每次更新仍镜像回 KV，便于回退。不要在升级部署前删除原有 KV 绑定或 namespace。

每个适配器的回调地址形如 `https://你的-Worker-域名/carrier/<适配器 id>/callback`，沙盒环境在末尾加 `/sandbox`。通用 Webhook 的地址即 `/carrier/generic/callback`。

跨越另有两个等价别名，老配置无需改动。把对应环境的地址配置到跨越开放平台的 PushRoute 回调：

- https://你的-Worker-域名/kye/callback/sandbox
- https://你的-Worker-域名/kye/callback/prod

### 暂停或恢复主动轮询

临时停用时只需删除 Cloudflare Cron Trigger，手机网页、KV 数据和跨越回调仍会保留。控制台路径为：Workers & Pages → 选择 Worker → Triggers → Cron Triggers → 对应规则右侧三点菜单 → Delete。变更最多可能需要约 15 分钟传播。

本仓库的 wrangler.jsonc 仍把 15 分钟规则作为默认部署配置；以后再次执行 wrangler deploy 会重新创建该规则。若希望后续部署也保持停用，把 triggers.crons 改为空数组后再部署；恢复时改回 `*/15 * * * *`。

## 调度策略

- 刚新增且无首个路由：约 15 分钟一次；持续两小时后降为一小时
- 已分配揽收员但未揽收：约 30 分钟一次
- 已揽收 / 始发：约 8 小时一次
- 干线运输：约 4 小时一次
- 预计送达前 24 小时：约 2 小时一次
- 预计送达前 6 小时：约 30 分钟一次
- 到达目的网点或进入收件目的地区域：约 15 分钟一次
- 派送：约 15 分钟一次
- 签收：结束该运单监控
- 已识别为路由、但文案无法分类：约 1 小时一次

## 隐私与安全

- **跨越适配器会主动丢弃完整地址**：收件和寄件地址不会写入 KV，只保留目的地行政区名称，用于判断是否进入目的区域；回调中的手机号和未使用字段也不会持久化。
- **其他适配器和通用 Webhook 的发送方必须自行避免**把完整地址或其他敏感信息写进统一事件字段。`event_text` 与 `location` 会被原样保存到 KV，Worker 不会对它们做清理——它无法判断哪一段文本是地址。
- 保存在你的 Cloudflare KV 中的内容是：运单号、所属快递、最新节点的文本、时间、位置、阶段，以及快递员姓名（若上游返回）和调度状态。
- 手机访问码保存在浏览器 localStorage。不要在公共或共享设备上登录。
- 回调使用跨越签名验签；管理 API 使用 Bearer token，并通过 Cloudflare Rate Limiting binding 做近似限流。合法访问码以不可逆摘要作为计数键，错误访问以来源摘要计数，原始访问码不会写入限流键或日志。
- 回调时间戳仅接受约五分钟内的请求，降低合法请求被延迟重放的风险。
- 通知渠道暂时失败时，待发送节点会保存在 KV 并在下一次 Cron 重试，不会为了重试通知而再次查询跨越；单条通知最多尝试 32 次且最长保留 7 天。
- 本地 secrets、状态 JSON 和 Python 缓存均已加入 .gitignore。
- 公开仓库前运行 `python scripts/audit_public_history.py` 扫描完整历史，并按公开发布检查清单人工复核二进制文件、截图、提交者邮箱和第三方资料。

## 本地辅助工具

云端 Worker 是主运行方式。本地 Windows 工具用于诊断或兼容旧工作流：

~~~powershell
$env:KYE_WORKER_BASE_URL = "https://你的-Worker-域名"
.\scripts\run-cloud-monitor.ps1
~~~

也可以直接传入 -BaseUrl。脚本只从 PATH 查找 Python，不包含任何开发者机器路径。

本地面板只接受 `127.0.0.1:8765` 或 `localhost:8765`，并拒绝来自其他网页来源的写操作。官方 API 是默认查询源；只有明确传入 `--provider uapi` 时才会把运单号发送到第三方 `uapis.cn`，使用前必须取得运单数据所有者同意。`kye_sandbox_test.py` 默认只输出分类结果；`--raw` 会输出可能含手机号和完整地址的原始响应，不应粘贴到公开 Issue 或聊天中。

scripts/smoke-test-local-app.py 是手工冒烟检查：先启动 run-dashboard.cmd，再单独运行该脚本。

## 测试

~~~powershell
python -m unittest discover -s scripts -p "test_*.py"

cd cloudflare-worker
node --check src/worker.js
node --test
~~~

测试使用虚构运单号和模拟接口，不会请求真实跨越运单。

## 开源许可

[MIT](LICENSE)

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告；贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
