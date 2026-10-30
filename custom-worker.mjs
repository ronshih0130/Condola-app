// OpenNext's generated worker only exports fetch. Cron calls scheduled().
// Reminders run at 09:00 Asia/Taipei. The ID-photo purge runs at 03:00.
// Keep this file a thin entry that only imports the OpenNext worker. The purge
// route runs inside that worker, which already loads the database driver.
// The TTF imports are Wrangler Data modules. The watermark code reads
// globalThis.__CONDOLA_FONTS because the OpenNext handler has no filesystem.
import { default as handler } from "./.open-next/worker.js";
import cjkFont from "./public/fonts/DroidSansFallback-subset.ttf";
import latinFont from "./src/server/fonts/DejaVuSans.ttf";

globalThis.__CONDOLA_FONTS = { cjk: cjkFont, latin: latinFont };

const REMINDER_CRON = "0 1 * * *";
const PURGE_CRON = "0 19 * * *";

function siteRequest(env, pathname) {
  const origin = String(env.CONDOLA_SITE_URL || "https://app.condola.app").replace(/\/$/, "");
  return new Request(`${origin}${pathname}`, {
    method: "POST",
    headers: { "x-cron-secret": env.CRON_SECRET || "" },
  });
}

const worker = {
  fetch: handler.fetch,
  async scheduled(controller, env, ctx) {
    const secret = env.CRON_SECRET || "";
    if (controller.cron === REMINDER_CRON) {
      if (!secret) {
        console.warn("cron reminders skipped: CRON_SECRET missing");
        return;
      }
      ctx.waitUntil(handler.fetch(siteRequest(env, "/api/cron/reminders"), env, ctx));
      return;
    }
    if (controller.cron !== PURGE_CRON) return;
    if (!secret) {
      console.warn("cron id-purge skipped: CRON_SECRET missing");
      return;
    }
    ctx.waitUntil((async () => {
      try {
        const response = await handler.fetch(siteRequest(env, "/api/cron/purge-id-documents"), env, ctx);
        if (!response.ok) throw new Error("status");
        const body = await response.json().catch(() => ({}));
        if (!body.disabled) {
          console.log(JSON.stringify({
            event: "id-purge", mode: body.mode,
            removed: Number(body.removed) || 0,
            wouldDelete: Number(body.wouldDelete) || 0,
            uploadSlotsWouldDelete: Number(body.uploadSlotsWouldDelete) || 0,
          }));
        }
      } catch (error) {
        console.error("id-purge failed", error instanceof Error ? error.name : "error");
        throw error;
      }
    })());
  },
};

export default worker;

// Named classes on worker.js are not properties of its default export. Re-exporting
// handler.DOQueueHandler publishes undefined, and workerd then refuses to start.
