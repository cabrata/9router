import { AsyncLocalStorage } from "node:async_hooks";
import { getAdapter } from "../driver.js";

// Per-request context set by withRequestLog(); saveRequestUsage() adds tokens into it.
// On globalThis because Next bundles each route separately (module copies may differ).
export const requestLogStore = globalThis.__9rRequestLogStore ||= new AsyncLocalStorage();
const keyRequestState = globalThis.__9rKeyRequestState ||= new Map();
const MINUTE_MS = 60_000;
// ponytail: unbounded in-memory FIFO queue per key; upgrade to bounded/timeout queue if users ask.

function localState(apiKeyId, now = Date.now()) {
  let state = keyRequestState.get(apiKeyId);
  if (!state) keyRequestState.set(apiKeyId, state = { activeRequests: 0, requestTimes: [], queue: [] });
  state.requestTimes = state.requestTimes.filter((time) => time > now - MINUTE_MS);
  return state;
}

function grantSlot(state, now) {
  if (now) state.requestTimes.push(now);
  state.activeRequests++;
  let released = false;
  return {
    ok: true,
    release() {
      if (released) return;
      released = true;
      state.activeRequests = Math.max(0, state.activeRequests - 1);
      // Wake queued waiters while a slot is free, in arrival order.
      while (state.queue.length > 0) {
        const waiter = state.queue[0];
        if (waiter.signal?.aborted) { state.queue.shift(); continue; }
        const waiterLimit = waiter.key.limitConcurrent || 0;
        if (waiterLimit > 0 && state.activeRequests >= waiterLimit) break;
        state.queue.shift();
        waiter.resolve(grantSlot(state, Date.now()));
      }
    },
  };
}

export function acquireApiKeyRequest(apiKey, signal, now = Date.now()) {
  const state = localState(apiKey.id, now);
  // RPM is checked immediately so queued requests don't silently starve the quota.
  if (apiKey.rpm > 0 && state.requestTimes.length >= apiKey.rpm) {
    return Promise.resolve({ ok: false, reason: "rpm", retryAfter: Math.max(1, Math.ceil((state.requestTimes[0] + MINUTE_MS - now) / 1000)) });
  }
  const limit = apiKey.limitConcurrent || 0;
  if (limit === 0 || (state.queue.length === 0 && state.activeRequests < limit)) {
    return Promise.resolve(grantSlot(state, now));
  }
  // FIFO wait until a slot frees up. Don't reserve RPM here on purpose: the
  // quota is counted on grant instead, so waiting in the queue doesn't burn it.
  return new Promise((resolve) => {
    const waiter = { key: apiKey, resolve, signal };
    const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
    const onAbort = () => {
      const idx = state.queue.indexOf(waiter);
      if (idx >= 0) state.queue.splice(idx, 1);
      resolve({ ok: false, reason: "aborted" });
    };
    waiter.resolve = (lease) => { cleanup(); resolve(lease); };
    if (signal?.aborted) { resolve({ ok: false, reason: "aborted" }); return; }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    state.queue.push(waiter);
  });
}

export async function getApiKeyMonitoring(apiKeyId, now = Date.now()) {
  const state = localState(apiKeyId, now);
  const db = await getAdapter();
  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const row = db.get(
    `SELECT SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS requestsLast24h,
            SUM(CASE WHEN timestamp >= ? AND status >= 400 THEN 1 ELSE 0 END) AS errorsLast24h,
            MAX(timestamp) AS lastRequestAt
       FROM requestLogs WHERE apiKeyId = ?`,
    [since, since, apiKeyId]
  );
  return {
    activeRequests: state.activeRequests,
    queuedRequests: state.queue.length,
    requestsLastMinute: state.requestTimes.length,
    requestsLast24h: Number(row?.requestsLast24h) || 0,
    errorsLast24h: Number(row?.errorsLast24h) || 0,
    lastRequestAt: row?.lastRequestAt || null,
  };
}

// ponytail: fixed row cap, pruned every PRUNE_EVERY inserts. Make it a setting if users ask.
const MAX_ROWS = parseInt(process.env.REQUEST_LOGS_MAX || "5000", 10);
const PRUNE_EVERY = 100;
let insertsSincePrune = 0;

const COLS = [
  "timestamp", "apiKeyId", "apiKeyName", "apiKeyMasked", "ip", "method", "path", "endpointKind",
  "model", "provider", "resolvedModel", "status", "stream", "promptTokens", "completionTokens",
  "durationMs", "ttftMs", "tps", "userAgent", "error",
];

export async function insertRequestLog(entry) {
  try {
    const db = await getAdapter();
    const values = COLS.map((c) => {
      const v = entry[c];
      if (typeof v === "boolean") return v ? 1 : 0;
      return v === undefined ? null : v;
    });
    db.run(`INSERT INTO requestLogs(${COLS.join(", ")}) VALUES(${COLS.map(() => "?").join(", ")})`, values);
    if (++insertsSincePrune >= PRUNE_EVERY) {
      insertsSincePrune = 0;
      db.run(`DELETE FROM requestLogs WHERE id <= (SELECT id FROM requestLogs ORDER BY id DESC LIMIT 1 OFFSET ?)`, [MAX_ROWS]);
    }
  } catch (e) {
    console.error("[requestLogs] insert failed:", e?.message || e);
  }
}

// Compat provider IDs look like "openai-compatible-chat-<uuid>"; show the user-chosen
// node name instead. Falls back to the prefix, then a short id.
function providerLabel(provider, nodes, aliases) {
  if (!provider) return provider;
  if (nodes[provider]) return nodes[provider];
  const target = aliases[provider];
  if (typeof target === "string" && target.includes("/")) return target.slice(0, target.indexOf("/"));
  const m = /^(openai|anthropic)-compatible-(?:responses-)?[0-9a-f]{8}-/i.exec(provider);
  return m ? `${m[1]}-compatible-${provider.slice(-4)}` : provider;
}

export async function getRequestLogs(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];
  if (filter.apiKeyId) {
    if (filter.apiKeyId === "none") conds.push("apiKeyId IS NULL");
    else { conds.push("apiKeyId = ?"); params.push(filter.apiKeyId); }
  }
  if (filter.status === "ok") conds.push("status < 400");
  else if (filter.status === "error") conds.push("status >= 400");
  if (filter.endpointKind) { conds.push("endpointKind = ?"); params.push(filter.endpointKind); }
  if (filter.search) {
    const q = `%${filter.search}%`;
    conds.push("(model LIKE ? OR resolvedModel LIKE ? OR ip LIKE ? OR path LIKE ? OR provider LIKE ?)");
    params.push(q, q, q, q, q);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const total = db.get(`SELECT COUNT(*) as c FROM requestLogs ${where}`, params)?.c || 0;
  const page = Math.max(1, filter.page || 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize || 50));
  const logs = db.all(
    `SELECT * FROM requestLogs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  if (logs.some((r) => r.provider && !r.provider.includes("/") && /-compatible-/.test(r.provider))) {
    const { getProviderNodes } = await import("./nodesRepo.js");
    const { getModelAliases } = await import("./aliasRepo.js");
    const [nodeList, aliases] = await Promise.all([getProviderNodes().catch(() => []), getModelAliases().catch(() => ({}))]);
    const nodes = Object.fromEntries(nodeList.map((n) => [n.id, n.name]));
    for (const r of logs) r.provider = providerLabel(r.provider, nodes, aliases);
  }
  for (const r of logs) r.stream = r.stream === 1;
  return { logs, pagination: { page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) } };
}

export async function clearRequestLogs() {
  const db = await getAdapter();
  db.run(`DELETE FROM requestLogs`);
}

// Called from saveRequestUsage(); attributes token usage to the current request log.
export function recordUsageForRequestLog(entry) {
  const ctx = requestLogStore.getStore();
  if (!ctx) return;
  const t = entry.tokens || {};
  const p = t.prompt_tokens || t.input_tokens || 0;
  const c = t.completion_tokens || t.output_tokens || 0;
  const sig = `${entry.timestamp}|${entry.provider}|${entry.model}|${p}|${c}`;
  if (ctx._seen.has(sig)) return;
  ctx._seen.add(sig);
  ctx.promptTokens += p;
  ctx.completionTokens += c;
  ctx.provider = entry.provider || ctx.provider;
  ctx.resolvedModel = entry.model || ctx.resolvedModel;
}
