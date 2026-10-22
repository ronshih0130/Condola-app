import { NextResponse } from "next/server";
import { cronAuthorized } from "@/server/cron-auth";
import { logServerError } from "@/server/errors";
import { purgeDueIdDocumentsUntilDone } from "@/server/id-docs";

export const dynamic = "force-dynamic";

async function cronSecret() {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  try {
    const mod = (await import("@opennextjs/cloudflare")) as {
      getCloudflareContext: (options?: { async?: boolean }) => Promise<{ env: { CRON_SECRET?: string } }>;
    };
    const ctx = await mod.getCloudflareContext({ async: true });
    return ctx.env.CRON_SECRET || "";
  } catch {
    return "";
  }
}

/**
 * Daily ID-photo purge. Header x-cron-secret. The Worker cron posts here.
 * Demo accepts demo-cron. A missing or wrong secret is a 404.
 * purgeDueIdDocumentsUntilDone runs as service_role and deletes the stored files.
 */
export async function POST(request: Request) {
  const expected = await cronSecret();
  if (!cronAuthorized(request.headers.get("x-cron-secret"), expected)) {
    return new NextResponse(null, { status: 404 });
  }
  try {
    const removed = await purgeDueIdDocumentsUntilDone();
    return NextResponse.json({ removed });
  } catch (error) {
    logServerError("purge-id-documents", error);
    return NextResponse.json({ error: "purge_failed" }, { status: 500 });
  }
}
