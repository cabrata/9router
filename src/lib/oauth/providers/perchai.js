import { PERCHAI_CONFIG } from "../constants/oauth.js";

const perchai = {
  config: PERCHAI_CONFIG,
  flowType: "authorization_code_pkce",
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = new URLSearchParams({
      provider: "google",
      redirect_to: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "s256",
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseAnonKey,
      },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Perch AI token exchange failed: ${error}`);
    }

    return await response.json();
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    email: tokens.user?.email || "",
    providerSpecificData: {
      userId: tokens.user?.id || "",
    },
  }),
};

export default perchai;
