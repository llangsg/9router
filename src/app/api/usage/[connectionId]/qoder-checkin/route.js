import "open-sse/index.js";
import { getProviderConnectionById } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { claimQoderIntlDailyCheckin } from "open-sse/services/qoderCheckin.js";
import { qoderUmidStatus } from "open-sse/services/qoderRisk.js";
import { refreshAndUpdateCredentials } from "../route.js";

export async function POST(request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;
    connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    if (connection.provider !== "qoder") return Response.json({ error: "Only Qoder International accounts are supported." }, { status: 400 });
    if (connection.isActive === false) return Response.json({ error: "This Qoder connection is disabled." }, { status: 400 });

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };
    if (connection.authType === "oauth") ({ connection } = await refreshAndUpdateCredentials(connection, false, proxyOptions));
    try {
      const result = await claimQoderIntlDailyCheckin(connection, proxyOptions);
      return Response.json(result, { status: result.success || result.alreadyCompleted ? 200 : 409 });
    } catch (error) {
      if (error.status !== 401 || connection.authType !== "oauth" || !connection.refreshToken) throw error;
      ({ connection } = await refreshAndUpdateCredentials(connection, true, proxyOptions));
      const result = await claimQoderIntlDailyCheckin(connection, proxyOptions);
      return Response.json(result, { status: result.success || result.alreadyCompleted ? 200 : 409 });
    }
  } catch (error) {
    console.warn(`[Qoder Check-in] ${error.message}`);
    const umid = qoderUmidStatus();
    return Response.json({ error: error.message, umid }, { status: error.status === 401 ? 401 : error.message.includes("UMID") ? 503 : 502 });
  }
}
