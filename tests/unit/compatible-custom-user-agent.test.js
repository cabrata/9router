import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";

const originalDataDir = process.env.DATA_DIR;

describe("compatible providers custom User-Agent", () => {
  describe("DefaultExecutor.buildHeaders()", () => {
    it("sets User-Agent from credentials.providerSpecificData.userAgent for openai-compatible", () => {
      const executor = new DefaultExecutor("openai-compatible-chat-1234");
      const headers = executor.buildHeaders({
        apiKey: "sk-test",
        providerSpecificData: {
          baseUrl: "https://compat.example.com/v1",
          userAgent: "codex_cli_rs/0.167.1",
        },
      });

      expect(headers["User-Agent"]).toBe("codex_cli_rs/0.167.1");
      expect(headers["Authorization"]).toBe("Bearer sk-test");
    });

    it("sets User-Agent from credentials.providerSpecificData.userAgent for anthropic-compatible", () => {
      const executor = new DefaultExecutor("anthropic-compatible-abcd");
      const headers = executor.buildHeaders({
        apiKey: "sk-ant-test",
        providerSpecificData: {
          baseUrl: "https://compat-ant.example.com/v1",
          userAgent: "claude-cli/2.1.322 (external, sdk-cli)",
        },
      });

      expect(headers["User-Agent"]).toBe("claude-cli/2.1.322 (external, sdk-cli)");
      expect(headers["x-api-key"]).toBe("sk-ant-test");
    });

    it("falls back to client rawHeaders user-agent if custom userAgent not configured", () => {
      const executor = new DefaultExecutor("openai-compatible-chat-5678");
      const headers = executor.buildHeaders({
        apiKey: "sk-test",
        providerSpecificData: {
          baseUrl: "https://compat.example.com/v1",
        },
        rawHeaders: {
          "user-agent": "cursor/0.45.0",
        },
      });

      expect(headers["User-Agent"]).toBe("cursor/0.45.0");
    });

    it("prefers custom userAgent over client rawHeaders user-agent", () => {
      const executor = new DefaultExecutor("openai-compatible-chat-5678");
      const headers = executor.buildHeaders({
        apiKey: "sk-test",
        providerSpecificData: {
          baseUrl: "https://compat.example.com/v1",
          userAgent: "Claude Code",
        },
        rawHeaders: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
      });

      expect(headers["User-Agent"]).toBe("Claude Code");
    });
  });

  describe("BaseExecutor.buildHeaders()", () => {
    it("sets User-Agent for openai-compatible and anthropic-compatible", () => {
      const executor = new BaseExecutor("openai-compatible-responses-9999", {});
      const headers = executor.buildHeaders({
        apiKey: "sk-test",
        providerSpecificData: {
          userAgent: "Trae/1.0.0",
        },
      });

      expect(headers["User-Agent"]).toBe("Trae/1.0.0");
    });
  });

  describe("openaiCompatNode embedding adapter", () => {
    it("includes custom User-Agent in buildHeaders", async () => {
      const { default: adapter } = await import("../../open-sse/handlers/embeddingProviders/openaiCompatNode.js");
      const headers = adapter.buildHeaders({
        apiKey: "sk-embed",
        providerSpecificData: {
          baseUrl: "https://embed.test/v1",
          userAgent: "Custom-Embed-Client/1.0",
        },
      });

      expect(headers["User-Agent"]).toBe("Custom-Embed-Client/1.0");
      expect(headers["Authorization"]).toBe("Bearer sk-embed");
    });
  });

  describe("execute() header overrides precedence", () => {
    it("prioritizes providerOverrides.headers over node userAgent", async () => {
      const executor = new DefaultExecutor("openai-compatible-chat-override-test");
      let sentHeaders = null;
      vi.spyOn(executor, "buildUrl").mockReturnValue("https://compat.test/v1/chat/completions");

      const directFetch = vi.fn(async (url, init = {}) => {
        sentHeaders = init.headers;
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      });

      await executor.execute({
        model: "gpt-6-astra",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        directFetch,
        credentials: {
          apiKey: "sk-key",
          providerSpecificData: {
            baseUrl: "https://compat.test/v1",
            userAgent: "Node-UA/1.0",
          },
          rawHeaders: {
            "user-agent": "Downstream-UA/1.0",
          },
        },
        providerOverrides: {
          headers: {
            "User-Agent": "Override-UA/2.0",
          },
        },
      });

      expect(sentHeaders["User-Agent"]).toBe("Override-UA/2.0");
    });
  });

  describe("provider-nodes & connection lifecycle with userAgent", () => {
    let tempDir;
    let cleanup = () => {};

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-compat-ua-"));
      process.env.DATA_DIR = tempDir;
      vi.resetModules();
    });

    afterEach(() => {
      cleanup();
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
    });

    it("creates node with userAgent and propagates to connection", async () => {
      vi.doMock("next/server", () => ({
        NextResponse: {
          json(body, init = {}) {
            return new Response(JSON.stringify(body), {
              status: init.status || 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        },
      }));

      const { POST: createConnection } = await import("@/app/api/providers/route.js");
      const { createProviderNode, getProviderConnections } = await import("@/models/index.js");
      const { PUT: updateNode } = await import("@/app/api/provider-nodes/[id]/route.js");

      // 1. Create provider node with custom userAgent
      const node = await createProviderNode({
        id: "openai-compatible-chat-ua-test",
        type: "openai-compatible",
        name: "UA Test Node",
        prefix: "uatest",
        apiType: "chat",
        baseUrl: "https://compat.test/v1",
        userAgent: "codex_cli_rs/0.167.1",
      });

      expect(node.userAgent).toBe("codex_cli_rs/0.167.1");

      // 2. Create connection for this node
      const req = new Request("https://9router.local/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: node.id,
          apiKey: "sk-secret",
          name: "Test Connection",
          defaultModel: "gpt-6-astra",
        }),
      });

      const res = await createConnection(req);
      expect(res.status).toBe(201);
      const conns = await getProviderConnections({ provider: node.id });
      expect(conns).toHaveLength(1);
      expect(conns[0].providerSpecificData.userAgent).toBe("codex_cli_rs/0.167.1");

      // 3. Update node userAgent and verify connection is updated
      const updateReq = new Request(`https://9router.local/api/provider-nodes/${node.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "UA Test Node Renamed",
          prefix: "uatest",
          baseUrl: "https://compat.test/v1",
          apiType: "chat",
          userAgent: "claude-cli/2.1.322",
        }),
      });

      const putRes = await updateNode(updateReq, { params: Promise.resolve({ id: node.id }) });
      expect(putRes.status).toBe(200);

      const updatedConns = await getProviderConnections({ provider: node.id });
      expect(updatedConns[0].providerSpecificData.userAgent).toBe("claude-cli/2.1.322");

      // 4. Update node with empty userAgent to clear it
      const clearReq = new Request(`https://9router.local/api/provider-nodes/${node.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "UA Test Node",
          prefix: "uatest",
          baseUrl: "https://compat.test/v1",
          apiType: "chat",
          userAgent: "",
        }),
      });

      const clearRes = await updateNode(clearReq, { params: Promise.resolve({ id: node.id }) });
      expect(clearRes.status).toBe(200);
      const clearedConns = await getProviderConnections({ provider: node.id });
      expect(clearedConns[0].providerSpecificData.userAgent).toBeNull();
    });

    it("propagates userAgent for anthropic-compatible and custom-embedding nodes", async () => {
      vi.doMock("next/server", () => ({
        NextResponse: {
          json(body, init = {}) {
            return new Response(JSON.stringify(body), {
              status: init.status || 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        },
      }));

      const { POST: createConnection } = await import("@/app/api/providers/route.js");
      const { createProviderNode, getProviderConnections } = await import("@/models/index.js");

      // Anthropic-compatible
      const antNode = await createProviderNode({
        id: "anthropic-compatible-ua-test",
        type: "anthropic-compatible",
        name: "Anthropic Node",
        prefix: "ant",
        baseUrl: "https://anthropic.test/v1",
        userAgent: "claude-code/1.0.0",
      });

      const antReq = new Request("https://9router.local/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: antNode.id,
          apiKey: "sk-ant",
          name: "Ant Connection",
        }),
      });
      await createConnection(antReq);
      const antConns = await getProviderConnections({ provider: antNode.id });
      expect(antConns[0].providerSpecificData.userAgent).toBe("claude-code/1.0.0");

      // Custom embedding
      const embNode = await createProviderNode({
        id: "custom-embedding-ua-test",
        type: "custom-embedding",
        name: "Embed Node",
        prefix: "emb",
        baseUrl: "https://embed.test/v1",
        userAgent: "voyage/2.0.0",
      });

      const embReq = new Request("https://9router.local/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: embNode.id,
          apiKey: "sk-emb",
          name: "Emb Connection",
        }),
      });
      await createConnection(embReq);
      const embConns = await getProviderConnections({ provider: embNode.id });
      expect(embConns[0].providerSpecificData.userAgent).toBe("voyage/2.0.0");
    });

    it("sends User-Agent during validation for openai, anthropic, and custom-embedding", async () => {
      vi.doMock("next/server", () => ({
        NextResponse: {
          json(body, init = {}) {
            return new Response(JSON.stringify(body), {
              status: init.status || 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        },
      }));

      const interceptedHeaders = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url, init = {}) => {
        interceptedHeaders.push(init.headers || {});
        return new Response(JSON.stringify({ data: [{ id: "test-model", embedding: [0.1, 0.2] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      try {
        const { POST: validateNode } = await import("@/app/api/provider-nodes/validate/route.js");

        // 1. OpenAI compatible
        const reqOpenAI = new Request("https://9router.local/api/provider-nodes/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: "https://compat.example.com/v1",
            apiKey: "sk-test",
            type: "openai-compatible",
            userAgent: "Codex/1.0.0",
          }),
        });
        const resOpenAI = await validateNode(reqOpenAI);
        expect((await resOpenAI.json()).valid).toBe(true);
        expect(interceptedHeaders[0]["User-Agent"]).toBe("Codex/1.0.0");

        // 2. Anthropic compatible
        const reqAnthropic = new Request("https://9router.local/api/provider-nodes/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: "https://anthropic.example.com/v1",
            apiKey: "sk-ant",
            type: "anthropic-compatible",
            userAgent: "Claude Code",
          }),
        });
        const resAnthropic = await validateNode(reqAnthropic);
        expect((await resAnthropic.json()).valid).toBe(true);
        expect(interceptedHeaders[1]["User-Agent"]).toBe("Claude Code");

        // 3. Custom embedding
        const reqEmbed = new Request("https://9router.local/api/provider-nodes/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: "https://embed.example.com/v1",
            apiKey: "sk-emb",
            type: "custom-embedding",
            modelId: "text-embed-3",
            userAgent: "Embed-Tester/1.0",
          }),
        });
        const resEmbed = await validateNode(reqEmbed);
        expect((await resEmbed.json()).valid).toBe(true);
        expect(interceptedHeaders[2]["User-Agent"]).toBe("Embed-Tester/1.0");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
