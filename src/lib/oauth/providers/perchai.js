import { PERCHAI_CONFIG } from "../constants/oauth.js";

const perchai = {
  config: PERCHAI_CONFIG,
  flowType: "authorization_code_pkce",
  callbackPath: PERCHAI_CONFIG.callbackPath || "/callback",
  // ponytail: defaults to Google with select_account prompt; upgrade to multi-provider UI when Perch adds more OAuth targets.
  buildAuthUrl: (config, redirectUri, state, codeChallenge, meta = {}) => {
    const provider = meta?.socialProvider || meta?.provider || "google";
    const params = new URLSearchParams({
      provider,
      redirect_to: redirectUri,
    });
    if (codeChallenge) {
      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", "s256");
    }
    if (state) params.set("state", state);
    if (provider === "google") params.set("prompt", "select_account");
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  // ponytail: accepts PKCE code, callback URL, raw JWT, or JSON from ~/.perch/cli-auth-session.json.
  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    const raw = typeof code === "string" ? code.trim() : code;

    // 1. JSON session (from ~/.perch/cli-auth-session.json or direct paste)
    if (typeof raw === "string" && raw.startsWith("{") && raw.endsWith("}")) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.accessToken || parsed.access_token) return parsed;
      } catch {}
    } else if (raw && typeof raw === "object" && (raw.accessToken || raw.access_token)) {
      return raw;
    }

    // 2. Direct JWT access token paste
    if (typeof raw === "string" && raw.startsWith("eyJ") && raw.includes(".")) {
      return { access_token: raw };
    }

    // 3. Callback URL (extract ?code=)
    let authCode = raw;
    if (typeof raw === "string" && (raw.includes("://") || raw.includes("code="))) {
      try {
        const url = new URL(raw.startsWith("http") ? raw : `http://127.0.0.1${raw.startsWith("/") ? "" : "/"}${raw}`);
        const codeParam = url.searchParams.get("code");
        if (codeParam) authCode = codeParam;
      } catch {}
    }

    // 4. PKCE exchange with Supabase
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
      },
      body: JSON.stringify({
        auth_code: authCode,
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = errorText;
      try {
        const parsed = JSON.parse(errorText);
        errorMsg = parsed.error_description || parsed.msg || parsed.message || parsed.error || errorText;
      } catch {}
      throw new Error(`Perch AI token exchange failed: ${errorMsg}`);
    }

    return await response.json();
  },
  mapTokens: (tokens) => {
    const accessToken = tokens.access_token || tokens.accessToken;
    const refreshToken = tokens.refresh_token || tokens.refreshToken || null;
    let email = tokens.user?.email || tokens.email || "";
    let userId = tokens.user?.id || tokens.userId || "";

    if (!email && typeof accessToken === "string" && accessToken.startsWith("eyJ") && accessToken.includes(".")) {
      try {
        const b64 = accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
        const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
        email = payload.email || "";
        userId = userId || payload.sub || "";
      } catch {}
    }

    const expiresIn = tokens.expires_in ||
      (typeof tokens.expiresAt === "number" ? Math.max(0, tokens.expiresAt - Math.floor(Date.now() / 1000)) : 3600);

    return {
      accessToken,
      refreshToken,
      expiresIn,
      email,
      providerSpecificData: {
        userId,
        appUrl: tokens.appUrl || "https://app.perchai.app",
        authMethod: refreshToken ? "oauth" : "access_token",
      },
    };
  },
};

export default perchai;
