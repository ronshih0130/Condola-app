import type { OrgRole } from "./types";

export const ENV_COOKIE = "condola_env";
export const ORG_COOKIE = "condola_org";

export type OrgEnvironment = "live" | "sandbox";

export type FirmContext = {
  orgId: string;
  liveOrgId: string;
  environment: OrgEnvironment;
  role: OrgRole;
};

export type EnvChoice = {
  preferred: string | null;
  environment: OrgEnvironment;
};

type SqlClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

/** Null when this process is not inside a request (unit tests, seed). */
export async function readEnvChoice(): Promise<EnvChoice | null> {
  try {
    const { cookies } = await import("next/headers");
    const jar = await cookies();
    return {
      preferred: jar.get(ORG_COOKIE)?.value ?? null,
      environment: jar.get(ENV_COOKIE)?.value === "sandbox" ? "sandbox" : "live",
    };
  } catch {
    return null;
  }
}

/**
 * Staff always resolve through their live membership. The sandbox cookie then
 * swaps in that firm's linked sandbox, so a sandbox membership row cannot
 * become the default firm.
 */
export async function resolveStaffOrg(
  sql: SqlClient,
  userId: string,
  preferredOrg: string | null,
  environment: OrgEnvironment,
): Promise<FirmContext | null> {
  const live = await sql.query<{ org_id: string; role: OrgRole }>(
    `SELECT m.org_id::text, m.role::text AS role
       FROM org_members m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.status = 'active' AND o.environment = 'live'
      ORDER BY CASE WHEN m.org_id::text = $2 THEN 0 ELSE 1 END, m.created_at
      LIMIT 1`,
    [userId, preferredOrg],
  );
  const member = live.rows[0];
  if (!member) return null;
  if (environment !== "sandbox") {
    return { orgId: member.org_id, liveOrgId: member.org_id, environment: "live", role: member.role };
  }
  const sandbox = await sql.query<{ id: string }>(
    `SELECT id::text FROM organizations WHERE live_org_id = $1 AND environment = 'sandbox'`,
    [member.org_id],
  );
  const sandboxId = sandbox.rows[0]?.id;
  if (!sandboxId) {
    return { orgId: member.org_id, liveOrgId: member.org_id, environment: "live", role: member.role };
  }
  return { orgId: sandboxId, liveOrgId: member.org_id, environment: "sandbox", role: member.role };
}
