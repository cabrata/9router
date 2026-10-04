import { requestLogStore, insertRequestLog } from "@/lib/db/repos/requestLogsRepo.js";
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getClientIp } from "@/lib/auth/loginLimiter";
import { errorResponse } from "open-sse/utils/error.js";

export { ENDPOINT_KINDS } from "@/shared/constants/config";

function extractKey(request) {
  const h = request.headers;
  const auth = h.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return h.get("x-api-key") || h.get("x-goog-api-key") || new URL(request.url).searchParams.get("key") || null;
}

export async function getRequestApiKey(request) {
  return getApiKeyByKey(extractKey(request)).catch(() => null);
}

export function maskKey(k) {
  if (!k) return null;
  return k.length <= 10 ? `${k.slice(0, 2)}…` : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

function clientIp(request) {
  const ip = getClientIp(request);
  if (ip !== "unknown") return ip;
  // Display-only fallback (bare `next dev` has no peer stamp). Not used for auth.
  const h = request.headers;
  return h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || "unknown";
}

async function peekModel(request) {
  const url = new URL(request.url);
  const gem = url.pathname.match(/\/models\/(.+?):(?:stream)?[gG]enerateContent/);
  if (gem) return decodeURIComponent(gem[1]);
  if (request.method !== "POST") return null;
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("multipart/form-data")) return (await request.clone().formData()).get("model") || null;
    const body = await request.clone().json();
    return typeof body?.model === "string" ? body.model : null;
  } catch {
    return null;
  }
}

// "cx/*" matches any model of provider alias cx; "*" matches all; otherwise exact
// (Claude Code's "[1m]" context marker is ignored).
export function isModelAllowed(model, allowed) {
  if (!allowed?.length) return true;
  if (!model) return false;
  const m = model.replace(/\[[^\]]*\]$/, "");
  return allowed.some((a) => a === "*" || a === m || (a.endsWith("/*") && m.startsWith(a.slice(0, -1))));
}

export function isEndpointAllowed(kind, allowed) {
  return !allowed?.length || allowed.includes(kind);
}

export function computeTps(completionTokens, durationMs, ttftMs, stream) {
  const genMs = stream && durationMs > ttftMs ? durationMs - ttftMs : durationMs;
  if (!completionTokens || genMs <= 0) return 0;
  return Math.round((completionTokens / (genMs / 1000)) * 10) / 10;
}

/**
 * Wrap a /v1 route handler: enforces per-key model/endpoint permissions and
 * writes one requestLogs row when the response body finishes (or is cancelled).
 */
export function withRequestLog(kind, handler) {
  return async (request, routeCtx) => {
    const start = Date.now();
    const url = new URL(request.url);
    const rawKey = extractKey(request);
    const [keyRec, model] = await Promise.all([getRequestApiKey(request), peekModel(request)]);

    const ctx = {
      timestamp: new Date(start).toISOString(),
      apiKeyId: keyRec?.id || null,
      apiKeyName: keyRec?.name || null,
      apiKeyMasked: maskKey(rawKey),
      ip: clientIp(request),
      method: request.method,
      path: url.pathname.replace(/^\/api(?=\/v1)/, ""),
      endpointKind: kind,
      model,
      provider: null,
      resolvedModel: null,
      promptTokens: 0,
      completionTokens: 0,
      stream: false,
      userAgent: request.headers.get("user-agent")?.slice(0, 200) || null,
      error: null,
      _seen: new Set(),
    };

    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      const end = Date.now();
      const durationMs = end - start;
      const ttftMs = ctx.ttftAt ? ctx.ttftAt - start : durationMs;
      insertRequestLog({
        ...ctx, status, durationMs, ttftMs,
        tps: computeTps(ctx.completionTokens, durationMs, ttftMs, ctx.stream),
      });
    };

    let denied = null;
    if (keyRec && !isEndpointAllowed(kind, keyRec.allowedEndpoints)) denied = `API key not allowed to use endpoint type: ${kind}`;
    else if (keyRec && model && !isModelAllowed(model, keyRec.allowedModels)) denied = `API key not allowed to use model: ${model}`;
    if (denied) {
      ctx.error = denied;
      finish(403);
      return errorResponse(403, denied);
    }

    let response;
    try {
      response = await requestLogStore.run(ctx, () => handler(request, routeCtx));
    } catch (e) {
      ctx.error = e?.message || String(e);
      finish(500);
      throw e;
    }

    const status = response?.status || 0;
    ctx.stream = (response?.headers?.get("content-type") || "").includes("text/event-stream");
    if (status >= 400 && !ctx.error) {
      try { ctx.error = (await response.clone().text()).slice(0, 500); } catch { /* body unreadable */ }
    }
    if (!response?.body) {
      finish(status);
      return response;
    }

    const tap = new TransformStream({
      transform(chunk, controller) {
        if (!ctx.ttftAt) ctx.ttftAt = Date.now();
        controller.enqueue(chunk);
      },
      flush() { finish(status); },
      cancel() { ctx.error ||= "client disconnected"; finish(status === 200 ? 499 : status); },
    });
    return new Response(response.body.pipeThrough(tap), {
      status, statusText: response.statusText, headers: response.headers,
    });
  };
}
