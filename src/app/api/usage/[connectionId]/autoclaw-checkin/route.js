import "open-sse/index.js";
import { getProviderConnectionById } from "@/lib/localDb";
import { claimAutoClawIntlDailyCheckin } from "@/lib/autoclawIntl";
import { refreshAndUpdateCredentials } from "../route.js";

export async function POST(request, { params }) {
  try {
    const { connectionId } = await params;
    let connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    if (connection.provider !== "autoclaw-intl") return Response.json({ error: "Only AutoClaw International accounts are supported." }, { status: 400 });
    if (connection.isActive === false) return Response.json({ error: "This AutoClaw connection is disabled." }, { status: 400 });
    if (connection.authType === "oauth") ({ connection } = await refreshAndUpdateCredentials(connection, false));
    try { return Response.json(await claimAutoClawIntlDailyCheckin(connection)); }
    catch (error) {
      if (error.status !== 401 || !connection.refreshToken) throw error;
      ({ connection } = await refreshAndUpdateCredentials(connection, true));
      return Response.json(await claimAutoClawIntlDailyCheckin(connection));
    }
  } catch (error) { return Response.json({ error: error.message }, { status: error.status === 401 ? 401 : 502 }); }
}
