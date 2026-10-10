const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const APP_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const WORKER_VERSION = "0.2.0-platform-hardening";
const WATCHLIST_KEY = "watchlist:v1";
const WATCHLIST_COORDINATOR_NAME = "primary";
const WAYBILL_PATTERN = /^(?:KY|KYE)[A-Z0-9]{8,20}$/i;
const APP_TOKEN_MIN_LENGTH = 32;
const CALLBACK_MAX_SKEW_MS = 5 * 60 * 1000;
const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_PENDING_NOTIFICATIONS = 100;
const MAX_NOTIFICATION_ATTEMPTS = 32;
const NOTIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SUBSCRIPTION_ATTEMPTS = 8;
const TOKEN_INVALID_CODES = new Set(["6000", "6001", "6002", "6003"]);
const EARLY_WORDS = ["已揽收", "已揽件", "揽件完毕", "揽收完毕", "揽收成功", "收件完成", "取件完成", "已取件", "始发"];
const PICKUP_ASSIGNED_WORDS = ["取货调度", "分配揽收员", "安排揽收", "等待揽收", "预约取件", "安排取件"];
const TRANSIT_WORDS = ["运输中", "运输途中", "发往", "离开", "转运"];
const DESTINATION_WORDS = ["到达目的", "目的网点", "目的站点", "派送网点", "派件网点", "派送站点", "派件站点"];
const DISPATCH_WORDS = ["派送中", "派件中", "正在派送", "正在派件", "开始派送", "安排派送", "安排派件"];
const DELIVERED_WORDS = ["已签收", "签收完毕", "签收成功", "妥投"];

const APP_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><title>Courier Pulse · 快递追踪</title>
<style>
:root{color-scheme:light;--blue:#2563eb;--ink:#172033;--muted:#64748b;--line:#dbe5f2;--bg:#f4f8ff;--green:#16845b;--red:#c2413a}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#eaf2ff,#fff 460px);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}.shell{width:min(720px,calc(100% - 24px));margin:auto;padding:20px 0 48px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}.brand{font-size:20px;font-weight:750}.online{font-size:12px;color:var(--green)}h1{margin:0 0 8px;color:#1e40af;font-size:34px;line-height:1.15;letter-spacing:-.04em}.lead{margin:0;color:var(--muted)}.panel,.card{background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:0 10px 30px #1e40af12}.panel{padding:16px;margin-top:22px}label{display:block;font-size:14px;font-weight:650}input{width:100%;margin-top:7px;padding:13px 14px;border:1px solid #b8c9e1;border-radius:11px;font:inherit;outline:0}input:focus{border-color:var(--blue);box-shadow:0 0 0 3px #2563eb22}button{min-height:46px;border:0;border-radius:11px;font:inherit;font-weight:650;cursor:pointer}.primary{width:100%;margin-top:10px;background:var(--blue);color:#fff}.ghost{padding:0 13px;background:#eff6ff;color:#1e40af}.danger{color:var(--red);background:transparent;min-height:36px;font-size:13px}.notice{min-height:25px;margin-top:10px;color:var(--muted);font-size:14px}.error{color:var(--red)}h2{font-size:18px;margin:28px 0 10px}.grid{display:grid;gap:12px}.card{padding:15px}.row{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.waybill{font-weight:750;letter-spacing:.03em}.badge{padding:3px 8px;border-radius:999px;background:#dbeafe;color:#1e40af;font-size:12px;white-space:nowrap}.done{background:#dcfce7;color:#166534}.meta{margin-top:9px;color:var(--muted);font-size:13px}.meta b{color:var(--ink)}.card-actions{display:flex;justify-content:flex-end;margin-top:8px}.empty{padding:22px;text-align:center;color:var(--muted);border:1px dashed #b8c9e1;border-radius:14px}@media(min-width:560px){.add-row{display:flex;gap:10px;align-items:end}.add-row .primary{width:150px;margin:0}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style></head><body><main class="shell"><div class="top"><div class="brand">Courier Pulse</div><div class="online">● 云端在线</div></div><section><h1>手机上管理运单</h1><p class="lead">添加、停止和查看运单，不依赖你的电脑开机。</p></section><section id="login" class="panel"><label>访问码<input id="token" type="password" autocomplete="current-password" placeholder="输入 Cloudflare 访问码"></label><button id="loginBtn" class="primary">进入清单</button><div id="loginNotice" class="notice" role="status"></div></section><section id="app" hidden><form id="add" class="panel"><div class="add-row"><label style="flex:1">添加运单号<input id="waybills" autocomplete="off" placeholder="例如 KY4000000000001"></label><button class="primary" type="submit">开始追踪</button></div><div id="notice" class="notice" role="status"></div></form><h2>正在追踪</h2><div id="active" class="grid"></div><h2>已完成 / 已停止</h2><div id="done" class="grid"></div><button id="logout" class="ghost" style="margin-top:22px">退出本机登录</button></section></main><script>
const $=s=>document.querySelector(s), key="kye_app_token";let token=localStorage.getItem(key)||"";function notice(t,e){const n=$("#notice");if(n){n.textContent=t||"";n.className=e?"notice error":"notice"}}function loginNotice(t,e){const n=$("#loginNotice");if(n){n.textContent=t||"";n.className=e?"notice error":"notice"}}function headers(){return {"Content-Type":"application/json",Authorization:"Bearer "+token}}function esc(v){return String(v??"").replace(/[&<>"']/g,c=>c==="&"?"&amp;":c==="<"?"&lt;":c===">"?"&gt;":c==='"'?"&quot;":"&#39;")}function parse(v){return [...new Set(v.trim().toUpperCase().replaceAll("，"," ").split(/[\\s,]+/).filter(Boolean))]}function card(x,done){const d=document.createElement("article");d.className="card";const status=done?(x.status==="completed"?"已签收":"已停止"):(x.last_status==="out_for_delivery"?"派送中":"监控中");d.innerHTML='<div class="row"><div class="waybill">'+esc(x.waybill)+'</div><span class="badge '+(x.status==="completed"?"done":"")+'">'+status+'</span></div><div class="meta"><b>最近节点：</b>'+esc(x.last_event_text||"暂无节点记录")+'</div><div class="meta"><b>快递员：</b>'+esc(x.courier_name||"暂无")+'</div><div class="meta"><b>预计送达：</b>'+esc(x.profile&&x.profile.expected_delivery_time||"暂无")+'</div>'+(done?"":'<div class="card-actions"><button class="danger" data-waybill="'+esc(x.waybill)+'">停止追踪</button></div>');if(!done)d.querySelector(".danger").onclick=()=>remove(x.waybill);return d}async function api(path,opts){const r=await fetch(path,Object.assign({headers:headers(),cache:"no-store"},opts||{}));const d=await r.json().catch(()=>({error:"服务器返回无效"}));if(r.status===401){localStorage.removeItem(key);token="";showLogin()}if(!r.ok)throw Error(d.error||"请求失败");return d}function showLogin(){$("#login").hidden=false;$("#app").hidden=true}async function load(){const d=await api("/api/watchlist");const all=Object.values(d.shipments||{}),a=all.filter(x=>x.status==="active"),done=all.filter(x=>x.status!=="active");$("#active").replaceChildren(...(a.length?a.map(x=>card(x,false)):[Object.assign(document.createElement("div"),{className:"empty",textContent:"还没有正在追踪的运单"})]));$("#done").replaceChildren(...(done.length?done.map(x=>card(x,true)):[Object.assign(document.createElement("div"),{className:"empty",textContent:"签收完成的运单会出现在这里"})]))}async function remove(w){if(!confirm("确定停止追踪 "+w+" 吗？"))return;try{await api("/api/watchlist/remove",{method:"POST",body:JSON.stringify({waybills:[w]})});notice("已停止追踪");await load()}catch(e){notice(e.message,true)}}$("#loginBtn").onclick=async()=>{const b=$("#loginBtn");token=$("#token").value.trim();if(!token){loginNotice("请先输入访问码",true);return}b.disabled=true;b.textContent="正在验证…";loginNotice("正在连接云端…");localStorage.setItem(key,token);try{await load();loginNotice("");$("#login").hidden=true;$("#app").hidden=false}catch(e){loginNotice(e.message||"登录失败",true);localStorage.removeItem(key);token=""}finally{b.disabled=false;b.textContent="进入清单"}};$("#add").onsubmit=async e=>{e.preventDefault();const w=parse($("#waybills").value);if(!w.length)return;const b=e.target.querySelector("button");b.disabled=true;notice("正在查询并订阅，请稍候…");try{const d=await api("/api/watchlist/add",{method:"POST",body:JSON.stringify({waybills:w})});$("#waybills").value="";notice(d.warning?"已加入云端追踪；"+d.warning:"已加入云端追踪");await load()}catch(err){notice(err.message,true)}finally{b.disabled=false}};$("#logout").onclick=()=>{localStorage.removeItem(key);token="";showLogin()};if(token){$("#token").value=token;loginNotice("正在恢复登录…");load().then(()=>{loginNotice("");$("#login").hidden=true;$("#app").hidden=false}).catch(e=>{showLogin();loginNotice(e.message||"登录失败",true)})}
</script></body></html>`;

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_CONSTANTS = Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0,
);

function rotateLeft(value, amount) {
  return (value << amount) | (value >>> (32 - amount));
}

function wordHexLittleEndian(word) {
  let result = "";
  for (let offset = 0; offset < 32; offset += 8) {
    result += ((word >>> offset) & 0xff).toString(16).padStart(2, "0");
  }
  return result;
}

export function md5Hex(text) {
  const input = new TextEncoder().encode(text);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;

  const bitLength = BigInt(input.length) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number(bitLength & 0xffffffffn), true);
  view.setUint32(paddedLength - 4, Number((bitLength >> 32n) & 0xffffffffn), true);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;

  for (let block = 0; block < paddedLength; block += 64) {
    const words = Array.from({ length: 16 }, (_, index) => view.getUint32(block + index * 4, true));
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;

    for (let index = 0; index < 64; index += 1) {
      let mixed;
      let wordIndex;
      if (index < 16) {
        mixed = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        mixed = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        mixed = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }

      const previousD = d;
      d = c;
      c = b;
      const sum = (a + mixed + MD5_CONSTANTS[index] + words[wordIndex]) | 0;
      b = (b + rotateLeft(sum, MD5_SHIFTS[index])) | 0;
      a = previousD;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
  }

  return [h0, h1, h2, h3].map(wordHexLittleEndian).join("");
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function verifyKyeSignature(platformFlag, timestamp, rawBody, suppliedSignature, now = Date.now()) {
  if (!/^\d{13}$/.test(timestamp ?? "") || !/^[a-fA-F0-9]{32}$/.test(suppliedSignature ?? "")) {
    return false;
  }
  if (Math.abs(now - Number(timestamp)) > CALLBACK_MAX_SKEW_MS) return false;
  const expected = md5Hex(`${platformFlag}${timestamp}${rawBody}`).toUpperCase();
  return constantTimeEqual(expected, suppliedSignature.toUpperCase());
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function logError(message, error) {
  console.error(JSON.stringify({
    message,
    error: error instanceof Error ? error.message : clean(error),
  }));
}

function authorized(request, env) {
  const token = typeof env.MONITOR_TOKEN === "string" ? env.MONITOR_TOKEN.trim() : "";
  if (token.length < APP_TOKEN_MIN_LENGTH) return false;
  const header = request.headers.get("authorization") ?? "";
  return constantTimeEqual(header, `Bearer ${token}`);
}

function appAuthorized(request, env) {
  const token = typeof env.APP_ACCESS_TOKEN === "string" ? env.APP_ACCESS_TOKEN.trim() : "";
  if (token.length < APP_TOKEN_MIN_LENGTH) return false;
  const header = request.headers.get("authorization") ?? "";
  return constantTimeEqual(header, `Bearer ${token}`);
}

function watchlistStorage(env) {
  return env.WATCHLIST_STORAGE ?? env.KYE_WATCHLIST;
}

function watchlistCoordinator(env) {
  const namespace = env.WATCHLIST_COORDINATOR;
  if (!namespace) return null;
  if (typeof namespace.getByName === "function") return namespace.getByName(WATCHLIST_COORDINATOR_NAME);
  if (typeof namespace.idFromName === "function" && typeof namespace.get === "function") {
    return namespace.get(namespace.idFromName(WATCHLIST_COORDINATOR_NAME));
  }
  throw new Error("watchlist coordinator binding is invalid");
}

async function managementRateLimit(request, env, routeGroup) {
  if (!env.APP_RATE_LIMITER || typeof env.APP_RATE_LIMITER.limit !== "function") return null;
  const authorization = request.headers.get("authorization") ?? "";
  const validToken = routeGroup === "events"
    ? authorized(request, env)
    : routeGroup === "health"
      ? (appAuthorized(request, env) || authorized(request, env))
      : appAuthorized(request, env);
  const actor = validToken
    ? `token:${md5Hex(authorization)}`
    : `unauthorized:${md5Hex(request.headers.get("cf-connecting-ip") || "unknown")}`;
  const { success } = await env.APP_RATE_LIMITER.limit({ key: `${routeGroup}:${actor}` });
  if (success) return null;
  return new Response(JSON.stringify({ ok: false, error: "rate limit exceeded" }), {
    status: 429,
    headers: { ...JSON_HEADERS, "retry-after": "60" },
  });
}

function emptyWatchlist() {
  return { version: 1, shipments: {}, pending_notifications: [] };
}

async function readWatchlist(env) {
  const storage = watchlistStorage(env);
  if (!storage) throw new Error("cloud watchlist is not configured");
  const state = (await storage.get(WATCHLIST_KEY, "json")) ?? emptyWatchlist();
  if (!state || typeof state !== "object" || !state.shipments || typeof state.shipments !== "object") return emptyWatchlist();
  const pendingWasArray = Array.isArray(state.pending_notifications);
  const originalPending = pendingWasArray ? state.pending_notifications : [];
  const notificationCutoff = Date.now() - NOTIFICATION_MAX_AGE_MS;
  state.pending_notifications = originalPending.filter((item) => {
    const attempts = Math.max(0, Number(item?.notification_attempts) || 0);
    const enqueuedAt = Date.parse(item?.notification_enqueued_at ?? "");
    return attempts < MAX_NOTIFICATION_ATTEMPTS && (!Number.isFinite(enqueuedAt) || enqueuedAt >= notificationCutoff);
  }).slice(-MAX_PENDING_NOTIFICATIONS);
  let migrationNeeded = !pendingWasArray
    || state.pending_notifications.length !== originalPending.length;
  const retentionCutoff = Date.now() - HISTORY_RETENTION_MS;
  for (const [waybill, shipment] of Object.entries(state.shipments)) {
    if (shipment && typeof shipment === "object") {
      const safeProfile = sanitizeProfile(shipment.profile);
      if (JSON.stringify(safeProfile) !== JSON.stringify(shipment.profile ?? {})) migrationNeeded = true;
      shipment.profile = safeProfile;
      const finishedAt = Date.parse(shipment.completed_at ?? shipment.stopped_at ?? "");
      if (shipment.status !== "active" && Number.isFinite(finishedAt) && finishedAt < retentionCutoff) {
        delete state.shipments[waybill];
        migrationNeeded = true;
      }
    }
  }
  if (migrationNeeded) await storage.put(WATCHLIST_KEY, JSON.stringify(state));
  return state;
}

async function writeWatchlist(env, state) {
  const storage = watchlistStorage(env);
  if (!storage) throw new Error("cloud watchlist is not configured");
  await storage.put(WATCHLIST_KEY, JSON.stringify(state));
}

function formatKyeTimestamp(date = new Date()) {
  const value = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return value.toISOString().slice(0, 19).replace("T", " ");
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json;charset=UTF-8", ...headers },
    body,
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`KYE returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) throw new Error(`KYE HTTP ${response.status}`);
  return payload;
}

function requiredKyeConfig(env) {
  const values = [env.KYE_APP_KEY, env.KYE_APP_SECRET, env.KYE_CUSTOMER_CODE, env.KYE_PROD_PLATFORM_FLAG];
  if (values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error("cloud KYE production credentials are not configured");
  }
  return {
    appKey: env.KYE_APP_KEY.trim(),
    appSecret: env.KYE_APP_SECRET.trim(),
    customerCode: env.KYE_CUSTOMER_CODE.trim(),
    platformFlag: env.KYE_PROD_PLATFORM_FLAG.trim(),
  };
}

async function kyeToken(env, config) {
  const cacheKey = `${config.appKey}\n${config.appSecret}\n${config.customerCode}\n${config.platformFlag}`;
  if (kyeToken.cache?.key === cacheKey && kyeToken.cache.expiresAt > Date.now()) {
    return kyeToken.cache.token;
  }
  const body = JSON.stringify({ appkey: config.appKey, appsecret: config.appSecret });
  const payload = await postJson("https://open.ky-express.com/security/token", body, { "User-Agent": "courier-pulse/1.0" });
  const data = typeof payload?.data === "string" ? (() => { try { return JSON.parse(payload.data); } catch { return { token: payload.data }; } })() : payload?.data;
  const token = data?.token;
  if (typeof token !== "string" || !token.trim()) throw new Error(`KYE token failed: ${payload?.code ?? "unknown"} ${payload?.msg ?? ""}`);
  const normalized = token.trim();
  const advertisedSeconds = Number(data?.expires_in ?? data?.expiresIn ?? data?.expire ?? 3600);
  const cacheSeconds = Number.isFinite(advertisedSeconds) && advertisedSeconds > 0
    ? (advertisedSeconds > 120 ? Math.min(advertisedSeconds - 60, 3000) : Math.max(10, Math.floor(advertisedSeconds / 2)))
    : 3000;
  kyeToken.cache = { key: cacheKey, token: normalized, expiresAt: Date.now() + cacheSeconds * 1000 };
  return normalized;
}

async function kyeCall(env, method, business, retryToken = true) {
  const config = requiredKyeConfig(env);
  const body = JSON.stringify(business);
  const timestamp = formatKyeTimestamp();
  const token = await kyeToken(env, config);
  const payload = await postJson("https://open.ky-express.com/router/rest", body, {
    appkey: config.appKey,
    token,
    sign: md5Hex(`${config.appSecret}${timestamp}${body}`),
    timestamp,
    method,
    format: "json",
    "User-Agent": "courier-pulse/1.0",
  });
  if (retryToken && TOKEN_INVALID_CODES.has(String(payload?.code ?? ""))) {
    kyeToken.cache = undefined;
    return kyeCall(env, method, business, false);
  }
  return payload;
}

function walk(value, callback) {
  if (Array.isArray(value)) { for (const item of value) walk(item, callback); return; }
  if (value && typeof value === "object") { callback(value); for (const child of Object.values(value)) walk(child, callback); }
}

function clean(value) { return value === null || value === undefined ? "" : String(value).trim(); }

function classifyEvent(waybill, textValue, timeValue, courierValue) {
  const text = clean(textValue);
  const time = clean(timeValue);
  const courier = clean(courierValue);
  const delivered = DELIVERED_WORDS.some((word) => text.includes(word));
  const dispatch = !delivered && DISPATCH_WORDS.some((word) => text.includes(word));
  const destination = DESTINATION_WORDS.some((word) => text.includes(word));
  const transit = TRANSIT_WORDS.some((word) => text.includes(word));
  const early = EARLY_WORDS.some((word) => text.includes(word));
  const pickupAssigned = !early && PICKUP_ASSIGNED_WORDS.some((word) => text.includes(word));
  const status = delivered ? "delivered" : dispatch ? "out_for_delivery" : "other";
  const fingerprint = md5Hex(JSON.stringify({ waybill, time, text, courier }));
  const interval = dispatch || destination ? 15 : transit ? 240 : pickupAssigned ? 30 : early ? 480 : 60;
  return {
    waybill,
    status,
    courier_name: courier || null,
    event_time: time || null,
    event_text: text || null,
    event_fingerprint: fingerprint,
    destination,
    transit,
    early,
    pickup_assigned: pickupAssigned,
    interval,
  };
}

function latestKyeEvent(payload, waybill) {
  let matched;
  walk(payload, (item) => {
    if (!matched && clean(item.waybillNumber).toUpperCase() === waybill) matched = item;
  });
  const candidates = [];
  const routeItems = Array.isArray(matched?.exteriorRouteList) ? matched.exteriorRouteList : Array.isArray(matched?.routeList) ? matched.routeList : [];
  for (const item of routeItems) {
    const route = item.routeDescription ?? item.desc ?? item.context ?? item.description ?? item.routeStep;
    const time = item.uploadDate ?? item.time ?? item.eventTime ?? item.event_time;
    if (route || time || item.state || item.status) candidates.push({ item, text: clean(route), time: clean(time) });
  }
  if (!candidates.length && matched) {
    const route = matched.routeDescription ?? matched.desc ?? matched.context ?? matched.description ?? matched.routeStep;
    const time = matched.uploadDate ?? matched.time ?? matched.eventTime ?? matched.event_time;
    if (route || time || matched.state || matched.status) candidates.push({ item: matched, text: clean(route), time: clean(time) });
  }
  if (!candidates.length) return { text: "", time: "", courier: "", profile: {} };
  candidates.sort((a, b) => a.time.localeCompare(b.time));
  const latest = candidates[candidates.length - 1];
  const courier = clean(latest.item.deliveryName ?? latest.item.courierName ?? latest.item.delivery_name);
  return { text: latest.text, time: latest.time, courier, profile: {} };
}

function classifyKye(payload, waybill) {
  const event = latestKyeEvent(payload, waybill);
  return classifyEvent(waybill, event.text, event.time, event.courier);
}

function regionNamesFromAddress(addressValue) {
  const address = clean(addressValue);
  if (!address) return [];
  const names = new Set();
  const genericNames = new Set(["中国", "城区", "市辖", "辖区"]);
  const pattern = /([\u3400-\u9fff]{2,8}?)(特别行政区|自治区|自治州|省|市|盟|区|县|旗|镇)/g;
  for (const match of address.matchAll(pattern)) {
    const name = clean(match[1]);
    if (name.length >= 2 && !genericNames.has(name)) names.add(name);
    if (match[2] === "区" && name.endsWith("新") && name.length > 2) names.add(name.slice(0, -1));
  }
  return [...names];
}

function destinationRegionNames(profile) {
  const stored = Array.isArray(profile?.destination_regions)
    ? profile.destination_regions.map(clean).filter(Boolean)
    : [];
  return [...new Set([
    ...stored,
    ...regionNamesFromAddress(profile?.receivingAddress ?? profile?.receiving_address),
  ])];
}

function sanitizeProfile(profile) {
  if (!profile || typeof profile !== "object") return {};
  const safe = {};
  for (const key of ["mailingTime", "serviceModeName", "expected_delivery_time"]) {
    if (clean(profile[key])) safe[key] = clean(profile[key]);
  }
  const regions = destinationRegionNames(profile);
  if (regions.length) safe.destination_regions = regions;
  return safe;
}

function applyDestinationRegion(result, profile) {
  if (result.destination || !result.event_text) return result;
  const destination = destinationRegionNames(profile).some((name) => {
    let index = result.event_text.indexOf(name);
    while (index !== -1) {
      const prefix = result.event_text.slice(Math.max(0, index - 20), index);
      const onlyNamesDestination = /(?:发往|前往|运往|开往|驶往|送往|去往)[^，。；;|【】]{0,16}$/.test(prefix);
      if (!onlyNamesDestination) return true;
      index = result.event_text.indexOf(name, index + name.length);
    }
    return false;
  });
  return destination ? { ...result, destination: true, interval: 15 } : result;
}

function classifyPushItem(item) {
  const waybill = clean(item?.mailno).toUpperCase();
  const text = [item?.step, item?.desc ?? item?.eventText ?? item?.status].map(clean).filter(Boolean).join(" | ");
  const time = item?.time ?? item?.eventTime ?? item?.event_time;
  const courier = item?.deliveryName ?? item?.courierName ?? item?.delivery_name;
  return classifyEvent(waybill, text, time, courier);
}

function minimizePushPayload(payload) {
  return payload.map((item) => ({
    mailno: clean(item?.mailno),
    step: clean(item?.step),
    desc: clean(item?.desc ?? item?.eventText ?? item?.status),
    time: clean(item?.time ?? item?.eventTime ?? item?.event_time),
    deliveryName: clean(item?.deliveryName ?? item?.courierName ?? item?.delivery_name),
  }));
}

function notificationMode(env) {
  return clean(env.NOTIFICATION_MODE).toLowerCase() === "critical_only" ? "critical_only" : "all_nodes";
}

function shouldNotifyClassification(env, result) {
  if (!result.event_time && !result.event_text) return false;
  if (notificationMode(env) === "all_nodes") return true;
  return result.pickup_assigned || (result.status === "out_for_delivery" && Boolean(result.courier_name));
}

function sameEvent(shipment, result) {
  if (shipment.last_event_time && result.event_time) {
    if (shipment.last_event_time !== result.event_time) return false;
    return !result.courier_name || shipment.courier_name === result.courier_name;
  }
  return shipment.last_event_text === result.event_text && shipment.courier_name === result.courier_name;
}

function profileForKye(payload, waybill) {
  let matched;
  walk(payload, (item) => { if (!matched && clean(item.waybillNumber).toUpperCase() === waybill) matched = item; });
  if (!matched) return {};
  const profile = {};
  for (const key of ["mailingTime", "serviceModeName"]) if (clean(matched[key])) profile[key] = clean(matched[key]);
  const destinationRegions = regionNamesFromAddress(matched.receivingAddress ?? matched.receiving_address);
  if (destinationRegions.length) profile.destination_regions = destinationRegions;
  for (const key of ["expectedDeliveryTime", "estimatedDeliveryTime", "estimateArrivalTime", "expectedArrivalTime", "planDeliveryTime"]) if (clean(matched[key])) { profile.expected_delivery_time = clean(matched[key]); break; }
  return sanitizeProfile(profile);
}

function tightenInterval(interval, expectedDeliveryTime, now = new Date()) {
  if (!expectedDeliveryTime) return interval;
  const normalized = String(expectedDeliveryTime).trim().replace(" ", "T");
  const parsed = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`);
  if (Number.isNaN(parsed.getTime())) return interval;
  const hoursRemaining = (parsed.getTime() - now.getTime()) / 3600000;
  if (hoursRemaining <= 6) return Math.min(interval, 30);
  if (hoursRemaining <= 24) return Math.min(interval, 120);
  return interval;
}

async function queryKye(env, waybills) {
  return kyeCall(env, "open.api.openCommon.queryRoute", {
    customerCode: requiredKyeConfig(env).customerCode,
    waybillNumbers: waybills,
    platformFlag: requiredKyeConfig(env).platformFlag,
  });
}

function kyeResponseSucceeded(payload) {
  return payload?.success !== false && (payload?.code === undefined || String(payload.code) === "10000");
}

function kyeHasNoRouteYet(payload) {
  const message = clean(payload?.msg ?? payload?.message);
  return message.includes("未查询到路由") || message.includes("暂无路由") || message.includes("无路由信息");
}

function pendingKyeClassification(waybill, profile = {}) {
  const eventText = "等待跨越生成首个路由节点";
  return {
    waybill,
    status: "pending",
    courier_name: null,
    event_time: null,
    event_text: eventText,
    event_fingerprint: md5Hex(JSON.stringify({ waybill, status: "pending", text: eventText })),
    destination: false,
    transit: false,
    early: false,
    pickup_assigned: false,
    interval: 15,
    profile,
  };
}

async function subscribeKye(env, waybills) {
  const config = requiredKyeConfig(env);
  return kyeCall(env, "open.api.openCommon.subscribeRoute", {
    waybillNumber: waybills,
    orderChannel: config.platformFlag,
    type: ["10"],
    customerCode: config.customerCode,
  });
}

function validatePushPayload(payload) {
  return (
    Array.isArray(payload) &&
    payload.length > 0 &&
    payload.length <= 100 &&
    payload.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof item.mailno === "string" &&
        WAYBILL_PATTERN.test(item.mailno.trim()),
    )
  );
}

function escapeTelegramHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function telegramMessage(environment, payload) {
  const lines = [`<b>Courier Pulse · KYE（${escapeTelegramHtml(environment)}）</b>`];
  for (const item of payload) {
    const waybill = escapeTelegramHtml(item.mailno);
    const event = escapeTelegramHtml(item.desc ?? item.eventText ?? item.status ?? "有新的物流事件");
    const time = escapeTelegramHtml(item.time ?? item.eventTime ?? "");
    const courier = escapeTelegramHtml(item.deliveryName ?? item.courierName ?? "");
    lines.push(`\n<b>${waybill}</b>：${event}`);
    if (time) lines.push(`时间：${time}`);
    if (courier) lines.push(`快递员：${courier}`);
  }
  return lines.join("\n").slice(0, 4096);
}

async function sendTelegramUpdate(env, environment, payload) {
  const token = typeof env.TELEGRAM_BOT_TOKEN === "string" ? env.TELEGRAM_BOT_TOKEN.trim() : "";
  const chatId = typeof env.TELEGRAM_CHAT_ID === "string" ? env.TELEGRAM_CHAT_ID.trim() : "";
  if (!token || !chatId) return;

  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: telegramMessage(environment, payload), parse_mode: "HTML" }),
  });
  if (!response.ok) {
    throw new Error(`Telegram notification failed with HTTP ${response.status}`);
  }
}

async function sendBarkUpdate(env, environment, payload) {
  const deviceKey = typeof env.BARK_DEVICE_KEY === "string" ? env.BARK_DEVICE_KEY.trim() : "";
  if (!deviceKey) return;
  const server = typeof env.BARK_SERVER_URL === "string" && env.BARK_SERVER_URL.trim()
    ? env.BARK_SERVER_URL.trim().replace(/\/$/, "")
    : "https://api.day.app";
  const response = await fetch(`${server}/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_key: deviceKey,
      title: "物流更新 · KYE",
      body: telegramMessage(environment, payload).replace(/<[^>]+>/g, ""),
      group: "courier-pulse",
    }),
  });
  if (!response.ok) {
    throw new Error(`Bark notification failed with HTTP ${response.status}`);
  }
}

function notificationFingerprint(item) {
  return item.event_fingerprint || classifyPushItem(item).event_fingerprint;
}

function enqueueNotifications(state, payload, now = new Date()) {
  const unique = new Map();
  for (const item of Array.isArray(state.pending_notifications) ? state.pending_notifications : []) {
    unique.set(notificationFingerprint(item), item);
  }
  for (const item of payload) {
    const key = notificationFingerprint(item);
    const previous = unique.get(key);
    const attempts = Math.max(
      Number(previous?.notification_attempts) || 0,
      Number(item?.notification_attempts) || 0,
    ) + 1;
    unique.set(key, {
      ...item,
      notification_attempts: attempts,
      notification_enqueued_at: previous?.notification_enqueued_at ?? item?.notification_enqueued_at ?? now.toISOString(),
    });
  }
  state.pending_notifications = [...unique.values()]
    .filter((item) => (Number(item.notification_attempts) || 0) < MAX_NOTIFICATION_ATTEMPTS)
    .slice(-MAX_PENDING_NOTIFICATIONS);
}

async function sendNotifications(env, environment, payload) {
  if (!payload.length) return;
  if (env.BARK_DEVICE_KEY) await sendBarkUpdate(env, environment, payload);
  else await sendTelegramUpdate(env, environment, payload);
}

async function markCallbackVerifiedDirect(env, payload, pendingNotifications = []) {
  if (!watchlistStorage(env)) return;
  const state = await readWatchlist(env);
  let changed = false;
  const now = new Date().toISOString();
  for (const item of payload) {
    const waybill = clean(item?.mailno).toUpperCase();
    const shipment = state.shipments[waybill];
    if (!shipment || shipment.status !== "active") continue;
    const result = applyDestinationRegion(classifyPushItem(item), shipment.profile);
    shipment.callback_verified = true;
    shipment.last_callback_at = now;
    shipment.last_callback_event_time = result.event_time;
    shipment.last_callback_event_text = result.event_text;
    const isCurrent = !shipment.last_event_time || !result.event_time || result.event_time >= shipment.last_event_time;
    if (isCurrent) {
      shipment.last_status = result.status;
      shipment.last_event_time = result.event_time;
      shipment.last_event_text = result.event_text;
      shipment.courier_name = result.courier_name;
      shipment.last_event_fingerprint = result.event_fingerprint;
      shipment.pending_since = null;
    }
    if (result.status === "delivered") {
      shipment.status = "completed";
      shipment.completed_at = shipment.completed_at ?? now;
      shipment.next_poll_at = null;
      shipment.next_subscription_at = null;
    } else if (isCurrent) {
      const interval = tightenInterval(result.interval, shipment.profile?.expected_delivery_time, new Date(now));
      shipment.next_poll_at = new Date(new Date(now).getTime() + interval * 60000).toISOString();
    }
    changed = true;
  }
  if (pendingNotifications.length) {
    enqueueNotifications(state, pendingNotifications);
    changed = true;
  }
  if (changed) await writeWatchlist(env, state);
}

async function markCallbackVerified(env, payload, pendingNotifications = []) {
  const coordinator = watchlistCoordinator(env);
  if (!coordinator) return markCallbackVerifiedDirect(env, payload, pendingNotifications);
  const response = await coordinator.fetch(new Request("https://watchlist.internal/internal/callback-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, pendingNotifications }),
  }));
  if (!response.ok) throw new Error(`watchlist coordinator rejected callback state with HTTP ${response.status}`);
}

async function receivePush(request, env, environment, ctx) {
  if (!env.KYE_EVENTS) {
    return jsonResponse({ code: "1", msg: "storage unavailable" }, 503);
  }
  const platformFlag =
    environment === "sandbox" ? env.KYE_SANDBOX_PLATFORM_FLAG : env.KYE_PROD_PLATFORM_FLAG;
  if (!platformFlag) {
    return jsonResponse({ code: "1", msg: "callback not configured" }, 503);
  }

  const timestamp = request.headers.get("x-kye-timestamp") ?? "";
  const signature = request.headers.get("x-kye-sign") ?? "";
  const rawBody = await request.text();
  if (!verifyKyeSignature(platformFlag, timestamp, rawBody, signature)) {
    return jsonResponse({ code: "1", msg: "invalid signature" }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ code: "1", msg: "invalid json" }, 400);
  }
  if (!validatePushPayload(payload)) {
    return jsonResponse({ code: "1", msg: "invalid payload" }, 400);
  }

  const safePayload = minimizePushPayload(payload);
  const candidateMap = new Map(safePayload.map((item) => {
    const eventFingerprint = classifyPushItem(item).event_fingerprint;
    const key = `push:${environment}:${eventFingerprint}`;
    return [key, { item, key }];
  }));
  const candidates = [...candidateMap.values()];
  const existing = await Promise.all(candidates.map(({ key }) => env.KYE_EVENTS.get(key)));
  const fresh = candidates.filter((_, index) => !existing[index]);
  const receivedAt = new Date().toISOString();
  await Promise.all(fresh.map(({ item, key }) => env.KYE_EVENTS.put(
    key,
    JSON.stringify({ key, environment, receivedAt, payload: [item] }),
    { expirationTtl: 60 * 60 * 24 * 14 },
  )));
  const newPayload = fresh.map(({ item }) => item);
  if (newPayload.length && ctx?.waitUntil) {
    ctx.waitUntil((async () => {
      const notifyPayload = newPayload.filter((item) => shouldNotifyClassification(env, classifyPushItem(item)));
      let pendingNotifications = [];
      try {
        await sendNotifications(env, environment, notifyPayload);
      } catch (error) {
        pendingNotifications = notifyPayload;
        logError("push notification failed", error);
      }
      await markCallbackVerified(env, newPayload, pendingNotifications);
    })().catch((error) => logError("callback processing failed", error)));
  }
  return jsonResponse({ code: "0", msg: "success" });
}

async function listEvents(request, env) {
  if (!authorized(request, env)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!env.KYE_EVENTS) {
    return jsonResponse({ error: "storage unavailable" }, 503);
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || undefined;
  const listing = await env.KYE_EVENTS.list({ prefix: "push:", limit: 100, cursor });
  const events = (
    await Promise.all(listing.keys.map((entry) => env.KYE_EVENTS.get(entry.name, "json")))
  ).filter(Boolean);
  return jsonResponse({ events, cursor: listing.list_complete ? null : listing.cursor });
}

async function acknowledgeEvents(request, env) {
  if (!authorized(request, env)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!env.KYE_EVENTS) {
    return jsonResponse({ error: "storage unavailable" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid json" }, 400);
  }
  const keys = body?.keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 100) {
    return jsonResponse({ error: "keys must contain 1 to 100 entries" }, 400);
  }
  const validKeys = keys.filter((key) => typeof key === "string" && key.startsWith("push:"));
  if (validKeys.length !== keys.length) {
    return jsonResponse({ error: "invalid event key" }, 400);
  }
  await Promise.all(validKeys.map((key) => env.KYE_EVENTS.delete(key)));
  return jsonResponse({ acknowledged: validKeys.length });
}

function appError(message, status = 400) { return jsonResponse({ ok: false, error: message }, status); }

async function appWatchlist(request, env) {
  if (!appAuthorized(request, env)) return appError("unauthorized", 401);
  try { return jsonResponse(await readWatchlist(env)); } catch (error) { return appError(error.message, 503); }
}

async function appAdd(request, env) {
  if (!appAuthorized(request, env)) return appError("unauthorized", 401);
  let body;
  try { body = await request.json(); } catch { return appError("invalid json"); }
  const waybills = [...new Set(Array.isArray(body?.waybills) ? body.waybills.map((value) => String(value).trim().toUpperCase()) : [])];
  if (!waybills.length || waybills.length > 20 || waybills.some((waybill) => !WAYBILL_PATTERN.test(waybill))) return appError("请输入 1 至 20 个有效的 KY/KYE 运单号");
  try {
    const query = await queryKye(env, waybills);
    const waitingForFirstRoute = !kyeResponseSucceeded(query) && kyeHasNoRouteYet(query);
    if (!kyeResponseSucceeded(query) && !waitingForFirstRoute) return appError(`跨越查询失败：${query?.msg ?? query?.code ?? "unknown"}`, 502);
    const classifications = waybills.map((waybill) => {
      const profile = waitingForFirstRoute ? {} : profileForKye(query, waybill);
      const classified = waitingForFirstRoute ? null : applyDestinationRegion(classifyKye(query, waybill), profile);
      const item = !classified?.event_text && !classified?.event_time
        ? pendingKyeClassification(waybill, profile)
        : classified;
      item.profile = profile;
      item.interval = tightenInterval(item.interval, item.profile.expected_delivery_time);
      return item;
    });
    const subscribable = classifications.filter((item) => item.status !== "delivered").map((item) => item.waybill);
    let subscriptionStatus = subscribable.length ? "subscribed" : "not_required";
    let subscriptionWarning = null;
    if (subscribable.length) {
      try {
        const subscription = await subscribeKye(env, subscribable);
        if (!kyeResponseSucceeded(subscription)) {
          subscriptionStatus = "pending";
          subscriptionWarning = `跨越暂未接受节点订阅：${subscription?.msg ?? subscription?.code ?? "unknown"}`;
        }
      } catch (error) {
        subscriptionStatus = "pending";
        subscriptionWarning = `节点订阅稍后重试：${error.message}`;
      }
    }
    const state = await readWatchlist(env);
    for (const item of classifications) {
      const now = new Date();
      const existing = state.shipments[item.waybill] ?? {};
      state.shipments[item.waybill] = {
        ...existing,
        waybill: item.waybill,
        status: item.status === "delivered" ? "completed" : "active",
        added_at: existing.added_at ?? now.toISOString(),
        completed_at: item.status === "delivered" ? (existing.completed_at ?? now.toISOString()) : null,
        last_status: item.status,
        last_event_time: item.event_time,
        last_event_text: item.event_text,
        courier_name: item.courier_name,
        last_event_fingerprint: item.event_fingerprint,
        pending_since: item.status === "pending" ? (existing.pending_since ?? now.toISOString()) : null,
        profile: item.profile,
        subscription_status: item.status === "delivered" ? "not_required" : subscriptionStatus,
        subscription_attempts: item.status === "delivered" || subscriptionStatus === "subscribed" ? 0 : 1,
        subscription_error: item.status === "delivered" ? null : subscriptionWarning,
        next_subscription_at: item.status === "delivered" || subscriptionStatus === "subscribed" ? null : new Date(now.getTime() + 15 * 60000).toISOString(),
        callback_verified: existing.callback_verified === true,
        last_callback_at: existing.last_callback_at ?? null,
        next_poll_at: item.status === "delivered" ? null : new Date(now.getTime() + item.interval * 60000).toISOString(),
      };
    }
    await writeWatchlist(env, state);
    return jsonResponse({ ok: true, added: waybills, subscribed: subscriptionStatus === "subscribed" ? subscribable : [], warning: subscriptionWarning, shipments: state.shipments });
  } catch (error) { return appError(error.message, 502); }
}

async function appRemove(request, env) {
  if (!appAuthorized(request, env)) return appError("unauthorized", 401);
  let body;
  try { body = await request.json(); } catch { return appError("invalid json"); }
  const waybills = [...new Set(Array.isArray(body?.waybills) ? body.waybills.map((value) => String(value).trim().toUpperCase()) : [])];
  if (!waybills.length || waybills.some((waybill) => !WAYBILL_PATTERN.test(waybill))) return appError("运单号格式不正确");
  try {
    const state = await readWatchlist(env);
    const now = new Date().toISOString();
    for (const waybill of waybills) if (state.shipments[waybill]?.status === "active") { state.shipments[waybill].status = "stopped"; state.shipments[waybill].completed_at = now; state.shipments[waybill].next_poll_at = null; }
    await writeWatchlist(env, state);
    return jsonResponse({ ok: true, stopped: waybills });
  } catch (error) { return appError(error.message, 503); }
}

function due(value, now) { return !value || new Date(value).getTime() <= now.getTime(); }

function recordSubscriptionFailure(shipment, message, now) {
  const attempts = Math.max(0, Number(shipment.subscription_attempts) || 0) + 1;
  shipment.subscription_attempts = attempts;
  shipment.subscription_error = message;
  if (attempts >= MAX_SUBSCRIPTION_ATTEMPTS) {
    shipment.subscription_status = "failed";
    shipment.next_subscription_at = null;
    return;
  }
  shipment.subscription_status = "pending";
  const delayMinutes = Math.min(15 * (2 ** (attempts - 1)), 24 * 60);
  shipment.next_subscription_at = new Date(now.getTime() + delayMinutes * 60000).toISOString();
}

function pendingPollInterval(shipment, now) {
  const started = new Date(shipment.pending_since ?? shipment.added_at ?? now).getTime();
  return Number.isFinite(started) && now.getTime() - started >= 2 * 60 * 60000 ? 60 : 15;
}

async function scheduledMonitorDirect(env) {
  const state = await readWatchlist(env);
  const now = new Date();
  const activeShipments = Object.values(state.shipments).filter((item) => item.status === "active");
  const subscriptionRetries = activeShipments.filter((item) => item.subscription_status === "pending" && due(item.next_subscription_at, now)).slice(0, 20);
  const dueWaybills = activeShipments.filter((item) => due(item.next_poll_at, now)).map((item) => item.waybill).slice(0, 20);
  const notifications = [...state.pending_notifications];
  if (!subscriptionRetries.length && !dueWaybills.length && !notifications.length) return;
  if (subscriptionRetries.length) {
    try {
      const subscription = await subscribeKye(env, subscriptionRetries.map((item) => item.waybill));
      if (kyeResponseSucceeded(subscription)) {
        for (const shipment of subscriptionRetries) {
          shipment.subscription_status = "subscribed";
          shipment.subscription_attempts = 0;
          shipment.subscription_error = null;
          shipment.next_subscription_at = null;
        }
      } else {
        const message = clean(subscription?.msg ?? subscription?.code ?? "unknown");
        for (const shipment of subscriptionRetries) {
          recordSubscriptionFailure(shipment, message, now);
        }
      }
    } catch (error) {
      for (const shipment of subscriptionRetries) {
        recordSubscriptionFailure(shipment, error.message, now);
      }
    }
  }
  if (dueWaybills.length) {
    let query = null;
    try {
      query = await queryKye(env, dueWaybills);
    } catch (error) {
      for (const waybill of dueWaybills) {
        const shipment = state.shipments[waybill];
        shipment.last_error = error.message;
        shipment.next_poll_at = new Date(now.getTime() + 60 * 60000).toISOString();
      }
      logError("KYE batch query failed", error);
    }
    if (query && !kyeResponseSucceeded(query)) {
      const noRoute = kyeHasNoRouteYet(query);
      const message = clean(query?.msg ?? query?.code ?? "unknown");
      for (const waybill of dueWaybills) {
        const shipment = state.shipments[waybill];
        if (noRoute) {
          shipment.last_status = "pending";
          shipment.pending_since = shipment.pending_since ?? now.toISOString();
          shipment.last_event_text = shipment.last_event_text || "等待跨越生成首个路由节点";
          shipment.last_error = null;
          shipment.next_poll_at = new Date(now.getTime() + pendingPollInterval(shipment, now) * 60000).toISOString();
        } else {
          shipment.last_error = message;
          shipment.next_poll_at = new Date(now.getTime() + 60 * 60000).toISOString();
        }
      }
      if (!noRoute) logError("KYE batch query rejected", message);
    }
    if (query && kyeResponseSucceeded(query)) {
      for (const waybill of dueWaybills) {
        const shipment = state.shipments[waybill];
        const queriedProfile = profileForKye(query, waybill);
        let result = classifyKye(query, waybill);
        if (!result.event_text && !result.event_time) {
          shipment.last_status = "pending";
          shipment.pending_since = shipment.pending_since ?? now.toISOString();
          shipment.last_error = null;
          shipment.next_poll_at = new Date(now.getTime() + pendingPollInterval(shipment, now) * 60000).toISOString();
          continue;
        }
        shipment.profile = sanitizeProfile({ ...(shipment.profile ?? {}), ...queriedProfile });
        result = applyDestinationRegion(result, shipment.profile);
        const changed = !sameEvent(shipment, result);
        Object.assign(shipment, { last_status: result.status, last_event_time: result.event_time, last_event_text: result.event_text, courier_name: result.courier_name, last_event_fingerprint: result.event_fingerprint, last_error: null, pending_since: null });
        if (result.status === "delivered") {
          shipment.status = "completed";
          shipment.completed_at = shipment.completed_at ?? now.toISOString();
          shipment.next_poll_at = null;
          shipment.next_subscription_at = null;
        } else {
          const interval = tightenInterval(result.interval, shipment.profile.expected_delivery_time, now);
          shipment.next_poll_at = new Date(now.getTime() + interval * 60000).toISOString();
        }
        if (changed && shouldNotifyClassification(env, result)) {
          notifications.push({ mailno: waybill, desc: result.event_text, time: result.event_time, deliveryName: result.courier_name, event_fingerprint: result.event_fingerprint });
        }
      }
    }
  }
  if (notifications.length) {
    try {
      await sendNotifications(env, "主动查询", notifications);
      state.pending_notifications = [];
    } catch (error) {
      enqueueNotifications(state, notifications);
      logError("scheduled notification failed", error);
    }
  }
  await writeWatchlist(env, state);
}

export async function scheduledMonitor(env) {
  const coordinator = watchlistCoordinator(env);
  if (!coordinator) return scheduledMonitorDirect(env);
  const response = await coordinator.fetch(new Request("https://watchlist.internal/internal/scheduled", { method: "POST" }));
  if (!response.ok) throw new Error(`watchlist coordinator rejected scheduled run with HTTP ${response.status}`);
}

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app")) return new Response(APP_HTML, { headers: APP_HEADERS });
  if (request.method === "GET" && url.pathname === "/health") {
    const body = {
      ok: true,
      service: "courier-pulse",
      version: WORKER_VERSION,
      notification_mode: notificationMode(env),
    };
    // An unauthenticated liveness probe stays free; a credentialed one is metered so that
    // /health cannot be used as an unlimited oracle for guessing the management tokens.
    if (request.headers.get("authorization")) {
      const limited = await managementRateLimit(request, env, "health");
      if (limited) return limited;
      if (appAuthorized(request, env) || authorized(request, env)) {
        body.capabilities = {
          watchlist_storage: env.WATCHLIST_COORDINATOR ? "durable_object" : (env.KYE_WATCHLIST ? "kv" : "unconfigured"),
          rate_limiting: Boolean(env.APP_RATE_LIMITER),
          bark: Boolean(env.BARK_DEVICE_KEY),
          telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        };
      }
    }
    return jsonResponse(body);
  }
  if (request.method === "POST" && url.pathname === "/kye/callback/sandbox") {
    return receivePush(request, env, "sandbox", ctx);
  }
  if (request.method === "POST" && url.pathname === "/kye/callback/prod") {
    return receivePush(request, env, "prod", ctx);
  }
  if (request.method === "GET" && url.pathname === "/events") {
    const limited = await managementRateLimit(request, env, "events");
    if (limited) return limited;
    return listEvents(request, env);
  }
  if (request.method === "POST" && url.pathname === "/events/ack") {
    const limited = await managementRateLimit(request, env, "events");
    if (limited) return limited;
    return acknowledgeEvents(request, env);
  }
  if (
    (request.method === "GET" && url.pathname === "/api/watchlist")
    || (request.method === "POST" && (url.pathname === "/api/watchlist/add" || url.pathname === "/api/watchlist/remove"))
  ) {
    const limited = await managementRateLimit(request, env, "watchlist");
    if (limited) return limited;
    const coordinator = watchlistCoordinator(env);
    if (coordinator) return coordinator.fetch(request);
    if (request.method === "GET") return appWatchlist(request, env);
    if (url.pathname.endsWith("/add")) return appAdd(request, env);
    return appRemove(request, env);
  }
  return jsonResponse({ error: "not found" }, 404);
}

class DurableWatchlistStorage {
  constructor(storage, mirror) {
    this.storage = storage;
    this.mirror = mirror;
  }

  async migrate() {
    const current = await this.storage.get(WATCHLIST_KEY);
    if (current !== undefined && current !== null) return;
    const legacy = this.mirror ? await this.mirror.get(WATCHLIST_KEY) : null;
    await this.storage.put(WATCHLIST_KEY, legacy ?? JSON.stringify(emptyWatchlist()));
  }

  async get(key, type) {
    const value = await this.storage.get(key);
    if ((type === "json") && typeof value === "string") return JSON.parse(value);
    return value ?? null;
  }

  async put(key, value) {
    await this.storage.put(key, value);
    if (this.mirror) {
      try {
        await this.mirror.put(key, value);
      } catch (error) {
        logError("watchlist KV mirror failed", error);
      }
    }
  }
}

export class WatchlistCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = new DurableWatchlistStorage(ctx.storage, env.KYE_WATCHLIST);
    this.operationTail = Promise.resolve();
  }

  fetch(request) {
    const operation = this.operationTail.then(async () => {
      await this.storage.migrate();
      const runtimeEnv = { ...this.env, WATCHLIST_COORDINATOR: undefined, WATCHLIST_STORAGE: this.storage };
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/watchlist") return appWatchlist(request, runtimeEnv);
      if (request.method === "POST" && url.pathname === "/api/watchlist/add") return appAdd(request, runtimeEnv);
      if (request.method === "POST" && url.pathname === "/api/watchlist/remove") return appRemove(request, runtimeEnv);
      if (request.method === "POST" && url.pathname === "/internal/scheduled") {
        await scheduledMonitorDirect(runtimeEnv);
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/internal/callback-state") {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: "invalid json" }, 400); }
        if (!Array.isArray(body?.payload) || !Array.isArray(body?.pendingNotifications)) {
          return jsonResponse({ error: "invalid callback state" }, 400);
        }
        await markCallbackVerifiedDirect(runtimeEnv, body.payload, body.pendingNotifications);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    this.operationTail = operation.catch(() => undefined);
    return operation;
  }
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(scheduledMonitor(env).catch((error) => logError("scheduled monitor failed", error)));
  },
};
