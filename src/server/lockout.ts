/** Failed sign-in lockout: 5 tries, then 15 minutes. */

export const LOCKOUT_LIMIT = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export function nextFailure(failedCount: number, now: Date) {
  const count = failedCount + 1;
  const locked = count >= LOCKOUT_LIMIT;
  return {
    failedCount: count,
    locked,
    lockedUntil: locked ? new Date(now.getTime() + LOCKOUT_MS) : null,
  };
}

export function lockActive(lockedUntil: Date | null, now: Date) {
  return Boolean(lockedUntil && lockedUntil.getTime() > now.getTime());
}
