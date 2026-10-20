import { pool } from "./db";

/** Auth and team events. The ledger trigger still audits row changes; this records who signed in. */
export async function writeAudit(
  orgId: string | null,
  userId: string | null,
  event: string,
  detail: Record<string, unknown> = {},
) {
  await pool.query(
    `INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row, reason)
     VALUES ($1, $2, 'app', 'auth_events', $3, 'insert', $3, $4::jsonb, $3)`,
    [orgId, userId, event, JSON.stringify({ event, ...detail })],
  );
}
