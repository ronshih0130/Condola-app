import { NextResponse } from "next/server";
import { openVendorPhoto } from "@/server/vendor-repair";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await context.params;
  const photo = await openVendorPhoto(token, id);
  if (!photo) return new Response("Not found", { status: 404 });
  return NextResponse.redirect(photo.url, 302);
}
