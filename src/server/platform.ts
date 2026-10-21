import { writeAudit } from "./audit";
import { query } from "./db";

/** Comma-separated allowlist. Unset means /m/admin stays closed. Not a required Worker secret. */
export function platformAdminEmails() {
  return (process.env.CONDOLA_PLATFORM_ADMIN_EMAILS || "")
    .split(/[,;\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformAdmin(email: string | null | undefined) {
  const value = email?.trim().toLowerCase() ?? "";
  return value !== "" && platformAdminEmails().includes(value);
}

/** True when 「緊急暫停正式使用」 is on. Missing row means off, so go-live stays allowed. */
export async function goLiveLocked() {
  const row = await query<{ locked: boolean }>(
    `SELECT coalesce((SELECT value = 'true'::jsonb FROM platform_settings WHERE key = 'go_live_lock'), false) AS locked`,
  );
  return Boolean(row.rows[0]?.locked);
}

export async function setGoLiveLock(actorId: string, locked: boolean) {
  await query(
    `INSERT INTO platform_settings (key, value, description)
     VALUES ('go_live_lock', to_jsonb($1::boolean), 'Emergency pause of 開始正式使用. Off by default.')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [locked],
  );
  await writeAudit(null, actorId, "go_live_lock", { locked });
}
