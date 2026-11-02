import type { Client } from "pg";
import type { Session } from "./types";

/** OFF retains the legacy payment path, including databases not yet migrated. */
export async function lockPaymentResultContext(client: Client, session: Session, leaseId: string): Promise<boolean> {
  const exists=await client.query<{present:boolean}>(`SELECT to_regprocedure('app.b010_lock_payment_context(uuid,uuid,text,uuid,uuid,text)') IS NOT NULL AS present`);
  if (!exists.rows[0]?.present) return false;
  const sessionId=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(session.sessionId) ? session.sessionId : null;
  const result=await client.query<{enabled:boolean}>(`SELECT app.b010_lock_payment_context($1,$2,$3,$4,$5,$6) AS enabled`,
    [session.orgId,session.liveOrgId,session.environment,sessionId,leaseId,session.role]);
  return result.rows[0].enabled;
}

export async function emitPaymentResult(client: Client, paymentId: string, kind: "payment_confirmed" | "payment_rejected" | "payment_reversed") {
  return (await client.query<{id:string}>(`SELECT app.b010_emit_payment_event($1,$2)::text AS id`,[paymentId,kind])).rows[0].id;
}
