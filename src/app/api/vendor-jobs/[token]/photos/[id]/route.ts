import { NextResponse } from "next/server";
import { openVendorPhoto } from "@/server/vendor-repair";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await context.params;
  const photo = await openVendorPhoto(token, id);
  if (!photo) return new Response("Not found", { status: 404 });
  if ("bytes" in photo) {
    return new Response(new Uint8Array(photo.bytes).buffer, {
      headers: {
        "Content-Type": photo.contentType,
        "Cache-Control": "private, no-store, max-age=0",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Disposition": "inline",
      },
    });
  }
  return NextResponse.redirect(photo.url, 302);
}
