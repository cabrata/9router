"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Modal, Button, ModelSelectModal } from "@/shared/components";
import { ENDPOINT_KINDS } from "@/shared/constants/config";

// Edit which models / endpoint types an API key may use. Empty list = unrestricted.
export default function KeyPermissionsModal({ apiKey, onClose, onSaved }) {
  const [models, setModels] = useState(apiKey.allowedModels || []);
  const [endpoints, setEndpoints] = useState(apiKey.allowedEndpoints || []);
  const [manual, setManual] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [activeProviders, setActiveProviders] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/providers").then((r) => r.json()).then((d) => setActiveProviders(d.connections || [])).catch(() => {});
  }, []);

  const addModel = (v) => {
    const s = (v || "").trim();
    if (s) setModels((m) => (m.includes(s) ? m : [...m, s]));
  };
  const toggleEndpoint = (k) => setEndpoints((e) => (e.includes(k) ? e.filter((x) => x !== k) : [...e, k]));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/keys/${apiKey.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedModels: models, allowedEndpoints: endpoints }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      onSaved(data.key);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal isOpen={!showPicker} title={`Permissions: ${apiKey.name || ""}`} onClose={onClose} size="lg">
        <div className="flex flex-col gap-5">
          <div>
            <p className="text-sm font-medium mb-1">Allowed endpoint types</p>
            <p className="text-xs text-text-muted mb-2">None selected = all endpoints allowed.</p>
            <div className="flex flex-wrap gap-2">
              {ENDPOINT_KINDS.map((k) => (
                <label key={k} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs cursor-pointer border ${endpoints.includes(k) ? "border-brand-500 bg-brand-500/10 text-brand-600" : "border-border text-text-muted"}`}>
                  <input type="checkbox" className="sr-only" checked={endpoints.includes(k)} onChange={() => toggleEndpoint(k)} />
                  {k}
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="text-sm font-medium mb-1">Allowed models / combos</p>
            <p className="text-xs text-text-muted mb-2">
              None = all models allowed. Use <code>provider/*</code> to allow every model of a provider (e.g. <code>cc/*</code>).
            </p>
            <div className="flex flex-wrap gap-1.5 mb-2 min-h-[28px]">
              {models.length === 0 && <span className="text-xs text-text-muted italic">All models</span>}
              {models.map((m) => (
                <span key={m} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-2 text-xs font-mono">
                  {m}
                  <button type="button" aria-label={`Remove ${m}`} className="text-text-muted hover:text-red-500" onClick={() => setModels((x) => x.filter((y) => y !== m))}>
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                className="flex-1 h-9 px-3 text-sm bg-surface-2 rounded-[10px] text-text-main font-mono focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                placeholder="provider/model or provider/*"
                aria-label="Add model manually"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { addModel(manual); setManual(""); } }}
              />
              <Button size="md" variant="secondary" onClick={() => { addModel(manual); setManual(""); }}>Add</Button>
              <Button size="md" variant="outline" icon="list" onClick={() => setShowPicker(true)}>Pick</Button>
            </div>
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2">
            <Button onClick={save} loading={saving} fullWidth>Save</Button>
            <Button variant="ghost" onClick={onClose} fullWidth>Cancel</Button>
          </div>
        </div>
      </Modal>
      {showPicker && (
        <ModelSelectModal
          isOpen
          onClose={() => setShowPicker(false)}
          onSelect={(m) => addModel(m?.value)}
          onDeselect={(m) => setModels((x) => x.filter((y) => y !== m?.value))}
          activeProviders={activeProviders}
          title="Allow models"
          addedModelValues={models}
          closeOnSelect={false}
        />
      )}
    </>
  );
}

KeyPermissionsModal.propTypes = {
  apiKey: PropTypes.object.isRequired,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func.isRequired,
};
