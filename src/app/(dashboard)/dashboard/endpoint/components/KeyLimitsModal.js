"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal } from "@/shared/components";

const toLocalDateTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

const displayDate = (value) => value ? new Date(value).toLocaleString() : "Never";

export default function KeyLimitsModal({ apiKey, onClose, onSaved }) {
  const [neverExpires, setNeverExpires] = useState(!apiKey.expiredAt);
  const [expiredAt, setExpiredAt] = useState(toLocalDateTime(apiKey.expiredAt));
  const [limitConcurrent, setLimitConcurrent] = useState(String(apiKey.limitConcurrent || 0));
  const [rpm, setRpm] = useState(String(apiKey.rpm || 0));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const monitoring = apiKey.monitoring || {};

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/keys/${apiKey.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expiredAt: neverExpires ? null : new Date(expiredAt).toISOString(),
          limitConcurrent: Number(limitConcurrent) || 0,
          rpm: Number(rpm) || 0,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save limits");
      onSaved(data.key);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen title={`Limits: ${apiKey.name}`} onClose={onClose} size="lg">
      <div className="flex flex-col gap-5">
        <section aria-labelledby="key-monitoring-heading">
          <h3 id="key-monitoring-heading" className="text-sm font-semibold mb-2">Live monitoring</h3>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              ["Active", monitoring.activeRequests ?? 0],
              ["Last minute", monitoring.requestsLastMinute ?? 0],
              ["Last 24 hours", monitoring.requestsLast24h ?? 0],
              ["Errors (24h)", monitoring.errorsLast24h ?? 0],
            ].map(([label, value]) => (
              <div key={label} className="bg-surface-2 rounded-[10px] p-3 min-w-0">
                <dt className="text-xs text-text-muted">{label}</dt>
                <dd className="text-lg font-semibold mt-0.5 tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-text-muted mt-2">
            Last request: {monitoring.lastRequestAt ? new Date(monitoring.lastRequestAt).toLocaleString() : "No requests recorded"}
          </p>
        </section>

        <section aria-labelledby="key-limits-heading" className="flex flex-col gap-4">
          <h3 id="key-limits-heading" className="text-sm font-semibold">Request limits</h3>
          <label className="flex items-center gap-3 min-h-11 cursor-pointer">
            <input
              type="checkbox"
              checked={neverExpires}
              onChange={(e) => setNeverExpires(e.target.checked)}
              className="size-4 accent-brand-500"
            />
            <span className="text-sm">Never expires</span>
          </label>
          {!neverExpires && (
            <Input
              label="Expires at"
              type="datetime-local"
              value={expiredAt}
              onChange={(e) => setExpiredAt(e.target.value)}
              required
            />
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Concurrent request limit"
              type="number"
              min="0"
              step="1"
              value={limitConcurrent}
              onChange={(e) => setLimitConcurrent(e.target.value)}
              hint="0 means unlimited"
            />
            <Input
              label="Requests per minute"
              type="number"
              min="0"
              step="1"
              value={rpm}
              onChange={(e) => setRpm(e.target.value)}
              hint="0 means unlimited"
            />
          </div>
          <p className="text-xs text-text-muted">Current expiration: {displayDate(apiKey.expiredAt)}</p>
        </section>

        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!neverExpires && !expiredAt}>Save limits</Button>
        </div>
      </div>
    </Modal>
  );
}

KeyLimitsModal.propTypes = {
  apiKey: PropTypes.object.isRequired,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func.isRequired,
};
