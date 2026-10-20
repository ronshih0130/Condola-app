import { NextResponse } from "next/server";

/** Impersonating manager / tenant / owner from a cookie is removed. */
export async function GET() {
  return new NextResponse(null, { status: 404 });
}
