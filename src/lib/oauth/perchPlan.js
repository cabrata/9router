// Perch AI plan setup — the "pick a plan" step the Perch CLI performs at first
// login. Every Perch API call fails with 403 tier_selection_required until the
// account has a plan, so 9router mirrors the CLI setup prompt instead of making
// users discover https://chat.perchai.app on their own.
//
// Flow (mirrors `perch login` → setup):
//   1. `getPerchPlanStatus` probes the token (no spend) and reports whether a
//      plan is still required, plus which plan the account currently has.
//   2. `claimPerchPlan` sends the CLI's own plan selection, so the web dashboard
//      does not have to be opened manually.
//   3. The chosen plan is stored in providerSpecificData.perchPlan and sent as
//      roostModelChoice on every call (same as ~/.perch/cli-settings.json).

import {
  probePerchPlan,
  choosePerchStarterPlan,
  rememberPerchPlan,
  perchPlanCache,
  perchPlanNotice,
  PERCH_CLI_PLAN_PATH,
  PERCH_TIER_GATE_CODE,
} from "open-sse/executors/perchai.js";
import { getProviderConnections, updateProviderConnection } from "@/models";

export const PERCH_PLAN_OPTIONS = [
  {
    id: "starter",
    label: "Starter (Free)",
    roostChoice: "starter",
    description: "Free tier with starter models (DeepSeek/GLM/MiniMax flash, Beam).",
    free: true,
  },
  {
    id: "pro",
    label: "Pro",
    roostChoice: "pro",
    description: "Auto routing across the full frontier model list, plus Pro 1M context.",
    free: false,
  },
];

export const PERCH_PLAN_CHOICES = new Set(PERCH_PLAN_OPTIONS.map((p) => p.roostChoice));

const PLAN_LABELS = {
  starter: "Starter",
  standard: "Standard",
  pro: "Pro",
  standard_max: "Standard 1M",
  pro_max: "Pro 1M",
};

export function describePerchPlan(plan) {
  if (!plan) return null;
  return PLAN_LABELS[plan] || String(plan);
}

export function getPerchConnectionToken(connection) {
  return connection?.apiKey || connection?.accessToken || null;
}

export function getPerchAppUrl(connection) {
  return connection?.providerSpecificData?.appUrl || "https://app.perchai.app";
}

function maskToken(token) {
  if (!token || typeof token !== "string") return null;
  return token.length <= 12 ? "…" : `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/**
 * Resolve an existing perchai connection by id (preferred) or the first active one.
 */
export async function resolvePerchConnection({ connectionId = null } = {}) {
  const connections = await getProviderConnections({ provider: "perchai" });
  if (!Array.isArray(connections) || connections.length === 0) return null;
  if (connectionId) {
    return connections.find((c) => c.id === connectionId) || null;
  }
  return connections.find((c) => c.isActive !== false) || connections[0];
}

export async function getPerchPlanStatus(connection, fetchImpl = globalThis.fetch) {
  const token = getPerchConnectionToken(connection);
  if (!token) {
    return { ok: false, error: "Perch AI connection has no access token", status: 400 };
  }
  const appUrl = getPerchAppUrl(connection);
  const state = await probePerchPlan(appUrl, token, fetchImpl, null);
  return {
    ok: true,
    required: !!state.required,
    // Only the upstream answer counts; a plan stored in providerSpecificData is the
    // local preference and must not be presented as the account's actual plan.
    plan: state.plan || null,
    planLabel: describePerchPlan(state.plan),
    notice: state.required ? state.notice : null,
    noticeVersion: state.noticeVersion || null,
    errorCode: state.required ? PERCH_TIER_GATE_CODE : null,
    signupUrl: state.proUrl || "https://chat.perchai.app",
    options: PERCH_PLAN_OPTIONS,
  };
}

// Plan selection is the CLI's own `cli-plan` POST: { plan, noticeVersion }.
// The previous implementation guessed at /plan, /roost-plan and /cli-context,
// none of which exist, so every claim "succeeded" while the gate stayed shut.
// Only Starter can be selected through the API; Pro is a link to `proUrl`.

export async function claimPerchPlan({ connectionId = null, plan = "starter", fetchImpl = globalThis.fetch } = {}) {
  const roostChoice = String(plan || "").trim().toLowerCase();
  if (!PERCH_PLAN_CHOICES.has(roostChoice)) {
    return {
      ok: false,
      status: 400,
      error: `Unknown Perch plan "${plan}". Choose one of: ${[...PERCH_PLAN_CHOICES].join(", ")}`,
      options: PERCH_PLAN_OPTIONS,
    };
  }

  const connection = await resolvePerchConnection({ connectionId });
  if (!connection) {
    return { ok: false, status: 404, error: "Perch AI connection not found. Connect a Perch AI account first." };
  }
  const token = getPerchConnectionToken(connection);
  if (!token) {
    return { ok: false, status: 400, error: "Perch AI connection has no access token" };
  }

  const appUrl = getPerchAppUrl(connection);

  if (roostChoice !== "starter") {
    // The terminal API only selects Starter; the CLI renders Pro as a link.
    return {
      ok: false,
      status: 400,
      error: "Perch only allows selecting the Starter plan from the terminal API. Open chat.perchai.app to upgrade to Pro.",
      errorCode: PERCH_TIER_GATE_CODE,
      signupUrl: "https://chat.perchai.app",
      plan: roostChoice,
      needsManualSelection: true,
      options: PERCH_PLAN_OPTIONS,
    };
  }

  // Ask Perch first: the gate is decided server-side, so persisting a choice
  // before the server accepts it just hid the failure behind a saved label.
  const state = await probePerchPlan(appUrl, token, fetchImpl, null);
  const selection = await choosePerchStarterPlan(appUrl, token, state.noticeVersion, fetchImpl, null);

  const existingData = connection.providerSpecificData || {};
  if (!selection.ok) {
    rememberPerchPlan(token, { required: true, plan: null, notice: state.notice });
    return {
      ok: false,
      status: selection.status >= 400 ? 409 : 502,
      error: state.notice || selection.error,
      detail: selection.error,
      errorCode: selection.errorCode || PERCH_TIER_GATE_CODE,
      signupUrl: state.proUrl || "https://chat.perchai.app",
      plan: roostChoice,
      needsManualSelection: true,
      connectionSaved: false,
      options: PERCH_PLAN_OPTIONS,
    };
  }

  // Accepted: record the choice on the connection and re-read the gate.
  const chosen = PERCH_PLAN_OPTIONS.find((p) => p.roostChoice === roostChoice);
  const saved = await updateProviderConnection(connection.id, {
    providerSpecificData: {
      ...existingData,
      perchPlan: roostChoice,
      perchPlanLabel: chosen?.label || describePerchPlan(roostChoice),
      perchPlanSelectedAt: new Date().toISOString(),
      perchPlanNotice: null,
    },
    lastError: null,
  }).catch(() => null);

  perchPlanCache.delete(token);
  const confirmed = await probePerchPlan(appUrl, token, fetchImpl, null);
  if (confirmed.required) {
    return {
      ok: false,
      status: 409,
      error: confirmed.notice || perchPlanNotice(),
      errorCode: PERCH_TIER_GATE_CODE,
      signupUrl: confirmed.proUrl || "https://chat.perchai.app",
      plan: roostChoice,
      needsManualSelection: true,
      connectionSaved: !!saved,
      options: PERCH_PLAN_OPTIONS,
    };
  }

  rememberPerchPlan(token, { required: false, plan: roostChoice, notice: "" });
  return {
    ok: true,
    required: false,
    plan: roostChoice,
    planLabel: describePerchPlan(roostChoice),
    alreadyChosen: selection.alreadyChosen === true,
    appliedVia: PERCH_CLI_PLAN_PATH,
    connectionSaved: !!saved,
    token: maskToken(token),
    options: PERCH_PLAN_OPTIONS,
  };
}
