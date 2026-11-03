import crypto from "node:crypto";

const BASE = "https://autoglm-api.autoglm.ai";
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const VERSION = "1.18.5";
const sessions = globalThis.__autoclawIntlOAuthSessions || (globalThis.__autoclawIntlOAuthSessions = new Map());

export function autoclawHeaders(token = "") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = crypto.createHash("md5").update(`${APP_ID}&${timestamp}&${APP_KEY}`).digest("hex");
  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    "X-Version": VERSION,
    "X-Product": "autoclaw",
    "X-Client-Type": "pc",
    "X-Harness-Type": "zcode",
    "X-Tm": process.platform === "win32" ? "win" : "linux",
    "X-Lang": "zh-CN",
    "X-Channel": "official",
    "X-Auth-Appid": APP_ID,
    "X-Auth-TimeStamp": timestamp,
    "X-Auth-Sign": sign,
    "X-Trace-Id": crypto.randomUUID(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function autoclawRequest(path, body, token = "") {
  const response = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: autoclawHeaders(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`AutoClaw returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok) {
    const error = new Error(data?.msg || data?.message || `AutoClaw request failed (${response.status})`);
    if (response.status === 401) error.status = 401;
    throw error;
  }
  return data;
}

export async function getAutoClawCaptchaConfig() {
  const result = await autoclawRequest("/userapi/overseasv1/oauth-captcha-config", {});
  if (Number(result.code || 0) !== 0) throw new Error(result.msg || `Captcha configuration failed (${result.code})`);
  const data = result.data || {};
  if (!data.enabled || !data.scene_id) throw new Error("AutoClaw OAuth captcha is unavailable");
  return { region: data.region, prefix: data.prefix, sceneId: data.scene_id };
}

export async function startAutoClawOAuth({ captchaVerifyParam, redirectUri }) {
  for (const [id, session] of sessions) if (Date.now() - session.createdAt > 10 * 60 * 1000) sessions.delete(id);
  const captcha = String(captchaVerifyParam || "").trim();
  if (!captcha) throw new Error("Complete the security verification first");
  const sessionId = crypto.randomUUID();
  const deviceId = crypto.randomBytes(32).toString("hex");
  const parsedRedirect = new URL(redirectUri);
  if (parsedRedirect.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsedRedirect.hostname) || parsedRedirect.pathname !== "/auth/callback-google" || parsedRedirect.search || parsedRedirect.hash || parsedRedirect.username || parsedRedirect.password) throw new Error("AutoClaw requires an HTTP loopback callback at /auth/callback-google");
  const navigateUri = parsedRedirect.toString();
  const result = await autoclawRequest("/userapi/overseasv1/google-oauth-url", {
    source_id: "autoclaw",
    device_id: deviceId,
    navigate_uri: navigateUri,
    ali_captcha_verify_param: captcha,
  });
  if (Number(result.code || 0) !== 0) throw new Error(result.msg || `AutoClaw OAuth start failed (${result.code})`);
  const authUrl = result.data?.oauth_url;
  if (!authUrl) throw new Error("AutoClaw did not return an authorization URL");
  sessions.set(sessionId, { deviceId, navigateUri, createdAt: Date.now(), used: false });
  return { sessionId, authUrl };
}

function decodeClaims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); } catch { return {}; }
}

export async function exchangeAutoClawOAuth({ sessionId, code, state }) {
  const session = sessions.get(sessionId);
  if (!session || session.used || Date.now() - session.createdAt > 10 * 60 * 1000) throw new Error("AutoClaw login session expired; start again");
  if (!code) throw new Error("Missing AutoClaw authorization code");
  session.used = true;
  try {
    const result = await autoclawRequest("/userapi/overseasv1/google-oauth-login", {
      source_id: "autoclaw",
      device_id: session.deviceId,
      code,
      state: state || "",
      navigate_uri: session.navigateUri,
    });
    if (Number(result.code || 0) !== 0) throw new Error(result.msg || `AutoClaw token exchange failed (${result.code})`);
    const data = result.data || {};
    const accessToken = String(data.access_token || "").trim();
    if (!accessToken) throw new Error("AutoClaw did not return an access token");
    const claims = decodeClaims(accessToken);
    const userId = String(data.user_id || claims.user_id || claims.uid || claims.sub || "");
    const displayName = String(data.user_name || "").trim() || (userId ? `AutoClaw ${userId}` : "AutoClaw account");
    const { createProviderConnection, updateProviderConnection } = await import("@/models");
    const { getProviderConnections } = await import("@/lib/localDb");
    const existing = userId
      ? (await getProviderConnections({ provider: "autoclaw-intl" })).find(item => item.providerSpecificData?.userId === userId)
      : null;
    const connectionData = {
      authType: "oauth",
      accessToken,
      refreshToken: data.refresh_token || null,
      expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
      displayName,
      name: displayName,
      email: existing?.email || null,
      providerSpecificData: { ...existing?.providerSpecificData, authMethod: "oauth", deviceId: session.deviceId, userId },
      testStatus: "active",
      isActive: true,
      lastError: null,
      lastErrorAt: null,
    };
    const connection = existing
      ? await updateProviderConnection(existing.id, connectionData)
      : await createProviderConnection({ provider: "autoclaw-intl", ...connectionData });
    return { id: connection.id, provider: connection.provider, displayName: connection.displayName, email: connection.email };
  } finally {
    sessions.delete(sessionId);
  }
}

export async function refreshAutoClawIntlToken(credentials) {
  if (!credentials?.refreshToken) return null;
  const deviceId = credentials.providerSpecificData?.deviceId || "";
  const body = { refresh_token: credentials.refreshToken, source_id: "autoclaw", ...(deviceId ? { device_id: deviceId } : {}) };
  let result = await autoclawRequest("/userapi/v1/refresh", body, credentials.accessToken || "");
  if (Number(result.code) === 400002) result = await autoclawRequest("/userapi/v1/agent-refresh", body, credentials.accessToken || "");
  const data = result.data || {};
  if (Number(result.code ?? 0) !== 0 || !data.access_token) throw new Error(result.msg || `AutoClaw refresh failed (${result.code})`);
  const claims = decodeClaims(data.access_token);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || credentials.refreshToken,
    expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
  };
}

export async function claimAutoClawIntlDailyCheckin(credentials) {
  const result = await autoclawRequest("/autoclaw-proxy/proxy/autoclaw-task-complete", { task_id: "daily_signin" }, credentials.accessToken);
  const data = result.data || {};
  if (Number(result.code) !== 0) {
    const error = new Error(result.msg || `AutoClaw check-in failed (${result.code})`);
    if ([401, 400000, 410000].includes(Number(result.code))) error.status = 401;
    throw error;
  }
  if (data.reward_points > 0 || (data.success === true && data.already_completed !== true)) return { success: true, alreadyCompleted: false, message: `Daily check-in claimed${data.reward_points ? `: ${data.reward_points} points` : ""}.`, rewardPoints: data.reward_points || 0 };
  if (data.already_completed === true) return { success: false, alreadyCompleted: true, message: "Today's AutoClaw check-in is already completed.", rewardPoints: 0 };
  const tasks = await autoclawRequest("/autoclaw-proxy/proxy/autoclaw-task-list", undefined, credentials.accessToken);
  if (Number(tasks.code ?? 0) !== 0) {
    const error = new Error(tasks.msg || `AutoClaw task lookup failed (${tasks.code})`);
    if ([400000, 410000].includes(Number(tasks.code))) error.status = 401;
    throw error;
  }
  const items = tasks.data?.tasks || tasks.data?.task_list || tasks.data || [];
  const daily = Array.isArray(items) ? items.find(item => item.task_id === "daily_signin") : null;
  if (daily?.completed === true) return { success: false, alreadyCompleted: true, message: "Today's AutoClaw check-in is already completed.", rewardPoints: 0 };
  throw new Error(data.message || data.msg || "AutoClaw did not confirm the daily check-in");
}
