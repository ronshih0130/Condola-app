import { cronAuthorized } from "@/server/cron-auth";
import { runDueReminders } from "@/server/reminders";
import { runLocalRentReminders } from "@/server/local-rent-reminders";

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

export async function POST(request: Request) {
  const expected = await cronSecret();
  if (!cronAuthorized(request.headers.get("x-cron-secret"), expected)) {
    return new Response("unauthorized", { status: 401 });
  }
  try {
    const local = await runLocalRentReminders();
    const result = await runDueReminders();
    return Response.json({ ...result, local });
  } catch (error) {
    console.error("reminders", error instanceof Error ? error.message : "failed");
    return new Response("failed", { status: 500 });
  }
}
