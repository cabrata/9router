import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import REGISTRY from "open-sse/providers/registry/index.js";
import { getExecutor } from "open-sse/executors/index.js";
import { PROVIDER_MODELS, getDefaultModel, isValidModel, findModelName, getModelTargetFormat, getModelUpstreamId } from "open-sse/config/providerModels.js";
import { translateRequest } from "open-sse/translator/index.js";
import { detectFormat, getTargetFormat } from "open-sse/services/provider.js";
import { FORMATS } from "open-sse/translator/formats.js";
import {
  PerchAiExecutor,
  buildPerchRequestBody,
  wrapPerchCompletionStream,
  wrapPerchNonStreaming,
  resolvePerchToken,
} from "open-sse/executors/perchai.js";
import perchaiOAuth from "@/lib/oauth/providers/perchai.js";
import { OAUTH_PROVIDERS, ALIAS_TO_ID } from "@/shared/constants/providers.js";
import { AI_MODELS } from "@/shared/constants/models.js";
import { resolveCaps } from "@/shared/hooks/useModelCaps.js";
import { matchesSearch } from "@/shared/utils/modelSearchFilter.js";
import { resolveProviderIconId } from "@/shared/utils/providerIcon.js";
import { refreshAccessToken } from "open-sse/services/tokenRefresh/providers.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { getPricingForModel, calculateCostFromTokens } from "open-sse/providers/pricing.js";
import { CLI_TOOLS } from "@/shared/constants/cliTools.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";

const originalFetch = global.fetch;

describe("Perch AI Provider Integration", () => {
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("registers perchai in REGISTRY with models and metadata", () => {
    const perch = REGISTRY.find((r) => r.id === "perchai");
    expect(perch).toBeDefined();
    expect(perch.alias).toBe("perch");
    expect(perch.category).toBe("oauth");
    expect(perch.display.name).toBe("Perch AI");
    expect(perch.models.length).toBeGreaterThan(20);
  });

  it("exposes perch models in PROVIDER_MODELS and validates models", () => {
    expect(PROVIDER_MODELS["perch"]).toBeDefined();
    expect(getDefaultModel("perch")).toBe("standard");
    expect(isValidModel("perch", "standard")).toBe(true);
    expect(isValidModel("perch", "gpt-6.1-sol")).toBe(true);
    expect(isValidModel("perch", "claude-opus-5.5")).toBe(true);
    expect(isValidModel("perch", "deepseek-v4.1-flash")).toBe(true);
    expect(OAUTH_PROVIDERS["perchai"]).toBeDefined();
    expect(resolveProviderIconId("perch")).toBe("perchai");
  });

  it("retrieves PerchAiExecutor via getExecutor", () => {
    const exec1 = getExecutor("perchai");
    const exec2 = getExecutor("perch");
    expect(exec1).toBeInstanceOf(PerchAiExecutor);
    expect(exec2).toBeInstanceOf(PerchAiExecutor);
  });

  it("formats request body for roost tiers and exact model options", () => {
    const tierBody = buildPerchRequestBody("standard", {
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 500,
    });
    expect(tierBody.roostModelChoice).toBe("standard");
    expect(tierBody.lane).toBe("chat");
    expect(tierBody.request.maxTokens).toBe(500);

    const modelBody = buildPerchRequestBody("gpt-6.1-sol", {
      messages: [{ role: "user", content: "solve" }],
    });
    expect(modelBody.preferredModelId).toBe("gpt-6.1-sol");
    expect(modelBody.manualModelOptionId).toBe("azure-foundry-gpt-6-1-sol");

    const deepseekBody = buildPerchRequestBody("deepseek-v4.1-flash", {
      messages: [{ role: "user", content: "code" }],
    });
    expect(deepseekBody.preferredModelId).toBe("deepseek-v4.1-flash");
    expect(deepseekBody.manualModelOptionId).toBe("dashscope-deepseek-v4-1-flash");
  });

  it("resolves token from credentials or falls back to disk", () => {
    expect(resolvePerchToken({ apiKey: "key_xyz" })).toBe("key_xyz");
    expect(resolvePerchToken({ accessToken: "token_abc" })).toBe("token_abc");
  });

  it("translates Perch AI SSE stream to OpenAI completion chunks", async () => {
    const sseLines = [
      'data: {"type":"reasoning_delta","text":"Analyzing..."}',
      'data: {"type":"answer_delta","text":"Result: "}',
      'data: {"type":"answer_delta","text":"42"}',
      'data: {"type":"done","ok":true,"text":"Result: 42","toolCalls":[],"usage":{"prompt_tokens":5,"completion_tokens":4,"total_tokens":9}}',
    ].join("\n\n") + "\n\n";

    const fakeResponse = new Response(sseLines, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const stream = wrapPerchCompletionStream(fakeResponse, "standard");
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }

    expect(text).toContain('"reasoning_content":"Analyzing..."');
    expect(text).toContain('"content":"Result: "');
    expect(text).toContain('"content":"42"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
  });

  it("translates Perch AI non-streaming JSON to OpenAI completion", async () => {
    const fakeResponse = new Response(
      JSON.stringify({
        ok: true,
        text: "The answer is 42.",
        toolCalls: [],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

    const wrapped = await wrapPerchNonStreaming(fakeResponse, "gpt-6.1-sol");
    expect(wrapped.status).toBe(200);
    const json = await wrapped.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("The answer is 42.");
    expect(json.usage.total_tokens).toBe(16);
  });

  it("generates correct Supabase OAuth parameters and maps tokens", () => {
    const authUrl = perchaiOAuth.buildAuthUrl(
      { authorizeUrl: "https://zlfuvsfjtgsdtqcaykia.supabase.co/auth/v1/authorize" },
      "http://127.0.0.1:20127/callback",
      "test_state",
      "test_challenge"
    );
    expect(authUrl).toContain("provider=google");
    expect(authUrl).toContain("code_challenge=test_challenge");

    const mapped = perchaiOAuth.mapTokens({
      access_token: "jwt_token_123",
      refresh_token: "refresh_token_456",
      expires_in: 3600,
      user: { id: "uid_1", email: "user@perchai.app" },
    });
    expect(mapped.accessToken, "jwt_token_123");
    expect(mapped.refreshToken, "refresh_token_456");
    expect(mapped.email, "user@perchai.app");
    expect(mapped.providerSpecificData.userId, "uid_1");
  });

  it("refreshes token via Supabase OAuth refresh profile", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          access_token: "new_perch_access_token",
          refresh_token: "new_perch_refresh_token",
          expires_in: 3600,
        }),
    });
    global.fetch = fetchMock;

    const res = await refreshAccessToken("perchai", "old_refresh_token", {}, console);
    expect(res).not.toBeNull();
    expect(res.accessToken).toBe("new_perch_access_token");
    expect(res.refreshToken).toBe("new_perch_refresh_token");
    expect(res.expiresIn).toBe(3600);

    const [callUrl, callInit] = fetchMock.mock.calls[0];
    expect(callUrl).toContain("grant_type=refresh_token");
    expect(callInit.headers["apikey"]).toBe("sb_publishable_w4R_pNkUpygBFIljZCoOlA_67ACg0FO");
    expect(callInit.headers["Content-Type"]).toBe("application/json");
    const parsedBody = JSON.parse(callInit.body);
    expect(parsedBody.refresh_token).toBe("old_refresh_token");
    expect(parsedBody.grant_type).toBe("refresh_token");
  });

  it("resolves capabilities for Perch AI models", () => {
    const standardCaps = getCapabilitiesForModel("perch", "standard");
    expect(standardCaps.tools).toBe(true);
    expect(standardCaps.contextWindow).toBeGreaterThan(0);

    const gpt6Caps = getCapabilitiesForModel("perch", "gpt-6.1-sol");
    expect(gpt6Caps.tools).toBe(true);

    const claudeCaps = getCapabilitiesForModel("perch", "claude-opus-5.5");
    expect(claudeCaps.tools).toBe(true);
  });

  it("configures perch in CLI_TOOLS", () => {
    const perchTool = CLI_TOOLS.perch;
    expect(perchTool).toBeDefined();
    expect(perchTool.id).toBe("perch");
    expect(perchTool.name).toBe("Perch CLI");
    expect(perchTool.color).toBe("#22C55E");
    expect(perchTool.defaultModels.length).toBeGreaterThan(0);
  });

  it("executes PerchAiExecutor end-to-end with simulated upstream fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: () =>
        Promise.resolve({
          ok: true,
          text: "Hello from Perch AI!",
          toolCalls: [],
          usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
        }),
    });
    global.fetch = fetchMock;

    const executor = new PerchAiExecutor();
    const result = await executor.execute({
      model: "perch/gpt-6.1-sol",
      body: {
        messages: [{ role: "user", content: "Hi" }],
      },
      stream: false,
      credentials: { apiKey: "test-perch-jwt" },
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
    });

    expect(result.url).toBe("https://app.perchai.app/api/perch-terminal/model-call");
    expect(fetchMock).toHaveBeenCalled();
    const [callUrl, callInit] = fetchMock.mock.calls[0];
    expect(callUrl).toBe("https://app.perchai.app/api/perch-terminal/model-call");
    expect(callInit.headers["Authorization"]).toBe("Bearer test-perch-jwt");
    expect(callInit.headers["User-Agent"]).toContain("Perch-CLI");

    const payload = JSON.parse(callInit.body);
    expect(payload.preferredModelId).toBe("gpt-6.1-sol");
    expect(payload.manualModelOptionId).toBe("azure-foundry-gpt-6-1-sol");
    expect(payload.request.messages[0].content).toBe("Hi");

    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("Hello from Perch AI!");
  });

  it("translates Claude format request to OpenAI format for Perch AI", () => {
    const claudeBody = {
      model: "perch/claude-opus-5.5",
      max_tokens: 1024,
      system: "You are a helpful coding assistant.",
      messages: [{ role: "user", content: "Write a quicksort in JavaScript" }],
    };

    const sourceFormat = detectFormat(claudeBody);
    expect(sourceFormat).toBe(FORMATS.CLAUDE);

    const translated = translateRequest(sourceFormat, FORMATS.OPENAI, "perch/claude-opus-5.5", claudeBody);
    expect(translated.messages).toBeDefined();
    // Claude system prompt should be in messages
    const systemMsg = translated.messages.find((m) => m.role === "system");
    expect(systemMsg.content).toBe("You are a helpful coding assistant.");
    const userMsg = translated.messages.find((m) => m.role === "user");
    expect(userMsg.content).toBe("Write a quicksort in JavaScript");

    const perchBody = buildPerchRequestBody("claude-opus-5.5", translated);
    expect(perchBody.preferredModelId).toBe("claude-opus-5.5");
    expect(perchBody.manualModelOptionId).toBe("anthropic-claude-opus-5-5");
    expect(perchBody.request.messages.length).toBe(2);
  });

  it("resolves model names, target formats, and upstream IDs", () => {
    expect(findModelName("perch", "gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(findModelName("perch", "claude-opus-5.5")).toBe("Claude Opus 5.5");
    expect(findModelName("perch", "standard")).toBe("Standard (Auto)");

    // Target format defaults to OPENAI via getTargetFormat
    expect(getTargetFormat("perch", "standard")).toBe(FORMATS.OPENAI);
    expect(getTargetFormat("perch", "gpt-6.1-sol")).toBe(FORMATS.OPENAI);

    // Upstream ID resolution
    expect(getModelUpstreamId("perch", "gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(getModelUpstreamId("perch", "standard")).toBe("standard");
  });

  it("throws descriptive error when token is missing", async () => {
    const executor = new PerchAiExecutor();
    await expect(
      executor.execute({
        model: "standard",
        body: { messages: [] },
        stream: false,
        credentials: {},
      })
    ).rejects.toThrow(/Perch AI requires authentication/);
  });

  it("returns error response when upstream fails with 401 Unauthorized", async () => {
    const errorFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: new Headers({ "Content-Type": "application/json" }),
      text: async () => JSON.stringify({ ok: false, error: "Unauthorized", errorCode: "not_authenticated" }),
    });

    const executor = new PerchAiExecutor();
    const result = await executor.execute({
      model: "standard",
      body: { messages: [] },
      stream: false,
      credentials: { apiKey: "invalid_key" },
      fetchImpl: errorFetch,
    });

    expect(result.response.ok).toBe(false);
    expect(result.response.status).toBe(401);
  });

  it("contains perchai in OAUTH_TEST_CONFIG with refreshable: true", () => {
    const testUtilsSrc = fs.readFileSync(
      path.resolve("src/app/api/providers/[id]/test/testUtils.js"),
      "utf-8"
    );
    expect(testUtilsSrc).toContain("perchai:");
    expect(testUtilsSrc).toMatch(/perchai:\s*\{[\s\S]*?refreshable:\s*true/);
    expect(testUtilsSrc).toContain("https://app.perchai.app/api/perch-terminal/public-model-default");
  });

  it("calculates cost accurately for Perch AI models without NaN", () => {
    const pricingGpt6 = getPricingForModel("perch", "gpt-6.1-sol");
    expect(pricingGpt6).toBeDefined();
    expect(typeof pricingGpt6.input).toBe("number");
    expect(typeof pricingGpt6.output).toBe("number");

    const cost = calculateCostFromTokens(
      { prompt_tokens: 1000, completion_tokens: 500 },
      pricingGpt6
    );
    expect(typeof cost).toBe("number");
    expect(Number.isNaN(cost)).toBe(false);
    expect(cost).toBeGreaterThan(0);

    const pricingDeepseek = getPricingForModel("perch", "deepseek-v4.1-flash");
    expect(pricingDeepseek).toBeDefined();
    const deepseekCost = calculateCostFromTokens(
      { prompt_tokens: 2000, completion_tokens: 1000 },
      pricingDeepseek
    );
    expect(deepseekCost).toBeGreaterThan(0);
  });

  it("translates streaming tool call deltas and tool_use_end events accurately", async () => {
    const toolCallStream = [
      'data: {"type":"tool_call_delta","toolCalls":[{"id":"call_abc","type":"function","function":{"name":"search","arguments":"{\\"q\\":\\"test\\"}"}}]}',
      'data: {"type":"tool_use_end","toolCalls":[{"id":"call_abc","type":"function","function":{"name":"search","arguments":"{\\"q\\":\\"test\\"}"}}]}',
      'data: {"type":"done","ok":true,"text":"","toolCalls":[{"id":"call_abc","type":"function","function":{"name":"search","arguments":"{\\"q\\":\\"test\\"}"}}],"usage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}}',
    ].join("\n\n") + "\n\n";

    const response = new Response(toolCallStream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const stream = wrapPerchCompletionStream(response, "pro");
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }

    expect(text).toContain('"name":"search"');
    expect(text).toContain('"arguments":"{\\"q\\":\\"test\\"}"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain("data: [DONE]");
  });

  it("maps ALIAS_TO_ID and resolves caps via resolveCaps", () => {
    expect(ALIAS_TO_ID["perch"]).toBe("perchai");

    const caps = resolveCaps({}, {}, "perch/gpt-6.1-sol");
    expect(caps).toBeDefined();
    expect(typeof caps.reasoning).toBe("boolean");
    expect(caps.contextWindow).toBeGreaterThan(0);
  });

  it("filters perch models via matchesSearch and populates AI_MODELS", () => {
    const perchModels = AI_MODELS.filter((m) => m.provider === "perch");
    expect(perchModels.length).toBeGreaterThanOrEqual(35);

    const match1 = matchesSearch(perchModels[0], "perch");
    expect(match1).toBe(true);

    const gpt6Model = perchModels.find((m) => m.model === "gpt-6.1-sol");
    expect(gpt6Model).toBeDefined();
    expect(matchesSearch(gpt6Model, "sol")).toBe(true);
    expect(matchesSearch(gpt6Model, "!claude")).toBe(true);
    expect(matchesSearch(gpt6Model, "claude")).toBe(false);
  });

  it("resolves connection proxy for perchai connections", async () => {
    const proxyConfig = await resolveConnectionProxyConfig({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:8080",
    });
    expect(proxyConfig.connectionProxyEnabled).toBe(true);
    expect(proxyConfig.connectionProxyUrl).toBe("http://127.0.0.1:8080");
  });

  it("resolves thinking levels for Perch AI reasoning models", () => {
    const deepseekLevels = getThinkingLevels("perch", "deepseek-v4.1-flash");
    expect(deepseekLevels).toBeDefined();
    expect(deepseekLevels.length).toBeGreaterThan(0);
    expect(deepseekLevels).toContain("high");
  });
});
