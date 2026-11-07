import { svc } from "./db";
import { captureScheduledReminders, type LocalCapture } from "./local-reminder-capture";
import { produceNotificationEvent } from "./notification-event-producers";

/** One injected instant is shared by discovery and all local event decisions.
 * This path never invokes a delivery provider. */
export async function runLocalRentReminders(at = new Date(), capture?: LocalCapture) {
  if (!Number.isFinite(at.getTime())) throw new Error("Reminder time unavailable");
  const available=await svc(null,async (c)=>(await c.query<{present:boolean}>(`SELECT to_regprocedure('app.b028_pending_scheduled(timestamptz)') IS NOT NULL AS present`)).rows[0].present);
  if (!available) return {queued:0,captured:0,failed:0};
  const candidates=await svc(null,async (c) => (await c.query<{org_id:string;invoice_id:string}>(`SELECT i.org_id::text,i.id::text AS invoice_id
    FROM invoices i JOIN organizations o ON o.id=i.org_id JOIN leases l ON l.id=i.lease_id AND l.org_id=i.org_id
    JOIN platform_settings f ON f.key='rent_reminders_v2'
    WHERE o.environment='live' AND o.feature_flags->'rent_reminders_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
      AND l.status='active' AND l.terminated_on IS NULL AND i.status IN ('open','partially_paid') AND i.balance_minor>0
      AND EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name=o.timezone)
      AND EXISTS (SELECT 1 FROM reminder_rules r WHERE r.org_id=i.org_id AND r.is_enabled AND 'email'=ANY(r.channels) AND (($1::timestamptz AT TIME ZONE o.timezone)::date-i.due_date)=ANY(r.offsets_days) AND ((r.event_type='rent_due' AND (($1::timestamptz AT TIME ZONE o.timezone)::date-i.due_date)<=0) OR (r.event_type='rent_overdue' AND (($1::timestamptz AT TIME ZONE o.timezone)::date-i.due_date) IN (1,7))))
    ORDER BY i.org_id,i.id`,[at.toISOString()])).rows);
  let queued=0, failed=0;
  for (const item of candidates) {
    try {
      const result=await svc(null,async (c) => {
        const id=(await c.query<{id:string|null}>(`SELECT app.b010_schedule_rent($1,$2,$3)::text AS id`,[item.org_id,item.invoice_id,at.toISOString()])).rows[0].id;
        if (id) await produceNotificationEvent(c,item.org_id,"b010_source_event",id);
        return id;
      });
      if (result) queued++;
    } catch { failed++; }
  }
  const pending=await svc(null,async (c)=>(await c.query<{org_id:string;event_id:string}>(
    `SELECT org_id::text,event_id::text FROM app.b028_pending_scheduled($1)`,[at.toISOString()])).rows);
  let captured=0;
  for (const item of pending) {
    try { captured+=await captureScheduledReminders(item.org_id,item.event_id,at,capture); }
    catch { failed++; }
  }
  return {queued,captured,failed};
}
