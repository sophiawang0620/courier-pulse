import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

import { handleRequest, md5Hex, scheduledMonitor, verifyKyeSignature, WatchlistCoordinator } from "../src/worker.js";

const APP_TOKEN = "a".repeat(32);
const MONITOR_TOKEN = "m".repeat(32);

function currentTimestamp() {
  return Date.now().toString();
}

class MemoryKv {
  constructor() {
    this.values = new Map();
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async get(key, type) {
    const value = this.values.get(key) ?? null;
    return type === "json" && value ? JSON.parse(value) : value;
  }

  async list({ prefix }) {
    const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name }));
    return { keys, list_complete: true };
  }

  async delete(key) {
    this.values.delete(key);
  }
}

class MemoryDurableContext {
  constructor() {
    this.storage = new MemoryKv();
  }
}

function sign(platformFlag, timestamp, body) {
  return createHash("md5").update(platformFlag + timestamp + body, "utf8").digest("hex").toUpperCase();
}

function queryPayload(events) {
  return {
    success: true,
    code: 10000,
    data: {
      esWaybill: events.map(({ waybill, text, time, courier, receivingAddress }) => ({
        waybillNumber: waybill,
        receivingAddress,
        exteriorRouteList: [{ routeDescription: text, uploadDate: time, deliveryName: courier }],
      })),
    },
  };
}

function scheduledEnv(kv, overrides = {}) {
  return {
    KYE_WATCHLIST: kv,
    KYE_APP_KEY: "key",
    KYE_APP_SECRET: "secret",
    KYE_CUSTOMER_CODE: "customer",
    KYE_PROD_PLATFORM_FLAG: "platform",
    BARK_DEVICE_KEY: "bark-key",
    ...overrides,
  };
}

function activeShipment(waybill, overrides = {}) {
  return {
    waybill,
    status: "active",
    added_at: "2026-09-14T00:00:00.000Z",
    last_status: "other",
    last_event_time: "2026-09-14 08:00:00",
    last_event_text: "旧节点",
    courier_name: null,
    last_event_fingerprint: "old",
    profile: {},
    subscription_status: "subscribed",
    next_subscription_at: null,
    next_poll_at: "2000-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("MD5 implementation matches Node for ASCII and UTF-8", () => {
  for (const value of ["", "abc", "跨越速运", "a".repeat(1000)]) {
    const expected = createHash("md5").update(value, "utf8").digest("hex");
    assert.equal(md5Hex(value), expected);
  }
});

test("mobile app page exposes login feedback and valid browser JavaScript", async () => {
  const response = await handleRequest(new Request("https://example.test/app"), {});
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(html, /id="loginNotice"/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "inline app script should exist");
  assert.doesNotThrow(() => new vm.Script(script));
});

test("health endpoint identifies the deployed notification build", async () => {
  const response = await handleRequest(new Request("https://example.test/health"), {});
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.service, "courier-pulse");
  assert.equal(payload.version, "0.2.0-platform-hardening");
  assert.equal(payload.notification_mode, "all_nodes");
  assert.deepEqual(payload.capabilities, {
    watchlist_storage: "unconfigured",
    rate_limiting: false,
    bark: false,
    telegram: false,
  });
});

test("management APIs return 429 when the optional rate limiter rejects a request", async () => {
  const keys = [];
  const response = await handleRequest(new Request("https://example.test/api/watchlist", {
    headers: { authorization: `Bearer ${APP_TOKEN}`, "cf-connecting-ip": "203.0.113.1" },
  }), {
    APP_ACCESS_TOKEN: APP_TOKEN,
    KYE_WATCHLIST: new MemoryKv(),
    APP_RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } },
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^watchlist:token:[a-f0-9]{32}$/);
  assert.doesNotMatch(keys[0], new RegExp(APP_TOKEN));
});

test("unauthorized rate-limit keys do not change when an attacker rotates guessed tokens", async () => {
  const keys = [];
  const env = {
    APP_ACCESS_TOKEN: APP_TOKEN,
    KYE_WATCHLIST: new MemoryKv(),
    APP_RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: true }; } },
  };
  for (const guess of ["wrong-token-one", "wrong-token-two"]) {
    const response = await handleRequest(new Request("https://example.test/api/watchlist", {
      headers: { authorization: `Bearer ${guess}`, "cf-connecting-ip": "203.0.113.1" },
    }), env);
    assert.equal(response.status, 401);
  }
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0], /^watchlist:unauthorized:[a-f0-9]{32}$/);
});

test("Durable Object migrates KV and serializes concurrent watchlist mutations", async () => {
  const mirror = new MemoryKv();
  await mirror.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: {
      KY4000000000001: activeShipment("KY4000000000001"),
      KY4000000000002: activeShipment("KY4000000000002"),
    },
    pending_notifications: [],
  }));
  const coordinator = new WatchlistCoordinator(new MemoryDurableContext(), {
    APP_ACCESS_TOKEN: APP_TOKEN,
    KYE_WATCHLIST: mirror,
  });
  const stop = (waybill) => coordinator.fetch(new Request("https://example.test/api/watchlist/remove", {
    method: "POST",
    headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ waybills: [waybill] }),
  }));
  const responses = await Promise.all([stop("KY4000000000001"), stop("KY4000000000002")]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);

  const read = await coordinator.fetch(new Request("https://example.test/api/watchlist", {
    headers: { authorization: `Bearer ${APP_TOKEN}` },
  }));
  const state = await read.json();
  assert.equal(state.shipments.KY4000000000001.status, "stopped");
  assert.equal(state.shipments.KY4000000000002.status, "stopped");
  const mirrored = await mirror.get("watchlist:v1", "json");
  assert.equal(mirrored.shipments.KY4000000000001.status, "stopped");
  assert.equal(mirrored.shipments.KY4000000000002.status, "stopped");
});

test("Durable Object remains authoritative when the optional KV mirror write fails", async () => {
  const mirror = new MemoryKv();
  await mirror.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: { KY4000000000001: activeShipment("KY4000000000001") },
    pending_notifications: [],
  }));
  mirror.put = async () => { throw new Error("KV write rate limited"); };
  const coordinator = new WatchlistCoordinator(new MemoryDurableContext(), {
    APP_ACCESS_TOKEN: APP_TOKEN,
    KYE_WATCHLIST: mirror,
  });
  const response = await coordinator.fetch(new Request("https://example.test/api/watchlist/remove", {
    method: "POST",
    headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ waybills: ["KY4000000000001"] }),
  }));
  assert.equal(response.status, 200);
  const read = await coordinator.fetch(new Request("https://example.test/api/watchlist", {
    headers: { authorization: `Bearer ${APP_TOKEN}` },
  }));
  assert.equal((await read.json()).shipments.KY4000000000001.status, "stopped");
});

test("watchlist API migrates legacy full addresses to destination region names", async () => {
  const kv = new MemoryKv();
  await kv.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: {
      KY4000000000001: activeShipment("KY4000000000001", {
        profile: {
          mailingAddress: "北京市朝阳区某路 1 号",
          receivingAddress: "上海市奉贤区某路 2 号",
          expected_delivery_time: "2026-09-23 18:00:00",
        },
      }),
    },
  }));
  const response = await handleRequest(new Request("https://example.test/api/watchlist", {
    headers: { authorization: `Bearer ${APP_TOKEN}` },
  }), { APP_ACCESS_TOKEN: APP_TOKEN, KYE_WATCHLIST: kv });
  const payload = await response.json();
  const profile = payload.shipments.KY4000000000001.profile;
  assert.equal(response.status, 200);
  assert.equal(profile.mailingAddress, undefined);
  assert.equal(profile.receivingAddress, undefined);
  assert.deepEqual(profile.destination_regions, ["上海", "奉贤"]);
  assert.equal(profile.expected_delivery_time, "2026-09-23 18:00:00");
  const stored = await kv.get("watchlist:v1", "json");
  assert.equal(stored.shipments.KY4000000000001.profile.mailingAddress, undefined);
  assert.equal(stored.shipments.KY4000000000001.profile.receivingAddress, undefined);
});

test("a newly placed waybill with no route can enter the cloud watchlist", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/security/token")) {
      return new Response(JSON.stringify({ data: { token: "test-token" } }), { status: 200 });
    }
    if (options.headers?.method === "open.api.openCommon.queryRoute") {
      return new Response(JSON.stringify({ success: false, code: 10010, msg: "未查询到路由和运单信息" }), { status: 200 });
    }
    if (options.headers?.method === "open.api.openCommon.subscribeRoute") {
      return new Response(JSON.stringify({ success: false, code: 10010, msg: "运单暂不可订阅" }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const kv = new MemoryKv();
    const env = {
      APP_ACCESS_TOKEN: APP_TOKEN,
      KYE_WATCHLIST: kv,
      KYE_APP_KEY: "key",
      KYE_APP_SECRET: "secret",
      KYE_CUSTOMER_CODE: "customer",
      KYE_PROD_PLATFORM_FLAG: "platform",
    };
    const response = await handleRequest(new Request("https://example.test/api/watchlist/add", {
      method: "POST",
      headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ waybills: ["KY4000000000001"] }),
    }), env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.match(payload.warning, /暂未接受节点订阅/);
    assert.equal(payload.shipments.KY4000000000001.status, "active");
    assert.equal(payload.shipments.KY4000000000001.last_status, "pending");
    assert.equal(payload.shipments.KY4000000000001.subscription_status, "pending");
    assert.ok(payload.shipments.KY4000000000001.next_subscription_at);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduled polling batches due shipments and alerts for every new node in test mode", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  await kv.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: {
      KY4000000000001: activeShipment("KY4000000000001"),
      KY4000000000002: activeShipment("KY4000000000002"),
    },
  }));
  let queryCalls = 0;
  const barkBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/security/token")) return new Response(JSON.stringify({ data: { token: "test-token" } }));
    if (options.headers?.method === "open.api.openCommon.queryRoute") {
      queryCalls += 1;
      const business = JSON.parse(options.body);
      assert.deepEqual(business.waybillNumbers, ["KY4000000000001", "KY4000000000002"]);
      return new Response(JSON.stringify(queryPayload([
        { waybill: "KY4000000000001", text: "快件离开上海，发往广州", time: "2026-09-14 10:00:00" },
        { waybill: "KY4000000000002", text: "快件运输中", time: "2026-09-14 10:05:00" },
      ])));
    }
    if (String(url).endsWith("/push")) {
      barkBodies.push(JSON.parse(options.body));
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await scheduledMonitor(scheduledEnv(kv));
    assert.equal(queryCalls, 1, "all due waybills should share one queryRoute call");
    assert.equal(barkBodies.length, 1);
    assert.match(barkBodies[0].body, /KY4000000000001/);
    assert.match(barkBodies[0].body, /KY4000000000002/);
    const state = await kv.get("watchlist:v1", "json");
    assert.equal(state.shipments.KY4000000000001.last_event_time, "2026-09-14 10:00:00");
    assert.equal(state.shipments.KY4000000000002.last_event_time, "2026-09-14 10:05:00");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduled polling keeps duplicate nodes silent", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  await kv.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: {
      KY4000000000001: activeShipment("KY4000000000001", {
        last_event_time: "2026-09-14 10:00:00",
        last_event_text: "快件运输中",
      }),
    },
  }));
  let barkCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/security/token")) return new Response(JSON.stringify({ data: { token: "test-token" } }));
    if (options.headers?.method === "open.api.openCommon.queryRoute") {
      return new Response(JSON.stringify(queryPayload([
        { waybill: "KY4000000000001", text: "快件运输中", time: "2026-09-14 10:00:00" },
      ])));
    }
    if (String(url).endsWith("/push")) { barkCalls += 1; return new Response("{}"); }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await scheduledMonitor(scheduledEnv(kv));
    assert.equal(barkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduled polling persists state and retries a failed notification without re-querying KYE", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  await kv.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: { KY4000000000001: activeShipment("KY4000000000001") },
  }));
  let queryCalls = 0;
  let barkCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/security/token")) return new Response(JSON.stringify({ data: { token: "test-token" } }));
    if (options.headers?.method === "open.api.openCommon.queryRoute") {
      queryCalls += 1;
      return new Response(JSON.stringify(queryPayload([
        { waybill: "KY4000000000001", text: "快件运输中", time: "2026-09-14 10:00:00" },
      ])));
    }
    if (String(url).endsWith("/push")) {
      barkCalls += 1;
      return new Response("{}", { status: barkCalls === 1 ? 500 : 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await scheduledMonitor(scheduledEnv(kv));
    let state = await kv.get("watchlist:v1", "json");
    assert.equal(state.shipments.KY4000000000001.last_event_text, "快件运输中");
    assert.equal(state.pending_notifications.length, 1);

    await scheduledMonitor(scheduledEnv(kv));
    state = await kv.get("watchlist:v1", "json");
    assert.equal(queryCalls, 1, "notification retry must not repeat queryRoute");
    assert.equal(barkCalls, 2);
    assert.deepEqual(state.pending_notifications, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("KYE calls refresh an invalid cached token and retry once", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  await kv.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: { KY4000000000001: activeShipment("KY4000000000001") },
  }));
  let tokenFetches = 0;
  let queryCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/security/token")) {
      tokenFetches += 1;
      return new Response(JSON.stringify({ data: { token: `refresh-token-${tokenFetches}` } }));
    }
    if (options.headers?.method === "open.api.openCommon.queryRoute") {
      queryCalls += 1;
      if (options.headers.token === "refresh-token-1") {
        return new Response(JSON.stringify({ success: false, code: 6001, msg: "token invalid" }));
      }
      assert.equal(options.headers.token, "refresh-token-2");
      return new Response(JSON.stringify(queryPayload([
        { waybill: "KY4000000000001", text: "快件运输中", time: "2026-09-14 10:00:00" },
      ])));
    }
    if (String(url).endsWith("/push")) return new Response("{}");
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await scheduledMonitor(scheduledEnv(kv, {
      KYE_APP_KEY: "token-refresh-key",
      KYE_APP_SECRET: "token-refresh-secret",
    }));
    const state = await kv.get("watchlist:v1", "json");
    assert.equal(tokenFetches, 2);
    assert.equal(queryCalls, 2);
    assert.equal(state.shipments.KY4000000000001.last_event_text, "快件运输中");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("notification retries stop after the bounded attempt limit", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  await kv.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: {},
    pending_notifications: [{
      mailno: "KY4000000000001",
      desc: "快件运输中",
      time: "2026-09-14 10:00:00",
      notification_attempts: 31,
      notification_enqueued_at: new Date().toISOString(),
    }],
  }));
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/push")) return new Response("{}", { status: 500 });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await scheduledMonitor(scheduledEnv(kv));
    const state = await kv.get("watchlist:v1", "json");
    assert.deepEqual(state.pending_notifications, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a route inside the receiving region switches to a 15-minute polling interval", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  await kv.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: {
      KY4000000000001: activeShipment("KY4000000000001"),
      KY4000000000002: activeShipment("KY4000000000002"),
      KY4000000000003: activeShipment("KY4000000000003"),
    },
  }));
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/security/token")) return new Response(JSON.stringify({ data: { token: "test-token" } }));
    if (options.headers?.method === "open.api.openCommon.queryRoute") {
      return new Response(JSON.stringify(queryPayload([
        {
          waybill: "KY4000000000001",
          text: "快件已装车，即将离开【奉贤浦星分拨站】",
          time: "2026-09-16 07:15:47",
          receivingAddress: "上海市奉贤区浦星公路",
        },
        {
          waybill: "KY4000000000002",
          text: "快件已离开【苏州虎丘分拨】",
          time: "2026-09-16 07:15:47",
          receivingAddress: "北京市朝阳区望京路",
        },
        {
          waybill: "KY4000000000003",
          text: "快件离开苏州，发往上海奉贤分拨站",
          time: "2026-09-16 07:15:47",
          receivingAddress: "上海市奉贤区浦星公路",
        },
      ])));
    }
    if (String(url).endsWith("/push")) return new Response("{}");
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const before = Date.now();
    await scheduledMonitor(scheduledEnv(kv));
    const state = await kv.get("watchlist:v1", "json");
    const destinationDelay = new Date(state.shipments.KY4000000000001.next_poll_at).getTime() - before;
    const transitDelay = new Date(state.shipments.KY4000000000002.next_poll_at).getTime() - before;
    const destinationMentionDelay = new Date(state.shipments.KY4000000000003.next_poll_at).getTime() - before;
    assert.ok(destinationDelay >= 14 * 60000 && destinationDelay <= 16 * 60000);
    assert.ok(transitDelay >= 239 * 60000 && transitDelay <= 241 * 60000);
    assert.ok(destinationMentionDelay >= 239 * 60000 && destinationMentionDelay <= 241 * 60000);
    assert.deepEqual(state.shipments.KY4000000000001.profile.destination_regions, ["上海", "奉贤"]);
    assert.equal(state.shipments.KY4000000000001.profile.receivingAddress, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("critical mode only alerts pickup assignment and courier dispatch", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  await kv.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: {
      KY4000000000001: activeShipment("KY4000000000001"),
      KY4000000000002: activeShipment("KY4000000000002"),
      KY4000000000003: activeShipment("KY4000000000003"),
    },
  }));
  const barkBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/security/token")) return new Response(JSON.stringify({ data: { token: "test-token" } }));
    if (options.headers?.method === "open.api.openCommon.queryRoute") {
      return new Response(JSON.stringify(queryPayload([
        { waybill: "KY4000000000001", text: "快件离开上海，发往广州", time: "2026-09-14 10:00:00" },
        { waybill: "KY4000000000002", text: "取货调度，已分配揽收员", time: "2026-09-14 10:01:00" },
        { waybill: "KY4000000000003", text: "快件正在派送中", time: "2026-09-14 10:02:00", courier: "李四" },
      ])));
    }
    if (String(url).endsWith("/push")) { barkBodies.push(JSON.parse(options.body)); return new Response("{}"); }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await scheduledMonitor(scheduledEnv(kv, { NOTIFICATION_MODE: "critical_only" }));
    assert.equal(barkBodies.length, 1);
    assert.doesNotMatch(barkBodies[0].body, /KY4000000000001/);
    assert.match(barkBodies[0].body, /KY4000000000002/);
    assert.match(barkBodies[0].body, /KY4000000000003/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("critical mode alerts when a courier name is added to the same dispatch node", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  await kv.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: {
      KY4000000000001: activeShipment("KY4000000000001", {
        last_status: "out_for_delivery",
        last_event_time: "2026-09-14 10:00:00",
        last_event_text: "快件正在派送中",
        courier_name: null,
      }),
    },
  }));
  let barkCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/security/token")) return new Response(JSON.stringify({ data: { token: "test-token" } }));
    if (options.headers?.method === "open.api.openCommon.queryRoute") {
      return new Response(JSON.stringify(queryPayload([
        { waybill: "KY4000000000001", text: "快件正在派送中", time: "2026-09-14 10:00:00", courier: "李四" },
      ])));
    }
    if (String(url).endsWith("/push")) { barkCalls += 1; return new Response("{}"); }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await scheduledMonitor(scheduledEnv(kv, { NOTIFICATION_MODE: "critical_only" }));
    assert.equal(barkCalls, 1);
    const state = await kv.get("watchlist:v1", "json");
    assert.equal(state.shipments.KY4000000000001.courier_name, "李四");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a delivered node alerts in test mode and automatically completes monitoring", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  await kv.put("watchlist:v1", JSON.stringify({ version: 1, shipments: { KY4000000000001: activeShipment("KY4000000000001") } }));
  let barkCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/security/token")) return new Response(JSON.stringify({ data: { token: "test-token" } }));
    if (options.headers?.method === "open.api.openCommon.queryRoute") {
      return new Response(JSON.stringify(queryPayload([
        { waybill: "KY4000000000001", text: "签收完毕", time: "2026-09-14 18:00:00" },
      ])));
    }
    if (String(url).endsWith("/push")) { barkCalls += 1; return new Response("{}"); }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await scheduledMonitor(scheduledEnv(kv));
    const state = await kv.get("watchlist:v1", "json");
    assert.equal(barkCalls, 1);
    assert.equal(state.shipments.KY4000000000001.status, "completed");
    assert.equal(state.shipments.KY4000000000001.next_poll_at, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown shipments poll every 15 minutes then back off after two hours", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  const recent = new Date(Date.now() - 30 * 60000).toISOString();
  const old = new Date(Date.now() - 3 * 60 * 60000).toISOString();
  await kv.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: {
      KY4000000000001: activeShipment("KY4000000000001", { last_status: "pending", pending_since: recent }),
      KY4000000000002: activeShipment("KY4000000000002", { last_status: "pending", pending_since: old }),
    },
  }));
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/security/token")) return new Response(JSON.stringify({ data: { token: "test-token" } }));
    if (options.headers?.method === "open.api.openCommon.queryRoute") {
      return new Response(JSON.stringify({ success: false, code: 10010, msg: "未查询到路由和运单信息" }));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const before = Date.now();
    await scheduledMonitor(scheduledEnv(kv));
    const state = await kv.get("watchlist:v1", "json");
    const recentDelay = new Date(state.shipments.KY4000000000001.next_poll_at).getTime() - before;
    const oldDelay = new Date(state.shipments.KY4000000000002.next_poll_at).getTime() - before;
    assert.ok(recentDelay >= 14 * 60000 && recentDelay <= 16 * 60000);
    assert.ok(oldDelay >= 59 * 60000 && oldDelay <= 61 * 60000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unrecognized route node uses the conservative 60-minute fallback", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  await kv.put("watchlist:v1", JSON.stringify({ version: 1, shipments: { KY4000000000001: activeShipment("KY4000000000001") } }));
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/security/token")) return new Response(JSON.stringify({ data: { token: "test-token" } }));
    if (options.headers?.method === "open.api.openCommon.queryRoute") {
      return new Response(JSON.stringify(queryPayload([
        { waybill: "KY4000000000001", text: "快件操作完成", time: "2026-09-14 10:00:00" },
      ])));
    }
    if (String(url).endsWith("/push")) return new Response("{}");
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const before = Date.now();
    await scheduledMonitor(scheduledEnv(kv));
    const state = await kv.get("watchlist:v1", "json");
    const delay = new Date(state.shipments.KY4000000000001.next_poll_at).getTime() - before;
    assert.ok(delay >= 59 * 60000 && delay <= 61 * 60000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subscription retries stop after the configured attempt limit", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  await kv.put("watchlist:v1", JSON.stringify({
    version: 1,
    shipments: {
      KY4000000000001: activeShipment("KY4000000000001", {
        subscription_status: "pending",
        subscription_attempts: 7,
        next_subscription_at: "2000-01-01T00:00:00.000Z",
        next_poll_at: "2999-01-01T00:00:00.000Z",
      }),
    },
  }));
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/security/token")) return new Response(JSON.stringify({ data: { token: "test-token" } }));
    if (options.headers?.method === "open.api.openCommon.subscribeRoute") {
      return new Response(JSON.stringify({ success: false, code: 10010, msg: "permission denied" }));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await scheduledMonitor(scheduledEnv(kv));
    const state = await kv.get("watchlist:v1", "json");
    const shipment = state.shipments.KY4000000000001;
    assert.equal(shipment.subscription_attempts, 8);
    assert.equal(shipment.subscription_status, "failed");
    assert.equal(shipment.next_subscription_at, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delivered callback completes cloud monitoring even when critical mode suppresses its alert", async () => {
  const originalFetch = globalThis.fetch;
  const eventsKv = new MemoryKv();
  const watchlistKv = new MemoryKv();
  await watchlistKv.put("watchlist:v1", JSON.stringify({ version: 1, shipments: { KY4000000000001: activeShipment("KY4000000000001") } }));
  let barkCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/push")) { barkCalls += 1; return new Response("{}"); }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const timestamp = currentTimestamp();
  const body = JSON.stringify([{ mailno: "KY4000000000001", step: "签收", desc: "签收完毕", time: "2026-09-14 18:00:00" }]);
  const tasks = [];
  try {
    const response = await handleRequest(new Request("https://example.test/kye/callback/prod", {
      method: "POST",
      headers: { "x-kye-timestamp": timestamp, "x-kye-sign": sign("SZYG", timestamp, body) },
      body,
    }), {
      KYE_EVENTS: eventsKv,
      KYE_WATCHLIST: watchlistKv,
      KYE_PROD_PLATFORM_FLAG: "SZYG",
      BARK_DEVICE_KEY: "bark-key",
      NOTIFICATION_MODE: "critical_only",
    }, { waitUntil(task) { tasks.push(task); } });
    await Promise.all(tasks);
    const state = await watchlistKv.get("watchlist:v1", "json");
    assert.equal(response.status, 200);
    assert.equal(barkCalls, 0);
    assert.equal(state.shipments.KY4000000000001.status, "completed");
    assert.equal(state.shipments.KY4000000000001.callback_verified, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("KYE signature requires a 13-digit timestamp and exact raw body", () => {
  const timestamp = currentTimestamp();
  const body = '[{"mailno":"KY4000000000001"}]';
  const signature = sign("SZYG", timestamp, body);
  assert.equal(verifyKyeSignature("SZYG", timestamp, body, signature), true);
  assert.equal(verifyKyeSignature("SZYG", timestamp, `${body} `, signature), false);
  assert.equal(verifyKyeSignature("SZYG", "bad", body, signature), false);
  const staleTimestamp = String(Date.now() - 6 * 60 * 1000);
  assert.equal(verifyKyeSignature("SZYG", staleTimestamp, body, sign("SZYG", staleTimestamp, body)), false);
});

test("valid callback is stored, deduplicated, listed, and acknowledged", async () => {
  const kv = new MemoryKv();
  const env = {
    KYE_EVENTS: kv,
    KYE_SANDBOX_PLATFORM_FLAG: "SZYG",
    KYE_PROD_PLATFORM_FLAG: "SZYG",
    MONITOR_TOKEN,
  };
  const timestamp = currentTimestamp();
  const body = JSON.stringify([
    {
      mailno: "KY4000000000001",
      node: 12,
      step: "派送中",
      desc: "快件正在派送",
      time: "2026-09-11 12:00:00",
      deliveryName: "李四",
      deliveryPhone: "13800000000",
    },
  ]);
  const callbackRequest = () =>
    new Request("https://example.test/kye/callback/sandbox", {
      method: "POST",
      headers: {
        "x-kye-timestamp": timestamp,
        "x-kye-sign": sign("SZYG", timestamp, body),
      },
      body,
    });

  assert.equal((await handleRequest(callbackRequest(), env)).status, 200);
  assert.equal((await handleRequest(callbackRequest(), env)).status, 200);
  assert.equal(kv.values.size, 1);

  const listResponse = await handleRequest(
    new Request("https://example.test/events", {
      headers: { authorization: `Bearer ${MONITOR_TOKEN}` },
    }),
    env,
  );
  const listed = await listResponse.json();
  assert.equal(listed.events.length, 1);
  assert.equal(listed.events[0].payload[0].deliveryName, "李四");
  assert.equal(listed.events[0].payload[0].deliveryPhone, undefined);

  const ackResponse = await handleRequest(
    new Request("https://example.test/events/ack", {
      method: "POST",
      headers: {
        authorization: `Bearer ${MONITOR_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ keys: [listed.events[0].key] }),
    }),
    env,
  );
  assert.equal(ackResponse.status, 200);
  assert.equal(kv.values.size, 0);
});

test("callback deduplicates each shipment event across different batch compositions", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  const env = {
    KYE_EVENTS: kv,
    KYE_PROD_PLATFORM_FLAG: "SZYG",
    BARK_DEVICE_KEY: "bark-key",
    NOTIFICATION_MODE: "critical_only",
  };
  const first = [{ mailno: "KY4000000000001", step: "取货调度", desc: "已分配揽收员", time: "2026-09-11 10:00:00" }];
  const second = [...first, { mailno: "KY4000000000002", step: "运输", desc: "快件运输中", time: "2026-09-11 10:01:00" }];
  const barkBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/push")) { barkBodies.push(JSON.parse(options.body)); return new Response("{}"); }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  async function deliver(payload) {
    const body = JSON.stringify(payload);
    const timestamp = currentTimestamp();
    const tasks = [];
    const response = await handleRequest(new Request("https://example.test/kye/callback/prod", {
      method: "POST",
      headers: { "x-kye-timestamp": timestamp, "x-kye-sign": sign("SZYG", timestamp, body) },
      body,
    }), env, { waitUntil(task) { tasks.push(task); } });
    await Promise.all(tasks);
    return response;
  }
  try {
    assert.equal((await deliver(first)).status, 200);
    assert.equal((await deliver(second)).status, 200);
    assert.equal(barkBodies.length, 1, "the unchanged pickup event must not be notified twice");
    assert.equal(kv.values.size, 2, "each unique shipment event is stored once");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callback checks and stores batch events concurrently before acknowledging", async () => {
  class TrackingKv extends MemoryKv {
    activeReads = 0;
    activeWrites = 0;
    reads = 0;
    maxReads = 0;
    maxWrites = 0;

    async get(key, type) {
      this.reads += 1;
      this.activeReads += 1;
      this.maxReads = Math.max(this.maxReads, this.activeReads);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const value = await super.get(key, type);
      this.activeReads -= 1;
      return value;
    }

    async put(key, value) {
      this.activeWrites += 1;
      this.maxWrites = Math.max(this.maxWrites, this.activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 2));
      await super.put(key, value);
      this.activeWrites -= 1;
    }
  }

  const kv = new TrackingKv();
  const payload = Array.from({ length: 20 }, (_, index) => ({
    mailno: `KY${4000000000000 + index}`,
    step: "运输",
    desc: "快件运输中",
    time: `2026-09-11 10:${String(index).padStart(2, "0")}:00`,
  }));
  const body = JSON.stringify([...payload, payload[0]]);
  const timestamp = currentTimestamp();
  const response = await handleRequest(new Request("https://example.test/kye/callback/prod", {
    method: "POST",
    headers: { "x-kye-timestamp": timestamp, "x-kye-sign": sign("SZYG", timestamp, body) },
    body,
  }), { KYE_EVENTS: kv, KYE_PROD_PLATFORM_FLAG: "SZYG" });
  assert.equal(response.status, 200);
  assert.equal(kv.values.size, 20);
  assert.equal(kv.reads, 20, "duplicate entries in one callback should be collapsed before KV reads");
  assert.ok(kv.maxReads > 1, "event existence checks should not be serialized");
  assert.ok(kv.maxWrites > 1, "event writes should not be serialized");
});

test("callback queues a failed notification even when the shipment is not in the watchlist", async () => {
  const originalFetch = globalThis.fetch;
  const eventsKv = new MemoryKv();
  const watchlistKv = new MemoryKv();
  const payload = [{ mailno: "KY4000000000001", step: "运输", desc: "快件运输中", time: "2026-09-11 10:00:00" }];
  const body = JSON.stringify(payload);
  const timestamp = currentTimestamp();
  const tasks = [];
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/push")) return new Response("{}", { status: 500 });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const response = await handleRequest(new Request("https://example.test/kye/callback/prod", {
      method: "POST",
      headers: { "x-kye-timestamp": timestamp, "x-kye-sign": sign("SZYG", timestamp, body) },
      body,
    }), {
      KYE_EVENTS: eventsKv,
      KYE_WATCHLIST: watchlistKv,
      KYE_PROD_PLATFORM_FLAG: "SZYG",
      BARK_DEVICE_KEY: "bark-key",
    }, { waitUntil(task) { tasks.push(task); } });
    await Promise.all(tasks);
    const state = await watchlistKv.get("watchlist:v1", "json");
    assert.equal(response.status, 200);
    assert.equal(state.pending_notifications.length, 1);
    assert.equal(state.pending_notifications[0].mailno, "KY4000000000001");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callback accepts an alphanumeric KYE waybill suffix", async () => {
  const kv = new MemoryKv();
  const body = JSON.stringify([{ mailno: "KY40000000AB12", step: "运输", desc: "快件运输中", time: "2026-09-11 10:00:00" }]);
  const timestamp = currentTimestamp();
  const response = await handleRequest(new Request("https://example.test/kye/callback/prod", {
    method: "POST",
    headers: { "x-kye-timestamp": timestamp, "x-kye-sign": sign("SZYG", timestamp, body) },
    body,
  }), { KYE_EVENTS: kv, KYE_PROD_PLATFORM_FLAG: "SZYG" });
  assert.equal(response.status, 200);
  assert.equal(kv.values.size, 1);
});

test("watchlist API rejects configured access tokens shorter than 32 characters", async () => {
  const response = await handleRequest(new Request("https://example.test/api/watchlist", {
    headers: { authorization: "Bearer short" },
  }), { APP_ACCESS_TOKEN: "short", KYE_WATCHLIST: new MemoryKv() });
  assert.equal(response.status, 401);
});

test("event API rejects configured monitor tokens shorter than 32 characters", async () => {
  const response = await handleRequest(new Request("https://example.test/events", {
    headers: { authorization: "Bearer short" },
  }), { MONITOR_TOKEN: "short", KYE_EVENTS: new MemoryKv() });
  assert.equal(response.status, 401);
});

test("callback rejects bad signatures and event API rejects missing authorization", async () => {
  const env = {
    KYE_EVENTS: new MemoryKv(),
    KYE_SANDBOX_PLATFORM_FLAG: "SZYG",
    MONITOR_TOKEN,
  };
  const callback = await handleRequest(
    new Request("https://example.test/kye/callback/sandbox", {
      method: "POST",
      headers: { "x-kye-timestamp": currentTimestamp(), "x-kye-sign": "0".repeat(32) },
      body: '[{"mailno":"KY4000000000001"}]',
    }),
    env,
  );
  assert.equal(callback.status, 401);
  assert.equal((await handleRequest(new Request("https://example.test/events"), env)).status, 401);
  assert.equal(env.KYE_EVENTS.values.size, 0);
});
