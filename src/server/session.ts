import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { isLocale, type Locale } from "@/i18n";
import { withClient } from "./db";
import { SESSION_COOKIE } from "./auth";
import { ENV_COOKIE, ORG_COOKIE, resolveStaffOrg, type OrgEnvironment } from "./org-scope";
import { PORTAL_ROLE_COOKIE, pickPortalOrg, resolvePortalKind } from "./portal-role";
import { correctRetiredSampleAddresses, ensureSampleLoaded, ensureSandbox } from "./sandbox";
import type { CalendarMode, Session } from "./types";

export type Prefs = { locale: Locale; calendar: CalendarMode; leaseId: string | null };

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function requestPrefs(): Promise<Prefs> {
  const jar = await cookies();
  const locale: Locale = isLocale(jar.get("condola_locale")?.value) ? (jar.get("condola_locale")!.value as Locale) : "zh-TW";
  const calendar: CalendarMode = jar.get("condola_calendar")?.value === "roc" ? "roc" : "gregorian";
  const leaseId = jar.get("condola_lease")?.value ?? null;
  return { locale, calendar, leaseId };
}

type IdentityRow = {
  session_id: string;
  user_id: string;
  name: string | null;
  email: string | null;
};

async function readSessionOnce(): Promise<Session | null> {
  const prefs = await requestPrefs();
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  let path = "";
  try {
    path = (await headers()).get("x-pathname") || "";
  } catch {
    path = "";
  }
  const portalCookie = jar.get(PORTAL_ROLE_COOKIE)?.value ?? null;
  try {
    let seedSample = false;
    const session = await withClient(async (client): Promise<(Session & { needsSandbox?: boolean }) | null> => {
      const found = await client.query<IdentityRow>(
        `SELECT s.id::text AS session_id, s.user_id::text, p.display_name AS name,
                coalesce(p.email::text, u.email) AS email
           FROM auth_sessions s
           JOIN auth.users u ON u.id = s.user_id
           LEFT JOIN profiles p ON p.id = u.id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [sha256(token)],
      );
      const identity = found.rows[0];
      if (!identity) return null;
      await client.query(
        `UPDATE auth_sessions
            SET last_active_at = now(),
                expires_at = greatest(expires_at, now() + interval '12 hours')
          WHERE id = $1`,
        [identity.session_id],
      );
      const preferredOrg = jar.get(ORG_COOKIE)?.value ?? null;
      const rawEnv = jar.get(ENV_COOKIE)?.value;
      const envChoice: OrgEnvironment | null = rawEnv === "sandbox" ? "sandbox" : rawEnv === "live" ? "live" : null;
      const base = {
        userId: identity.user_id,
        sessionId: identity.session_id,
        email: identity.email ?? "",
        name: identity.name ?? "",
        locale: prefs.locale,
        calendar: prefs.calendar,
        leaseId: prefs.leaseId,
      };
      const firm = await resolveStaffOrg(client, identity.user_id, preferredOrg, envChoice);
      if (firm) {
        if (firm.environment === "sandbox" && !firm.needsSandbox) {
          await correctRetiredSampleAddresses(client, firm.orgId);
          const peek = await client.query<{ needed: boolean }>(
            `SELECT (o.sample_loaded_at IS NULL AND NOT (
                EXISTS (SELECT 1 FROM properties p WHERE p.org_id = o.id)
                OR EXISTS (SELECT 1 FROM leases l WHERE l.org_id = o.id)
                OR EXISTS (SELECT 1 FROM units u WHERE u.org_id = o.id)
                OR EXISTS (SELECT 1 FROM contacts c WHERE c.org_id = o.id)
              )) AS needed
               FROM organizations o
              WHERE o.id = $1 AND o.environment = 'sandbox'`,
            [firm.orgId],
          );
          seedSample = Boolean(peek.rows[0]?.needed);
        } else if (firm.environment === "sandbox") {
          seedSample = true;
        }
        return {
          ...base,
          kind: "staff" as const,
          role: firm.role,
          orgId: firm.orgId,
          liveOrgId: firm.liveOrgId,
          environment: firm.environment,
          liveEnabled: firm.liveEnabled,
          needsSandbox: firm.needsSandbox,
        };
      }
      const contact = await client.query<{
        org_id: string;
        environment: OrgEnvironment;
        live_org_id: string;
        is_tenant: boolean;
        is_owner: boolean;
        latest_kind: string | null;
        latest_at: Date | null;
      }>(
        `SELECT c.org_id::text,
                o.environment::text AS environment,
                coalesce(o.live_org_id::text, c.org_id::text) AS live_org_id,
                bool_or(c.is_tenant) AS is_tenant,
                bool_or(c.is_owner) AS is_owner,
                (
                  SELECT i.kind::text
                    FROM invitations i
                   WHERE i.accepted_by = $1
                     AND i.org_id = c.org_id
                     AND i.status = 'accepted'
                     AND i.kind IN ('owner', 'tenant')
                   ORDER BY i.accepted_at DESC NULLS LAST
                   LIMIT 1
                ) AS latest_kind,
                (
                  SELECT i.accepted_at
                    FROM invitations i
                   WHERE i.accepted_by = $1
                     AND i.org_id = c.org_id
                     AND i.status = 'accepted'
                     AND i.kind IN ('owner', 'tenant')
                   ORDER BY i.accepted_at DESC NULLS LAST
                   LIMIT 1
                ) AS latest_at
           FROM contacts c
           JOIN organizations o ON o.id = c.org_id
          WHERE c.user_id = $1 AND c.archived_at IS NULL
          GROUP BY c.org_id, o.environment, o.live_org_id
          ORDER BY c.org_id`,
        [identity.user_id],
      );
      const picked = pickPortalOrg(
        contact.rows.map((row) => ({
          row,
          isOwner: row.is_owner,
          isTenant: row.is_tenant,
          latestAt: row.latest_at ? new Date(row.latest_at).getTime() : null,
        })),
        path,
        portalCookie,
      );
      const portal = picked?.row;
      if (!portal) return null;
      let orgId = portal.org_id;
      let environment: OrgEnvironment = portal.environment === "sandbox" ? "sandbox" : "live";
      let liveOrgId = portal.live_org_id;
      if (prefs.leaseId) {
        const leaseOrg = await client.query<{ org_id: string; environment: OrgEnvironment; live_org_id: string }>(
          `SELECT l.org_id::text, o.environment::text AS environment, coalesce(o.live_org_id::text, l.org_id::text) AS live_org_id
             FROM leases l
             JOIN organizations o ON o.id = l.org_id
             JOIN lease_parties lp ON lp.lease_id = l.id
             JOIN contacts c ON c.id = lp.contact_id
            WHERE l.id = $1 AND c.user_id = $2
            LIMIT 1`,
          [prefs.leaseId, identity.user_id],
        );
        if (leaseOrg.rows[0]) {
          orgId = leaseOrg.rows[0].org_id;
          environment = leaseOrg.rows[0].environment === "sandbox" ? "sandbox" : "live";
          liveOrgId = leaseOrg.rows[0].live_org_id;
        }
      }
      const latest = portal.latest_kind === "owner" || portal.latest_kind === "tenant" ? portal.latest_kind : null;
      const kind = resolvePortalKind({
        path,
        cookie: portalCookie,
        isOwner: contact.rows.some((row) => row.is_owner),
        isTenant: contact.rows.some((row) => row.is_tenant),
        latest,
      });
      if (!kind) return null;
      return {
        ...base,
        kind,
        role: null,
        orgId,
        liveOrgId,
        environment,
        portals: {
          owner: contact.rows.some((row) => row.is_owner),
          tenant: contact.rows.some((row) => row.is_tenant),
        },
      };
    });
    if (session?.kind === "staff" && session.environment === "sandbox") {
      const sandboxId = session.needsSandbox ? await ensureSandbox(session) : session.orgId;
      const opened = { ...session, orgId: sandboxId, environment: "sandbox" as const, needsSandbox: false };
      if (seedSample) await ensureSampleLoaded(opened);
      if (session.needsSandbox) await withClient((client) => correctRetiredSampleAddresses(client, sandboxId));
      return opened;
    }
    return session;
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
