import { createHash, timingSafeEqual } from "node:crypto";
import { demoModeEnabled } from "./demo";

/** Daily 09:00 Asia/Taipei. Cron triggers run in UTC. */
export const REMINDER_CRON = "0 1 * * *";

/** Compare two strings without leaking which one mismatched. */
export function secretsMatch(left: string, right: string) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

/** Header x-cron-secret. Demo mode also accepts the fixed local value demo-cron. */
export function cronAuthorized(header: string | null, secret = process.env.CRON_SECRET?.trim() ?? "") {
  const presented = header ?? "";
  if (secret && secretsMatch(presented, secret)) return true;
  return demoModeEnabled() && secretsMatch(presented, "demo-cron");
}
