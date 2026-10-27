import { NextResponse } from "next/server";
import { getApiKeys, createApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { normalizeApiKeyLimits } from "@/lib/db/repos/apiKeysRepo.js";
import { getApiKeyMonitoring } from "@/lib/db/repos/requestLogsRepo.js";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeys();
    await Promise.all(keys.map(async (key) => { key.monitoring = await getApiKeyMonitoring(key.id); }));
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    let limits;
    try { limits = normalizeApiKeyLimits(body); }
    catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
    const apiKey = await createApiKey(name, machineId, limits);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      expiredAt: apiKey.expiredAt,
      limitConcurrent: apiKey.limitConcurrent,
      rpm: apiKey.rpm,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
