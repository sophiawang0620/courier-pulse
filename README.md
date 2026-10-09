# Courier Pulse

一个可自行部署、可扩展多家快递公司的物流追踪与通知框架。目前内置跨越速运（KYE）适配器，使用跨越开放平台正式接口查询和订阅物流节点，在 Cloudflare Workers 上定时运行，并通过 Bark 或 Telegram 推送提醒。手机网页可添加、查看和停止追踪运单，电脑关机后仍可工作。

> 本项目不是跨越速运官方产品。使用者必须自行取得跨越开放平台的合法账号、接口权限和凭证，并遵守跨越、Cloudflare、Bark 与 Telegram 的服务条款。仓库不提供、共享或绕过任何平台凭证。

第三方名称、文档和 SDK 不属于本项目的 MIT 许可范围，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。准备公开自己的派生仓库前，请执行 [公开发布检查清单](docs/public-release-checklist.md)。

## 功能

- 手机网页管理云端运单清单
- 接收并验签跨越 PushRoute 回调
- 以 Cloudflare Cron 主动调用 queryRoute 作为回调缺失时的保障
- Bark 优先、Telegram 备用的节点通知
- 测试模式提醒每个新节点；稳定模式只提醒关键节点
- 签收后自动停止查询
- 自适应查询频率，并在进入收件目的地区域后缩短为约 15 分钟
- KV 去重，避免同一节点反复通知

## 工作方式

~~~text
手机网页 ──> Worker API ──> KYE_WATCHLIST KV
                         └─> 跨越 queryRoute / subscribeRoute

Cloudflare Cron ──> 到期运单批量查询 ──> Bark / Telegram
跨越 PushRoute ──> 验签与 KYE_EVENTS KV ──> Bark / Telegram
~~~

Cron 可以每 15 分钟唤醒一次，但只有到达该运单自己的 next_poll_at 才会调用跨越查询。没有活动运单或没有到期运单时，不会请求跨越接口。

## 前置条件

- 跨越开放平台应用及生产环境权限
- Cloudflare 账号
- Node.js 22 或更高版本（部署和 Worker 测试）
- 可选：Bark iOS App，或 Telegram Bot
- 可选：Python 3.11 或更高版本（本地诊断、旧版 Windows 辅助工具）

## 部署

### 1. 创建两个 KV Namespace

在 Cloudflare 控制台创建两个 KV：

- 事件库，对应绑定名 KYE_EVENTS
- 云端清单，对应绑定名 KYE_WATCHLIST

把它们的 namespace ID 填入 cloudflare-worker/wrangler.jsonc。绑定名不要修改。

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

如果使用沙盒回调，再配置 KYE_SANDBOX_PLATFORM_FLAG；如果使用本地事件消费者，再配置 MONITOR_TOKEN。APP_ACCESS_TOKEN 是手机网页的访问码；MONITOR_TOKEN 只供本地消费者读取。两者必须使用不同的随机值，且至少 32 个字符；Worker 会拒绝使用过短访问码的管理请求。不要把任何 secret 写进配置、源码、Issue 或聊天记录。

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

访问 https://你的-Worker-域名/health，应返回 ok: true。手机访问根地址或 /app，输入 APP_ACCESS_TOKEN 后即可管理运单。

将以下两个地址配置到跨越开放平台相应环境的 PushRoute 回调：

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

- 完整收件地址和寄件地址不会写入 KV；只保存目的地行政区名称，用于判断是否进入目的区域。
- 运单号、最新物流节点、快递员姓名（若接口返回）和调度状态会保存在你的 Cloudflare KV；回调中的手机号和未使用字段不会持久化。
- 手机访问码保存在浏览器 localStorage。不要在公共或共享设备上登录。
- 回调使用跨越签名验签；管理 API 使用 Bearer token。
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
