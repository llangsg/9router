import { NextResponse } from "next/server";
import { getAutoClawCaptchaConfig } from "@/lib/autoclawIntl";

export async function GET() {
  try { return NextResponse.json(await getAutoClawCaptchaConfig()); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: 502 }); }
}
