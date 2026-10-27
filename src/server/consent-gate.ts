import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "./session";
import type { Session } from "./types";
import {
  buildStoredConsent,
  consentCoversCurrent,
  consentRepository,
  type ConsentRepository,
  type ConsentSource,
  type StoredConsent,
} from "./consent";
import { sameAppPath } from "./public-origin";
import { requirePartnerConsent } from "./partner-consent-gate";

export type ConsentGateResult = { ok: true; recorded: boolean } | { ok: false; error: "consent" };

/**
 * Missing or stale table consent blocks the action unless the person
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

/** Used by file handlers whose authorization runs on an existing connection. */
export class ConsentRequiredError extends Error {}

export function consentRequiredResponse() {
  return Response.json(
    { ok: false, error: "errors.consentRequired" },
    { status: 403, headers: { "Cache-Control": "private, no-store" } },
  );
}

/**
 * Trusted session evidence only. No metadata fallback or additional query.
 * Class B notes: session touching (last_active_at and expiry extension) is
 * allowed authentication bookkeeping before this gate. Business mutations
 * and sandbox provisioning still require current consent.
 */
export async function requireCurrentConsent(
  session?: Session,
  mode: "api" | "action" | "page" = "action",
  next?: string,
): Promise<Response | null> {
  const current = session ?? await getSession();
  if (consentCoversCurrent(current.consent ?? null)) return requirePartnerConsent(current, mode);
  if (mode === "api") return consentRequiredResponse();
  const fallback = current.kind === "staff" ? "/m" : current.kind === "owner" ? "/o" : "/t";
  const path = consentNextPath(next ?? (await headers()).get("x-pathname") ?? "", fallback);
  const base = current.kind === "staff" ? "/consent" : "/consent/portal";
  redirect(`${base}?next=${encodeURIComponent(path)}`);
}
