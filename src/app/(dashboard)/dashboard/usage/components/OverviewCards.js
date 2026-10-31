"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(Math.round(n || 0));
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

/**
 * Animate a number toward `value` (ease-out). Values outside a 20x jump snap
 * instead of counting, so a period switch does not show a meaningless sweep.
 */
function useCountUp(value, duration = 700) {
  const [display, setDisplay] = useState(value || 0);
  const fromRef = useRef(value || 0);

  useEffect(() => {
    const from = fromRef.current;
    const to = value || 0;
    if (from === to) return;

    const ratio = from > 0 && to > 0 ? to / from : 1;
    if (ratio > 20 || ratio < 0.05) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }

    let raf;
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const current = from + (to - from) * eased;
      fromRef.current = current;
      setDisplay(current);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return display;
}

function StatCard({ label, value, format, className, title, footnote }) {
  const display = useCountUp(value);
  const text = format(display);
  return (
    <Card className="flex min-w-0 flex-col items-center text-center gap-1 px-3 py-3 sm:px-4">
      <span className="text-text-muted text-xs uppercase font-semibold sm:text-sm">{label}</span>
      <span
        className={`w-full truncate text-lg font-bold tabular-nums ${className || ""} xl:text-xl`}
        title={title ?? text}
      >
        {text}
      </span>
      {footnote && <span className="text-[10px] text-text-muted">{footnote}</span>}
    </Card>
  );
}

StatCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.number,
  format: PropTypes.func.isRequired,
  className: PropTypes.string,
  title: PropTypes.string,
  footnote: PropTypes.string,
};

export default function OverviewCards({ stats }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4">
      <StatCard label="Total Requests" value={stats.totalRequests} format={fmt} />
      <StatCard label="Total Input Tokens" value={stats.totalPromptTokens} format={fmt} className="text-primary" />
      <StatCard label="Cached Tokens" value={stats.totalCachedTokens} format={fmt} className="text-info" />
      <StatCard label="Output Tokens" value={stats.totalCompletionTokens} format={fmt} className="text-success" />
      <StatCard
        label="Est. Cost"
        value={stats.totalCost}
        format={(n) => `~${fmtCost(n)}`}
        className="text-warning"
        title={`~${fmtCost(stats.totalCost)}`}
        footnote="Estimated, not actual billing"
      />
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};

export { useCountUp, fmt, fmtCost };
