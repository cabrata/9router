import { NextResponse } from "next/server";
import { getRequestLogs, clearRequestLogs } from "@/lib/db/repos/requestLogsRepo.js";

export const dynamic = "force-dynamic";

// GET /api/usage/request-log-entries?page&pageSize&apiKeyId&status=ok|error&endpointKind&search
export async function GET(request) {
  try {
    const sp = new URL(request.url).searchParams;
    const result = await getRequestLogs({
      page: parseInt(sp.get("page"), 10) || 1,
      pageSize: parseInt(sp.get("pageSize"), 10) || 50,
      apiKeyId: sp.get("apiKeyId") || null,
      status: sp.get("status") || null,
      endpointKind: sp.get("endpointKind") || null,
      search: sp.get("search")?.trim() || null,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[API] request-logs failed:", error);
    return NextResponse.json({ error: "Failed to fetch request logs" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await clearRequestLogs();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[API] request-logs clear failed:", error);
    return NextResponse.json({ error: "Failed to clear request logs" }, { status: 500 });
  }
}
