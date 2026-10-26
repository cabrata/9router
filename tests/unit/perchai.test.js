import { describe, it, expect } from "vitest";
import REGISTRY from "open-sse/providers/registry/index.js";
import { getExecutor } from "open-sse/executors/index.js";
import { PROVIDER_MODELS, getDefaultModel, isValidModel } from "open-sse/config/providerModels.js";
import {
  PerchAiExecutor,
  buildPerchRequestBody,
  wrapPerchCompletionStream,
  wrapPerchNonStreaming,
  resolvePerchToken,
} from "open-sse/executors/perchai.js";
import perchaiOAuth from "@/lib/oauth/providers/perchai.js";
import { OAUTH_PROVIDERS } from "@/shared/constants/providers.js";
import { resolveProviderIconId } from "@/shared/utils/providerIcon.js";

describe("Perch AI Provider Integration", () => {
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
    expect(mapped.accessToken).toBe("jwt_token_123");
    expect(mapped.refreshToken).toBe("refresh_token_456");
    expect(mapped.email).toBe("user@perchai.app");
    expect(mapped.providerSpecificData.userId).toBe("uid_1");
  });
});
