import { createHash, timingSafeEqual } from "node:crypto";

/** Daily 09:00 Asia/Taipei. Cron triggers run in UTC. */
export const REMINDER_CRON = "0 1 * * *";

export function cronAuthorized(header: string | null, secret: string) {
  if (!secret || !header) return false;
  const left = createHash("sha256").update(header).digest();
  const right = createHash("sha256").update(secret).digest();
  return timingSafeEqual(left, right);
}
