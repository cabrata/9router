"use client";

import { useMemo } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { useCountUp } from "./OverviewCards";

const fmt = (n) => new Intl.NumberFormat().format(Math.round(n || 0));
const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;
const fmtPct = (n) => `${(n || 0).toFixed(1)}%`;

function Stat({ label, value, format, className, title }) {
  const display = useCountUp(value);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase text-text-muted">{label}</span>
      <span
        className={`truncate text-sm font-bold tabular-nums ${className || ""}`}
        title={title ?? format(display)}
      >
        {format(display)}
      </span>
    </div>
  );
}

Stat.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.number,
  format: PropTypes.func.isRequired,
  className: PropTypes.string,
  title: PropTypes.string,
};

/**
 * Live secondary stats derived from the recent-request window (same feed as
 * Recent Requests). Window-scoped, not period totals.
 */
export default function LiveStats({ requests = [], pending = {}, activeRequests = [] }) {
  const stats = useMemo(() => {
    const list = Array.isArray(requests) ? requests : [];
    let prompt = 0, output = 0, cached = 0, cost = 0, errors = 0;
    for (const r of list) {
      prompt += r.promptTokens || 0;
      output += r.completionTokens || 0;
      cached += r.cachedTokens || 0;
      cost += r.cost || 0;
      const ok = !r.status || r.status === "ok" || r.status === "success";
      if (!ok) errors++;
    }
    const totalIn = prompt + output;
    const pendingCount = Object.values(pending?.byModel || {}).reduce((s, n) => s + (n || 0), 0);
    return {
      requests: list.length,
      totalIn,
      cacheHit: prompt > 0 ? (cached / prompt) * 100 : 0,
      avgIn: list.length ? prompt / list.length : 0,
      avgOut: list.length ? output / list.length : 0,
      cost,
      costPerReq: list.length ? cost / list.length : 0,
      failRate: list.length ? (errors / list.length) * 100 : 0,
      pendingCount: pendingCount || activeRequests.length,
    };
  }, [requests, pending, activeRequests]);

  return (
    <Card className="min-w-0" padding="sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">Live Stats</span>
        <span className="flex items-center gap-1.5 text-[10px] text-text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
          last {stats.requests} requests
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat label="In + Out" value={stats.totalIn} format={fmt} className="text-primary" />
        <Stat label="Cache Hit" value={stats.cacheHit} format={fmtPct} className="text-info" />
        <Stat label="Avg In / Req" value={stats.avgIn} format={fmt} />
        <Stat label="Avg Out / Req" value={stats.avgOut} format={fmt} className="text-success" />
        <Stat label="Cost (window)" value={stats.cost} format={fmtCost} className="text-warning" />
        <Stat label="Avg Cost / Req" value={stats.costPerReq} format={fmtCost} />
        <Stat label="Fail Rate" value={stats.failRate} format={fmtPct} className={stats.failRate > 0 ? "text-error" : ""} />
        <Stat
          label="In Flight"
          value={stats.pendingCount}
          format={fmt}
          className={stats.pendingCount > 0 ? "text-primary" : ""}
        />
      </div>
    </Card>
  );
}

LiveStats.propTypes = {
  requests: PropTypes.array,
  pending: PropTypes.object,
  activeRequests: PropTypes.array,
};
