import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { resolveQoderCredentials } from "./qoderModels.js";
import { getQoderRiskIdentity, buildQoderRiskHeaders } from "./qoderRisk.js";

const BASE = "https://openapi.qoder.sh";
const CAMPAIGNS = "/sash/api/v1/me/campaigns";

async function readPayload(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${label} failed (${response.status}): ${body.message || body.errorMessage || "upstream request rejected"}`);
    error.status = response.status;
    throw error;
  }
  return body.data && typeof body.data === "object" ? body.data : body;
}

function sashHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    "cosy-clienttype": "10",
    accept: "application/json",
    "accept-language": "zh-CN",
    "user-agent": "Qoder",
  };
}

async function fetchCampaigns(headers, proxyOptions) {
  const response = await proxyAwareFetch(`${BASE}${CAMPAIGNS}`, {
    method: "GET",
    headers,
  }, proxyOptions);
  return readPayload(response, "Qoder campaign lookup");
}

function isProUpgrade(item) {
  const labels = [item.campaignKey, item.actionType, item.title, item.name, item.campaignName];
  if (labels.some(value => /pro|upgrade/i.test(String(value || "")))) return true;
  return String(item.benefit?.kind || "").toUpperCase() === "CREDITS" && Number(item.benefit?.amount) >= 1000;
}

function campaignDiagnostics(payload, rows) {
  const states = [...new Set(rows.map(item => `${String(item.actionType || "<empty>")}:${String(item.claimStatus || "<empty>")}`))].slice(0, 12);
  return {
    campaignCount: rows.length,
    payloadKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : [],
    campaignStates: states,
  };
}

export async function claimQoderIntlDailyCheckin(connection, proxyOptions = null) {
  if (connection.provider !== "qoder") throw new Error("Only Qoder International accounts are supported");
  const credentials = await resolveQoderCredentials({
    provider: "qoder",
    apiKey: connection.apiKey,
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    providerSpecificData: connection.providerSpecificData || {},
    displayName: connection.displayName,
    email: connection.email,
  }, proxyOptions, null, "intl");
  const token = credentials.accessToken || credentials.apiKey;
  if (!token) throw new Error("Qoder credential is missing");

  let uid = String(credentials.providerSpecificData?.userId || "").trim();
  let initial;
  if (!uid) {
    initial = await fetchCampaigns(sashHeaders(token), proxyOptions);
    uid = String(initial.uid || "").trim();
  }
  if (!uid) throw new Error("Qoder did not return an account UID; check the account authorization");

  const identity = await getQoderRiskIdentity(uid);
  const riskHeaders = { ...sashHeaders(token), ...buildQoderRiskHeaders(identity, uid) };
  const campaigns = await fetchCampaigns(riskHeaders, proxyOptions);
  const rows = Array.isArray(campaigns.campaigns) ? campaigns.campaigns : [];
  const eligible = rows.filter(item => {
    const actionType = String(item.actionType || "").toUpperCase();
    return (!actionType || actionType === "CLAIM_BENEFIT") && !isProUpgrade(item);
  });
  const target = eligible.find(item => String(item.claimStatus || "").toUpperCase() === "CLAIMABLE");
  const alreadyClaimed = eligible.some(item => String(item.claimStatus || "").toUpperCase() === "CLAIMED");
  if (!target) {
    const diagnostics = campaignDiagnostics(campaigns, rows);
    console.warn(`[Qoder Check-in] No claimable campaign: ${JSON.stringify(diagnostics)}`);
    return {
      success: false,
      alreadyCompleted: alreadyClaimed,
      message: alreadyClaimed ? "Today's Qoder check-in has already been claimed." : "No daily check-in campaign is available for this account.",
      diagnostics,
    };
  }
  const campaignId = target.campaignId || target.id;
  if (!campaignId) throw new Error("Qoder check-in campaign is missing its campaign ID");

  const claimResponse = await proxyAwareFetch(`${BASE}${CAMPAIGNS}/${encodeURIComponent(campaignId)}/claim`, {
    method: "POST",
    headers: { ...riskHeaders, "content-type": "application/json" },
    body: "{}",
  }, proxyOptions);
  const result = await claimResponse.json().catch(() => ({}));
  if (claimResponse.status === 409 || result.result === "ALREADY_CLAIMED") {
    return { success: false, alreadyCompleted: true, message: "Today's Qoder check-in has already been claimed." };
  }
  if (!claimResponse.ok) {
    const error = new Error(`Qoder check-in claim failed (${claimResponse.status}): ${result.message || result.errorMessage || "upstream request rejected"}`);
    error.status = claimResponse.status;
    throw error;
  }
  const body = result.data && typeof result.data === "object" ? result.data : result;
  const status = String(body.status || "").toUpperCase();
  if (status !== "CLAIMED" && status !== "GRANTED" && status !== "SUCCESS") {
    return { success: false, message: `Qoder check-in was not completed (status: ${body.status || "unknown"}).` };
  }
  if (body.replayed) return { success: false, alreadyCompleted: true, message: "Today's Qoder check-in has already been claimed." };
  const amount = Number(body.benefit?.amount ?? 100);
  const days = Number(body.benefit?.validity?.days);
  return {
    success: true,
    reward: amount,
    unit: "credits",
    message: Number.isFinite(days) && days > 0 ? `Received ${amount} credits, valid for ${days} days.` : `Received ${amount} credits.`,
  };
}
