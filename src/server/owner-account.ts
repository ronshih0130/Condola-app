import type { Client } from "pg";
import { tx } from "./db";
import { ownerPortalExtensionsEnabled } from "./owner-portal-access";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

/**
 * B-023 slice 3: owner account — own login sessions, own contact profile and
 * owner notification preferences, behind the strict `owner_portal_extensions`
 * flag (OFF ⇒ null/unavailable before any B-023 gateway is called, so /o/account
 * 404s and nothing is written). Ownership and recent authentication are decided
 * in SQL (app.b023_*):
 * - sessions: only auth.uid()'s own; sign out ONE other session; the current
 *   session is never revoked here; revoke requires the current session to have
 *   signed in within the last OWNER_RECENT_AUTH_MINUTES (no re-auth flow exists).
 * - profile: display name, language and preferred channel of the caller's own
 *   owner contact; email/phone are read-only (no verification flow exists).
 * - preferences: per owner contact and category; absent = ON. Stored only: no existing
 *   delivery code consults them yet (wiring pending: B-028 producers, B-014 report delivery).
 */
export const OWNER_RECENT_AUTH_MINUTES = 15;
export const OWNER_NOTIFICATION_CATEGORIES = ["repair_updates", "statement_reports"] as const;
export type OwnerNotificationCategory = (typeof OWNER_NOTIFICATION_CATEGORIES)[number];
export const OWNER_PROFILE_CHANNELS = ["in_app", "email", "sms", "line"] as const;
export type OwnerProfileChannel = (typeof OWNER_PROFILE_CHANNELS)[number];
export const OWNER_LOCALES = ["zh-TW", "en"] as const;

export type OwnerSessionRow = {
  session_id: string; device: string | null; created_at: string; last_active_at: string;
  is_current: boolean; recent_auth: boolean;
};
export type OwnerProfileView = {
  display_name: string; email: string | null; phone_e164: string | null; locale: string;
  preferred_channel: OwnerProfileChannel | null; channels: OwnerProfileChannel[]; version: string;
};
export type OwnerPreferenceRow = { category: OwnerNotificationCategory; enabled: boolean; updated_at: string | null };
export type OwnerAccountView = { sessions: OwnerSessionRow[]; profile: OwnerProfileView; preferences: OwnerPreferenceRow[] };

export type RevokeSessionInput = { targetSessionId: string; requestId: string };
export type SaveProfileInput = { requestId: string; displayName: string; locale: string; channel: string | null; version: string };
export type SetPreferenceInput = { requestId: string; category: string; enabled: boolean };
export type OwnerAccountResult = {
  state: "revoked" | "recorded" | "replayed" | "unchanged" | "stale" | "invalid" | "conflict" | "current" | "reauth_required" | "gone" | "unavailable";
};

const unavailable: OwnerAccountResult = { state: "unavailable" };

function ownerSession(s: Session) {
  return s.kind === "owner" && !s.needsSandbox && [s.userId, s.orgId, s.sessionId].every(isUuid) && ["live", "sandbox"].includes(s.environment);
}
function scope(s: Session) { return { orgId: s.orgId, environment: s.environment }; }
async function currentSession(client: Client, s: Session) {
  return (await client.query(`SELECT 1 FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
    [s.sessionId, s.userId])).rowCount === 1;
}
function result(raw: unknown, allowed: OwnerAccountResult["state"][]): OwnerAccountResult {
  const state = (raw as { state?: unknown } | null)?.state;
  return typeof state === "string" && (allowed as string[]).includes(state) ? { state: state as OwnerAccountResult["state"] } : unavailable;
}

/** Trimmed display name, 1..100 characters, no control characters; else null. */
export function ownerDisplayName(value: unknown) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name.length < 1 || [...name].length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** Everything /o/account shows. null ⇒ 404 (flag OFF, not an owner, revoked session, any error). Read-only. */
export async function ownerAccountView(session: Session): Promise<OwnerAccountView | null> {
  if (!ownerSession(session)) return null;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId)) return null;
      const sessions = (await client.query<OwnerSessionRow>(
        `SELECT session_id::text, device, created_at::text, last_active_at::text, is_current, recent_auth
           FROM app.b023_owner_sessions($1,$2)`, [session.orgId, session.sessionId])).rows;
      const profile = (await client.query<OwnerProfileView>(
        `SELECT display_name, email, phone_e164, locale, preferred_channel, channels, version FROM app.b023_owner_profile($1)`,
        [session.orgId])).rows[0];
      if (!profile) return null;
      const preferences = (await client.query<OwnerPreferenceRow>(
        `SELECT category, enabled, updated_at::text FROM app.b023_owner_notification_settings($1)`, [session.orgId])).rows;
      return { sessions, profile, preferences };
    }, scope(session), { isolation: "repeatable read", readOnly: true });
  } catch { return null; }
}

/** Sign out one OTHER own session. Idempotent by requestId. Recent-auth enforced in SQL. */
export async function revokeOwnerSession(session: Session, input: RevokeSessionInput): Promise<OwnerAccountResult> {
  if (!ownerSession(session) || !input || !isUuid(input.targetSessionId) || !isUuid(input.requestId)) return unavailable;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId) || !await currentSession(client, session)) return unavailable;
      const raw = (await client.query<{ result: unknown }>(`SELECT app.b023_revoke_owner_session($1,$2,$3,$4) AS result`,
        [session.orgId, session.sessionId, input.targetSessionId, input.requestId])).rows[0]?.result;
      return result(raw, ["revoked", "replayed", "conflict", "current", "reauth_required", "gone"]);
    }, scope(session));
  } catch { return unavailable; }
}

/** Save own display name / language / preferred channel. Idempotent by requestId; optimistic by version. */
export async function saveOwnerProfile(session: Session, input: SaveProfileInput): Promise<OwnerAccountResult> {
  if (!ownerSession(session) || !input || !isUuid(input.requestId)) return unavailable;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId) || !await currentSession(client, session)) return unavailable;
      const name = ownerDisplayName(input.displayName);
      const channel = input.channel === null || input.channel === "" ? null : input.channel;
      if (!name || !(OWNER_LOCALES as readonly string[]).includes(input.locale) || typeof input.version !== "string" || !/^[0-9a-f]{32}$/.test(input.version)
        || (channel !== null && !(OWNER_PROFILE_CHANNELS as readonly string[]).includes(channel))) return { state: "invalid" };
      const raw = (await client.query<{ result: unknown }>(`SELECT app.b023_save_owner_profile($1,$2,$3,$4,$5,$6,$7) AS result`,
        [session.orgId, session.sessionId, input.requestId, name, input.locale, channel, input.version])).rows[0]?.result;
      return result(raw, ["recorded", "replayed", "unchanged", "stale", "invalid", "conflict"]);
    }, scope(session));
  } catch { return unavailable; }
}

/** Opt in/out of one owner notification category. Idempotent by requestId. */
export async function setOwnerNotificationPreference(session: Session, input: SetPreferenceInput): Promise<OwnerAccountResult> {
  if (!ownerSession(session) || !input || !isUuid(input.requestId)) return unavailable;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId) || !await currentSession(client, session)) return unavailable;
      if (!(OWNER_NOTIFICATION_CATEGORIES as readonly string[]).includes(input.category) || typeof input.enabled !== "boolean") return { state: "invalid" };
      const raw = (await client.query<{ result: unknown }>(`SELECT app.b023_set_owner_notification_preference($1,$2,$3,$4,$5) AS result`,
        [session.orgId, session.sessionId, input.requestId, input.category, input.enabled])).rows[0]?.result;
      return result(raw, ["recorded", "replayed", "unchanged", "conflict", "invalid"]);
    }, scope(session));
  } catch { return unavailable; }
}
