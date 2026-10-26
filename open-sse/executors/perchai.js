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

// Map friendly model IDs to Perch AI internal option IDs
const MODEL_OPTIONS = {
  "gemini-4-argon": "gemini-gemini-4-argon",
  "claude-opus-5.5": "anthropic-claude-opus-5-5",
  "claude-sonnet-5.5": "anthropic-claude-sonnet-5-5",
  "claude-haiku-5.5": "anthropic-claude-haiku-5-5",
  "gpt-6.1-sol": "azure-foundry-gpt-6-1-sol",
  "gpt-6-sol": "azure-foundry-gpt-6-sol",
  "gpt-6-luna": "azure-foundry-gpt-6-luna",
  "gpt-5.6-sol": "azure-foundry-gpt-5-6-sol",
  "gpt-5.6-luna": "azure-foundry-gpt-5-6-luna",
  "gpt-5.6-terra": "azure-foundry-gpt-5-6-terra",
  "grok-4.7": "azure-foundry-grok-4-7",
  "grok-4.6": "bedrock-mantle-xai-grok-4-6",
  "kimi-3.1-pro": "openrouter-moonshotai-kimi-k3-1-pro",
  "kimi-3": "azure-foundry-fw-kimi-k3",
  "kimi-2.7": "wandb-kimi-k2-7-code",
  "deepseek-v4.1-flash": "dashscope-deepseek-v4-1-flash",
  "deepseek-v4.1-flash-1017": "openrouter-deepseek-deepseek-v4-1-flash-1017",
  "deepseek-v4": "wandb-deepseek-ai-deepseek-v4-pro",
  "deepseek-flash-starter": "openrouter-deepseek-deepseek-v4-1-flash-1017-cloudflare",
  "glm-5.3": "azure-foundry-fw-glm-5-3",
  "glm-5.3-flash": "wandb-zai-org-glm-5-3-flash",
  "glm-5.3-flash-starter": "openrouter-z-ai-glm-5-3-flash",
  "glm-5.2": "wandb-zai-org-glm-5-2",
  "qwen-3.8-max": "openrouter-qwen-qwen3-8-max-0902",
  "qwen-3.8": "wandb-qwen-qwen3-8-27b",
  "qwen-3.8-flash": "openrouter-qwen-qwen3-8-flash",
  "qwen-3.7-plus": "fireworks-accounts-fireworks-models-qwen3p7-plus",
  "minimax-m3": "wandb-minimax-m3",
  "minimax-m3.1-flash-starter": "openrouter-minimax-minimax-m3-1-flash-free",
  "beam-1.0": "wandb-reflection-beam-1-0-501b-a23b",
  "beam-1.0-starter": "openrouter-reflection-beam-1-0-501b-a23b",
  "nemotron-ultra": "wandb-nvidia-nvidia-nemotron-3-ultra-550b-a55b",
  "nemotron-lightning": "wandb-nvidia-nvidia-nemotron-3-5-lightning-30b-a3b",
  "laguna-s": "poolside-poolside-laguna-s-2-1",
  "inkling": "fireworks-accounts-fireworks-models-inkling",
};

const ROOST_TIERS = new Set(["standard", "pro", "starter", "standard_max", "pro_max"]);

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

    if (!res.ok) return null;
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
  const optionId = MODEL_OPTIONS[cleanModel] || null;

  const runId = extra?.runId || `cli-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const hasTicket = extra?.hasTicket !== false;

  return {
    request: {
      messages: body?.messages || [],
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
    ...(isTier
      ? {
          roostModelChoice: cleanModel,
          roostReasoning: true,
          effort: { level: "high", orchestration: false },
        }
      : {
          manualModelOptionId: optionId || cleanModel,
        }),
  };
}

export function wrapPerchCompletionStream(response, model) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let done = false;
  let firstChunkSent = false;
  const chunkId = `chatcmpl-perch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const created = Math.floor(Date.now() / 1000);

  const formatToolCalls = (toolCalls) => {
    if (!Array.isArray(toolCalls)) return [];
    return toolCalls.map((tc, idx) => {
      const fn = tc.function || {};
      const name = tc.name || fn.name || "";
      const rawArgs = tc.arguments !== undefined ? tc.arguments : fn.arguments;
      const argumentsStr = typeof rawArgs === "string" ? rawArgs : (rawArgs ? JSON.stringify(rawArgs) : "");
      return {
        index: idx,
        id: tc.id || `call_${idx}`,
        type: "function",
        function: {
          name,
          arguments: argumentsStr,
        },
      };
    });
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
      const formatted = formatToolCalls(payload.toolCalls);
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
      arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}),
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

    // Acquire or reuse Perch turn-ticket (matches CLI turn ticket minting)
    let ticketData = await getPerchTurnTicket(appUrl, token, fetchFn, proxyOptions);

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

    // If 401 or 403 not_authorized occurs, attempt token refresh and single retry (matches CLI YLr/r6r)
    if (response.status === 401 || response.status === 403) {
      try {
        const cloned = response.clone();
        const errText = await cloned.text().catch(() => "");
        const shouldRefresh = response.status === 401 || errText.includes("not_authorized") || errText.includes("perch_surface_required");
        if (shouldRefresh && session?.refreshToken) {
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
            response = await fetchFn(url, fetchOptions, proxyOptions);
          }
        }
      } catch {}
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
