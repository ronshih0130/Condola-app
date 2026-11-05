import { consentCoversCurrent, withMissingConsentFallback, type StoredConsent } from "./consent";
import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Client } from "pg";
import { cache } from "react";
import { isLocale, type Locale } from "@/i18n";
import { withClient } from "./db";
import { resolveIdentity, type IdentityResolveCtx } from "./identity";
import { readPartnerStateOn } from "./partner-consent";
import { SESSION_COOKIE } from "./auth";
import { ENV_COOKIE, ORG_COOKIE, type OrgEnvironment } from "./org-scope";
import { PORTAL_ROLE_COOKIE } from "./portal-role";
import { correctRetiredSampleAddresses, ensureSampleLoaded, ensureSandbox } from "./sandbox";
import type { CalendarMode, Session } from "./types";

export type Prefs = { locale: Locale; calendar: CalendarMode; leaseId: string | null };

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Same hash `readSessionOn` stores on `auth_sessions.token_hash`. */
export function sessionTokenHash(token: string) {
  return sha256(token);
}

export async function requestPrefs(): Promise<Prefs> {
  const jar = await cookies();
  const locale: Locale = isLocale(jar.get("condola_locale")?.value) ? (jar.get("condola_locale")!.value as Locale) : "zh-TW";
  const calendar: CalendarMode = jar.get("condola_calendar")?.value === "roc" ? "roc" : "gregorian";
  const leaseId = jar.get("condola_lease")?.value ?? null;
  return { locale, calendar, leaseId };
}

type IdentityRow = {
  consent: StoredConsent | null;
  session_id: string;
  user_id: string;
  name: string | null;
  email: string | null;
};

export type SessionLoad = {
  session: (Session & { needsSandbox?: boolean }) | null;
  seedSample: boolean;
};

/**
 * Session lookup on a connection the caller already holds.
 * Photo GETs pass touch:false so three parallel images do not queue on one last_active update.
 */
export async function readSessionOn(client: Client, options?: { touch?: boolean }): Promise<SessionLoad> {
  const prefs = await requestPrefs();
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return { session: null, seedSample: false };
  let path = "";
  try {
    path = (await headers()).get("x-pathname") || "";
  } catch {
    path = "";
  }
  const portalCookie = jar.get(PORTAL_ROLE_COOKIE)?.value ?? null;
  let seedSample = false;
  const found = await withMissingConsentFallback(() => client.query<IdentityRow>(
        `SELECT s.id::text AS session_id, s.user_id::text, p.display_name AS name,
                CASE WHEN u.email_confirmed_at IS NOT NULL THEN u.email ELSE NULL END AS email, latest.consent
           FROM auth_sessions s
           JOIN auth.users u ON u.id = s.user_id
           LEFT JOIN profiles p ON p.id = u.id
           LEFT JOIN LATERAL (
             SELECT jsonb_build_object(
               'accepted_at', c.accepted_at, 'terms_version', c.terms_version,
               'privacy_version', c.privacy_version, 'source', c.source
             ) AS consent
               FROM public.consents c WHERE c.user_id = u.id
              ORDER BY c.recorded_at DESC, c.id DESC LIMIT 1
           ) latest ON true
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [sha256(token)],
      ), () => client.query<IdentityRow>(
        `SELECT s.id::text AS session_id, s.user_id::text, p.display_name AS name,
                CASE WHEN u.email_confirmed_at IS NOT NULL THEN u.email ELSE NULL END AS email, NULL::jsonb AS consent
           FROM auth_sessions s
           JOIN auth.users u ON u.id = s.user_id
           LEFT JOIN profiles p ON p.id = u.id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [sha256(token)],
      ));
  const identity = found.rows[0];
  if (!identity) return { session: null, seedSample: false };
  if (options?.touch !== false) {
    await client.query(
      `UPDATE auth_sessions
          SET last_active_at = now(),
              expires_at = greatest(expires_at, now() + interval '12 hours')
        WHERE id = $1`,
      [identity.session_id],
    );
  }
      const preferredOrg = jar.get(ORG_COOKIE)?.value ?? null;
      const rawEnv = jar.get(ENV_COOKIE)?.value;
      const envChoice: OrgEnvironment | null = rawEnv === "sandbox" ? "sandbox" : rawEnv === "live" ? "live" : null;
      const ctx: IdentityResolveCtx = {
        preferredOrg,
        envCookie: envChoice,
        path,
        portalCookie,
        leaseId: prefs.leaseId,
      };
      const base = {
        userId: identity.user_id,
        consent: identity.consent,
        sessionId: identity.session_id,
        email: identity.email ?? "",
        name: identity.name ?? "",
        locale: prefs.locale,
        calendar: prefs.calendar,
        leaseId: prefs.leaseId,
      };
      const resolved = await resolveIdentity(client, identity.user_id, ctx);
      if (!resolved) return { session: null, seedSample: false };
      if (resolved.kind === "staff") {
        const partnerConsent = await readPartnerStateOn(client, {
          ...base, ...resolved, kind: "staff",
        });
        if (consentCoversCurrent(identity.consent) && !partnerConsent.required && resolved.environment === "sandbox" && !resolved.needsSandbox) {
          await correctRetiredSampleAddresses(client, resolved.orgId);
          const peek = await client.query<{ needed: boolean }>(
            `SELECT (o.sample_loaded_at IS NULL AND NOT (
                EXISTS (SELECT 1 FROM properties p WHERE p.org_id = o.id)
                OR EXISTS (SELECT 1 FROM leases l WHERE l.org_id = o.id)
                OR EXISTS (SELECT 1 FROM units u WHERE u.org_id = o.id)
                OR EXISTS (SELECT 1 FROM contacts c WHERE c.org_id = o.id)
              )) AS needed
               FROM organizations o
              WHERE o.id = $1 AND o.environment = 'sandbox'`,
            [resolved.orgId],
          );
          seedSample = Boolean(peek.rows[0]?.needed);
        } else if (resolved.environment === "sandbox") {
          seedSample = true;
        }
        return {
          seedSample,
          session: {
            ...base,
            kind: "staff" as const,
            partnerConsent,
            role: resolved.role,
            orgId: resolved.orgId,
            liveOrgId: resolved.liveOrgId,
            environment: resolved.environment,
            liveEnabled: resolved.liveEnabled,
            needsSandbox: resolved.needsSandbox,
          },
        };
      }
      return {
        seedSample,
        session: {
          ...base,
          kind: resolved.kind,
          role: null,
          orgId: resolved.orgId,
          liveOrgId: resolved.liveOrgId,
          environment: resolved.environment,
          portals: resolved.portals,
        },
      };
}

/** Sandbox provisioning stays after the lookup, and may open its own connection. */
export async function completeSession(loaded: SessionLoad): Promise<Session | null> {
  const session = loaded.session;
  if (session?.kind === "staff" && consentCoversCurrent(session.consent ?? null) && !session.partnerConsent?.required && session.environment === "sandbox") {
    const sandboxId = session.needsSandbox ? await ensureSandbox(session) : session.orgId;
    const opened = { ...session, orgId: sandboxId, environment: "sandbox" as const, needsSandbox: false };
    if (loaded.seedSample) await ensureSampleLoaded(opened);
    if (session.needsSandbox) await withClient((client) => correctRetiredSampleAddresses(client, sandboxId));
    return opened;
  }
  return session;
}

async function readSessionOnce(): Promise<Session | null> {
  try {
    const loaded = await withClient((client) => readSessionOn(client));
    return completeSession(loaded);
  } catch (error) {
    if (process.env.NEXT_PHASE === "phase-production-build") return null;
    throw error;
  }
}

/** One session lookup per request. Root layout and the page used to each open a database connection. */
export const readSession = cache(readSessionOnce);

export async function getSession(): Promise<Session> {
  const session = await readSession();
  if (!session) redirect("/login");
  return session;
}
