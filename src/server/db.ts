import { Client, type QueryResultRow } from "pg";
import { mapDbError } from "./errors";
import { readEnvChoice, resolveStaffOrg, type OrgEnvironment } from "./org-scope";

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
export async function tx<T>(userId: string, fn: (client: Client) => Promise<T>, scope?: TxScope): Promise<T> {
  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
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
        const choice = await readEnvChoice();
        if (choice) {
          const firm = await resolveStaffOrg(client, userId, choice.preferred, choice.environment);
          if (firm) await pinOrg(client, firm.orgId, firm.environment);
        }
      }
      await client.query("SET LOCAL ROLE authenticated");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw mapDbError(error);
    }
  });
}

/**
 * Schema note: signing, portal-user provisioning, demo notifications and the
 * try-out flag run as service_role (BYPASSRLS), matching the schema comment
 * that those flows are server-side. Callers must authorize first.
 */
export async function svc<T>(userId: string | null, fn: (client: Client) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      if (userId) await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`);
      await client.query("SET LOCAL ROLE service_role");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw mapDbError(error);
    }
  });
}
