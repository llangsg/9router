import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { resolveQoderCredentials } from "./qoderModels.js";

const BASE = "https://openapi.qoder.com.cn";
const CAMPAIGNS = "/sash/api/v1/me/campaigns";

async function readPayload(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${body.message || body.errorMessage || "upstream request rejected"}`);
  return body.data && typeof body.data === "object" ? body.data : body;
}

export async function claimQoderCnDailyCheckin(connection, proxyOptions = null) {
  const credentials = await resolveQoderCredentials({
    provider: "qoder-cn",
    apiKey: connection.apiKey,
    accessToken: connection.accessToken,
    providerSpecificData: connection.providerSpecificData || {},
  }, proxyOptions, null, "cn");
  const token = credentials.accessToken || credentials.apiKey;
  if (!token) throw new Error("Qoder credential is missing");

  const headers = {
    authorization: `Bearer ${token}`,
    "cosy-clienttype": "10",
    accept: "application/json",
    "accept-language": "zh-CN",
    "user-agent": "Qoder",
    "content-type": "application/json",
  };
  const campaignsResponse = await proxyAwareFetch(`${BASE}${CAMPAIGNS}?forceRefresh=true`, { method: "GET", headers }, proxyOptions);
  const list = await readPayload(campaignsResponse, "Qoder check-in lookup");
  const campaigns = Array.isArray(list.campaigns) ? list.campaigns : [];
  const claimed = campaigns.some(item => item.actionType === "CLAIM_BENEFIT" && item.claimStatus === "CLAIMED");
  const target = campaigns.find(item => item.actionType === "CLAIM_BENEFIT" && item.claimStatus === "CLAIMABLE");
  if (!target) return { success: false, alreadyCompleted: claimed, message: claimed ? "Today's Qoder check-in has already been claimed." : "No claimable Qoder check-in campaign is available for this account." };
  if (!target.campaignId) throw new Error("Qoder check-in campaign is missing its campaign ID");

  const claimResponse = await proxyAwareFetch(`${BASE}${CAMPAIGNS}/${encodeURIComponent(target.campaignId)}/claim`, {
    method: "POST",
    headers,
    body: "{}",
  }, proxyOptions);
  const result = await claimResponse.json().catch(() => ({}));
  if (claimResponse.status === 409 || result.result === "ALREADY_CLAIMED") {
    return { success: false, alreadyCompleted: true, message: "Today's Qoder check-in has already been claimed." };
  }
  const body = await readPayload(new Response(JSON.stringify(result), { status: claimResponse.status }), "Qoder check-in claim");
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
