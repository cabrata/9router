import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { readPerchCliCredentials } from "@/lib/oauth/utils/perchCliCredentials";

/**
 * POST /api/oauth/perchai/import
 * Save a Perch AI session (from CLI auto-import or manual paste).
 * Body: { accessToken, refreshToken?, email?, userId?, expiresAt? }
 */
export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {}

    let accessToken = typeof body?.accessToken === "string" ? body.accessToken.trim() : "";
    let refreshToken = typeof body?.refreshToken === "string" ? body.refreshToken.trim() : null;
    let email = body?.email || null;
    let userId = body?.userId || null;
    let expiresAt = typeof body?.expiresAt === "number" ? new Date(body.expiresAt * 1000).toISOString() : null;

    // Fallback: read directly from ~/.perch/cli-auth-session.json if not provided
    if (!accessToken) {
      const cli = await readPerchCliCredentials();
      if (!cli.found || !cli.accessToken) {
        return NextResponse.json({ error: "Access token is required or run `perch login` first" }, { status: 400 });
      }
      accessToken = cli.accessToken;
      refreshToken = cli.refreshToken || null;
      email = cli.email || email;
      userId = cli.userId || userId;
      if (typeof cli.expiresAt === "number") {
        expiresAt = new Date(cli.expiresAt * 1000).toISOString();
      }
    }

    const displayName = email ? `Perch AI (${email})` : "Perch AI (CLI)";

    const connection = await createProviderConnection({
      provider: "perchai",
      authType: "oauth",
      accessToken,
      refreshToken,
      expiresAt,
      email,
      displayName,
      providerSpecificData: {
        authMethod: refreshToken ? "oauth" : "access_token",
        userId: userId || null,
        appUrl: "https://app.perchai.app",
        source: "cli-import",
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.displayName,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Failed to import Perch credentials" },
      { status: 500 },
    );
  }
}
