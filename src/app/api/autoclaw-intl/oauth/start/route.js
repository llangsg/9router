import { NextResponse } from "next/server";
import { startAutoClawOAuth } from "@/lib/autoclawIntl";

export async function POST(request) {
  try {
    const body = await request.json();
    const result = await startAutoClawOAuth({ captchaVerifyParam: body.captchaVerifyParam, redirectUri: body.redirectUri });
    return NextResponse.json(result);
  } catch (error) { return NextResponse.json({ error: error.message }, { status: 502 }); }
}
