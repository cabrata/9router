"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import { Card, Button } from "@/shared/components";
import Pagination from "@/shared/components/Pagination";
import { ENDPOINT_KINDS } from "@/shared/constants/config";

const inputCls = "h-9 px-3 text-sm bg-surface-2 rounded-[10px] text-text-main focus:outline-none focus:ring-2 focus:ring-brand-500/30";

function statusCls(s) {
  if (s >= 500 || s === 499) return "bg-red-500/15 text-red-500";
  if (s >= 400) return "bg-orange-500/15 text-orange-500";
  return "bg-green-500/15 text-green-600";
}

const fmtNum = (n) => (n ? n.toLocaleString() : "0");
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms || 0}ms`);

export default function RequestLogsClient() {
  const [data, setData] = useState({ logs: [], pagination: { totalItems: 0 } });
  const [keys, setKeys] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [filters, setFilters] = useState({ apiKeyId: "", status: "", endpointKind: "", search: "" });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ page, pageSize });
    for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
    try {
      const res = await fetch(`/api/usage/request-log-entries?${qs}`);
      if (res.ok) setData(await res.json());
    } catch { /* keep last data */ }
  }, [page, pageSize, filters]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = autoRefresh ? setInterval(load, 5000) : null;
    return () => { clearTimeout(first); if (t) clearInterval(t); };
  }, [autoRefresh, load]);
  useEffect(() => {
    fetch("/api/keys").then((r) => r.json()).then((d) => setKeys(d.keys || [])).catch(() => {});
  }, []);

  const setFilter = (k, v) => { setPage(1); setFilters((f) => ({ ...f, [k]: v })); };

  const handleClear = async () => {
    if (!confirm("Delete all request logs?")) return;
    await fetch("/api/usage/request-log-entries", { method: "DELETE" });
    load();
  };

  return (
    <div className="flex flex-col gap-4">
      <Card padding="sm">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${inputCls} flex-1 min-w-[180px]`}
            placeholder="Search model, IP, path, provider…"
            aria-label="Search logs"
            value={filters.search}
            onChange={(e) => setFilter("search", e.target.value)}
          />
          <select className={inputCls} aria-label="API key" value={filters.apiKeyId} onChange={(e) => setFilter("apiKeyId", e.target.value)}>
            <option value="">All API keys</option>
            <option value="none">No / unknown key</option>
            {keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
          <select className={inputCls} aria-label="Endpoint type" value={filters.endpointKind} onChange={(e) => setFilter("endpointKind", e.target.value)}>
            <option value="">All endpoints</option>
            {ENDPOINT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <select className={inputCls} aria-label="Status" value={filters.status} onChange={(e) => setFilter("status", e.target.value)}>
            <option value="">All status</option>
            <option value="ok">Success (&lt;400)</option>
            <option value="error">Error (≥400)</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto refresh
          </label>
          <Button size="sm" variant="outline" icon="refresh" onClick={load}>Refresh</Button>
          <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>Clear</Button>
        </div>
      </Card>

      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/5 text-left text-xs text-text-muted">
                <th className="p-3 font-semibold">Time</th>
                <th className="p-3 font-semibold">Status</th>
                <th className="p-3 font-semibold">API Key</th>
                <th className="p-3 font-semibold">IP</th>
                <th className="p-3 font-semibold">Path</th>
                <th className="p-3 font-semibold">Model</th>
                <th className="p-3 font-semibold text-right">In</th>
                <th className="p-3 font-semibold text-right">Out</th>
                <th className="p-3 font-semibold text-right">TPS</th>
                <th className="p-3 font-semibold text-right">TTFT</th>
                <th className="p-3 font-semibold text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {data.logs.length === 0 && (
                <tr><td colSpan={11} className="p-8 text-center text-text-muted">No requests logged yet.</td></tr>
              )}
              {data.logs.map((l) => (
                <Fragment key={l.id}>
                  <tr
                    onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                    className="border-b border-black/[0.03] dark:border-white/[0.03] hover:bg-surface-2 cursor-pointer"
                  >
                    <td className="p-3 whitespace-nowrap text-xs text-text-muted" title={l.timestamp}>{new Date(l.timestamp).toLocaleString()}</td>
                    <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs font-mono font-semibold ${statusCls(l.status)}`}>{l.status}</span></td>
                    <td className="p-3">
                      <div className="text-xs font-medium">{l.apiKeyName || <span className="text-text-muted">{l.apiKeyMasked ? "unknown" : "none"}</span>}</div>
                      {l.apiKeyMasked && <div className="text-[11px] font-mono text-text-muted">{l.apiKeyMasked}</div>}
                    </td>
                    <td className="p-3 font-mono text-xs">{l.ip}</td>
                    <td className="p-3 font-mono text-xs"><span className="text-text-muted">{l.method}</span> {l.path}</td>
                    <td className="p-3 text-xs max-w-[260px]">
                      <div className="truncate" title={l.model}>{l.model || "-"}</div>
                      {l.resolvedModel && l.resolvedModel !== l.model && (
                        <div className="truncate text-[11px] text-text-muted" title={`${l.provider}/${l.resolvedModel}`}>→ {l.provider}/{l.resolvedModel}</div>
                      )}
                    </td>
                    <td className="p-3 text-right font-mono text-xs">{fmtNum(l.promptTokens)}</td>
                    <td className="p-3 text-right font-mono text-xs">{fmtNum(l.completionTokens)}</td>
                    <td className="p-3 text-right font-mono text-xs">{l.tps ? l.tps.toFixed(1) : "-"}</td>
                    <td className="p-3 text-right font-mono text-xs">{l.stream ? fmtMs(l.ttftMs) : "-"}</td>
                    <td className="p-3 text-right font-mono text-xs">{fmtMs(l.durationMs)}</td>
                  </tr>
                  {expanded === l.id && (
                    <tr className="bg-surface-2/50">
                      <td colSpan={11} className="p-3 text-xs">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 font-mono">
                          <div><span className="text-text-muted">Endpoint type:</span> {l.endpointKind}</div>
                          <div><span className="text-text-muted">Stream:</span> {l.stream ? "yes" : "no"}</div>
                          <div><span className="text-text-muted">Provider:</span> {l.provider || "-"}</div>
                          <div><span className="text-text-muted">User-Agent:</span> {l.userAgent || "-"}</div>
                          {l.error && <div className="sm:col-span-2 text-red-500 break-all whitespace-pre-wrap"><span className="text-text-muted">Error:</span> {l.error}</div>}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination
          currentPage={page}
          pageSize={pageSize}
          totalItems={data.pagination?.totalItems || 0}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />
      </Card>
    </div>
  );
}
