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

async function fetchCampaigns(token, headers, proxyOptions) {
  const response = await proxyAwareFetch(`${BASE}${CAMPAIGNS}?forceRefresh=true`, {
    method: "GET",
    headers: { ...headers, authorization: `Bearer ${token}` },
  }, proxyOptions);
  return readPayload(response, "Qoder campaign lookup");
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

  const initial = await fetchCampaigns(token, sashHeaders(token), proxyOptions);
  const uid = String(initial.uid || credentials.providerSpecificData?.userId || "").trim();
  if (!uid) throw new Error("Qoder did not return an account UID; check the account authorization");

  const identity = await getQoderRiskIdentity(uid);
  const riskHeaders = { ...sashHeaders(token), ...buildQoderRiskHeaders(identity, uid) };
  const campaigns = await fetchCampaigns(token, riskHeaders, proxyOptions);
  const rows = Array.isArray(campaigns.campaigns) ? campaigns.campaigns : [];
  const eligible = rows.filter(item => item.actionType === "CLAIM_BENEFIT");
  const target = eligible.find(item => item.claimStatus === "CLAIMABLE");
  const alreadyClaimed = eligible.some(item => item.claimStatus === "CLAIMED");
  if (!target) {
    return {
      success: false,
      alreadyCompleted: alreadyClaimed,
      message: alreadyClaimed ? "Today's Qoder check-in has already been claimed." : "No daily check-in campaign is available for this account.",
    };
  }
  if (!target.campaignId) throw new Error("Qoder check-in campaign is missing its campaign ID");

  const claimResponse = await proxyAwareFetch(`${BASE}${CAMPAIGNS}/${encodeURIComponent(target.campaignId)}/claim`, {
    method: "POST",
    headers: { ...riskHeaders, authorization: `Bearer ${token}`, "content-type": "application/json" },
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
  if (body.status !== "CLAIMED") return { success: false, message: `Qoder check-in was not completed (status: ${body.status || "unknown"}).` };
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
