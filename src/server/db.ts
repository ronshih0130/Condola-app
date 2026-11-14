import { Client, type QueryResultRow } from "pg";
import { finishAfterResponse } from "./after-response";
import { logServerError, mapDbError } from "./errors";
import { readEnvChoice, resolveStaffOrg, type OrgEnvironment } from "./org-scope";
import { withUsageTransaction } from "./usage-events";

function closedSocket(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /socket has been closed|Connection terminated/i.test(message);
}

/** pg's terminate (X) message. Sent once, then the socket is closed. */
const TERMINATE = Buffer.from([88, 0, 0, 0, 4]);

/**
 * Workers close the socket as the request finishes. pg then writes a goodbye
 * and emits `This socket has been closed` once per client. Swallow that, wait
 * until the query that was already awaited has left the connection, and end once.
 */
function guardSocketClose(client: Client) {
  client.on("error", () => {});
  const connection = client.connection as Client["connection"] & { _ending?: boolean };
  const stream = connection.stream;
  stream.on("error", () => {});
  let ending = false;
  connection.end = () => {
    if (ending) return;
    ending = true;
    connection._ending = true;
    const finish = () => {
      try {
        stream.end();
      } catch (error) {
        if (!closedSocket(error)) throw error;
        try {
          stream.destroy();
        } catch {
          // The runtime already closed it.
        }
      }
    };
    try {
      if (!stream.writable) {
        finish();
        return;
      }
      stream.write(TERMINATE, () => {
        try {
          finish();
        } catch {
          // close callback can run after the Worker has dropped the socket
        }
      });
    } catch (error) {
      if (!closedSocket(error)) throw error;
      finish();
    }
  };
}

async function endOnce(client: Client, ended: { current: boolean }) {
  if (ended.current) return;
  ended.current = true;
  const active = (client as Client & { _activeQuery?: { once?: (event: string, fn: () => void) => void } })._activeQuery;
  if (active) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      client.once("drain", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  try {
    await Promise.race([
      client.end(),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
  } catch (error) {
    if (!closedSocket(error)) throw error;
  }
}

/**
 * One database connection for a single operation.
 * Cloudflare Workers close sockets when a request ends, so a module-level Pool
 * (or anything stored on globalThis) hands the next request a dead socket.
 */
export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 8000,
  });
  const ended = { current: false };
  client.on("error", () => {});
  await client.connect();
  guardSocketClose(client);
  try {
    return await fn(client);
  } finally {
    await endOnce(client, ended);
  }
}

/**
 * One connection. The deferred statement runs after the response on Workers
 * (ctx.waitUntil) and before return in node tests. The photo path uses this
 * so the access log does not add a round trip before the bytes are sent.
 */
export async function withDeferredClient<T>(
  fn: (client: Client, defer: (sql: string, params?: unknown[]) => void) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 8000,
  });
  const ended = { current: false };
  client.on("error", () => {});
  await client.connect();
  guardSocketClose(client);
  const deferred: { sql: string; params: unknown[] }[] = [];
  try {
    const result = await fn(client, (sql, params = []) => {
      deferred[0] = { sql, params };
    });
    const statement = deferred[0];
    if (!statement) {
      await endOnce(client, ended);
      return result;
    }
    const work = (async () => {
      try {
        await client.query(statement.sql, statement.params);
      } finally {
        await endOnce(client, ended);
      }
    })();
    await finishAfterResponse(work);
    return result;
  } catch (error) {
    await endOnce(client, ended);
    throw error;
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
  return withClient((client) => client.query<T>(sql, params));
}

export async function many<T extends QueryResultRow>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await client.query<T>(sql, params);
  return result.rows;
}

export async function one<T extends QueryResultRow>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const rows = await many<T>(client, sql, params);
  if (!rows[0]) {
    const { FlowError } = await import("./errors");
    throw new FlowError("errors.notFound");
  }
  return rows[0];
}

export async function maybe<T extends QueryResultRow>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await many<T>(client, sql, params);
  return rows[0] ?? null;
}

export type TxScope = { orgId: string; environment?: OrgEnvironment } | { pin: false };

async function pinOrg(client: Client, orgId: string, environment: OrgEnvironment) {
  await client.query(`SELECT set_config('app.active_org_id', $1, true)`, [orgId]);
  await client.query(`SELECT set_config('app.env', $1, true)`, [environment]);
}

/** Run as the signed-in persona so Postgres RLS applies. */
export async function tx<T>(userId: string, fn: (client: Client) => Promise<T>, scope?: TxScope, options?: { isolation?: "repeatable read" | "serializable"; readOnly?: boolean }): Promise<T> {
  return withClient(async (client) => {
    try {
      const isolation = options?.isolation === "serializable" ? " ISOLATION LEVEL SERIALIZABLE" : options?.isolation === "repeatable read" ? " ISOLATION LEVEL REPEATABLE READ" : "";
      await client.query(`BEGIN${isolation}${options?.readOnly ? " READ ONLY" : ""}`);
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      if (scope && "pin" in scope) {
        // Explicitly unpinned: sandbox rows stay hidden, live membership is unchanged.
      } else if (scope && "orgId" in scope) {
        const environment =
          scope.environment ??
          (
            await client.query<{ environment: OrgEnvironment }>(
              `SELECT environment::text AS environment FROM organizations WHERE id = $1`,
              [scope.orgId],
            )
          ).rows[0]?.environment ??
          "live";
        await pinOrg(client, scope.orgId, environment);
      } else {
        // Request paths must pass requireOrgScope(session) or use txForSession.
        // This fallback is for non-request callers such as seed and cron.
        // pinOrg sets app.active_org_id. post_reversal and fn_invoice_recalc
        // compare that setting when current_user is authenticated.
        // cookies() throws outside a request; still resolve the live firm so
        // the setting exists for those functions.
        const choice = await readEnvChoice();
        const firm = await resolveStaffOrg(
          client,
          userId,
          choice?.preferred ?? null,
          choice?.environment ?? null,
        );
        if (firm) await pinOrg(client, firm.orgId, firm.environment);
      }
      await client.query("SET LOCAL ROLE authenticated");
      const result = await withUsageTransaction(client, () => fn(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      return rollBack(client, error);
    }
  });
}

async function rollBack(client: Client, error: unknown): Promise<never> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    logServerError("rollback", rollbackError);
  }
  throw mapDbError(error);
}

/**
 * Schema note: signing, portal-user provisioning, demo notifications and the
 * try-out flag run as service_role (BYPASSRLS), matching the schema comment
 * that those flows are server-side. Callers must authorize first.
 */
/** service_role transaction on a connection the caller already holds. */
export type SvcOptions = { isolation?: "read committed" | "repeatable read"; readOnly?: boolean };

/**
 * BEGIN statement for svcOn. Read-only defaults to REPEATABLE READ (one snapshot); an explicit
 * isolation is honoured on writable transactions too (B-056 r3-final #5: the snapshot builder
 * runs READ COMMITTED under its row lock).
 */
export function svcBeginStatement(options?: SvcOptions): string {
  const level = options?.isolation ?? (options?.readOnly ? "repeatable read" : null);
  const isolation = level === "repeatable read" ? " ISOLATION LEVEL REPEATABLE READ" : level === "read committed" ? " ISOLATION LEVEL READ COMMITTED" : "";
  return `BEGIN${isolation}${options?.readOnly ? " READ ONLY" : ""}`;
}

export async function svcOn<T>(client: Client, userId: string | null, fn: (client: Client) => Promise<T>, options?: SvcOptions): Promise<T> {
  try {
    await client.query(svcBeginStatement(options));
    if (userId) {
      await client.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'service_role', true)`,
        [userId],
      );
    } else {
      await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`);
    }
    await client.query("SET LOCAL ROLE service_role");
    const result = await withUsageTransaction(client, () => fn(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    return rollBack(client, error);
  }
}

export async function svc<T>(userId: string | null, fn: (client: Client) => Promise<T>, options?: SvcOptions): Promise<T> {
  return withClient((client) => svcOn(client, userId, fn, options));
}
