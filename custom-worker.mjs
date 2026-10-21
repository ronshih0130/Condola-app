// OpenNext's generated worker only exports fetch. Cron calls scheduled().
import { default as handler } from "./.open-next/worker.js";

const REMINDER_CRON = "0 1 * * *";

const worker = {
  fetch: handler.fetch,
  async scheduled(controller, env, ctx) {
    if (controller.cron !== REMINDER_CRON) return;
    const secret = env.CRON_SECRET || "";
    if (!secret) {
      console.warn("cron reminders skipped: CRON_SECRET missing");
      return;
    }
    const origin = String(env.CONDOLA_SITE_URL || "https://app.condola.app").replace(/\/$/, "");
    const request = new Request(`${origin}/api/cron/reminders`, {
      method: "POST",
      headers: { "x-cron-secret": secret },
    });
    ctx.waitUntil(handler.fetch(request, env, ctx));
  },
};

export default worker;

export const DOQueueHandler = handler.DOQueueHandler;
export const DOShardedTagCache = handler.DOShardedTagCache;
