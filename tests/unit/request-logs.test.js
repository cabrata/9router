// Request logs + per-key permissions: wrapper logs key/IP/path/tokens/TPS and enforces allow-lists.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, rl, repo, key;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-reqlog-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  rl = await import("@/lib/requestLog.js");
  repo = await import("@/lib/db/repos/requestLogsRepo.js");
  key = await db.createApiKey("Team A", "machine-1");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const req = (model, extra = {}) => new Request("http://localhost/api/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json", "x-forwarded-for": "10.1.2.3", ...extra },
  body: JSON.stringify({ model, messages: [] }),
});

async function latest() {
  await new Promise((r) => setTimeout(r, 20));
  return (await repo.getRequestLogs({ pageSize: 1 })).logs[0];
}

describe("request logs", () => {
  it("pure helpers", () => {
    expect(rl.isModelAllowed("cc/opus", [])).toBe(true);
    expect(rl.isModelAllowed("cc/opus", ["cc/*"])).toBe(true);
    expect(rl.isModelAllowed("cc/opus[1m]", ["cc/opus"])).toBe(true);
    expect(rl.isModelAllowed("gh/gpt", ["cc/*"])).toBe(false);
    expect(rl.isEndpointAllowed("chat", ["embeddings"])).toBe(false);
    expect(rl.computeTps(100, 3000, 1000, true)).toBe(50);
  });

  it("logs a streamed request with tokens from saveRequestUsage", async () => {
    const handler = rl.withRequestLog("chat", async () => {
      const stream = new ReadableStream({
        async start(c) {
          c.enqueue(new TextEncoder().encode("data: hi\n\n"));
          await new Promise((r) => setTimeout(r, 30));
          db.saveRequestUsage({ provider: "claude", model: "opus", tokens: { prompt_tokens: 12, completion_tokens: 34 } });
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    const res = await handler(req("cc/opus"));
    await res.text();
    const log = await latest();
    expect(log).toMatchObject({
      status: 200, apiKeyId: key.id, apiKeyName: "Team A", ip: "10.1.2.3",
      path: "/v1/chat/completions", model: "cc/opus", provider: "claude", resolvedModel: "opus",
      promptTokens: 12, completionTokens: 34, stream: true, endpointKind: "chat",
    });
    expect(log.tps).toBeGreaterThan(0);
  });

  it("denies models / endpoints outside the key's allow-list with 403", async () => {
    await db.updateApiKey(key.id, { allowedModels: ["cc/*"], allowedEndpoints: ["chat"] });
    const inner = vi.fn(async () => new Response("{}"));
    const res = await rl.withRequestLog("chat", inner)(req("gh/gpt-5"));
    expect(res.status).toBe(403);
    expect(inner).not.toHaveBeenCalled();
    expect((await latest()).status).toBe(403);

    const res2 = await rl.withRequestLog("embeddings", inner)(req("cc/opus"));
    expect(res2.status).toBe(403);

    const ok = await rl.withRequestLog("chat", inner)(req("cc/sonnet"));
    expect(ok.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
