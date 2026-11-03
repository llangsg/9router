import { NextResponse } from "next/server";
import { exchangeAutoClawOAuth } from "@/lib/autoclawIntl";

export async function POST(request) {
  try { return NextResponse.json({ success: true, connection: await exchangeAutoClawOAuth(await request.json()) }); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
}
