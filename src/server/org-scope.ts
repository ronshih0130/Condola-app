import type { OrgRole } from "./types";

export const ENV_COOKIE = "condola_env";
export const ORG_COOKIE = "condola_org";
/** Last environment choice. A session cookie was dropped on browser quit and a live firm then opened in test mode. */
export const ENV_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export type OrgEnvironment = "live" | "sandbox";

export type FirmContext = {
  orgId: string;
  liveOrgId: string;
  environment: OrgEnvironment;
  role: OrgRole;
  liveEnabled: boolean;
  /** Sandbox was chosen and the linked sandbox firm does not exist yet. */
  needsSandbox: boolean;
};

export type EnvChoice = {
  preferred: string | null;
  /** Null when the browser has not picked a mode yet. */
  environment: OrgEnvironment | null;
};

/**
 * A firm that has not started live, or while the emergency pause is on, always
 * opens in test mode. A live firm with data opens in live mode when the cookie
 * is missing, so quitting the browser cannot hide that firm's rows. An explicit
 * sandbox cookie still opens test mode. live_started_at counts as live data so
 * go-live without copied rows stays on the live firm.
 */
export function resolveStaffEnvironment(input: {
  cookie: OrgEnvironment | null;
  hasLiveData: boolean;
  liveEnabled: boolean;
}): OrgEnvironment {
  if (!input.liveEnabled || !input.hasLiveData) return "sandbox";
  if (input.cookie === "sandbox") return "sandbox";
  return "live";
}

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
    const raw = jar.get(ENV_COOKIE)?.value;
    return {
      preferred: jar.get(ORG_COOKIE)?.value ?? null,
      environment: raw === "sandbox" ? "sandbox" : raw === "live" ? "live" : null,
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
  cookie: OrgEnvironment | null,
): Promise<FirmContext | null> {
  const live = await sql.query<{ org_id: string; role: OrgRole; live_enabled: boolean; has_live_data: boolean }>(
    `SELECT m.org_id::text, m.role::text AS role,
            NOT coalesce((SELECT value = 'true'::jsonb FROM platform_settings WHERE key = 'go_live_lock'), false) AS live_enabled,
            (
              o.live_started_at IS NOT NULL
              OR EXISTS (SELECT 1 FROM properties p WHERE p.org_id = o.id)
              OR EXISTS (SELECT 1 FROM leases l WHERE l.org_id = o.id)
            ) AS has_live_data
       FROM org_members m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.status = 'active' AND o.environment = 'live'
      ORDER BY CASE WHEN m.org_id::text = $2 THEN 0 ELSE 1 END, m.created_at
      LIMIT 1`,
    [userId, preferredOrg],
  );
  const member = live.rows[0];
  if (!member) return null;
  const liveEnabled = Boolean(member.live_enabled);
  const environment = resolveStaffEnvironment({
    cookie,
    hasLiveData: Boolean(member.has_live_data),
    liveEnabled,
  });
  const base = { liveOrgId: member.org_id, role: member.role, liveEnabled };
  if (environment !== "sandbox") {
    return { ...base, orgId: member.org_id, environment: "live", needsSandbox: false };
  }
  const sandbox = await sql.query<{ id: string }>(
    `SELECT id::text FROM organizations WHERE live_org_id = $1 AND environment = 'sandbox'`,
    [member.org_id],
  );
  const sandboxId = sandbox.rows[0]?.id;
  if (!sandboxId) {
    return { ...base, orgId: member.org_id, environment: "sandbox", needsSandbox: true };
  }
  return { ...base, orgId: sandboxId, environment: "sandbox", needsSandbox: false };
}
