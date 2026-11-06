import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import test, { mock } from "node:test";
import { Client } from "pg";
import type { Locale } from "@/i18n";
import { approveMatch, confirmPayment, recordPayment, rejectPayment, reversePayment } from "./domain";
import { decideBankMatch } from "./bank-matching";
import { captureManualReminders } from "./local-reminder-capture";
import { publishHandover } from "./handover";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { runLocalRentReminders } from "./local-rent-reminders";
import { queueManualReminder } from "./manual-reminders";
import { createCaptureAdapter, runDeliveryAttempts } from "./notification-delivery";
import {
  NOTIFICATION_EVENTS_PROBE, __setNotificationProducersInstalledForTests, notificationMessageFor,
  renderNotificationMessage, type NotificationKind, type NotificationMessageInput,
} from "./notification-event-producers";
import { recordStatementVersion } from "./owner-net-ledger";
import { issuePortalInvite } from "./portal-invite";
import { authorizeEmergency, decideEstimate, submitEstimate } from "./repair-approval";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let db: Client;
const fetchBefore = globalThis.fetch;
let network = 0;
const templatesDir = new URL("../../e2e-evidence/B-028/templates/", import.meta.url);
const FORBIDDEN_COPY = ["房東", "收款", "收租", "入帳", "已收", "統一編號"];

test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: clone.url });
  await db.connect();
  globalThis.fetch = (async () => { network++; throw new Error("network disabled in B-028 family tests"); }) as typeof fetch;
});
test.after(async () => {
  globalThis.fetch = fetchBefore;
  __setNotificationProducersInstalledForTests(true);
  await db?.end();
  await clone?.cleanup();
});

async function reset() {
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true";
    process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed();
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
}
/** Global row + org flag, both orgs, strict shape. */
async function control(key: string, on: boolean, orgs: string[] = [ORG_ID, ORG2_ID]) {
  await db.query(`INSERT INTO platform_settings(key,value) VALUES($1,jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',$3::jsonb))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, on, JSON.stringify(orgs)]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object($1::text,$2::boolean) WHERE id=ANY($3::uuid[])`, [key, on, orgs]);
}
async function staff(userId: string, role: Session["role"], kind: Session["kind"] = "staff", orgId = ORG_ID): Promise<Session> {
  const sessionId = randomUUID();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [sessionId, userId, randomUUID()]);
  return { userId, sessionId, orgId, liveOrgId: orgId, environment: "live", kind, role, email: "synthetic@example.test",
    name: "Synthetic", locale: "en", calendar: "gregorian", leaseId: null };
}
async function effects() {
  const row = (await db.query<{ events: number; recipients: number; attempts: number; attempt_events: number }>(`SELECT
    (SELECT count(*)::int FROM app.b028_notification_events) AS events,
    (SELECT count(*)::int FROM app.b028_notification_event_recipients) AS recipients,
    (SELECT count(*)::int FROM app.b028_delivery_attempts) AS attempts,
    (SELECT count(*)::int FROM app.b028_delivery_attempt_events) AS attempt_events`)).rows[0];
  return row;
}
async function produce(org: string, kind: string, source: string) {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE service_role");
    const id = (await db.query<{ id: string | null }>("SELECT app.b028_produce_event($1,$2,$3)::text AS id", [org, kind, source])).rows[0].id;
    await db.query("COMMIT");
    return id;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}
async function trace(work: () => Promise<unknown>) {
  const spy = mock.method(Client.prototype, "query");
  try {
    await work();
    return spy.mock.calls.map(call => {
      const first = call.arguments[0] as unknown;
      const text = typeof first === "string" ? first : (first as { text?: string })?.text ?? String(first);
      return text.replace(/\s+/g, " ").trim();
    });
  } finally { spy.mock.restore(); }
}

type Expected = {
  kind: NotificationKind; sourceKind: string; sourceTable: string; sourceId: string; version: string; offset: string;
  rowTable: string; rowId: string; recipients: string[];
};
type Family<C> = {
  name: "invite" | "bill" | "payment" | "handover" | "report" | "repair";
  prepare: () => Promise<C>;
  run: (ctx: C) => Promise<void>;
  expected: (ctx: C) => Promise<Expected[]>;
};

// --- fixtures for each real domain operation (synthetic seed data only) ---

const invite: Family<{ manager: Session; contact: string; lease: string }> = {
  name: "invite",
  async prepare() {
    const row = (await db.query<{ lease_id: string; contact_id: string }>(`SELECT l.id::text AS lease_id,c.id::text AS contact_id
      FROM contacts c JOIN lease_parties lp ON lp.contact_id=c.id AND lp.role='primary' JOIN leases l ON l.id=lp.lease_id
      WHERE c.org_id=$1 AND c.display_name='李愛玲'`, [ORG_ID])).rows[0];
    assert.ok(row);
    return { manager: await staff(USERS.manager, "manager"), contact: row.contact_id, lease: row.lease_id };
  },
  async run(ctx) {
    const issued = await issuePortalInvite(ctx.manager, { kind: "tenant", contactId: ctx.contact, leaseId: ctx.lease, pageId: ctx.lease }, "https://staging.condola.app");
    assert.equal(issued.activated, false);
  },
  async expected(ctx) {
    const id = (await db.query<{ id: string }>(`SELECT id::text FROM invitations WHERE org_id=$1 AND contact_id=$2 AND status='pending'`, [ORG_ID, ctx.contact])).rows[0].id;
    return [{ kind: "invite_issued", sourceKind: "invitation", sourceTable: "invitations", sourceId: id, version: "issued", offset: "tenant",
      rowTable: "invitations", rowId: id, recipients: [`tenant:${ctx.contact}`] }];
  },
};

type BillCtx = { manager: Session; invoice: string; lease: string; instant: string; request: string; local: Array<{ to: string; text: string }> };
const bill: Family<BillCtx> = {
  name: "bill",
  async prepare() {
    await control("rent_reminders_v2", true, [ORG_ID]);
    await db.query(`INSERT INTO reminder_rules(org_id,event_type,offsets_days,channels,is_enabled) VALUES ($1,'rent_overdue',ARRAY[1,7]::smallint[],ARRAY['email']::channel_type[],true)
      ON CONFLICT(org_id,event_type) DO UPDATE SET offsets_days=EXCLUDED.offsets_days,channels=EXCLUDED.channels,is_enabled=true`, [ORG_ID]);
    const invoice = (await db.query<{ id: string; lease_id: string; instant: string }>(`SELECT i.id::text,i.lease_id::text,
        (((i.due_date+1)::timestamp+interval '12 hours') AT TIME ZONE o.timezone)::text AS instant
      FROM invoices i JOIN leases l ON l.id=i.lease_id JOIN organizations o ON o.id=l.org_id WHERE i.org_id=$1 AND l.status='active' AND l.terminated_on IS NULL
        AND i.status IN ('open','partially_paid') AND i.balance_minor>0 AND EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0)
        AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.org_id=i.org_id AND e.target_id=i.id AND e.kind IN ('rent_overdue_admin','rent_overdue_tenant'))
      ORDER BY i.due_date,i.id LIMIT 1`, [ORG_ID])).rows[0];
    assert.ok(invoice);
    return { manager: await staff(USERS.manager, "manager"), invoice: invoice.id, lease: invoice.lease_id, instant: invoice.instant, request: randomUUID(), local: [] };
  },
  async run(ctx) {
    // Scheduled path: schedules and locally captures its existing Email claims.
    await runLocalRentReminders(new Date(ctx.instant), (m) => ctx.local.push(m));
    const manual = await queueManualReminder(ctx.manager, ctx.lease, ctx.invoice, ctx.request);
    // Same request identity: the reminder replays its committed source event.
    assert.equal(await queueManualReminder(ctx.manager, ctx.lease, ctx.invoice, ctx.request), manual);
    await captureManualReminders(ctx.manager, ctx.lease, manual, (m) => ctx.local.push(m));
  },
  async expected() {
    const sources = (await db.query<{ id: string; kind: NotificationKind; occurrence_key: string; offset: string }>(`SELECT e.id::text,e.kind,e.occurrence_key,
        CASE WHEN e.kind='rent_manual' THEN 'manual' ELSE 'day:'||(e.local_date-i.due_date)::text END AS offset
      FROM app.b010_source_events e JOIN invoices i ON i.id=e.invoice_id WHERE e.org_id=$1 AND e.kind LIKE 'rent_%' ORDER BY e.id`, [ORG_ID])).rows;
    assert.ok(sources.some(s => s.kind === "rent_overdue") && sources.some(s => s.kind === "rent_manual"));
    const out: Expected[] = [];
    for (const s of sources) {
      const recipients = (await db.query<{ key: string }>(`SELECT CASE WHEN member_id IS NULL THEN 'tenant:'||contact_id ELSE 'staff:'||member_id END AS key
        FROM app.b028_recipient_claims WHERE event_id=$1 ORDER BY 1`, [s.id])).rows.map(r => r.key);
      assert.ok(recipients.length > 0);
      out.push({ kind: s.kind, sourceKind: "b010_source_event", sourceTable: "b010_source_events", sourceId: s.id, version: s.occurrence_key,
        offset: s.offset, rowTable: "b010_source_events", rowId: s.id, recipients });
    }
    return out;
  },
};

type PaymentCtx = { admin: Session; confirmed: string; rejected: string; payer: string; lease: string;
  legacy: { payment: string; suggestion: string }; enhanced: { payment: string; bank: string; suggestion: string }; recorded?: string };
const payment: Family<PaymentCtx> = {
  name: "payment",
  async prepare() {
    await control("bank_matching", true, [ORG_ID]);
    const admin = await staff(USERS.admin, "admin");
    const payer = (await db.query<{ id: string }>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant AND archived_at IS NULL`, [ORG_ID, USERS.tenant])).rows[0].id;
    const property = (await db.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,'B028 synthetic','TW','TWD','Asia/Taipei') RETURNING id::text`, [ORG_ID])).rows[0].id;
    const unit = (await db.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'B028') RETURNING id::text`, [ORG_ID, property])).rows[0].id;
    const lease = (await db.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active','2026-01-01','TWD',0) RETURNING id::text`, [ORG_ID, property, unit])).rows[0].id;
    await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`, [ORG_ID, lease, payer]);
    // A co-tenant who did not pay must never receive the payer's result.
    const other = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name,email) VALUES($1,true,'B028 co-tenant','co@example.test') RETURNING id::text`, [ORG_ID])).rows[0].id;
    await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant')`, [ORG_ID, lease, other]);
    const invoice = (await db.query<{ id: string }>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,total_minor) VALUES($1,$2,$3,$4,'TWD','2026-11-01','open',100000) RETURNING id::text`, [ORG_ID, property, lease, `B028-${randomUUID()}`])).rows[0].id;
    await db.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','Synthetic',1,100000,100000)`, [ORG_ID, invoice]);
    const submitted = async () => (await db.query<{ id: string }>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by)
      VALUES($1,$2,$3,$4,'TWD',100,'2026-11-01','bank_transfer','submitted','tenant_portal',$5) RETURNING id::text`, [ORG_ID, property, lease, payer, USERS.tenant])).rows[0].id;
    const pair = async () => {
      const id = await submitted();
      const account = (await db.query<{ id: string }>(`INSERT INTO bank_accounts(org_id,nickname,bank_name,currency) VALUES($1,'Synthetic','Synthetic','TWD') RETURNING id::text`, [ORG_ID])).rows[0].id;
      const file = (await db.query<{ id: string }>(`INSERT INTO files(org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by) VALUES($1,'bank-imports',$2,'synthetic.csv','text/csv',1,$3) RETURNING id::text`, [ORG_ID, randomUUID(), USERS.admin])).rows[0].id;
      const imported = (await db.query<{ id: string }>(`INSERT INTO bank_statement_imports(org_id,bank_account_id,file_id,status,uploaded_by) VALUES($1,$2,$3,'completed',$4) RETURNING id::text`, [ORG_ID, account, file, USERS.admin])).rows[0].id;
      const bank = (await db.query<{ id: string }>(`INSERT INTO bank_transactions(org_id,bank_account_id,import_id,row_number,posted_on,amount_minor,currency,raw,dedupe_hash,status) VALUES($1,$2,$3,1,'2026-11-01',100,'TWD','{}'::jsonb,$4,'suggested') RETURNING id::text`, [ORG_ID, account, imported, randomUUID()])).rows[0].id;
      const suggestion = (await db.query<{ id: string }>(`INSERT INTO bank_match_suggestions(org_id,bank_transaction_id,payment_id,score,reasons,status) VALUES($1,$2,$3,1,'{}'::jsonb,'suggested') RETURNING id::text`, [ORG_ID, bank, id])).rows[0].id;
      return { payment: id, bank, suggestion };
    };
    return { admin, confirmed: await submitted(), rejected: await submitted(), payer, lease, legacy: await pair(), enhanced: await pair() };
  },
  async run(ctx) {
    await confirmPayment(ctx.admin, ctx.confirmed);
    await confirmPayment(ctx.admin, ctx.confirmed); // replay of a completed confirmation
    await rejectPayment(ctx.admin, ctx.rejected, "Synthetic reason");
    await reversePayment(ctx.admin, ctx.confirmed, "Synthetic reversal");
    ctx.recorded = (await recordPayment(ctx.admin, { leaseId: ctx.lease, amountMajor: 1, paidOn: "2026-11-01", last5: "12345", reference: "Synthetic", requestId: randomUUID() })).paymentId;
    // Legacy match runs while the enhanced bank-matching control is OFF; the B-009 decision while it is ON.
    await db.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','false'::jsonb) WHERE key='bank_matching'`);
    await approveMatch(ctx.admin, ctx.legacy.suggestion);
    await db.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','true'::jsonb) WHERE key='bank_matching'`);
    await decideBankMatch(ctx.admin, { bankId: ctx.enhanced.bank, suggestionId: ctx.enhanced.suggestion, decision: "match", reason: "other" });
  },
  async expected(ctx) {
    const one = (id: string, status: string): Expected => ({ kind: `payment_${status}` as NotificationKind, sourceKind: "payment", sourceTable: "payments",
      sourceId: id, version: status, offset: "result", rowTable: "payments", rowId: id, recipients: [`tenant:${ctx.payer}`] });
    assert.ok(ctx.recorded);
    return [one(ctx.confirmed, "confirmed"), one(ctx.rejected, "rejected"), one(ctx.confirmed, "reversed"),
      one(ctx.recorded, "confirmed"), one(ctx.legacy.payment, "confirmed"), one(ctx.enhanced.payment, "confirmed")];
  },
};

const handover: Family<{ admin: Session; lease: string }> = {
  name: "handover",
  async prepare() {
    await control("handover_records", true, [ORG_ID]);
    const lease = (await db.query<{ id: string }>(`SELECT l.id::text FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id JOIN contacts c ON c.id=lp.contact_id
      WHERE l.org_id=$1 AND c.user_id=$2 AND lp.role='primary' AND l.status<>'draft' ORDER BY l.id LIMIT 1`, [ORG_ID, USERS.tenant])).rows[0].id;
    return { admin: await staff(USERS.admin, "admin"), lease };
  },
  async run(ctx) {
    await publishHandover(ctx.admin, ctx.lease, "move_in", "Synthetic condition", null);
  },
  async expected(ctx) {
    const version = (await db.query<{ id: string; record_id: string; revision: number }>(`SELECT v.id::text,v.record_id::text,v.revision FROM app.handover_versions v WHERE v.org_id=$1 AND v.lease_id=$2`, [ORG_ID, ctx.lease])).rows;
    assert.equal(version.length, 1);
    const tenants = (await db.query<{ key: string }>(`SELECT DISTINCT 'tenant:'||c.id AS key FROM lease_parties lp JOIN contacts c ON c.id=lp.contact_id AND c.org_id=lp.org_id
      WHERE lp.org_id=$1 AND lp.lease_id=$2 AND lp.role IN ('primary','co_tenant') AND c.is_tenant AND c.archived_at IS NULL ORDER BY 1`, [ORG_ID, ctx.lease])).rows.map(r => r.key);
    assert.ok(tenants.length > 0);
    return [{ kind: "handover_published", sourceKind: "handover_version", sourceTable: "handover_records", sourceId: version[0].record_id,
      version: String(version[0].revision), offset: "move_in", rowTable: "handover_versions", rowId: version[0].id, recipients: tenants }];
  },
};

const report: Family<{ admin: Session; statement: string; contact: string; request: string }> = {
  name: "report",
  async prepare() {
    await control("owner_net_ledger", true);
    const ownerUser = randomUUID();
    await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`, [ownerUser, `${ownerUser}@example.invalid`]);
    const contact = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_owner,user_id,display_name,locale) VALUES($1,true,$2,'B028 owner','en') RETURNING id::text`, [ORG_ID, ownerUser])).rows[0].id;
    const property = (await db.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'US','USD','America/Los_Angeles') RETURNING id::text`, [ORG_ID, randomUUID()])).rows[0].id;
    await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,'2094-01-01')`, [ORG_ID, property, contact]);
    const statement = (await db.query<{ id: string }>(`INSERT INTO owner_statements(org_id,owner_contact_id,currency,period_start,period_end,status,opening_balance_minor,closing_balance_minor,issued_by,issued_at)
      VALUES($1,$2,'USD','2095-01-01','2095-01-31','issued',0,0,$3,now()) RETURNING id::text`, [ORG_ID, contact, USERS.admin])).rows[0].id;
    return { admin: await staff(USERS.admin, "admin"), statement, contact, request: randomUUID() };
  },
  async run(ctx) {
    const recorded = await recordStatementVersion(ctx.admin, { statementId: ctx.statement, reason: "Synthetic correction", requestId: ctx.request });
    assert.equal(recorded.state, "recorded");
    // Exact replay returns the committed version without producing again.
    assert.equal((await recordStatementVersion(ctx.admin, { statementId: ctx.statement, reason: "Synthetic correction", requestId: ctx.request })).state, "recorded");
  },
  async expected(ctx) {
    const v = (await db.query<{ id: string; version_no: number }>(`SELECT id::text,version_no FROM app.b014_statement_versions WHERE statement_id=$1`, [ctx.statement])).rows;
    assert.equal(v.length, 1);
    return [{ kind: "report_version_recorded", sourceKind: "statement_version", sourceTable: "owner_statements", sourceId: ctx.statement,
      version: String(v[0].version_no), offset: "version", rowTable: "b014_statement_versions", rowId: v[0].id, recipients: [`owner:${ctx.contact}`] }];
  },
};

const repair: Family<{ admin: Session; owner: Session; ticket: string; currency: string; minorUnit: number; ownerContact: string; adminMember: string }> = {
  name: "repair",
  async prepare() {
    await control("repair_approvals", true, [ORG_ID]);
    const seed = (await db.query<{ property: string; owner_user: string; owner_contact: string }>(`SELECT t.property_id::text AS property,c.user_id::text AS owner_user,c.id::text AS owner_contact
      FROM maintenance_tickets t JOIN property_owners po ON po.org_id=t.org_id AND po.property_id=t.property_id
      JOIN contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
      WHERE t.org_id=$1 AND c.user_id IS NOT NULL AND c.is_owner AND c.archived_at IS NULL AND po.effective_to IS NULL ORDER BY t.id LIMIT 1`, [ORG_ID])).rows[0];
    assert.ok(seed);
    await db.query(`UPDATE property_owners SET repair_approval_threshold_minor=500000 WHERE org_id=$1 AND property_id=$2`, [ORG_ID, seed.property]);
    const ticket = randomUUID();
    await db.query(`INSERT INTO maintenance_tickets(id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)
      SELECT $1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$2),$3,category,priority,status,'B-028 fixture',cost_bearer,owner_approval
      FROM maintenance_tickets WHERE org_id=$2 ORDER BY id LIMIT 1`, [ticket, ORG_ID, seed.property]);
    const money = (await db.query<{ currency: string; minor_unit: number }>(`SELECT p.currency::text currency,r.minor_unit FROM properties p JOIN organizations o ON o.id=p.org_id
      JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency WHERE p.id=$1`, [seed.property])).rows[0];
    const adminMember = (await db.query<{ id: string }>(`SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2`, [ORG_ID, USERS.admin])).rows[0].id;
    return { admin: await staff(USERS.admin, "admin"), owner: await staff(seed.owner_user, null, "owner"), ticket, currency: money.currency.trim(),
      minorUnit: money.minor_unit, ownerContact: seed.owner_contact, adminMember };
  },
  async run(ctx) {
    const estimate = (expected: string | null) => submitEstimate(ctx.admin, { requestId: randomUUID(), ticketId: ctx.ticket, expectedHeadId: expected,
      amountMinor: 600000, currency: ctx.currency, minorUnit: ctx.minorUnit, workScope: "Replace damaged pipe", evidence: [] });
    const first = await estimate(null);
    assert.equal(first.status, "recorded");
    const emergency = await authorizeEmergency(ctx.admin, { requestId: randomUUID(), versionId: String(first.version_id), category: "water",
      reason: "Active leak", photos: [{ id: "synthetic-photo" }] });
    assert.equal(emergency.status, "recorded");
    const second = await estimate(String(first.version_id));
    assert.equal(second.status, "recorded");
    const decided = await decideEstimate(ctx.owner, { requestId: randomUUID(), versionId: String(second.version_id), decision: "approved" });
    assert.equal(decided.status, "recorded");
  },
  async expected(ctx) {
    const versions = (await db.query<{ id: string; version_no: string }>(`SELECT id::text,version_no::text FROM app.b013_estimate_versions WHERE ticket_id=$1 ORDER BY version_no`, [ctx.ticket])).rows;
    const outbox = (await db.query<{ id: string }>(`SELECT id::text FROM app.b013_repair_event_outbox WHERE ticket_id=$1 AND kind='emergency_owner_notice'`, [ctx.ticket])).rows;
    const decision = (await db.query<{ id: string }>(`SELECT id::text FROM app.b013_estimate_decisions WHERE ticket_id=$1`, [ctx.ticket])).rows;
    assert.equal(versions.length, 2); assert.equal(outbox.length, 1); assert.equal(decision.length, 1);
    const base = { sourceTable: "maintenance_tickets", sourceId: ctx.ticket };
    return [
      { ...base, kind: "repair_approval_requested", sourceKind: "repair_estimate_version", version: `estimate:${versions[0].version_no}`, offset: "approval", rowTable: "b013_estimate_versions", rowId: versions[0].id, recipients: [`owner:${ctx.ownerContact}`] },
      { ...base, kind: "repair_emergency_notice", sourceKind: "repair_outbox", version: `emergency:${versions[0].version_no}`, offset: "emergency_owner_notice", rowTable: "b013_repair_event_outbox", rowId: outbox[0].id, recipients: [`owner:${ctx.ownerContact}`] },
      { ...base, kind: "repair_approval_requested", sourceKind: "repair_estimate_version", version: `estimate:${versions[1].version_no}`, offset: "approval", rowTable: "b013_estimate_versions", rowId: versions[1].id, recipients: [`owner:${ctx.ownerContact}`] },
      { ...base, kind: "repair_decision_recorded", sourceKind: "repair_decision", version: `decision:${versions[1].version_no}`, offset: "approved", rowTable: "b013_estimate_decisions", rowId: decision[0].id, recipients: [`staff:${ctx.adminMember}`] },
    ];
  },
};

const families = [invite, bill, payment, handover, report, repair] as Family<unknown>[];

const disabledControls: Array<[string, () => Promise<void>]> = [
  ["absent global row", async () => { await db.query(`DELETE FROM platform_settings WHERE key='notification_events_v2'`); }],
  ["global enabled false", async () => { await control("notification_events_v2", false); }],
  ["malformed enabled", async () => { await control("notification_events_v2", true); await db.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','"true"') WHERE key='notification_events_v2'`); }],
  ["malformed allowlist", async () => { await control("notification_events_v2", true); await db.query(`UPDATE platform_settings SET value=jsonb_set(value,'{allowed_org_ids}',to_jsonb($1::text)) WHERE key='notification_events_v2'`, [ORG_ID]); }],
  ["allowlist without the org", async () => { await control("notification_events_v2", true, [ORG2_ID]); await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"notification_events_v2":true}' WHERE id=$1`, [ORG_ID]); }],
  ["org opt-in false", async () => { await control("notification_events_v2", true); await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"notification_events_v2":false}' WHERE id=$1`, [ORG_ID]); }],
];

test("gateway privileges: private tables and service-only producer", async () => {
  const acl = (await db.query<{ role: string; produce: boolean; message: boolean; events: boolean; recipients: boolean }>(`SELECT r AS role,
    has_function_privilege(r,'app.b028_produce_event(uuid,text,uuid)','EXECUTE') AS produce,
    has_function_privilege(r,'app.b028_event_message(uuid,uuid,text)','EXECUTE') AS message,
    has_table_privilege(r,'app.b028_notification_events','SELECT,INSERT,UPDATE,DELETE') AS events,
    has_table_privilege(r,'app.b028_notification_event_recipients','SELECT,INSERT,UPDATE,DELETE') AS recipients
    FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`)).rows;
  assert.deepEqual(acl.map(a => [a.role, a.produce, a.message, a.events, a.recipients]), [
    ["anon", false, false, false, false], ["authenticated", false, false, false, false], ["service_role", true, true, false, false],
  ]);
  const config = (await db.query<{ value: unknown; definer: boolean[]; paths: string[] }>(`SELECT
    (SELECT value FROM platform_settings WHERE key='notification_events_v2') AS value,
    (SELECT array_agg(p.prosecdef ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace='app'::regnamespace AND p.proname IN ('b028_produce_event','b028_event_message','b028_events_flag')) AS definer,
    (SELECT array_agg(array_to_string(p.proconfig,',') ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace='app'::regnamespace AND p.proname IN ('b028_produce_event','b028_event_message','b028_events_flag')) AS paths`)).rows[0];
  assert.deepEqual(config.value, { enabled: false, allowed_org_ids: [] });
  assert.deepEqual(config.definer, [true, true, true]);
  for (const path of config.paths) assert.match(path, /search_path=pg_catalog, public, app, pg_temp/);
  // Internal helpers/triggers and the transition ledger: private to every API role.
  const internal = (await db.query<{ name: string; definer: boolean; config: string; granted: boolean }>(`SELECT p.proname AS name,p.prosecdef AS definer,
      coalesce(array_to_string(p.proconfig,','),'') AS config,
      (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')
        OR has_function_privilege('service_role',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')) AS granted
    FROM pg_proc p WHERE p.pronamespace='app'::regnamespace AND p.proname IN ('b028_attempt_insert','b028_attempt_flag_effective',
      'b028_attempt_setting_transition','b028_attempt_org_transition','b028_events_flag','b028_event_locale','b028_notification_events_immutable')
    ORDER BY 1`)).rows;
  assert.deepEqual(internal.map(f => [f.name, f.granted]), [
    ["b028_attempt_flag_effective", false], ["b028_attempt_insert", false], ["b028_attempt_org_transition", false],
    ["b028_attempt_setting_transition", false], ["b028_event_locale", false], ["b028_events_flag", false], ["b028_notification_events_immutable", false],
  ]);
  for (const f of internal) assert.match(f.config, /search_path=pg_catalog/);
  for (const f of internal.filter(f => !["b028_attempt_flag_effective", "b028_event_locale"].includes(f.name))) {
    assert.equal(f.definer, true, f.name);
    assert.match(f.config, /search_path=pg_catalog, public, app, pg_temp/);
  }
  const ledger = (await db.query<{ rls: boolean; policies: boolean; granted: boolean }>(`SELECT c.relrowsecurity AS rls,
      EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
      EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS granted
    FROM pg_class c WHERE c.oid='app.b028_delivery_on_transitions'::regclass`)).rows[0];
  assert.deepEqual(ledger, { rls: true, policies: false, granted: false });
  const triggers = (await db.query<{ name: string; fn: string }>(`SELECT t.tgname AS name,t.tgfoid::regproc::text AS fn FROM pg_trigger t
    WHERE t.tgname IN ('b028_attempt_setting_transition','b028_attempt_org_transition') ORDER BY 1`)).rows;
  assert.deepEqual(triggers, [{ name: "b028_attempt_org_transition", fn: "app.b028_attempt_org_transition" },
    { name: "b028_attempt_setting_transition", fn: "app.b028_attempt_setting_transition" }]);
  // One shared, ungranted row write used by both the package-1 gateway and the producer.
  const shared = (await db.query<{ granted: boolean; enqueue: string; produce: string }>(`SELECT
    (has_function_privilege('service_role','app.b028_attempt_insert(uuid,text,uuid,text,text)','EXECUTE')
      OR has_function_privilege('authenticated','app.b028_attempt_insert(uuid,text,uuid,text,text)','EXECUTE')) AS granted,
    pg_get_functiondef('app.b028_delivery_enqueue(uuid,text,uuid,text,text)'::regprocedure) AS enqueue,
    pg_get_functiondef('app.b028_produce_event(uuid,text,uuid)'::regprocedure) AS produce`)).rows[0];
  assert.equal(shared.granted, false);
  for (const body of [shared.enqueue, shared.produce]) {
    assert.match(body, /app\.b028_attempt_insert\(/);
    assert.doesNotMatch(body.replace(/--[^\n]*/g, ""), /INSERT INTO app\.b028_delivery_attempts/);
  }
  // No explicit admission lock inside business transactions (no NOWAIT 55P03 path).
  const bodies = (await db.query<{ body: string }>(`SELECT pg_get_functiondef(p.oid) AS body FROM pg_proc p
    WHERE p.pronamespace='app'::regnamespace AND p.proname IN ('b028_produce_event','b028_events_flag')`)).rows;
  assert.equal(bodies.length, 2);
  for (const { body } of bodies) assert.doesNotMatch(body.replace(/--[^\n]*/g, ""), /NOWAIT|LOCK TABLE|FOR (SHARE|UPDATE)|b028_delivery_enabled|lock_timeout/);
});

for (const family of families) {
  test(`${family.name}: real operation emits one durable versioned event per source, intended recipients only, local capture only; OFF leaves SQL and rows unchanged`, async () => {
    const networkBefore = network;
    // 1. Baseline: hooks uninstalled (the pre-B-028 code path issues no producer SQL).
    await reset();
    let ctx = await family.prepare();
    await control("notification_delivery_v2", true);
    __setNotificationProducersInstalledForTests(false);
    let baseline: string[];
    try { baseline = await trace(() => family.run(ctx)); } finally { __setNotificationProducersInstalledForTests(true); }
    assert.ok(!baseline.some(sql => sql.includes(NOTIFICATION_EVENTS_PROBE) || sql.includes("b028_produce_event")));

    // 2. OFF (default control, delivery ON): identical statements plus only the read-only probe; zero new rows.
    await reset();
    ctx = await family.prepare();
    await control("notification_delivery_v2", true);
    const off = await trace(() => family.run(ctx));
    const offEffects = await effects();
    assert.deepEqual(offEffects, { events: 0, recipients: 0, attempts: 0, attempt_events: 0 });
    assert.deepEqual(off.filter(sql => !sql.startsWith(NOTIFICATION_EVENTS_PROBE)), baseline, "OFF statement trace equals the uninstalled baseline");
    assert.ok(!off.some(sql => /b028_produce_event|b028_notification_|b028_event_message/.test(sql)));
    const probes = off.filter(sql => sql.startsWith(NOTIFICATION_EVENTS_PROBE)).length;
    assert.ok(probes >= 1);

    // 3. ON (events + delivery): run the same real operation on fresh synthetic data.
    await reset();
    ctx = await family.prepare();
    await control("notification_delivery_v2", true);
    await control("notification_events_v2", true);
    const spy = mock.method(Client.prototype, "query");
    try { await family.run(ctx); } finally { spy.mock.restore(); }
    // Atomicity: every producer call runs on a connection whose transaction is open
    // (BEGIN seen, no COMMIT/ROLLBACK yet) and that same transaction later commits.
    const calls = spy.mock.calls.map(call => ({ client: call.this, sql: String((call.arguments[0] as { text?: string })?.text ?? call.arguments[0]).trim() }));
    const producerCalls = calls.map((c, i) => [c, i] as const).filter(([c]) => c.sql.includes("app.b028_produce_event("));
    assert.ok(producerCalls.length >= 1);
    // ON issues exactly one probe per producer call; OFF issued the same probes and stopped there.
    assert.equal(calls.filter(c => c.sql.startsWith(NOTIFICATION_EVENTS_PROBE)).length, producerCalls.length);
    assert.equal(probes, producerCalls.length);
    for (const [call, index] of producerCalls) {
      const same = calls.map((c, i) => [c, i] as const).filter(([c]) => c.client === call.client);
      const begin = same.filter(([c, i]) => i < index && /^BEGIN/.test(c.sql)).at(-1)?.[1];
      assert.ok(begin !== undefined, "producer runs inside a transaction");
      assert.ok(!same.some(([c, i]) => i > begin && i < index && /^(COMMIT|ROLLBACK)$/.test(c.sql)), "transaction still open at production");
      const end = same.find(([c, i]) => i > index && /^(COMMIT|ROLLBACK)$/.test(c.sql));
      assert.equal(end?.[0].sql, "COMMIT", "the producing business transaction commits");
    }
    const expected = await family.expected(ctx);
    const events = (await db.query<{ id: string; org_id: string; family: string; kind: string; source_table: string; source_id: string; source_version: string;
      offset_key: string; source_row_table: string; source_row_id: string; template_version: number }>(
      `SELECT id::text,org_id::text,family,kind,source_table,source_id::text,source_version,offset_key,source_row_table,source_row_id::text,template_version
       FROM app.b028_notification_events ORDER BY created_at,id`)).rows;
    assert.equal(events.length, expected.length, "exactly one durable event per committed source/version");
    const recipientKeys: Array<{ event: string; key: string }> = [];
    for (const want of expected) {
      const matching = events.filter(e => e.source_row_id === want.rowId && e.kind === want.kind);
      assert.equal(matching.length, 1, `one event for ${want.kind}`);
      const event = matching[0];
      assert.deepEqual([event.org_id, event.family, event.source_table, event.source_id, event.source_version, event.offset_key, event.source_row_table, event.template_version],
        [ORG_ID, family.name, want.sourceTable, want.sourceId, want.version, want.offset, want.rowTable, 1]);
      const recipients = (await db.query<{ recipient_key: string; org_id: string; persona: string; source_version: string }>(
        `SELECT recipient_key,org_id::text,persona,source_version FROM app.b028_notification_event_recipients WHERE event_id=$1 ORDER BY recipient_key`, [event.id])).rows;
      assert.deepEqual(recipients.map(r => r.recipient_key), [...want.recipients].sort(), `intended recipients only for ${want.kind}`);
      assert.ok(recipients.every(r => r.org_id === ORG_ID && r.source_version === want.version && r.recipient_key.startsWith(`${r.persona}:`)));
      for (const r of recipients) recipientKeys.push({ event: event.id, key: r.recipient_key });

      // Replay of the source identity returns the same event and adds nothing.
      const before = await effects();
      const replayed = await produce(ORG_ID, want.sourceKind, want.rowId);
      // A payment's version is its committed status: replaying a reversed payment returns its reversal event.
      if (want.sourceKind === "payment") assert.ok(events.some(e => e.id === replayed && e.source_id === want.sourceId));
      else assert.equal(replayed, event.id);
      assert.deepEqual(await effects(), before);
      // Wrong organization (ORG2 fully enabled) never resolves another org's source.
      assert.equal(await produce(ORG2_ID, want.sourceKind, want.rowId), null);
      assert.deepEqual(await effects(), before);
    }
    const settled = await effects();
    assert.equal(settled.recipients, recipientKeys.length);
    // Bills keep their existing Email claims as the only owner: no package-1 attempt.
    const attemptKeys = family.name === "bill" ? [] : recipientKeys;
    assert.equal(settled.attempts, attemptKeys.length, "one queued package-1 attempt per non-bill recipient");
    // Disabled controls: no new notification effects for any source of this family.
    for (const [label, apply] of disabledControls) {
      await apply();
      for (const want of expected) assert.equal(await produce(ORG_ID, want.sourceKind, want.rowId), null, label);
      assert.deepEqual(await effects(), settled, label);
      await control("notification_events_v2", true);
    }
    // Message inputs are unavailable while OFF.
    await control("notification_events_v2", false);
    assert.equal(await notificationMessageFor(ORG_ID, recipientKeys[0].event, recipientKeys[0].key), null);
    await control("notification_events_v2", true);

    // Local capture through package 1: exactly one capture per intended recipient, no network.
    const adapter = createCaptureAdapter("email");
    assert.equal(await runDeliveryAttempts(ORG_ID, adapter, 50), attemptKeys.length);
    assert.deepEqual(adapter.captures.map(c => `${c.sourceKind}/${c.sourceId}/${c.recipientKey}`).sort(),
      attemptKeys.map(r => `b028_event/${r.event}/${r.key}`).sort());
    if (family.name === "bill") {
      // Exactly one Email per reminder recipient across both paths, both flags ON:
      // the existing claim captured once, linked 1:1 to the event recipient, zero package-1 captures.
      const local = (ctx as BillCtx).local;
      const rows = (await db.query<{ recipient_key: string; claim_id: string | null; state: string; attempt: number }>(`SELECT x.recipient_key,x.claim_id::text,c.state,c.attempt
        FROM app.b028_notification_event_recipients x JOIN app.b028_recipient_claims c ON c.org_id=x.org_id AND c.id=x.claim_id ORDER BY x.id`)).rows;
      assert.equal(rows.length, recipientKeys.length);
      assert.equal(new Set(rows.map(r => r.claim_id)).size, rows.length);
      assert.ok(rows.every(r => r.state === "captured" && r.attempt === 1));
      assert.equal(local.length, rows.length, "one local claim capture per recipient");
      assert.equal(adapter.captures.length, 0);
      assert.equal((await db.query(`SELECT 1 FROM app.b028_recipient_claims c WHERE c.org_id=$1 AND NOT EXISTS (SELECT 1 FROM app.b028_notification_event_recipients x WHERE x.claim_id=c.id)`, [ORG_ID])).rowCount, 0);
    }
    assert.equal(await runDeliveryAttempts(ORG_ID, adapter, 50), 0, "completed recipients are never repeated");
    assert.equal((await db.query(`SELECT 1 FROM app.b028_delivery_attempts WHERE status<>'captured'`)).rowCount, 0);
    assert.equal(network, networkBefore, "zero network calls");

    // EN/zh-TW template captures from the committed events.
    const byLocale: Record<Locale, string[]> = { en: [], "zh-TW": [] };
    const seen = new Set<string>();
    for (const r of recipientKeys) {
      const stored = await notificationMessageFor(ORG_ID, r.event, r.key);
      assert.ok(stored?.subject && stored.text);
      const row = (await db.query<{ kind: NotificationKind; vars: Record<string, unknown>; persona: NotificationMessageInput["persona"]; recipient_name: string; firm_name: string }>(
        `SELECT kind,vars,persona,recipient_name,firm_name FROM app.b028_event_message($1,$2,$3)`, [ORG_ID, r.event, r.key])).rows[0];
      const identity = `${row.kind}/${row.persona}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      for (const locale of ["en", "zh-TW"] as const) {
        const message = renderNotificationMessage({ kind: row.kind, vars: row.vars, locale, persona: row.persona, recipientName: row.recipient_name, firmName: row.firm_name });
        for (const word of FORBIDDEN_COPY) assert.ok(!`${message.subject}${message.text}`.includes(word), `${row.kind} ${locale} contains ${word}`);
        byLocale[locale].push(`[${row.kind} -> ${row.persona}]\nSubject: ${message.subject}\n${message.text}\n`);
      }
    }
    mkdirSync(templatesDir, { recursive: true });
    for (const locale of ["en", "zh-TW"] as const) {
      writeFileSync(new URL(`${family.name}.${locale}.txt`, templatesDir),
        `# B-028 package 2 template capture: ${family.name} (${locale})\n# Rendered from committed local events on synthetic seed data; captured locally, nothing was sent.\n\n${byLocale[locale].join("\n")}`);
    }
  });
}

test("renewal is deferred: no renewal event kind exists without a durable renewal operation", async () => {
  const check = (await db.query<{ def: string }>(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
    WHERE c.conrelid='app.b028_notification_events'::regclass AND pg_get_constraintdef(c.oid) LIKE '%family%'`)).rows[0].def;
  assert.ok(!check.includes("renewal"));
  assert.equal(await produce(ORG_ID, "renewal", randomUUID()), null);
});

test("ON producer takes no NOWAIT lock: a concurrent settings write or org FOR UPDATE never fails the business action", async () => {
  await reset();
  const ctx = await payment.prepare();
  await control("notification_delivery_v2", true);
  await control("notification_events_v2", true);
  const holder = new Client({ connectionString: clone.url });
  await holder.connect();
  const within = <T>(work: Promise<T>, ms: number) => Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);
  try {
    // Uncommitted settings write (ROW EXCLUSIVE on platform_settings) held throughout.
    await holder.query("BEGIN");
    await holder.query(`UPDATE platform_settings SET value=value WHERE key='bank_matching'`);
    await within(confirmPayment(ctx.admin, ctx.confirmed), 5000);
    await holder.query("COMMIT");
    // Organization row held FOR UPDATE: the action waits for key-share like its other org-scoped writes, then succeeds.
    await holder.query("BEGIN");
    await holder.query(`SELECT id FROM organizations WHERE id=$1 FOR UPDATE`, [ORG_ID]);
    let settled: "ok" | Error | null = null;
    const pending = rejectPayment(ctx.admin, ctx.rejected, "Synthetic reason").then(() => { settled = "ok"; }, (e: Error) => { settled = e; });
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(settled, null, "no 55P03 while the org row is held");
    await holder.query("COMMIT");
    await within(pending, 5000);
    assert.equal(settled, "ok");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await holder.end();
  }
  const rows = (await db.query<{ kind: string; attempts: number }>(`SELECT e.kind,(SELECT count(*)::int FROM app.b028_delivery_attempts a WHERE a.source_id=e.id) AS attempts
    FROM app.b028_notification_events e ORDER BY e.kind`)).rows;
  assert.deepEqual(rows, [{ kind: "payment_confirmed", attempts: 1 }, { kind: "payment_rejected", attempts: 1 }]);
});

test("a failure after the producer rolls back the event, recipients and attempts with the business change", async () => {
  await reset();
  const ctx = await handover.prepare();
  await control("notification_delivery_v2", true);
  await control("notification_events_v2", true);
  const original = Client.prototype.query;
  type Armed = Client & { b028Armed?: boolean };
  let produced: string | null = null;
  const spy = mock.method(Client.prototype, "query", function (this: Client, ...args: unknown[]) {
    const first = args[0] as { text?: string } | string;
    const sql = (typeof first === "string" ? first : first?.text ?? "").trim();
    const client = this as Armed;
    if (client.b028Armed && !/^(ROLLBACK|COMMIT)$/.test(sql)) {
      client.b028Armed = false;
      return Promise.reject(Object.assign(new Error("injected failure after producer"), { code: "XX000" }));
    }
    const result = (original as (...a: unknown[]) => Promise<{ rows: Array<{ id?: string }> }>).apply(this, args);
    if (sql.includes("app.b028_produce_event(")) {
      return result.then(value => { produced = value.rows[0]?.id ?? null; client.b028Armed = true; return value; });
    }
    return result;
  });
  try {
    await assert.rejects(publishHandover(ctx.admin, ctx.lease, "move_in", "Synthetic condition", null));
  } finally { spy.mock.restore(); }
  assert.ok(produced, "the producer wrote inside the business transaction before the failure");
  assert.deepEqual(await effects(), { events: 0, recipients: 0, attempts: 0, attempt_events: 0 });
  assert.equal((await db.query(`SELECT 1 FROM app.handover_versions WHERE lease_id=$1`, [ctx.lease])).rowCount, 0);
});

test("producer attempt committed after delivery OFF stays inert while OFF and is retired, never dispatched, after re-ON", async () => {
  await reset();
  const ctx = await payment.prepare();
  await control("notification_delivery_v2", true);
  await control("notification_events_v2", true);
  const confirmed = async () => (await db.query<{ id: string }>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by,confirmed_by,confirmed_at)
    SELECT l.org_id,l.property_id,l.id,$2,'TWD',100,'2026-11-01','bank_transfer','confirmed','manager_entry',$3,$3,now() FROM leases l WHERE l.id=$1 RETURNING id::text`,
    [ctx.lease, ctx.payer, USERS.admin])).rows[0].id;
  const service = async (sql: string, args: unknown[]) => {
    await db.query("BEGIN");
    try {
      await db.query("SELECT set_config('app.active_org_id',$1,true)", [ORG_ID]);
      await db.query("SET LOCAL ROLE service_role");
      const rows = (await db.query(sql, args)).rows;
      await db.query("COMMIT");
      return rows;
    } catch (error) { await db.query("ROLLBACK"); throw error; }
  };
  const late = await confirmed();
  const producer = new Client({ connectionString: clone.url });
  await producer.connect();
  let event: string;
  try {
    // The producing transaction reads delivery ON and writes its attempt...
    await producer.query("BEGIN");
    await producer.query("SET LOCAL ROLE service_role");
    event = (await producer.query<{ id: string }>("SELECT app.b028_produce_event($1,'payment',$2)::text AS id", [ORG_ID, late])).rows[0].id;
    assert.ok(event);
    // ...another session turns delivery OFF and commits first...
    await control("notification_delivery_v2", false);
    // ...then the producing transaction commits.
    await producer.query("COMMIT");
  } finally { await producer.end(); }
  const row = async () => (await db.query<{ status: string; failure_code: string | null; attempt: number }>(
    `SELECT status,failure_code,attempt FROM app.b028_delivery_attempts WHERE source_kind='b028_event' AND source_id=$1`, [event])).rows;
  assert.deepEqual(await row(), [{ status: "queued", failure_code: null, attempt: 0 }]);
  // Inert while OFF: claim returns nothing and status is empty.
  assert.equal((await service("SELECT * FROM app.b028_delivery_claim($1,'email',10,120)", [ORG_ID])).length, 0);
  assert.equal((await service("SELECT * FROM app.b028_delivery_status($1,'b028_event',$2)", [ORG_ID, event])).length, 0);
  const adapter = createCaptureAdapter("email");
  assert.equal(await runDeliveryAttempts(ORG_ID, adapter, 10), 0);
  // Re-ON records the transition; the late attempt is retired at claim time, never dispatched.
  await control("notification_delivery_v2", true);
  assert.ok((await db.query(`SELECT 1 FROM app.b028_delivery_on_transitions WHERE org_id=$1`, [ORG_ID])).rowCount);
  assert.equal(await runDeliveryAttempts(ORG_ID, adapter, 10), 0);
  assert.equal(adapter.captures.length, 0);
  assert.deepEqual(await row(), [{ status: "failed", failure_code: "stale_admission", attempt: 0 }]);
  assert.deepEqual(await service("SELECT status,count::int AS count FROM app.b028_delivery_status($1,'b028_event',$2)", [ORG_ID, event]), [{ status: "failed", count: 1 }]);
  // Positive control: an attempt produced after the re-ON transition is dispatched once.
  const fresh = await confirmed();
  const freshEvent = await produce(ORG_ID, "payment", fresh);
  assert.ok(freshEvent);
  assert.equal(await runDeliveryAttempts(ORG_ID, adapter, 10), 1);
  assert.deepEqual(adapter.captures.map(c => c.sourceId), [freshEvent]);
  assert.equal(network, 0);
});

test("ON transitions are recorded for the global switch, allowlist add and org opt-in paths only", async () => {
  await reset();
  const transitions = async () => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM app.b028_delivery_on_transitions WHERE org_id=$1`, [ORG_ID])).rows[0].n);
  const setting = (value: unknown) => db.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='notification_delivery_v2'`, [JSON.stringify(value)]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"notification_delivery_v2":true}' WHERE id=$1`, [ORG_ID]);
  await setting({ enabled: false, allowed_org_ids: [ORG_ID] });
  const base = await transitions();
  await setting({ enabled: true, allowed_org_ids: [ORG_ID] }); // global switch OFF->ON
  assert.equal(await transitions(), base + 1);
  await setting({ enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] }); // already ON: no transition for ORG_ID
  assert.equal(await transitions(), base + 1);
  await setting({ enabled: true, allowed_org_ids: [ORG2_ID] }); // removed (OFF)
  assert.equal(await transitions(), base + 1);
  await setting({ enabled: true, allowed_org_ids: [ORG2_ID, ORG_ID] }); // allowlist add OFF->ON
  assert.equal(await transitions(), base + 2);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"notification_delivery_v2":false}' WHERE id=$1`, [ORG_ID]);
  await db.query(`UPDATE organizations SET name=name WHERE id=$1`, [ORG_ID]); // unrelated update: trigger does not fire
  assert.equal(await transitions(), base + 2);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"notification_delivery_v2":true}' WHERE id=$1`, [ORG_ID]); // org opt-in OFF->ON
  assert.equal(await transitions(), base + 3);
  // An unrelated organizations update is never blocked by a held settings row lock.
  const holder = new Client({ connectionString: clone.url });
  await holder.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM platform_settings WHERE key='notification_delivery_v2' FOR UPDATE`);
    await db.query("SET statement_timeout='2s'");
    await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"b028_unrelated":true}' WHERE id=$1`, [ORG_ID]);
    await db.query("RESET statement_timeout");
  } finally { await holder.query("ROLLBACK"); await holder.end(); }
});

test("a REPEATABLE READ producer whose snapshot predates OFF is retired after re-ON, not dispatched", async () => {
  await reset();
  const ctx = await payment.prepare();
  await control("notification_delivery_v2", true);
  await control("notification_events_v2", true);
  const paymentId = (await db.query<{ id: string }>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by,confirmed_by,confirmed_at)
    SELECT l.org_id,l.property_id,l.id,$2,'TWD',100,'2026-11-01','bank_transfer','confirmed','manager_entry',$3,$3,now() FROM leases l WHERE l.id=$1 RETURNING id::text`,
    [ctx.lease, ctx.payer, USERS.admin])).rows[0].id;
  const producer = new Client({ connectionString: clone.url });
  await producer.connect();
  let event: string;
  try {
    await producer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await producer.query("SELECT 1 FROM organizations WHERE id=$1", [ORG_ID]); // snapshot taken while ON
    await control("notification_delivery_v2", false);
    await control("notification_delivery_v2", true); // re-ON trigger fires before the producer inserts
    await producer.query("SET LOCAL ROLE service_role");
    event = (await producer.query<{ id: string }>("SELECT app.b028_produce_event($1,'payment',$2)::text AS id", [ORG_ID, paymentId])).rows[0].id;
    await producer.query("COMMIT");
  } finally { await producer.end(); }
  assert.ok(event);
  const stamps = (await db.query<{ late_insert: boolean; early_admission: boolean }>(`SELECT a.created_at>(SELECT max(became_on_at) FROM app.b028_delivery_on_transitions WHERE org_id=$1) AS late_insert,
      e.admitted_at<(SELECT max(became_on_at) FROM app.b028_delivery_on_transitions WHERE org_id=$1) AS early_admission
    FROM app.b028_delivery_attempts a JOIN app.b028_notification_events e ON e.id=a.source_id WHERE a.source_id=$2`, [ORG_ID, event])).rows;
  assert.deepEqual(stamps, [{ late_insert: true, early_admission: true }], "inserted after re-ON, admitted before it");
  const adapter = createCaptureAdapter("email");
  assert.equal(await runDeliveryAttempts(ORG_ID, adapter, 10), 0);
  assert.equal(adapter.captures.length, 0);
  assert.deepEqual((await db.query(`SELECT status,failure_code FROM app.b028_delivery_attempts WHERE source_id=$1`, [event])).rows, [{ status: "failed", failure_code: "stale_admission" }]);
});
