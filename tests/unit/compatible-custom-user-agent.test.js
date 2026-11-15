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
    });

    it("sends User-Agent during validation when userAgent is provided", async () => {
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
        return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      try {
        const { POST: validateNode } = await import("@/app/api/provider-nodes/validate/route.js");

        const req = new Request("https://9router.local/api/provider-nodes/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: "https://compat.example.com/v1",
            apiKey: "sk-test",
            type: "openai-compatible",
            userAgent: "Codex/1.0.0",
          }),
        });

        const res = await validateNode(req);
        const data = await res.json();
        expect(data.valid).toBe(true);
        expect(interceptedHeaders).toHaveLength(1);
        expect(interceptedHeaders[0]["User-Agent"]).toBe("Codex/1.0.0");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
