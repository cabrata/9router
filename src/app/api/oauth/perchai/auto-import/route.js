import { NextResponse } from "next/server";
import { readPerchCliCredentials } from "@/lib/oauth/utils/perchCliCredentials";

/**
 * GET /api/oauth/perchai/auto-import
 * Read signed-in Perch CLI session from ~/.perch/cli-auth-session.json or macOS keychain.
 */
export async function GET() {
  try {
    const result = await readPerchCliCredentials();
    if (!result.found) {
      return NextResponse.json({
        found: false,
        error: result.error || "Perch CLI credentials not found",
      });
    }

    return NextResponse.json({
      found: true,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      email: result.email,
      userId: result.userId,
      expiresAt: result.expiresAt,
      source: result.source,
    });
  } catch (error) {
    return NextResponse.json(
      { found: false, error: error.message || "Failed to read Perch CLI credentials" },
      { status: 500 },
    );
  }
}
