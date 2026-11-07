import { guardEffectiveSession, withEffectiveAuthority } from "@/server/b017-custom-role-governance";
import { assertCustomAuthorityOn } from "./b017-custom-role-governance";
import { many, svc, tx } from "./db";
import type { Session } from "./types";

export async function manualRemindersEnabled(session: Session): Promise<boolean> {
  session = await guardEffectiveSession(session, "tenants.contact");
  if (session.kind !== "staff" || !["admin","manager"].includes(session.role ?? "") || session.needsSandbox) return false;
  try { return await svc(session.userId, async (c) => withEffectiveAuthority(c, session, "tenants.contact", async () => {
    await assertCustomAuthorityOn(c, session, "tenants.contact");
    const r=await c.query<{ok:boolean}>(`SELECT EXISTS (SELECT 1 FROM organizations o
      JOIN org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
      JOIN auth_sessions s ON s.id=$4 AND s.user_id=$2
      JOIN platform_settings f ON f.key='rent_reminders_v2'
      WHERE o.id=$1 AND o.environment::text=$3 AND ((o.environment='live' AND o.id=$5 AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=$5))
        AND m.user_id=$2 AND m.status='active' AND m.role::text=$6 AND m.role IN ('admin','manager')
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND o.feature_flags->'rent_reminders_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
        AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) AS ok`,
      [session.orgId,session.userId,session.environment,session.sessionId,session.liveOrgId,session.role]);
    return r.rows[0].ok;
  })); } catch { return false; }
}

export async function manualReminderInvoices(session: Session, leaseId: string) {
  session = await guardEffectiveSession(session, "tenants.contact");
  if (!await manualRemindersEnabled(session)) return [];
  return tx(session.userId, async (c) => withEffectiveAuthority(c, session, "tenants.contact", async () => { await assertCustomAuthorityOn(c, session, "tenants.contact"); return many<{id:string;due_date:string;balance:string;currency:string}>(c,`SELECT i.id::text,i.due_date::text,i.balance_minor::text AS balance,i.currency
    FROM invoices i JOIN leases l ON l.id=i.lease_id AND l.org_id=i.org_id
    WHERE i.org_id=$1 AND l.id=$2 AND l.status='active' AND l.terminated_on IS NULL
      AND i.status IN ('open','partially_paid') AND i.balance_minor>0
      AND EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id=i.id AND il.org_id=i.org_id AND il.charge_type='rent' AND il.amount_minor>0)
    ORDER BY i.due_date,i.created_at,i.id`,[session.orgId,leaseId]); }),{orgId:session.orgId,environment:session.environment});
}

export async function queueManualReminder(session: Session, leaseId: string, invoiceId: string, requestId: string) {
  session = await guardEffectiveSession(session, "tenants.contact");
  if (session.kind !== "staff" || !["admin","manager"].includes(session.role ?? "") || session.needsSandbox) throw new Error("Reminder unavailable");
  return svc(session.userId,async (c) => withEffectiveAuthority(c, session, "tenants.contact", async () => { await assertCustomAuthorityOn(c, session, "tenants.contact"); return (await c.query<{id:string}>(
    `SELECT app.b010_manual_reminder($1,$2,$3,$4,$5,$6,$7)::text AS id`,
    [session.orgId,session.liveOrgId,session.environment,session.sessionId,leaseId,invoiceId,requestId])).rows[0].id; }));
}

export async function manualReminderStatus(session: Session, leaseId: string, eventId: string) {
  session = await guardEffectiveSession(session, "tenants.contact");
  if (session.kind !== "staff" || !["admin","manager"].includes(session.role ?? "") || session.needsSandbox) return null;
  return svc(session.userId,async (c) => withEffectiveAuthority(c, session, "tenants.contact", async () => { await assertCustomAuthorityOn(c, session, "tenants.contact"); return (await c.query<{queued:string;claimed:string;captured:string;failed:string}>(
    `SELECT * FROM app.b010_manual_status($1,$2,$3,$4,$5,$6)`,
    [session.orgId,session.liveOrgId,session.environment,session.sessionId,leaseId,eventId])).rows[0] ?? null; }));
}
