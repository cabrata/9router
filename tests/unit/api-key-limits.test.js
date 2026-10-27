import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, logs, requestLog;

const requestFor = (key) => new Request("http://localhost/api/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "test/model" }),
});

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-limits-"));
  process.env.DATA_DIR = tempDir;
  delete globalThis._dbAdapter;
  delete globalThis.__9rKeyRequestState;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  logs = await import("@/lib/db/repos/requestLogsRepo.js");
  requestLog = await import("@/lib/requestLog.js");
  await db.initDb();
});

afterAll(() => {
  try { globalThis._dbAdapter?.instance?.close?.(); } catch {}
  delete globalThis._dbAdapter;
  delete globalThis.__9rKeyRequestState;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API key expiration and request limits", () => {
  it("validates, persists, exports, imports, and enforces expiration", async () => {
    expect(() => db.normalizeApiKeyLimits({ expiredAt: "tomorrow" })).toThrow(/ISO date-time/);
    expect(() => db.normalizeApiKeyLimits({ rpm: 1.5 })).toThrow(/integer/);
    expect(() => db.normalizeApiKeyLimits({ limitConcurrent: 1_000_001 })).toThrow(/1000000/);

    const expiredAt = "2020-01-01T00:00:00.000Z";
    const key = await db.createApiKey("expired", "machine", { expiredAt, limitConcurrent: 2, rpm: 3 });
    expect(await db.getApiKeyById(key.id)).toMatchObject({ expiredAt, limitConcurrent: 2, rpm: 3 });
    expect(await db.validateApiKey(key.key)).toBe(false);

    const denied = await requestLog.withRequestLog("chat", vi.fn())(requestFor(key.key));
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("expired");

    const dump = await db.exportDb();
    await db.importDb(dump);
    expect(await db.getApiKeyById(key.id)).toMatchObject({ expiredAt, limitConcurrent: 2, rpm: 3 });
  });

  it("holds concurrency until completion or cancellation and enforces RPM", async () => {
    const key = await db.createApiKey("limited", "machine", { limitConcurrent: 1, rpm: 2 });
    let controllers = [];
    const handler = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controllers.push(controller);
        controller.enqueue(new TextEncoder().encode("open"));
      },
    })));
    const wrapped = requestLog.withRequestLog("chat", handler);

    const first = await wrapped(requestFor(key.key));
    expect((await logs.getApiKeyMonitoring(key.id)).activeRequests).toBe(1);
    const concurrent = await wrapped(requestFor(key.key));
    expect(concurrent.status).toBe(429);
    expect(await concurrent.text()).toContain("concurrent request limit");

    await first.body.cancel();
    expect((await logs.getApiKeyMonitoring(key.id)).activeRequests).toBe(0);

    const second = await wrapped(requestFor(key.key));
    controllers.at(-1).close();
    await second.text();
    expect((await logs.getApiKeyMonitoring(key.id)).activeRequests).toBe(0);

    const rpm = await wrapped(requestFor(key.key));
    expect(rpm.status).toBe(429);
    expect(rpm.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await rpm.text()).toContain("requests-per-minute");

    await new Promise((resolve) => setTimeout(resolve, 20));
    const monitoring = await logs.getApiKeyMonitoring(key.id);
    expect(monitoring).toMatchObject({ activeRequests: 0, requestsLastMinute: 2 });
    expect(monitoring.requestsLast24h).toBeGreaterThanOrEqual(3);
    expect(monitoring.errorsLast24h).toBeGreaterThanOrEqual(2);
    expect(monitoring.lastRequestAt).toMatch(/^\d{4}-/);
  });
});
