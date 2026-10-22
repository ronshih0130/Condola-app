// OpenNext's generated worker only exports fetch. Cron calls scheduled().
// Reminders run at 09:00 Asia/Taipei. The ID-photo purge runs at 03:00.
import pg from "pg";
import { default as handler } from "./.open-next/worker.js";
import { PURGE_CRON, runIdPurge } from "./id-purge-cron.mjs";

const REMINDER_CRON = "0 1 * * *";

async function purgeIdPhotos(env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    console.error("id-purge skipped: DATABASE_URL missing");
    throw new Error("id-purge skipped: DATABASE_URL missing");
  }
  const client = new pg.Client({ connectionString });
  client.on("error", () => {});
  await client.connect();
  try {
    const counts = await runIdPurge(client);
    console.log(JSON.stringify({ event: "id-purge", batches: counts.batches, documents: counts.documents, files: counts.files }));
  } finally {
    await client.end();
  }
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
      const origin = String(env.CONDOLA_SITE_URL || "https://app.condola.app").replace(/\/$/, "");
      const request = new Request(`${origin}/api/cron/reminders`, {
        method: "POST",
        headers: { "x-cron-secret": secret },
      });
      ctx.waitUntil(handler.fetch(request, env, ctx));
      return;
    }
    if (controller.cron !== PURGE_CRON) return;
    ctx.waitUntil((async () => {
      try {
        await purgeIdPhotos(env);
      } catch (error) {
        console.error("id-purge failed", error instanceof Error ? error.name : "error");
        throw error;
      }
    })());
  },
};

export default worker;

export const DOQueueHandler = handler.DOQueueHandler;
export const DOShardedTagCache = handler.DOShardedTagCache;
