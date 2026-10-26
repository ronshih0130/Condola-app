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

/** True when the existing platform_settings.go_live_lock row is on. A missing row means off. */
export async function goLiveLocked() {
  const row = await query<{ locked: boolean }>(
    `SELECT coalesce((SELECT value = 'true'::jsonb FROM platform_settings WHERE key = 'go_live_lock'), false) AS locked`,
  );
  return Boolean(row.rows[0]?.locked);
}
