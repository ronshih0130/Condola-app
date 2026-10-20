import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n";
import { pool } from "./db";
import { SESSION_COOKIE } from "./auth";
import type { CalendarMode, OrgRole, Session } from "./types";

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

export async function readSession(): Promise<Session | null> {
  const prefs = await requestPrefs();
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const found = await pool.query<IdentityRow>(
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
    await pool.query(`UPDATE auth_sessions SET last_active_at = now() WHERE id = $1`, [identity.session_id]);
    const preferredOrg = jar.get("condola_org")?.value ?? null;
    const member = await pool.query<{ org_id: string; role: OrgRole }>(
      `SELECT org_id::text, role::text AS role
         FROM org_members
        WHERE user_id = $1 AND status = 'active'
        ORDER BY CASE WHEN org_id::text = $2 THEN 0 ELSE 1 END, created_at
        LIMIT 1`,
      [identity.user_id, preferredOrg],
    );
    const base = {
      userId: identity.user_id,
      sessionId: identity.session_id,
      email: identity.email ?? "",
      name: identity.name ?? "",
      locale: prefs.locale,
      calendar: prefs.calendar,
      leaseId: prefs.leaseId,
    };
    if (member.rows[0]) {
      return { ...base, kind: "staff", role: member.rows[0].role, orgId: member.rows[0].org_id };
    }
    const contact = await pool.query<{ org_id: string; is_tenant: boolean; is_owner: boolean }>(
      `SELECT org_id::text,
              bool_or(is_tenant) AS is_tenant,
              bool_or(is_owner) AS is_owner
         FROM contacts
        WHERE user_id = $1 AND archived_at IS NULL
        GROUP BY org_id
        ORDER BY org_id
        LIMIT 1`,
      [identity.user_id],
    );
    const portal = contact.rows[0];
    if (!portal) return null;
    let orgId = portal.org_id;
    if (prefs.leaseId) {
      const leaseOrg = await pool.query<{ org_id: string }>(
        `SELECT l.org_id::text
           FROM leases l
           JOIN lease_parties lp ON lp.lease_id = l.id
           JOIN contacts c ON c.id = lp.contact_id
          WHERE l.id = $1 AND c.user_id = $2
          LIMIT 1`,
        [prefs.leaseId, identity.user_id],
      );
      if (leaseOrg.rows[0]) orgId = leaseOrg.rows[0].org_id;
    }
    if (portal.is_tenant) return { ...base, kind: "tenant", role: null, orgId };
    if (portal.is_owner) return { ...base, kind: "owner", role: null, orgId };
    return null;
  } catch (error) {
    if (process.env.NEXT_PHASE === "phase-production-build") return null;
    throw error;
  }
}

export async function getSession(): Promise<Session> {
  const session = await readSession();
  if (!session) redirect("/login");
  return session;
}
