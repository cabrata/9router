import { NextResponse } from "next/server";
import { getPerchPlanStatus, resolvePerchConnection } from "@/lib/oauth/perchPlan";

export const dynamic = "force-dynamic";

/**
 * GET /api/oauth/perchai/plan/status?connectionId=...
 * Tells the dashboard whether the Perch account still has to pick a plan
 * (the `tier_selection_required` gate) and which plan it currently has.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const connectionId = searchParams.get("connectionId") || null;

    const connection = await resolvePerchConnection({ connectionId });
    if (!connection) {
      return NextResponse.json(
        { error: "Perch AI connection not found. Connect a Perch AI account first." },
        { status: 404 }
      );
    }

    const status = await getPerchPlanStatus(connection);
    if (!status.ok) {
      return NextResponse.json({ error: status.error, options: status.options }, { status: status.status || 400 });
    }
    return NextResponse.json({ ...status, connectionId: connection.id });
  } catch (error) {
    console.error("[perchai/plan/status]", error);
    return NextResponse.json({ error: "Failed to check Perch AI plan" }, { status: 500 });
  }
}
