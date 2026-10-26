export const BACKUP_COOKIE = "condola_backup";

export function parseBackupCodes(value: string | undefined) {
  return (value ?? "")
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Showing the codes is one-time. The cookie is cleared immediately after. */
export function backupDisplay(value: string | undefined) {
  return { codes: parseBackupCodes(value), clearCookie: true as const };
}
