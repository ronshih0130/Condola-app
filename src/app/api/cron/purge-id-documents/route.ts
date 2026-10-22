import { NextResponse } from "next/server";
import { cronAuthorized } from "@/server/cron-auth";
import { logServerError } from "@/server/errors";
import { purgeDueIdDocumentsUntilDone } from "@/server/id-docs";

export const dynamic = "force-dynamic";

/**
 * Manual purge for preview and local e2e. Header x-cron-secret.
 * Demo accepts demo-cron. Production returns 404; the Worker cron calls the
 * function itself as service_role and does not use this route.
 */
export async function POST(request: Request) {
  if ((process.env.CONDOLA_ENV ?? "").trim() === "production") return new NextResponse(null, { status: 404 });
  if (!cronAuthorized(request.headers.get("x-cron-secret"))) return new NextResponse(null, { status: 404 });
  try {
    const removed = await purgeDueIdDocumentsUntilDone();
    return NextResponse.json({ removed });
  } catch (error) {
    logServerError("purge-id-documents", error);
    return NextResponse.json({ error: "purge_failed" }, { status: 500 });
  }
}
