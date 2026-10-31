// Custom (openai-compatible / anthropic-compatible) providers are stored in the
// request log under their raw node id ("openai-compatible-chat-<uuid>"), which
// read like noise in the dashboard. Display should show the node's name.
import { describe, expect, it, vi } from "vitest";

const node = { id: "openai-compatible-chat-3ee5320f-33ae-4b42-a3b2-6f4e3a0ad0e8", type: "openai-compatible", name: "My AI", prefix: "my" };

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: async () => ({
    all: () => [{ id: 1, provider: node.id, model: "my/gpt", stream: 1 }, { id: 2, provider: "openai", model: "gpt-4o", stream: 0 }],
    get: () => ({ c: 2 }),
  }),
}));
vi.mock("../../src/lib/db/repos/nodesRepo.js", () => ({ getProviderNodes: async () => [node] }));
vi.mock("../../src/lib/db/repos/aliasRepo.js", () => ({ getModelAliases: async () => ({}) }));

const { getRequestLogs } = await import("../../src/lib/db/repos/requestLogsRepo.js");

describe("request log provider label", () => {
  it("shows the compat node name instead of its id", async () => {
    const { logs } = await getRequestLogs();
    expect(logs[0].provider).toBe("My AI");
    expect(logs[0].stream).toBe(true);
    expect(logs[1].provider).toBe("openai");
  });
});
