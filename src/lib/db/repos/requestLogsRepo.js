import { AsyncLocalStorage } from "node:async_hooks";
import { getAdapter } from "../driver.js";

// Per-request context set by withRequestLog(); saveRequestUsage() adds tokens into it.
// On globalThis because Next bundles each route separately (module copies may differ).
export const requestLogStore = globalThis.__9rRequestLogStore ||= new AsyncLocalStorage();
const keyRequestState = globalThis.__9rKeyRequestState ||= new Map();
const MINUTE_MS = 60_000;

function localState(apiKeyId, now = Date.now()) {
  let state = keyRequestState.get(apiKeyId);
  if (!state) keyRequestState.set(apiKeyId, state = { activeRequests: 0, requestTimes: [] });
  state.requestTimes = state.requestTimes.filter((time) => time > now - MINUTE_MS);
  return state;
}

export function beginApiKeyRequest(apiKey, now = Date.now()) {
  const state = localState(apiKey.id, now);
  if (apiKey.rpm > 0 && state.requestTimes.length >= apiKey.rpm) {
    return { ok: false, reason: "rpm", retryAfter: Math.max(1, Math.ceil((state.requestTimes[0] + MINUTE_MS - now) / 1000)) };
  }
  if (apiKey.limitConcurrent > 0 && state.activeRequests >= apiKey.limitConcurrent) {
    return { ok: false, reason: "concurrency" };
  }
  state.requestTimes.push(now);
  state.activeRequests++;
  let released = false;
  return {
    ok: true,
    release() {
      if (released) return;
      released = true;
      state.activeRequests = Math.max(0, state.activeRequests - 1);
    },
  };
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
  ).map((r) => ({ ...r, stream: r.stream === 1 }));
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
