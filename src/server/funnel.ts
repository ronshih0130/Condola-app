import { query } from "./db";

export type FunnelEvent = "signup_started" | "email_confirmed" | "firm_created" | "golive";

export async function recordFunnel(
  event: FunnelEvent,
  input: { userId?: string | null; orgId?: string | null; email?: string | null; detail?: Record<string, unknown> },
) {
  await query(
    `INSERT INTO funnel_events (event_type, user_id, org_id, email, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [event, input.userId ?? null, input.orgId ?? null, input.email ?? null, JSON.stringify(input.detail ?? {})],
  );
}
