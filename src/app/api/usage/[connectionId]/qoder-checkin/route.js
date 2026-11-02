import "open-sse/index.js";
import { getProviderConnectionById } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { claimQoderCnDailyCheckin } from "open-sse/services/qoderCheckin.js";
import { refreshAndUpdateCredentials } from "../route.js";

export async function POST(request, { params }) {
  try {
    const { connectionId } = await params;
    const connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    if (connection.provider !== "qoder-cn") {
      return Response.json({ error: "Automated Qoder check-in is currently supported for Qoder China accounts only." }, { status: 400 });
    }
    if (connection.isActive === false) return Response.json({ error: "This Qoder connection is disabled." }, { status: 400 });

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };
    if (connection.authType === "oauth") {
      ({ connection } = await refreshAndUpdateCredentials(connection, false, proxyOptions));
    }
    const result = await claimQoderCnDailyCheckin(connection, proxyOptions);
    return Response.json(result, { status: result.success || result.alreadyCompleted ? 200 : 409 });
  } catch (error) {
    console.warn(`[Qoder Check-in] ${error.message}`);
    return Response.json({ error: error.message }, { status: 502 });
  }
}
