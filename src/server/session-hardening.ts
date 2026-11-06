import type { Client } from "pg";
import { query, withClient } from "./db";

// pg returns bigint as text: never round a credential epoch through a JS number.
export type CredentialEpoch = string | null;

export async function sessionHardeningEnabled(client?: Client) {
  const run = client ? client.query.bind(client) : query;
  const result = await run<{ enabled: boolean }>(`SELECT app.b031_session_hardening_enabled() AS enabled`);
  return result.rows[0]?.enabled === true;
}

export async function captureCredentialEpoch(userId: string, client?: Client, enabled?: boolean): Promise<CredentialEpoch> {
  if (!(enabled ?? await sessionHardeningEnabled(client))) return null;
  await reconcileCredentialChange(userId);
  const run = client ? client.query.bind(client) : query;
  const result = await run<{ epoch: string }>(`SELECT app.b031_credential_epoch($1::uuid)::text AS epoch`, [userId]);
  return result.rows[0].epoch;
}

/** Discover identity before password verification. A newly provisioned identity starts at zero. */
export async function captureEmailCredentialEpoch(email: string, client?: Client, enabled?: boolean) {
  enabled ??= await sessionHardeningEnabled(client);
  if (!enabled) return { userId: null, epoch: null };
  const run = client ? client.query.bind(client) : query;
  const result = await run<{ id: string; epoch: string }>(
    `SELECT id::text, app.b031_credential_epoch(id)::text AS epoch FROM auth.users WHERE lower(email) = lower($1)`, [email],
  );
  const userId = result.rows[0]?.id ?? null;
  return { userId, epoch: userId ? await captureCredentialEpoch(userId, client, true) : "0" };
}

export function credentialsChanged(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P0B31";
}

/** Commit recovery independently: rejecting a stale request must not undo recovery.
 * Call before acquiring any epoch/invitation/organization/challenge locks. */
async function reconcileCredentialChange(userId: string) {
  await credentialTransaction(async (client) => {
    await client.query(`SELECT app.b031_reconcile_credential_change($1::uuid)`, [userId]);
  });
}

export async function lockCredentialEpoch(client: Client, userId: string, epoch: CredentialEpoch) {
  if (epoch !== null) {
    await reconcileCredentialChange(userId);
    await client.query(`SELECT app.b031_lock_credential_epoch($1::uuid, $2::bigint)`, [userId, epoch]);
  }
}

export async function credentialTransaction<T>(fn: (client: Client) => Promise<T>) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SET LOCAL statement_timeout = '8s'");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function withCredentialFence<T>(userId: string, epoch: CredentialEpoch, fn: (client?: Client) => Promise<T>) {
  if (epoch === null) return fn();
  return credentialTransaction(async (client) => {
    await lockCredentialEpoch(client, userId, epoch);
    return fn(client);
  });
}

/** Call only for a flow that already read the flag as ON; take the exclusive lock before password writes. */
export async function bumpCredentialEpoch(client: Client, userId: string) {
  await client.query(`SELECT app.b031_bump_credential_epoch($1::uuid)`, [userId]);
}

export type CredentialChange = { id: string; userId: string; keepSession: string | null; startedAt: number };
export type CredentialChangeState = "done" | "failed" | "unknown";

async function revokeCredentials(client: Client, userId: string, keepSession: string | null) {
  await client.query(`UPDATE auth_sessions SET revoked_at = now()
    WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2) AND revoked_at IS NULL`, [userId, keepSession]);
  await client.query(`DELETE FROM auth_challenges WHERE user_id = $1`, [userId]);
}

/** Phase 1 must commit before calling the independently committing provider. */
export async function beginCredentialChange(client: Client, userId: string, epoch: CredentialEpoch, keepSession: string | null = null) {
  const result = await client.query<{ id: string }>(
    `SELECT app.b031_begin_credential_change($1::uuid, $2::bigint) AS id`, [userId, epoch]);
  await revokeCredentials(client, userId, keepSession);
  const id = result.rows[0].id;
  const timing = await client.query<{ started_at: Date }>(
    `SELECT started_at FROM app.b031_credential_changes WHERE id = $1`, [id]);
  return { id, userId, keepSession, startedAt: timing.rows[0].started_at.getTime() };
}

/** Commit phase 2 alone; acceptance uses the returned epoch in a NEW transaction. */
export async function finishCredentialChange(client: Client, change: CredentialChange, state: CredentialChangeState) {
  const result = await client.query<{ epoch: string }>(`SELECT app.b031_finish_credential_change($1::uuid, $2::uuid, $3::text)::text AS epoch`, [change.userId, change.id, state]);
  await revokeCredentials(client, change.userId, change.keepSession);
  return result.rows[0].epoch;
}
