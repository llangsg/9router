import "open-sse/index.js";
import { qoderUmidStatus } from "open-sse/services/qoderRisk.js";

export async function GET() {
  return Response.json(qoderUmidStatus());
}
