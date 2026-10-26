import {
  buildStoredConsent,
  consentCoversCurrent,
  consentRepository,
  type ConsentRepository,
  type ConsentSource,
  type StoredConsent,
} from "./consent";
import { sameAppPath } from "./public-origin";

export type ConsentGateResult = { ok: true; recorded: boolean } | { ok: false; error: "consent" };

/**
 * Missing or stale app_metadata consent blocks the action unless the person
 * ticked the checkbox on this request. A tick writes a server-timed record.
 * An already-current record does not need another tick.
 */
export async function passConsentGate(
  userId: string,
  source: ConsentSource,
  checked: boolean,
  repo: ConsentRepository = consentRepository,
): Promise<ConsentGateResult> {
  const current = await repo.read(userId);
  if (consentCoversCurrent(current)) return { ok: true, recorded: false };
  if (checked !== true) return { ok: false, error: "consent" };
  await repo.write(userId, buildStoredConsent(source));
  return { ok: true, recorded: true };
}

/** Team invite acceptance cannot create the login until the box is ticked. */
export function teamInviteBlocked(kind: string, checked: boolean | undefined) {
  return kind === "team_member" && checked !== true;
}

/** Keep consent redirects on this app, and never send them back to the gate. */
export function consentNextPath(value: string, fallback: string) {
  const path = sameAppPath(value);
  if (!path) return fallback;
  const pathname = path.split("?")[0];
  if (pathname === "/consent" || pathname.startsWith("/consent/")) return fallback;
  if (pathname === "/login" || pathname.startsWith("/login/")) return fallback;
  return path;
}

/** Where to send someone who still needs to tick. Null when consent is current. */
export function consentGateTarget(record: StoredConsent | null, variant: "reconsent" | "portal", next: string): string | null {
  if (consentCoversCurrent(record)) return null;
  const base = variant === "portal" ? "/consent/portal" : "/consent";
  return `${base}?next=${encodeURIComponent(consentNextPath(next, "/auth/continue"))}`;
}

/** Where /auth/enter sends this request. Consent wins over the requested path. */
export async function resolveEntryLocation(next: string | null, session: { userId: string; kind: string } | null) {
  const safe = sameAppPath(next) || "/auth/continue";
  if (!session) return safe;
  const variant = session.kind === "owner" || session.kind === "tenant" ? "portal" : "reconsent";
  return (await entryConsentRedirect(session.userId, variant, safe)) || safe;
}

export async function entryConsentRedirect(
  userId: string,
  variant: "reconsent" | "portal",
  next: string,
  repo: ConsentRepository = consentRepository,
) {
  return consentGateTarget(await repo.read(userId), variant, next);
}
