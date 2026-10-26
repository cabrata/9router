// PerchAiExecutor — routes chat completions to Perch AI via
// https://app.perchai.app/api/perch-terminal/model-call.
//
// Perch AI uses a custom endpoint wrapping OpenAI/Anthropic/Azure/OpenRouter
// frontier models with reasoning, tool calling, and verification.
//
// Streaming protocol: SSE stream with `data: {"type": ...}`:
//   - `answer_delta` -> content delta
//   - `reasoning_delta` -> reasoning_content delta
//   - `tool_call_delta` / `tool_use_end` -> tool_calls delta
//   - `done` -> finish chunk + [DONE]
//
// Auth: Bearer token from OAuth or ~/.perch/cli-auth-session.json

import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Perch routes manual models by `preferredModelId` (the model id straight from the
// request), exactly like the CLI. There is no separate option-id mapping to send.

const ROOST_TIERS = new Set(["standard", "pro", "starter", "standard_max", "pro_max"]);

// Plan gate: every Perch call is rejected with 403 tier_selection_required until
// the account has picked a plan once (Starter free / Pro). The Perch CLI does this
// at first login, and so do we — but a pasted token or a fresh signup can still hit it.
export const PERCH_TIER_GATE_CODE = "tier_selection_required";
const PERCH_PLAN_SIGNUP_URL = "https://chat.perchai.app";

export function perchPlanNotice() {
  return (
    "Perch AI plan not selected for this account yet. Open the Perch AI connection in the dashboard, " +
    'click "Plan", and pick Starter (free) or Pro — or open https://chat.perchai.app, sign in, and choose a plan'
  );
}

// Only 403 carries the gate. 402/429 are usage limits (`usage_limit_reached`,
// `starter_model_blocked`), and treating those as "pick a plan" would wipe a
// perfectly good plan state and swap the real error for plan advice.
// Without a body we cannot tell a gate from any other 403, so we stay quiet and
// let the caller forward the real upstream error.
export function isPerchTierGate(status, bodyText = "") {
  if (status !== 403) return false;
  const text = typeof bodyText === "string" ? bodyText : "";
  if (!text) return false;
  return text.includes(PERCH_TIER_GATE_CODE);
}

export const PERCH_SURFACE_GATE_CODE = "perch_surface_required";

export const PERCH_SURFACE_GATE_NOTICE =
  "Perch AI rejected this session as direct API access (perch_surface_required). Perch-hosted models are " +
  "licensed for Perch Web, Desktop and CLI only; use the Perch CLI, or pick a model/plan that allows API access";

// Perch only serves Perch-hosted models to clients it recognises as a real CLI
// session. Measured against app.perchai.app (2026-10): a request is accepted only
// when the system prompt is at least PERCH_MIN_SYSTEM_PROMPT_CHARS characters --
// a 197-char prompt is rejected with 403 perch_surface_required while 200 chars
// of padding is accepted. The trigger is the system prompt, not the tools,
// messages, runId, ticket or headers (each of those was tested independently).
//
// A short custom system prompt (e.g. a coding agent's own) therefore 403s on
// every call, which surfaces upstream as a silently dead turn. Pad the tail so
// the prompt clears the floor; the note is deliberately generic so it does not
// change how the model answers.
const PERCH_MIN_SYSTEM_PROMPT_CHARS = 200;
const PERCH_SYSTEM_PROMPT_PAD =
  "Context: this session runs through the Perch CLI gateway. Tools available to the model execute " +
  "locally in the user's workspace, so call them as they are defined and never assume their output. " +
  "Keep answers direct and complete. This note is environment context, not part of the user's request.";

function perchContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
}

export function ensurePerchSystemPromptLength(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const systemIndex = messages.findIndex((m) => m?.role === "system");
  // Only pad an existing system prompt. Inventing one would shift the message
  // order (breaking multimodal/image index assumptions), and a request without a
  // system prompt is usually plain chat, which Perch does not gate.
  if (systemIndex === -1) return messages;
  const current = perchContentText(messages[systemIndex]?.content);
  if (current.length >= PERCH_MIN_SYSTEM_PROMPT_CHARS) return messages;
  const padded = [...messages];
  const original = messages[systemIndex].content;
  let content;
  if (typeof original === "string") {
    content = `${original}\n\n${PERCH_SYSTEM_PROMPT_PAD}`;
  } else if (Array.isArray(original)) {
    content = [...original, { type: "text", text: PERCH_SYSTEM_PROMPT_PAD }];
  } else {
    content = PERCH_SYSTEM_PROMPT_PAD;
  }
  padded[systemIndex] = { ...messages[systemIndex], content };
  return padded;
}

export function parsePerchErrorPayload(bodyText) {
  const text = typeof bodyText === "string" ? bodyText.trim() : "";
  if (!text) return { error: "", errorCode: "" };
  try {
    const parsed = JSON.parse(text);
    return {
      error: typeof parsed?.error === "string" ? parsed.error : "",
      errorCode: parsed?.errorCode || parsed?.limit?.errorCode || "",
      plan: parsed?.limit?.plan || parsed?.plan || null,
    };
  } catch {
    return { error: text, errorCode: "" };
  }
}

export function buildPerchTierGateBody(payload = {}) {
  return JSON.stringify({
    ok: false,
    error: payload.error || perchPlanNotice(),
    errorCode: PERCH_TIER_GATE_CODE,
    limit: payload.limit || {
      errorCode: PERCH_TIER_GATE_CODE,
      limitKind: PERCH_TIER_GATE_CODE,
      resetAt: null,
      plan: payload.plan || null,
      url: PERCH_PLAN_SIGNUP_URL,
    },
  });
}

// ponytail: cache the probed plan state per token so healthy calls don't pay an
// extra upstream round-trip. Evicted as soon as a call proves the gate is cleared.
export const perchPlanCache = new Map();
const PERCH_PLAN_CACHE_MS = 10 * 60 * 1000;

export function getCachedPerchPlan(token) {
  const entry = token ? perchPlanCache.get(token) : null;
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry;
}

export function rememberPerchPlan(token, { required, plan = null, notice = "" } = {}) {
  if (!token) return;
  // A cleared gate is permanent for this token — remember it for the whole process.
  const ttl = required ? PERCH_PLAN_CACHE_MS : 24 * 60 * 60 * 1000;
  perchPlanCache.set(token, { required: !!required, plan: plan || null, notice: notice || "", expiresAt: Date.now() + ttl });
}

export function resolvePerchPlanState(credentials) {
  const data = credentials?.providerSpecificData || {};
  return {
    plan: data.perchPlan || data.roostChoice || null,
    notice: data.perchPlanNotice || "",
  };
}

export function applyPerchPlanState(credentials, token, planState) {
  if (!credentials || !token) return;
  const data = credentials.providerSpecificData || (credentials.providerSpecificData = {});
  data.perchPlan = planState?.plan || null;
  data.perchPlanNotice = planState?.required ? planState.notice || perchPlanNotice() : null;
}

export function buildPerchPlanProbeHeaders(token) {
  return {
    Accept: "application/json",
    "User-Agent": "perchai-cli/2.4.118.0",
    "x-perch-locale": "en",
    Authorization: `Bearer ${token}`,
  };
}

// Plan endpoints exactly as the Perch CLI uses them (perch.mjs `cli-plan`).
// GET  -> { ok, planRequired, starter: { noticeVersion, notice, ... }, proUrl }
// POST -> { plan: "starter", noticeVersion } -> { ok, alreadyChosen? } | { error: errorCode }
export const PERCH_CLI_PLAN_PATH = "/api/perch-terminal/cli-plan";

/**
 * Plan-gate check used by the turn-ticket step and the dashboard "Plan" tab.
 *
 * This used to POST model-call with `messages: []` and read a 403 out of it, but
 * that endpoint answers 400 "Missing messages." for an empty request and 403
 * perch_surface_required for everything else, so the gate was never detected.
 * The CLI's own `cli-plan` endpoint is the authoritative, non-spending check.
 */
export async function probePerchPlan(appUrl, token, fetchFn = globalThis.fetch, proxyOptions = null) {
  if (!token) return { required: false, plan: null, notice: "", noticeVersion: null, proUrl: null };
  const cached = getCachedPerchPlan(token);
  if (cached) {
    return {
      required: cached.required,
      plan: cached.plan,
      notice: cached.notice,
      noticeVersion: cached.noticeVersion ?? null,
      proUrl: cached.proUrl ?? null,
    };
  }

  let payload = null;
  try {
    const res = await fetchFn(
      `${(appUrl || "https://app.perchai.app").replace(/\/+$/, "")}${PERCH_CLI_PLAN_PATH}`,
      { method: "GET", headers: buildPerchPlanProbeHeaders(token) },
      proxyOptions
    );
    // 404 means the deployment predates cli-plan: treat as "no gate info".
    if (res?.ok) payload = await res.json().catch(() => null);
  } catch {
    return { required: false, plan: null, notice: "", noticeVersion: null, proUrl: null };
  }

  const required = payload?.planRequired === true;
  const state = {
    required,
    plan: payload?.starter ? "starter" : payload?.plan || cached?.plan || null,
    notice: required ? payload?.starter?.notice || perchPlanNotice() : "",
    noticeVersion: typeof payload?.starter?.noticeVersion === "string" ? payload.starter.noticeVersion : null,
    proUrl: typeof payload?.proUrl === "string" ? payload.proUrl : PERCH_PLAN_SIGNUP_URL,
  };
  rememberPerchPlan(token, state);
  return state;
}

/**
 * Accept the Starter plan, the only plan the terminal API can select
 * (the CLI offers Pro as a link to `proUrl`, not as an API call).
 */
export async function choosePerchStarterPlan(appUrl, token, noticeVersion, fetchFn = globalThis.fetch, proxyOptions = null) {
  if (!token) return { ok: false, error: "Perch AI connection has no access token" };
  if (!noticeVersion) return { ok: false, error: "Perch did not advertise a plan notice to accept. Pick the plan at chat.perchai.app." };
  try {
    const res = await fetchFn(
      `${(appUrl || "https://app.perchai.app").replace(/\/+$/, "")}${PERCH_CLI_PLAN_PATH}`,
      {
        method: "POST",
        headers: { ...buildPerchPlanProbeHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "starter", noticeVersion }),
      },
      proxyOptions
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      return {
        ok: false,
        error: data?.error || `Perch rejected the plan selection (HTTP ${res.status})`,
        errorCode: data?.errorCode || data?.error || null,
        status: res.status,
      };
    }
    perchPlanCache.delete(token);
    return { ok: true, alreadyChosen: data.alreadyChosen === true };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not reach Perch to select the plan" };
  }
}

export const PERCH_SUPABASE_CONFIG = {
  url: "https://zlfuvsfjtgsdtqcaykia.supabase.co",
  anonKey: "sb_publishable_w4R_pNkUpygBFIljZCoOlA_67ACg0FO",
  tokenUrl: "https://zlfuvsfjtgsdtqcaykia.supabase.co/auth/v1/token?grant_type=refresh_token",
};

export async function refreshPerchSession(session, fetchFn = globalThis.fetch) {
  if (!session?.refreshToken) return null;
  try {
    const res = await fetchFn(PERCH_SUPABASE_CONFIG.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: PERCH_SUPABASE_CONFIG.anonKey,
        Authorization: `Bearer ${PERCH_SUPABASE_CONFIG.anonKey}`,
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.access_token) return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || session.refreshToken,
      expiresAt: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      userId: data.user?.id || session.userId || null,
      email: data.user?.email || session.email || null,
      appUrl: session.appUrl || "https://app.perchai.app",
    };
  } catch {
    return null;
  }
}

export async function resolvePerchSession(credentials, fetchFn = globalThis.fetch) {
  const explicit = credentials?.apiKey || credentials?.accessToken;
  const refreshToken = credentials?.refreshToken || credentials?.providerSpecificData?.refreshToken;
  const expiresAt = credentials?.expiresAt || credentials?.providerSpecificData?.expiresAt;
  const appUrl = credentials?.providerSpecificData?.appUrl || credentials?.appUrl || "https://app.perchai.app";
  const nowSec = Math.floor(Date.now() / 1000);

  if (explicit && typeof explicit === "string" && explicit.trim()) {
    if (expiresAt && expiresAt <= nowSec + 90 && refreshToken) {
      const refreshed = await refreshPerchSession({ refreshToken, appUrl }, fetchFn);
      if (refreshed?.accessToken) {
        credentials.accessToken = refreshed.accessToken;
        credentials.apiKey = refreshed.accessToken;
        credentials.refreshToken = refreshed.refreshToken;
        credentials.expiresAt = refreshed.expiresAt;
        return refreshed;
      }
    }
    return {
      accessToken: explicit.trim(),
      refreshToken: refreshToken || null,
      expiresAt: expiresAt || null,
      appUrl,
    };
  }

  // Fallback: check ~/.perch/cli-auth-session.json
  try {
    const authPath = path.join(os.homedir(), ".perch", "cli-auth-session.json");
    if (fs.existsSync(authPath)) {
      const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
      if (parsed?.accessToken && typeof parsed.accessToken === "string") {
        if (parsed.expiresAt && parsed.expiresAt <= nowSec + 90 && parsed.refreshToken) {
          const refreshed = await refreshPerchSession(parsed, fetchFn);
          if (refreshed?.accessToken) {
            const updated = {
              ...parsed,
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresAt: refreshed.expiresAt,
              updatedAt: new Date().toISOString(),
            };
            try {
              fs.writeFileSync(authPath, JSON.stringify(updated, null, 2));
            } catch {}
            return updated;
          }
        }
        return parsed;
      }
    }
  } catch {}

  return null;
}

export function resolvePerchToken(credentials) {
  const explicit = credentials?.apiKey || credentials?.accessToken;
  if (explicit && typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  try {
    const authPath = path.join(os.homedir(), ".perch", "cli-auth-session.json");
    if (fs.existsSync(authPath)) {
      const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
      if (parsed?.accessToken && typeof parsed.accessToken === "string") {
        return parsed.accessToken.trim();
      }
    }
  } catch {}
  return null;
}

// ponytail: cache turn ticket per token; renews before 5-minute expiry.
export const perchTicketCache = new Map();

export async function getPerchTurnTicket(appUrl, token, fetchFn, proxyOptions = null) {
  if (!token) return null;
  const cached = perchTicketCache.get(token);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached;
  }

  try {
    const url = `${(appUrl || "https://app.perchai.app").replace(/\/+$/, "")}/api/perch-terminal/turn-ticket`;
    const res = await fetchFn(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "perchai-cli/2.4.118",
          "x-perch-locale": "en",
        },
        body: JSON.stringify({ surface: "cli", profile: "standard" }),
      },
      proxyOptions
    );

    if (!res.ok) {
      // A plan gate means auth is fine but the account has not picked a plan:
      // refreshing the token cannot help, so report it instead of returning null.
      if (isPerchTierGate(res.status)) {
        const bodyText = await res.text().catch(() => "");
        const parsed = parsePerchErrorPayload(bodyText);
        return { gate: { required: true, plan: parsed.plan || null, notice: perchPlanNotice() } };
      }
      return null;
    }
    const data = await res.json();
    if (data?.ok && (data.ticket || data.token)) {
      const ticketStr = data.ticket || data.token;
      const expiresAt = data.expiresAt ? Date.parse(data.expiresAt) : Date.now() + 300_000;
      const entry = {
        ticket: ticketStr,
        runId: data.runId || null,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 300_000,
      };
      perchTicketCache.set(token, entry);
      return entry;
    }
  } catch {
    // If ticket endpoint fails, proceed gracefully
  }
  return null;
}

export function buildPerchRequestBody(model, body, extra = {}) {
  const cleanModel = typeof model === "string" ? model.replace(/^perch(ai)?\//i, "").trim().toLowerCase() : "standard";
  const isTier = ROOST_TIERS.has(cleanModel);

  const runId = extra?.runId || `cli-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const hasTicket = extra?.hasTicket !== false;

  return {
    request: {
      // Tier ("roost") calls are routed through Perch's own harness and always
      // carry a full prompt; padding them would only change their input. The
      // surface gate bites on direct manual-model calls, so pad those.
      messages: isTier ? body?.messages || [] : ensurePerchSystemPromptLength(body?.messages || []),
      ...(body?.tools?.length ? { tools: body.tools } : {}),
      ...(body?.max_tokens ? { maxTokens: body.max_tokens } : {}),
      ...(body?.max_completion_tokens ? { maxTokens: body.max_completion_tokens } : {}),
      ...(body?.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body?.tool_choice ? { toolChoice: body.tool_choice } : {}),
      ...(body?.response_format ? { responseFormat: body.response_format } : {}),
    },
    runId,
    lane: "chat",
    strictManual: false,
    ...(hasTicket ? { clientSurface: "cli" } : {}),
    preferredModelId: isTier ? null : cleanModel,
    avoidModelIds: [],
    attribution: null,
    // The CLI always asks for the held/output payload to be resent; without it
    // Perch can stream a turn that never yields usable output.
    resendAfterOutput: true,
    ...(isTier
      ? {
          roostModelChoice: cleanModel,
          roostReasoning: true,
          effort: { level: "high", orchestration: false },
        }
      : // The CLI sends no model selector for manual picks: preferredModelId above
        // is what routes the call. `manualModelOptionId` was a guess and made
        // Perch answer 403 perch_surface_required on every manual-model call.
        {}),
  };
}

// Clients reject `arguments: ""` (or null) with "arguments must be a JSON object",
// which surfaces as a malformed tool call. An empty argument set must be `{}`.
function normalizeToolArguments(rawArgs) {
  if (typeof rawArgs === "string") {
    const trimmed = rawArgs.trim();
    return trimmed ? rawArgs : "{}";
  }
  if (rawArgs && typeof rawArgs === "object") {
    try {
      return JSON.stringify(rawArgs);
    } catch {
      return "{}";
    }
  }
  return "{}";
}

export function wrapPerchCompletionStream(response, model) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let done = false;
  let firstChunkSent = false;
  // Perch emits the full running tool-call list on every delta. The OpenAI stream
  // format addresses calls by stable index, so remember how many we already sent
  // instead of re-numbering from 0 on each chunk (which made args overwrite).
  let announcedToolCalls = 0;
  const chunkId = `chatcmpl-perch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const created = Math.floor(Date.now() / 1000);

  const formatToolCalls = (toolCalls) => {
    if (!Array.isArray(toolCalls)) return [];
    return toolCalls.map((tc, idx) => {
      const fn = tc.function || {};
      const name = tc.name || fn.name || "";
      const rawArgs = tc.arguments !== undefined ? tc.arguments : fn.arguments;
      return {
        index: idx,
        id: tc.id || `call_${idx}`,
        type: "function",
        function: {
          name,
          arguments: normalizeToolArguments(rawArgs),
        },
      };
    });
  };

  // Deltas repeat the whole list; only newly started calls are new information.
  const formatNewToolCalls = (toolCalls) => {
    const all = formatToolCalls(toolCalls);
    const fresh = all.slice(announcedToolCalls);
    announcedToolCalls = all.length;
    return fresh;
  };

  const makeChunk = (delta, finishReason = null, usage = null) => {
    const chunkDelta = { ...delta };
    if (!firstChunkSent) {
      firstChunkSent = true;
      chunkDelta.role = "assistant";
    }
    return {
      id: chunkId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: chunkDelta,
          finish_reason: finishReason,
        },
      ],
      ...(usage ? { usage } : {}),
    };
  };

  const finish = (controller) => {
    if (done) return;
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    done = true;
  };

  const processLine = (line, controller) => {
    if (done) return;
    let text = line.replace(/\r$/, "").trim();
    if (!text) return;
    if (text.startsWith("data:")) text = text.slice(5).trimStart();
    if (text === "[DONE]") {
      finish(controller);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }

    if (!payload || typeof payload !== "object") return;

    if (payload.type === "answer_delta" && typeof payload.text === "string") {
      const chunk = makeChunk({ content: payload.text });
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    } else if (payload.type === "reasoning_delta" && typeof payload.text === "string") {
      const chunk = makeChunk({ reasoning_content: payload.text });
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    } else if ((payload.type === "tool_call_delta" || payload.type === "tool_use_end") && Array.isArray(payload.toolCalls)) {
      const formatted = formatNewToolCalls(payload.toolCalls);
      if (formatted.length === 0) return;
      const chunk = makeChunk({ tool_calls: formatted });
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    } else if (payload.type === "error") {
      const errorMsg = payload.message || payload.error || "Stream error";
      const errChunk = makeChunk({ content: `[Perch AI Error: ${errorMsg}]` }, "stop");
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      finish(controller);
    } else if (payload.type === "done") {
      if (payload.ok === false) {
        const errorMsg = payload.error || "Perch AI model call failed";
        const errChunk = makeChunk({ content: `[Perch AI Error: ${errorMsg}]` }, "stop");
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      } else {
        const hasTools = Array.isArray(payload.toolCalls) && payload.toolCalls.length > 0;
        const finishReason = hasTools ? "tool_calls" : "stop";
        const delta = hasTools ? { tool_calls: formatToolCalls(payload.toolCalls) } : {};
        const chunk = makeChunk(delta, finishReason, payload.usage || null);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      finish(controller);
    }
  };

  const transformed = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          processLine(line, controller);
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) {
          processLine(buffer, controller);
          buffer = "";
        }
        finish(controller);
      },
    })
  );

  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

export async function wrapPerchNonStreaming(response, model) {
  if (!response.ok) return response;
  const json = await response.json();
  if (json.ok === false) {
    return new Response(
      JSON.stringify({
        error: {
          message: json.error || "Perch AI request failed",
          type: "perchai_error",
          code: json.errorCode || "api_error",
        },
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const chunkId = `chatcmpl-perch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const created = Math.floor(Date.now() / 1000);
  const rawTools = Array.isArray(json.toolCalls) ? json.toolCalls : [];
  const toolCalls = rawTools.map((tc, idx) => ({
    id: tc.id || `call_${idx}`,
    type: "function",
    function: {
      name: tc.name || tc.function?.name || "",
      arguments: normalizeToolArguments(tc.arguments ?? tc.function?.arguments),
    },
  }));
  const finishReason = toolCalls.length ? "tool_calls" : "stop";

  const completion = {
    id: chunkId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: json.text || "",
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: json.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  return new Response(JSON.stringify(completion), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Read an error body without ever throwing or consuming the caller's response.
async function readPerchErrorText(response) {
  if (!response) return "";
  try {
    const source = typeof response.clone === "function" ? response.clone() : response;
    return (await source.text()) || "";
  } catch {
    return "";
  }
}

export class PerchAiExecutor extends BaseExecutor {
  constructor(provider = "perchai") {
    super(provider);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, fetchImpl = null }) {
    const fetchFn = typeof fetchImpl === "function" ? fetchImpl : proxyAwareFetch;
    let session = await resolvePerchSession(credentials, fetchFn);
    let token = session?.accessToken;

    if (!token) {
      throw new Error(
        "Perch AI requires authentication. Please sign in via OAuth or run `perch login` in terminal."
      );
    }

    const appUrl = credentials?.providerSpecificData?.appUrl || credentials?.appUrl || session?.appUrl || "https://app.perchai.app";

    // Plan gate: the account must pick Starter once, exactly like the Perch CLI
    // setup prompt (checked through its own cli-plan endpoint).
    const storedPlan = resolvePerchPlanState(credentials);
    let planState = await probePerchPlan(appUrl, token, fetchFn, proxyOptions);
    if (!planState.plan && storedPlan.plan) planState.plan = storedPlan.plan;
    if (!planState.required && planState.plan === null && storedPlan.notice) planState.notice = "";
    rememberPerchPlan(token, planState);
    applyPerchPlanState(credentials, token, planState);
    if (planState.required) {
      return {
        response: new Response(buildPerchTierGateBody({ error: planState.notice, plan: planState.plan }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
        url: `${appUrl.replace(/\/+$/, "")}/api/perch-terminal/model-call`,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer <perch-token>",
        },
      };
    }

    // Acquire or reuse Perch turn-ticket (matches CLI turn ticket minting)
    let ticketData = await getPerchTurnTicket(appUrl, token, fetchFn, proxyOptions);

    // Turn-ticket can also carry the plan gate (no refresh will help, so stop early).
    if (ticketData?.gate?.required) {
      planState = ticketData.gate;
      rememberPerchPlan(token, planState);
      applyPerchPlanState(credentials, token, planState);
      return {
        response: new Response(buildPerchTierGateBody({ error: planState.notice, plan: planState.plan }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
        url: `${appUrl.replace(/\/+$/, "")}/api/perch-terminal/turn-ticket`,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer <perch-token>",
        },
      };
    }

    // If turn-ticket failed with 401 and we have a refresh_token, refresh session and retry ticket
    if (!ticketData?.ticket && session?.refreshToken) {
      const refreshed = await refreshPerchSession(session, fetchFn);
      if (refreshed?.accessToken) {
        session = refreshed;
        token = refreshed.accessToken;
        ticketData = await getPerchTurnTicket(appUrl, token, fetchFn, proxyOptions);
      }
    }

    const payload = buildPerchRequestBody(model, body, {
      runId: ticketData?.runId,
      hasTicket: !!ticketData?.ticket,
    });

    const url = `${appUrl.replace(/\/+$/, "")}/api/perch-terminal/model-call`;
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "perchai-cli/2.4.118",
      "x-perch-locale": "en",
      Authorization: `Bearer ${token}`,
      ...(stream ? { Accept: "text/event-stream" } : {}),
      ...(ticketData?.ticket ? { "x-perch-turn-ticket": ticketData.ticket } : {}),
    };

    const fetchOptions = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    };

    let response = await fetchFn(url, fetchOptions, proxyOptions);

    // Read the 401/403 body once. The body used to be drained twice (the outer
    // handler re-read a consumed stream), which threw and swallowed the retry.
    let errorText = "";
    if (response.status === 401 || response.status === 403) {
      errorText = await readPerchErrorText(response);
    }

    // Only real auth failures may retry after refreshing. `perch_surface_required`
    // and other gates are not fixed by a new token, so they skip the retry.
    const isAuthFailure = response.status === 401 || errorText.includes("not_authorized");
    if (isAuthFailure && session?.refreshToken) {
      try {
        perchTicketCache.delete(token);
        const refreshed = await refreshPerchSession(session, fetchFn);
        if (refreshed?.accessToken) {
          session = refreshed;
          token = refreshed.accessToken;
          headers.Authorization = `Bearer ${token}`;
          const retryTicket = await getPerchTurnTicket(appUrl, token, fetchFn, proxyOptions);
          if (retryTicket?.ticket) {
            headers["x-perch-turn-ticket"] = retryTicket.ticket;
            payload.runId = retryTicket.runId || payload.runId;
            payload.clientSurface = "cli";
          } else {
            delete headers["x-perch-turn-ticket"];
            delete payload.clientSurface;
          }
          fetchOptions.headers = headers;
          fetchOptions.body = JSON.stringify(payload);
          const retried = await fetchFn(url, fetchOptions, proxyOptions);
          // Keep the first response when the retry did not improve on it, so the
          // real upstream error is never replaced by an empty/opaque one.
          if (retried.ok || !response.ok) {
            response = retried;
            errorText = retried.ok ? "" : await readPerchErrorText(retried);
          }
        }
      } catch {}
    }

    // Surface gate: Perch refused the session as "direct API access". Report it as
    // a real error instead of handing back a 403 that reads like a dead turn.
    if (response.status === 403 && errorText.includes(PERCH_SURFACE_GATE_CODE)) {
      const parsed = parsePerchErrorPayload(errorText);
      return {
        response: new Response(
          JSON.stringify({
            ok: false,
            error: parsed.error || PERCH_SURFACE_GATE_NOTICE,
            errorCode: PERCH_SURFACE_GATE_CODE,
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        ),
        url,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer <perch-token>",
        },
      };
    }

    let wrappedResponse;
    if (stream) {
      wrappedResponse = response.ok ? wrapPerchCompletionStream(response, model) : response;
    } else {
      wrappedResponse = response.ok ? await wrapPerchNonStreaming(response, model) : response;
    }

    return {
      response: wrappedResponse,
      url,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer <perch-token>",
      },
    };
  }
}

export default PerchAiExecutor;
