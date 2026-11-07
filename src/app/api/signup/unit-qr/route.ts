import { NextRequest, NextResponse } from "next/server";
import { scanUnitQr, UNIT_QR_COOKIE, UNIT_QR_SECONDS } from "@/server/unit-qr-signup";
import { UNIT_QR_COOKIE_PATH } from "@/server/unit-qr-cookie";
import { unitQrPrivateHeaders } from "@/server/unit-qr-entry";
import { unitQrClientIp, unitQrIngress } from "@/server/unit-qr-ingress";

export async function POST(request: NextRequest) {
  const fail = () => new NextResponse(null, { status: 404, headers: unitQrPrivateHeaders });
  try {
    if (request.headers.get("origin") !== `${request.nextUrl.protocol}//${request.headers.get("host") || request.nextUrl.host}`
      || request.headers.get("content-type") !== "application/json") return fail();
    const reader = request.body?.getReader();
    if (!reader) return fail();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256) { await reader.cancel(); return fail(); }
      chunks.push(value);
    }
    const { token } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof token !== "string") return fail();
    const handle = await scanUnitQr(token, unitQrClientIp(request.headers, unitQrIngress()));
    if (!handle) return fail();
    const response = new NextResponse(null, { status: 204, headers: unitQrPrivateHeaders });
    response.cookies.set(UNIT_QR_COOKIE, handle, {
      httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:", path: UNIT_QR_COOKIE_PATH, maxAge: UNIT_QR_SECONDS,
    });
    return response;
  } catch {
    // Never log the request, body, token, or exception (including DB details).
    return fail();
  }
}
