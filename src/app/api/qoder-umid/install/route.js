import "open-sse/index.js";
import { installQoderUmid } from "open-sse/services/qoderRisk.js";

export async function POST() {
  try {
    return Response.json(await installQoderUmid());
  } catch (error) {
    return Response.json({ error: error.message }, { status: 502 });
  }
}
