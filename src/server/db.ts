import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { mapDbError } from "./errors";

const globalPool = globalThis as unknown as { condolaPool?: Pool };

export const pool =
  globalPool.condolaPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 12,
  });

if (process.env.NODE_ENV !== "production") globalPool.condolaPool = pool;

export async function many<T extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await client.query<T>(sql, params);
  return result.rows;
}

export async function one<T extends QueryResultRow>(
  client: PoolClient,
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
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await many<T>(client, sql, params);
  return rows[0] ?? null;
}

/** Run as the signed-in persona so Postgres RLS applies. */
export async function tx<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
    await client.query("SET LOCAL ROLE authenticated");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw mapDbError(error);
  } finally {
    client.release();
  }
}

/**
 * Schema note: signing, portal-user provisioning, demo notifications and the
 * try-out flag run as service_role (BYPASSRLS), matching the schema comment
 * that those flows are server-side. Callers must authorize first.
 */
export async function svc<T>(userId: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
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
  } finally {
    client.release();
  }
}
