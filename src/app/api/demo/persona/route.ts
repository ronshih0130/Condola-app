import { NextResponse } from "next/server";

/** Cookie persona switching is removed. Sign in as the member instead. */
export async function GET() {
  return new NextResponse(null, { status: 404 });
}
