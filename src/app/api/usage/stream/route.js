import { getUsageStats, getActiveRequests, getRealtimeSummary, statsEmitter } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

// Keep in sync with getRealtimeSummary's window rules (periods whose cached
// totals can be patched by one row; the others must be re-read).
const patchable = (period, ts) => {
  if (period === "24h") return ts >= Date.now() - 86400000;
  if (period === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return ts >= start.getTime();
  }
  return true;
};

const addRow = (summary, row) => {
  summary.totalRequests += 1;
  summary.totalPromptTokens += row.promptTokens || 0;
  summary.totalCompletionTokens += row.completionTokens || 0;
  summary.totalCachedTokens += row.cachedTokens || 0;
  summary.totalCost += row.cost || 0;
  return summary;
};

/**
 * Realtime usage feed.
 *
 * `?period=` selects the totals slice carried by each push. Messages:
 *   stats   - full getUsageStats() payload (on connect and on `update` events)
 *   events  - lightweight activeRequests/recentRequests (on `pending` events)
 *   summary - period totals (on `update` events and period switches)
 *   live    - one just-written row, already applied to `summary`
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const periodParam = searchParams.get("period") || "today";
  const encoder = new TextEncoder();
  const state = {
    closed: false,
    keepalive: null,
    controller: null,
    period: VALID_PERIODS.has(periodParam) ? periodParam : "today",
    summary: null,
  };

  const enqueue = (payload) => {
    state.controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };

  const cleanup = () => {
    state.closed = true;
    statsEmitter.off("update", pushSummary);
    statsEmitter.off("pending", pushEvents);
    statsEmitter.off("live", onLive);
    clearInterval(state.keepalive);
  };

  const pushStats = async () => {
    if (state.closed) return;
    try {
      const stats = await getUsageStats();
      state.summary = await getRealtimeSummary(state.period);
      enqueue({
        type: "stats",
        period: state.period,
        stats,
        activeRequests: stats.activeRequests || [],
        recentRequests: stats.recentRequests || [],
        errorProvider: stats.errorProvider || "",
        summary: state.summary,
      });
    } catch {
      cleanup();
    }
  };

  const pushSummary = async () => {
    if (state.closed) return;
    try {
      state.summary = await getRealtimeSummary(state.period);
      enqueue({ type: "summary", period: state.period, summary: state.summary });
    } catch {
      cleanup();
    }
  };

  const pushEvents = async () => {
    if (state.closed) return;
    try {
      const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
      enqueue({ type: "events", activeRequests, recentRequests, errorProvider });
    } catch {
      cleanup();
    }
  };

  const onLive = (row) => {
    if (state.closed) return;
    // Patch the cached totals for a fast tick; the following `update` event
    // re-reads from the DB, so unpatched windows stay correct.
    const ts = new Date(row.timestamp).getTime();
    const summary = state.summary && patchable(state.period, ts) && ts <= Date.now()
      ? addRow({ ...state.summary }, row)
      : null;
    enqueue({ type: "live", period: state.period, row, summary });
  };

  return new Response(
    new ReadableStream({
      async start(controller) {
        state.controller = controller;
        await pushStats();
        statsEmitter.on("update", pushSummary);
        statsEmitter.on("pending", pushEvents);
        statsEmitter.on("live", onLive);
        state.keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            cleanup();
          }
        }, 25000);
      },
      cancel() {
        cleanup();
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
}
