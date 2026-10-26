import { execFile } from "child_process";
import { promisify } from "util";
import { access, constants, readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

function parsePerchSession(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const data = JSON.parse(raw);
    const accessToken = data.accessToken || data.access_token;
    if (!accessToken) return null;
    return {
      version: data.version || 1,
      appUrl: data.appUrl || "https://app.perchai.app",
      accessToken,
      refreshToken: data.refreshToken || data.refresh_token || null,
      expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : null,
      userId: data.userId || data.user_id || data.user?.id || null,
      email: data.email || data.user?.email || null,
      updatedAt: data.updatedAt || null,
    };
  } catch {
    return null;
  }
}

// ponytail: reads ~/.perch/cli-auth-session.json or macOS keychain; upgrade if Perch CLI adds new storage backends.
export async function readPerchCliCredentials() {
  const authDir = process.env.PERCH_CLI_AUTH_DIR?.trim() || join(homedir(), ".perch");
  const authFile = join(authDir, "cli-auth-session.json");

  // 1. Check local file (Linux, Windows, and macOS without keychain)
  try {
    await access(authFile, constants.R_OK);
    const content = await readFile(authFile, "utf8");
    const parsed = parsePerchSession(content);
    if (parsed) return { found: true, ...parsed, source: "file", path: authFile };
  } catch {}

  // 2. Fallback: check macOS keychain if running on darwin
  if (process.platform === "darwin" && !process.env.PERCH_CLI_AUTH_DIR?.trim()) {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        "app.perchai.cli-auth",
        "-a",
        "default",
        "-w",
      ]);
      const parsed = parsePerchSession(stdout.trim());
      if (parsed) return { found: true, ...parsed, source: "keychain" };
    } catch {}
  }

  return { found: false, error: "Perch CLI session not found. Please log in via `perch login`." };
}

// ponytail: best-effort CLI detection using which/where + session file check.
export async function detectPerchCliInstalled() {
  const home = homedir();
  const session = await readPerchCliCredentials();

  let installed = false;
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    await execFileAsync(whichCmd, ["perch"]);
    installed = true;
  } catch {
    installed = false;
  }

  return {
    installed: installed || session.found,
    hasSession: session.found,
    session: session.found ? session : null,
    authFilePath: join(home, ".perch", "cli-auth-session.json"),
  };
}
