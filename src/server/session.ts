import { cookies } from "next/headers";
import { isLocale, type Locale } from "@/i18n";
import { pool } from "./db";
import { ORG_ID, USERS } from "./ids";
import type { CalendarMode, OrgRole, Session } from "./types";

type PersonaRow = {
  id: string;
  display_name: string | null;
  role: OrgRole | null;
  is_owner: boolean | null;
  is_tenant: boolean | null;
};

export async function getSession(): Promise<Session> {
  const jar = await cookies();
  const locale: Locale = isLocale(jar.get("condola_locale")?.value) ? jar.get("condola_locale")!.value as Locale : "zh-TW";
  const calendar: CalendarMode = jar.get("condola_calendar")?.value === "roc" ? "roc" : "gregorian";
  const requested = jar.get("condola_persona")?.value || USERS.admin;
  const leaseId = jar.get("condola_lease")?.value ?? null;
  const persona = await loadPersona(requested);
  return { ...persona, locale, calendar, leaseId };
}

export async function loadPersona(userId: string): Promise<Omit<Session, "locale" | "calendar" | "leaseId">> {
  const client = await pool.connect();
  try {
    const result = await client.query<PersonaRow>(
      `SELECT p.id, p.display_name, m.role::text AS role,
              bool_or(c.is_owner) AS is_owner,
              bool_or(c.is_tenant) AS is_tenant
         FROM profiles p
         LEFT JOIN org_members m
           ON m.user_id = p.id AND m.org_id = $2 AND m.status = 'active'
         LEFT JOIN contacts c ON c.user_id = p.id AND c.archived_at IS NULL
        WHERE p.id = $1
        GROUP BY p.id, p.display_name, m.role`,
      [userId, ORG_ID],
    );
    const row = result.rows[0] ?? (await fallbackAdmin(client));
    if (row.role) {
      return { userId: row.id, name: row.display_name ?? "", kind: "staff", role: row.role, orgId: ORG_ID };
    }
    if (row.is_tenant) {
      return { userId: row.id, name: row.display_name ?? "", kind: "tenant", role: null, orgId: ORG_ID };
    }
    if (row.is_owner) {
      return { userId: row.id, name: row.display_name ?? "", kind: "owner", role: null, orgId: ORG_ID };
    }
    return { userId: USERS.admin, name: "林雅婷", kind: "staff", role: "admin", orgId: ORG_ID };
  } finally {
    client.release();
  }
}

async function fallbackAdmin(client: import("pg").PoolClient) {
  const result = await client.query<PersonaRow>(
    `SELECT p.id, p.display_name, m.role::text AS role, false AS is_owner, false AS is_tenant
       FROM profiles p
       JOIN org_members m ON m.user_id = p.id AND m.org_id = $2
      WHERE p.id = $1`,
    [USERS.admin, ORG_ID],
  );
  return (
    result.rows[0] ?? {
      id: USERS.admin,
      display_name: "林雅婷",
      role: "admin" as const,
      is_owner: false,
      is_tenant: false,
    }
  );
}

export async function listPersonas() {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: string;
      display_name: string;
      role: OrgRole | null;
      is_owner: boolean;
      is_tenant: boolean;
    }>(
      `SELECT p.id, p.display_name,
              m.role::text AS role,
              coalesce(bool_or(c.is_owner), false) AS is_owner,
              coalesce(bool_or(c.is_tenant), false) AS is_tenant
         FROM profiles p
         LEFT JOIN org_members m
           ON m.user_id = p.id AND m.org_id = $1 AND m.status = 'active'
         LEFT JOIN contacts c
           ON c.user_id = p.id AND c.archived_at IS NULL AND (c.org_id = $1 OR c.is_tenant OR c.is_owner)
        WHERE m.id IS NOT NULL OR c.id IS NOT NULL
        GROUP BY p.id, p.display_name, m.role
        ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 WHEN 'accountant' THEN 2 WHEN 'maintenance' THEN 3 ELSE 4 END,
                 p.display_name`,
      [ORG_ID],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.display_name,
      role: row.role,
      kind: row.role ? "staff" : row.is_tenant ? "tenant" : "owner",
    }));
  } finally {
    client.release();
  }
}
