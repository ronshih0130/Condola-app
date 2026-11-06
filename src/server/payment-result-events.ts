import type { Client } from "pg";
import type { Session } from "./types";
import { svcOn } from "./db";

/** OFF retains the legacy payment path, including databases not yet migrated. */
export async function lockPaymentResultContext(client: Client, session: Session, leaseId: string): Promise<boolean> {
  const exists=await client.query<{present:boolean}>(`SELECT to_regprocedure('app.b010_lock_payment_context(uuid,uuid,text,uuid,uuid,text)') IS NOT NULL AS present`);
  if (!exists.rows[0]?.present) return false;
  const sessionId=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(session.sessionId) ? session.sessionId : null;
  const result=await client.query<{enabled:boolean}>(`SELECT app.b010_lock_payment_context($1,$2,$3,$4,$5,$6) AS enabled`,
    [session.orgId,session.liveOrgId,session.environment,sessionId,leaseId,session.role]);
  return result.rows[0].enabled;
}

export async function lockOwnerPaymentResultContext(client: Client, session: Session, leaseId: string): Promise<boolean> {
  const exists=await client.query<{present:boolean}>(`SELECT to_regprocedure('app.b010_lock_owner_payment_context(uuid,text,uuid,uuid)') IS NOT NULL AS present`);
  if (!exists.rows[0]?.present) return false;
  const sessionId=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(session.sessionId) ? session.sessionId : null;
  const result=await client.query<{enabled:boolean}>(`SELECT app.b010_lock_owner_payment_context($1,$2,$3,$4) AS enabled`,
    [session.orgId,session.environment,sessionId,leaseId]);
  return result.rows[0].enabled;
}

export async function authorizeOwnerPaymentConfirm(
  client: Client,
  session: Session,
  paymentId: string,
): Promise<
  | {state:"off"}
  | {state:"forbidden"}
  | {state:"notFound"}
  | {state:"ok";leaseId:string}
> {
  const exists=await client.query<{present:boolean}>(`SELECT to_regprocedure('app.b010_authorize_owner_payment_confirm(uuid,uuid,text,uuid)') IS NOT NULL AS present`);
  if (!exists.rows[0]?.present) return {state:"off"};
  const sessionId=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(session.sessionId) ? session.sessionId : null;

  await client.query(`SAVEPOINT b010_owner_auth`);
  let leaseId: string | null;
  try {
    const result=await client.query<{lease_id:string|null}>(
      `SELECT app.b010_authorize_owner_payment_confirm($1,$2,$3,$4)::text AS lease_id`,
      [paymentId,session.orgId,session.environment,sessionId],
    );
    leaseId=result.rows[0]?.lease_id ?? null;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT b010_owner_auth`);
    await client.query(`RELEASE SAVEPOINT b010_owner_auth`);
    if (typeof error === "object" && error !== null && (error as {code?:string}).code === "42501") {
      return {state:"forbidden"};
    }
    throw error;
  }
  await client.query(`RELEASE SAVEPOINT b010_owner_auth`);
  return leaseId ? {state:"ok",leaseId} : {state:"notFound"};
}

// svcOn owns a transaction normally. Map its boundaries to a savepoint here so
// privileged owner confirmation cannot commit the surrounding authenticated work.
export async function ownerElevated<T>(client: Client, session: Session, fn: (c: Client) => Promise<T>): Promise<T> {
  const scoped = Object.create(client) as Client;
  scoped.query = (async (sql: string, params?: unknown[]) => {
    const statement = sql === 'BEGIN' ? 'SAVEPOINT b010_owner_confirm'
      : sql === 'COMMIT' ? 'RELEASE SAVEPOINT b010_owner_confirm'
      : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT b010_owner_confirm' : sql;
    return client.query(statement, params);
  }) as Client['query'];
  try {
    return await svcOn(scoped, session.userId, fn);
  } finally {
    await client.query(`SET LOCAL ROLE authenticated`);
    await client.query(`SELECT set_config('request.jwt.claim.role','authenticated',true)`);
  }
}

export async function emitPaymentResult(client: Client, paymentId: string, kind: "payment_confirmed" | "payment_rejected" | "payment_reversed") {
  return (await client.query<{id:string}>(`SELECT app.b010_emit_payment_event($1,$2)::text AS id`,[paymentId,kind])).rows[0].id;
}
