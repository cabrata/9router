"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live usage feed from /api/usage/stream.
 *
 * Reconnects whenever `period` changes (previous payload is dropped, since its
 * totals belong to the old period). Returns the latest merged payload:
 *   { stats, activeRequests, recentRequests, errorProvider, summary, period, lastLive }
 * `lastLive` is the most recently written usage row (null until one arrives).
 * `onLive(row)` fires for each such row, for consumers outside this state.
 *
 * Message types are documented in the route (src/app/api/usage/stream/route.js).
 */
export default function useUsageStream(period = "today", { onLive } = {}) {
  const [data, setData] = useState(null);
  const onLiveRef = useRef(onLive);

  useEffect(() => {
    onLiveRef.current = onLive;
  }, [onLive]);

  useEffect(() => {
    const requested = period;
    const es = new EventSource(`/api/usage/stream?period=${encodeURIComponent(requested)}`);

    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      if (msg.type === "live") {
        if (msg.period !== requested) return;
        onLiveRef.current?.(msg.row);
        setData((prev) => ({
          ...(prev || {}),
          summary: msg.summary || prev?.summary || null,
          period: msg.period,
          lastLive: msg.row,
        }));
        return;
      }

      setData((prev) => {
        const next = { ...(prev || {}), period: msg.period ?? prev?.period };
        if (next.period !== requested) return prev; // message for a stale period
        if (msg.stats) {
          next.stats = msg.stats;
          next.activeRequests = msg.activeRequests;
          next.recentRequests = msg.recentRequests;
          next.errorProvider = msg.errorProvider;
        }
        if (msg.type === "events") {
          next.activeRequests = msg.activeRequests;
          next.recentRequests = msg.recentRequests;
          next.errorProvider = msg.errorProvider;
        }
        if (msg.summary) next.summary = msg.summary;
        return next;
      });
    };

    return () => es.close();
  }, [period]);

  // Totals from another period are stale by definition; drop them here instead
  // of resetting state from an effect.
  return data?.period === period ? data : null;
}
