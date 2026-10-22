/**
 * Which Postgres login a call uses.
 * `read` may use the Hyperdrive binding. `primary` is DATABASE_URL
 * (the Supabase session lookup and service_role writes).
 */
export type DbRoute = "read" | "primary";

export type DbRole = "authenticated" | "service_role";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Read queries use Hyperdrive when the Worker binding is present.
 * No binding (local, unit tests, `next dev`) keeps the existing `pg`
 * client on DATABASE_URL, which is the Supabase Postgres connection.
 * List queries do not go through supabase-js or PostgREST.
 */
export function selectConnectionString(
  route: DbRoute,
  databaseUrl: string | undefined,
  hyperdriveUrl: string | undefined,
): string {
  if (route === "read") {
    const pooled = hyperdriveUrl?.trim();
    if (pooled) return pooled;
  }
  const direct = databaseUrl?.trim();
  if (!direct) {
    throw new Error(route === "read" ? "HYPERDRIVE binding and DATABASE_URL are both unset" : "DATABASE_URL is not set");
  }
  return direct;
}

export const SET_ROLE_SQL: Record<DbRole, string> = {
  authenticated: "SET LOCAL ROLE authenticated",
  service_role: "SET LOCAL ROLE service_role",
};

/**
 * One simple-protocol batch: optional BEGIN, the transaction-local GUCs, and
 * SET LOCAL ROLE. Extended-protocol bind parameters cannot share a query with
 * SET ROLE, so the values are quoted literals. They are accepted only when
 * they match a UUID, the fixed role name, or live|sandbox.
 */
export function preambleSql(input: {
  userId: string | null;
  role: DbRole;
  pin?: { orgId: string; environment: string };
  begin: boolean;
}): string {
  if (input.role !== "authenticated" && input.role !== "service_role") throw new Error("refusing session claim");
  if (input.userId !== null && !UUID_RE.test(input.userId)) throw new Error("refusing session claim");
  if (input.pin) {
    if (!UUID_RE.test(input.pin.orgId)) throw new Error("refusing org pin");
    if (input.pin.environment !== "live" && input.pin.environment !== "sandbox") {
      throw new Error("refusing org environment");
    }
  }
  const parts = [`set_config('request.jwt.claim.role', ${sqlLiteral(input.role)}, true)`];
  if (input.userId) parts.push(`set_config('request.jwt.claim.sub', ${sqlLiteral(input.userId)}, true)`);
  if (input.pin) {
    parts.push(`set_config('app.active_org_id', ${sqlLiteral(input.pin.orgId)}, true)`);
    parts.push(`set_config('app.env', ${sqlLiteral(input.pin.environment)}, true)`);
  }
  const claims = `SELECT ${parts.join(", ")}; ${SET_ROLE_SQL[input.role]};`;
  return input.begin ? `BEGIN; ${claims}` : claims;
}

function sqlLiteral(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("refusing session claim");
  return `'${value}'`;
}
