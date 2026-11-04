const BASE_URL = "https://api.freepi.ai";
const CONSENT_VERSION = "0.4.10";

async function post(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

const freepi = {
  config: { baseUrl: BASE_URL },
  flowType: "device_code",
  requestDeviceCode: async () => {
    const { response, data } = await post("/auth/github/device", {});
    if (!response.ok || !data.session_id) {
      throw new Error(`FreePi device login failed: ${data.message || response.status}`);
    }
    const consent = await post("/auth/consent", {
      session_id: data.session_id,
      consent_version: CONSENT_VERSION,
    });
    if (!consent.response.ok) {
      throw new Error(`FreePi consent submission failed: ${consent.data.message || consent.response.status}`);
    }
    return {
      device_code: data.session_id,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      interval: data.interval || 5,
      expires_in: 900,
    };
  },
  pollToken: async (config, sessionId) => {
    const { response, data } = await post("/auth/token", { session_id: sessionId });
    if (response.ok && data.token) return { ok: true, data: { access_token: data.token } };
    if (data.code === "consent_required") {
      return { ok: false, data: { error: "access_denied", error_description: data.message } };
    }
    if (data.status === "pending" || data.retry_after) {
      return { ok: true, data: { error: data.retry_after ? "slow_down" : "authorization_pending", error_description: "Waiting for GitHub authorization" } };
    }
    return { ok: false, data: { error: data.code === "expired_token" ? "expired_token" : "access_denied", error_description: data.message || "FreePi token request failed" } };
  },
  postExchange: async tokens => {
    const response = await fetch(`${BASE_URL}/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    return response.ok ? response.json().catch(() => ({})) : {};
  },
  mapTokens: (tokens, profile) => ({
    accessToken: tokens.access_token,
    refreshToken: null,
    expiresIn: null,
    email: profile?.email || null,
    displayName: profile?.handle || null,
    providerSpecificData: { sessionId: "freepi2api", clientVersion: CONSENT_VERSION },
  }),
};

export default freepi;
