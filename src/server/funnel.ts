import { query } from "./db";

export type FunnelEvent = "signup_started" | "email_confirmed" | "firm_created" | "golive";

type Sql = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

export async function recordFunnel(
  event: FunnelEvent,
  input: { userId?: string | null; orgId?: string | null; email?: string | null; detail?: Record<string, unknown> },
  client?: Sql,
) {
  const sql = `INSERT INTO funnel_events (event_type, user_id, org_id, email, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`;
  const params = [event, input.userId ?? null, input.orgId ?? null, input.email ?? null, JSON.stringify(input.detail ?? {})];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}
