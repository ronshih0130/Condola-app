import { assertCustomRoleAdmission } from "./b017-admission";
import { appCookieOptions } from "./public-origin";
import type { OrgRole } from "./types";

export const ENV_COOKIE = "condola_env";
export const ORG_COOKIE = "condola_org";
/** Lifetime for the org cookie. The environment cookie is a session cookie and does not use this age. */
export const ENV_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

type EnvCookieJar = {
  set: (
    name: string,
    value: string,
    options: { httpOnly: boolean; sameSite: "lax"; secure: boolean; path: string; domain?: string; maxAge: number },
  ) => void;
};

/** Drop a leftover test-mode cookie. Sign-in must not keep sandbox selected. */
export function clearStoredEnvChoice(jar: EnvCookieJar) {
  jar.set(ENV_COOKIE, "", appCookieOptions({ httpOnly: false, maxAge: 0 }));
}

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
 * Login and sign-up open the live org. The sandbox cookie is a session cookie
 * set only when the user switches. A missing cookie is live, including a new
 * firm and while the emergency pause is on. /api/env?set=live still refuses
 * when that pause is on. hasLiveData and liveEnabled stay on the signature so
 * existing callers compile; they do not choose the environment.
 * Sign-in clears condola_env. A host-only sandbox cookie from before
 * Domain=.condola.app is not the cookie the jar expires, so sign-in also
 * redirects through /auth/enter, which expires every domain variant.
 */
export function resolveStaffEnvironment(input: {
  cookie: OrgEnvironment | null;
  hasLiveData: boolean;
  liveEnabled: boolean;
}): OrgEnvironment {
  void input.hasLiveData;
  void input.liveEnabled;
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
  const live = await sql.query<{ org_id: string; role: OrgRole; live_enabled: boolean; has_live_data: boolean; custom_roles_enabled: boolean }>(
    `SELECT m.org_id::text, m.role::text AS role,
            coalesce(o.feature_flags->'custom_roles'='true'::jsonb AND
              (SELECT value->'enabled'='true'::jsonb AND value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
               FROM platform_settings WHERE key='custom_roles'),false) AS custom_roles_enabled,
            NOT coalesce((SELECT value = 'true'::jsonb FROM platform_settings WHERE key = 'go_live_lock'), false) AS live_enabled,
            (
              o.live_started_at IS NOT NULL
              OR EXISTS (SELECT 1 FROM properties p WHERE p.org_id = o.id)
              OR EXISTS (SELECT 1 FROM leases l WHERE l.org_id = o.id)
            ) AS has_live_data
       FROM org_members m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.status = 'active' AND o.environment = 'live'
        AND NOT app.b056_member_paused(m.org_id, m.user_id)
      ORDER BY CASE WHEN m.org_id::text = $2 THEN 0 ELSE 1 END, m.created_at
      LIMIT 1`,
    [userId, preferredOrg],
  );
  const member = live.rows[0];
  if (!member) return null;
  assertCustomRoleAdmission(member.org_id, member.custom_roles_enabled === true);
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
