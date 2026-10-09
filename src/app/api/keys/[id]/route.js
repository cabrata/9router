import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { ENDPOINT_KINDS } from "@/lib/requestLog.js";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, name, allowedModels, allowedEndpoints, access } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const isStrList = (v) => Array.isArray(v) && v.length <= 1000 && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 300);
    const updateData = {};
    if (isActive !== undefined) updateData.isActive = !!isActive;
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) return NextResponse.json({ error: "Invalid name" }, { status: 400 });
      updateData.name = name.trim();
    }
    if (allowedModels !== undefined) {
      if (!isStrList(allowedModels)) return NextResponse.json({ error: "allowedModels must be an array of strings" }, { status: 400 });
      updateData.allowedModels = [...new Set(allowedModels.map((s) => s.trim()).filter(Boolean))];
    }
    if (allowedEndpoints !== undefined) {
      if (!isStrList(allowedEndpoints) || allowedEndpoints.some((e) => !ENDPOINT_KINDS.includes(e))) {
        return NextResponse.json({ error: `allowedEndpoints must be a subset of: ${ENDPOINT_KINDS.join(", ")}` }, { status: 400 });
      }
      updateData.allowedEndpoints = [...new Set(allowedEndpoints)];
    }
    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.access = checked.value;
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
