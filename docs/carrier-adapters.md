# 快递适配器

Courier Pulse 的调度、去重、通知和清单都只处理**统一事件结构**，不认识任何一家快递的字段。
每接入一家快递，只需要实现一个适配器对象。

## 统一事件结构

适配器的职责就是把自家接口的返回，变成下面这组字段：

| 字段 | 说明 |
| --- | --- |
| `carrier` | 适配器 id |
| `waybill` | 运单号，保留该快递自己的格式 |
| `status` | 物流阶段，取值见下表 |
| `delivered` | 是否已签收 |
| `event_time` | 节点时间 |
| `event_text` | 节点文案 |
| `location` | 节点所在地，可为空 |
| `courier_name` | 快递员姓名，可为空 |
| `event_fingerprint` | 去重用，由 `classifyEvent` 统一生成 |

目的地行政区不放在事件里，而是放在该运单的 `profile.destination_regions`，
因为它属于运单而不属于某一个节点。

### 阶段取值

适配器可以直接声明阶段，**声明值优先于中文关键词识别**。只有不声明时才回退到关键词。
这对非中文文案的物流系统尤其重要——否则 `critical_only` 模式会漏掉派送提醒。

| 取值 | 含义 | 轮询间隔 |
| --- | --- | --- |
| `pending` | 尚无节点 | 15 分钟（两小时后转一小时） |
| `pickup_assigned` | 已分配揽收员 | 30 分钟 |
| `collected` | 已揽收 / 始发 | 8 小时 |
| `in_transit` | 干线运输 | 4 小时 |
| `at_destination` | 到达目的网点 | 15 分钟 |
| `out_for_delivery` | 派送中 | 15 分钟 |
| `delivered` | 已签收 | 结束监控 |

不在此表内的值会被**拒绝**（回调返回 400），而不是被静默忽略。

## 适配器接口

```js
const EXAMPLE_ADAPTER = {
  id: "example",                       // 注册表键，也是清单键的前缀
  label: "示例快递",                    // 手机端下拉框显示的名字
  waybillPattern: /^EX\d{10}$/i,        // 自动识别用
  autoDetect: true,                    // 兜底型适配器设为 false，只能被显式选择
  maxBatch: 20,                        // 单次查询最多几个运单
  normalizeWaybill: (v) => v.trim().toUpperCase(),
  configured: (env) => Boolean(env.EXAMPLE_API_KEY),

  // 以下四个都是可选的，按这家快递实际支持的能力实现
  async queryRoute(env, waybills) { /* → { ok, waitingForFirstRoute, results } */ },
  async subscribeRoute(env, waybills) { /* → { ok, message } */ },
  async verifyCallback(request, env, rawBody, environment) { /* → { ok, status, message } */ },
  normalizeCallback(payload) { /* → [{ raw, event }] 或 null */ },
};
```

写完加进 `CARRIER_ADAPTERS` 数组即可，其余部分不需要改动。

### 适配器产出的记录

`normalizeCallback` 返回 `[{ record, event }]`，其中 `record` 使用上表的中性字段名
（`waybill` / `status` / `event_text` / `event_time` / `location` / `courier_name`），
**不需要了解任何一家快递的原始字段名**。

写入 KV 时会同时保存该中性记录和一份旧字段名的副本
（`mailno` / `step` / `desc` / `time` / `deliveryName`），
后者仅为兼容 `scripts/cloud_monitor.py` 这个早期本地消费者。
该脚本只能解析跨越格式的运单号，其他快递的事件在它那里会记为一条错误而不是崩溃。

### 只推送、不能查询的快递

省略 `queryRoute` 即可。调度器会跳过这类运单，不会为它们发起任何上游请求，
`next_poll_at` 恒为 `null`，它们只等自己的 Webhook。

### 回调地址

```
POST /carrier/<id>/callback            生产环境
POST /carrier/<id>/callback/sandbox    沙盒环境
```

跨越的 `/kye/callback/prod` 与 `/kye/callback/sandbox` 保留为别名，老配置不需要改。

## 清单键

清单以 `<carrier>:<waybill>` 为键。加前缀是因为不同快递完全可能发出相同的号码，
不区分会导致后写入的那条静默覆盖先写入的。

旧版本按裸运单号存储的记录，会在第一次读取时自动补上 `carrier: "kye"` 并换键。
这个迁移是幂等的，已经是复合键的记录不受影响。

## 内置的通用 Webhook 适配器

给没有官方适配器的用户：把自己物流系统的事件转成统一结构推进来即可。

```
POST /carrier/generic/callback
x-courier-pulse-timestamp: <13 位毫秒时间戳>
x-courier-pulse-signature: <hex(HMAC-SHA256(secret, "<timestamp>.<原始请求体>"))>
content-type: application/json

[
  {
    "waybill": "ORDER-20261010-001",
    "event_time": "2026-10-10 09:00:00",
    "event_text": "快件已到达上海分拨中心",
    "location": "上海分拨中心",
    "courier_name": "",
    "status": "in_transit"
  }
]
```

`status` 取值见上面的阶段表。也可以用 `"delivered": true` 作为 `status: "delivered"` 的简写。

密钥通过 `npx wrangler secret put GENERIC_WEBHOOK_SECRET` 设置，至少 32 个字符。
时间戳超出 ±5 分钟的请求会被拒绝，签名使用原始请求体字节计算。

`delivered: true` 会直接判定为签收，优先于其他取值；该运单随后自动结束监控。

通用适配器**不参与自动识别**——它的运单号格式几乎匹配一切，参与识别会让每个号码都变成歧义。
在手机页的下拉框里显式选择「通用 Webhook」即可。

## 尚未内置的快递

顺丰、京东等尚未内置。接入前需要先确认能够合法申请对方的官方 API；
本项目不会通过爬取官网物流页面来获取数据。
