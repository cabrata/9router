import { NextResponse } from "next/server";
import { claimPerchPlan, PERCH_PLAN_OPTIONS } from "@/lib/oauth/perchPlan";

export const dynamic = "force-dynamic";

/**
 * POST /api/oauth/perchai/plan/claim
 * Body: { plan: "starter" | "pro", connectionId? }
 *
 * Performs the plan setup step the Perch CLI runs at first login: picks the plan
 * for this account so calls stop failing with 403 tier_selection_required, then
 * verifies the gate is gone. Falls back to "open chat.perchai.app" when Perch
 * does not expose plan selection over the terminal API.
 */
export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {}

    const plan = typeof body?.plan === "string" ? body.plan.trim().toLowerCase() : "starter";
    const connectionId = typeof body?.connectionId === "string" ? body.connectionId : null;

    const result = await claimPerchPlan({ connectionId, plan });
    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          errorCode: result.errorCode || null,
          signupUrl: result.signupUrl || "https://chat.perchai.app",
          needsManualSelection: !!result.needsManualSelection,
          plan: result.plan || null,
          options: result.options || PERCH_PLAN_OPTIONS,
        },
        { status: result.status || 400 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[perchai/plan/claim]", error);
    return NextResponse.json({ error: "Failed to set Perch AI plan" }, { status: 500 });
  }
}
