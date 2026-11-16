import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { staffRepairTodayTurns, staffRepairTurns } from "./b3-repair-turns";
import { todayRepairRows } from "./b3-today-repairs";
import { TODAY_KIND_FLAGS, todayBankTurn, todayMonthCloseTurn, todayReplyTurn } from "./b3-today-kinds";
import { query } from "./db";
import { FlowError } from "./errors";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// MGT-148 (T-ROWS-2) / MGT-149 (T-REPAIR) readers on the Mac's disposable, fully migrated database.
// Synthetic fixtures only; no migration application, outbound work or provider calls.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const ON = { v3: async () => true };
const denied = (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden";
const KEYS = ["bank_matching", "tenant_thread_create", "vendor_link"];
const saved = new Map<string, unknown>();
test.before(async () => {
  for (const key of KEYS) {
    const row = (await query<{ value: unknown }>("SELECT value FROM platform_settings WHERE key = $1", [key])).rows[0];
    if (row) saved.set(key, row.value);
  }
});
test.after(async () => {
  for (const key of KEYS) {
    if (saved.has(key)) await query(`INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, JSON.stringify(saved.get(key))]);
    else await query("DELETE FROM platform_settings WHERE key = $1", [key]);
  }
});

type Role = "admin" | "manager" | "accountant" | "maintenance";
type Org = { orgId: string; property: string; staff: Record<Role, Session> };
async function user() {
  const id = randomUUID();
  await query(`INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, role, aud)
    VALUES ($1, $2, '{}'::jsonb, now(), 'authenticated', 'authenticated')`, [id, `${id}@example.test`]);
  return id;
}
async function allow(key: string, orgId: string) {
  await query(`INSERT INTO platform_settings (key, value) VALUES ($1, jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($2::text)))
    ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('enabled', true, 'allowed_org_ids',
      coalesce(platform_settings.value->'allowed_org_ids', '[]'::jsonb) || jsonb_build_array($2::text))`, [key, orgId]);
}
async function makeOrg(flags: Record<string, boolean> = {}): Promise<Org> {
  const orgId = (await query<{ id: string }>(`INSERT INTO organizations (name, country_code, default_currency, timezone, plan_tier, feature_flags)
    VALUES ('Today rows synthetic', 'TW', 'TWD', 'Asia/Taipei', 'beta', $1::jsonb) RETURNING id::text`,
  [JSON.stringify({ bank_matching: true, tenant_thread_create: true, ...flags })])).rows[0].id;
  const staff = {} as Record<Role, Session>;
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    const id = await user();
    await query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, $3::org_role, 'active')`, [orgId, id, role]);
    const sessionId = randomUUID();
    await query(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '1 hour')`, [sessionId, id, randomUUID()]);
    staff[role] = { userId: id, sessionId, orgId, liveOrgId: orgId, environment: "live", kind: "staff", role, locale: "zh-TW", calendar: "gregorian", leaseId: null, name: "Synthetic", email: "" };
  }
  const property = (await query<{ id: string }>(`INSERT INTO properties (org_id, name, country_code, currency, timezone)
    VALUES ($1, '景興路套房', 'TW', 'TWD', 'Asia/Taipei') RETURNING id::text`, [orgId])).rows[0].id;
  await allow("bank_matching", orgId); await allow("tenant_thread_create", orgId);
  return { orgId, property, staff };
}

async function bankLine(o: Org, status: string, postedOn: string, archived = false) {
  const account = (await query<{ id: string }>(`INSERT INTO bank_accounts (org_id, nickname, currency, archived_at)
    VALUES ($1, 'Synthetic account', 'TWD', CASE WHEN $2 THEN now() ELSE NULL END) RETURNING id::text`, [o.orgId, archived])).rows[0].id;
  const file = (await query<{ id: string }>(`INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
    VALUES ($1, 'bank-imports', $2, 'synthetic.csv', 'text/csv', 10, $3) RETURNING id::text`, [o.orgId, `synthetic/${randomUUID()}.csv`, o.staff.admin.userId])).rows[0].id;
  const imp = (await query<{ id: string }>(`INSERT INTO bank_statement_imports (org_id, bank_account_id, file_id, status, row_count, uploaded_by)
    VALUES ($1, $2, $3, 'completed', 1, $4) RETURNING id::text`, [o.orgId, account, file, o.staff.admin.userId])).rows[0].id;
  await query(`INSERT INTO bank_transactions (org_id, bank_account_id, import_id, row_number, posted_on, amount_minor, currency, description, counterparty_account_last5, raw, dedupe_hash, status)
    VALUES ($1, $2, $3, 1, $4, 1000, 'TWD', 'Synthetic memo', '12345', '{}'::jsonb, $5, $6::bank_txn_status)`, [o.orgId, account, imp, postedOn, randomUUID(), status]);
}

test("待對帳: lines to review across months on unarchived accounts; bank_matching OFF absent; admin/accountant only", async () => {
  const o = await makeOrg();
  await bankLine(o, "unmatched", "2026-09-03"); await bankLine(o, "suggested", "2026-11-02");
  await bankLine(o, "matched", "2026-08-01"); await bankLine(o, "ignored", "2026-08-01"); await bankLine(o, "unmatched", "2026-07-01", true);
  for (const role of ["admin", "accountant"] as const)
    assert.deepEqual(await todayBankTurn(o.staff[role], ON), { state: "ready", count: 2, oldestMonth: "2026-09", since: "2026-09-03" });
  for (const role of ["manager", "maintenance"] as const) await assert.rejects(todayBankTurn(o.staff[role], ON), denied);
  // v1 item under today_dash (dashboard-target.md §3); its capability flag bank_matching still gates it.
  const matchingOff = await makeOrg({ bank_matching: false });
  assert.deepEqual(await todayBankTurn(matchingOff.staff.admin, ON), { state: "off" });
  assert.deepEqual(await todayBankTurn(o.staff.admin, { v3: async () => false }), { state: "off" });
  // Another org's lines never leak.
  const other = await makeOrg();
  assert.deepEqual(await todayBankTurn(other.staff.admin, ON), { state: "ready", count: 0, oldestMonth: null, since: null });
});

test("月結: after the 5th last month not closed, counting owners still without a statement; closing clears it", async () => {
  const o = await makeOrg();
  const cal = (await query<{ period: string; day: number }>(`SELECT to_char((date_trunc('month', (clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date) - interval '1 month'), 'YYYY-MM') AS period,
    extract(day FROM (clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date)::int AS day`)).rows[0];
  const owner = async (statement: string | null) => {
    const c = (await query<{ id: string }>(`INSERT INTO contacts (org_id, is_owner, display_name) VALUES ($1, true, 'Synthetic owner') RETURNING id::text`, [o.orgId])).rows[0].id;
    await query(`INSERT INTO property_owners (org_id, property_id, owner_contact_id) VALUES ($1, $2, $3)`, [o.orgId, o.property, c]);
    if (statement) await query(`INSERT INTO owner_statements (org_id, owner_contact_id, currency, period_start, period_end, status)
      VALUES ($1, $2, 'TWD', $3::date, ($3::date + interval '1 month - 1 day')::date, $4::statement_status)`, [o.orgId, c, `${cal.period}-01`, statement]);
  };
  await owner(null); await owner(null); await owner("issued"); await owner("void");
  const ready = await todayMonthCloseTurn(o.staff.accountant, ON);
  if (cal.day > 5) assert.deepEqual(ready, { state: "ready", row: { period: cal.period, month: Number(cal.period.slice(5)), owners: 3, since: ready.state === "ready" ? ready.row?.since : "" } });
  else assert.deepEqual(ready, { state: "ready", row: null });
  await query(`INSERT INTO month_closes (org_id, period_month, closed_by) VALUES ($1, $2::date, $3)`, [o.orgId, `${cal.period}-01`, o.staff.admin.userId]);
  assert.deepEqual(await todayMonthCloseTurn(o.staff.admin, ON), { state: "ready", row: null });
  for (const role of ["manager", "maintenance"] as const) await assert.rejects(todayMonthCloseTurn(o.staff[role], ON), denied);
  // No owner waiting: the approved line needs {k} > 0, so that case has no row (GS-44).
  assert.deepEqual(await todayMonthCloseTurn((await makeOrg()).staff.admin, ON), { state: "ready", row: null });
  assert.deepEqual(await todayMonthCloseTurn(o.staff.admin, { v3: async () => false }), { state: "off" });
});

async function thread(o: Org, messages: ("tenant" | "staff" | "system" | "deleted-staff" | "stranger" | "guarantor")[]) {
  const unit = (await query<{ id: string }>(`INSERT INTO units (org_id, property_id, label) VALUES ($1, $2, $3) RETURNING id::text`, [o.orgId, o.property, randomUUID().slice(0, 8)])).rows[0].id;
  const lease = (await query<{ id: string }>(`INSERT INTO leases (org_id, property_id, unit_id, target_unit_id, status, start_date, currency, rent_amount_minor)
    VALUES ($1, $2, $3, $3, 'active', '2026-01-01', 'TWD', 100) RETURNING id::text`, [o.orgId, o.property, unit])).rows[0].id;
  const tenant = (await query<{ id: string }>(`INSERT INTO contacts (org_id, is_tenant, display_name) VALUES ($1, true, 'Synthetic tenant') RETURNING id::text`, [o.orgId])).rows[0].id;
  const stranger = (await query<{ id: string }>(`INSERT INTO contacts (org_id, is_tenant, display_name) VALUES ($1, true, 'Other contact') RETURNING id::text`, [o.orgId])).rows[0].id;
  await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, 'primary')`, [o.orgId, lease, tenant]);
  const guarantor = (await query<{ id: string }>(`INSERT INTO contacts (org_id, display_name) VALUES ($1, 'Synthetic guarantor') RETURNING id::text`, [o.orgId])).rows[0].id;
  await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, 'guarantor')`, [o.orgId, lease, guarantor]);
  const member = (await query<{ id: string }>(`SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2`, [o.orgId, o.staff.manager.userId])).rows[0].id;
  const id = (await query<{ id: string }>(`INSERT INTO message_threads (org_id, kind, lease_id, property_id) VALUES ($1, 'lease', $2, $3) RETURNING id::text`, [o.orgId, lease, o.property])).rows[0].id;
  let at = Date.parse("2026-11-14T00:00:00Z");
  for (const kind of messages) {
    at += 3_600_000;
    await query(`INSERT INTO messages (org_id, thread_id, sender_contact_id, sender_member_id, body, created_at, deleted_at)
      VALUES ($1, $2, $3, $4, 'Synthetic body', $5::timestamptz, CASE WHEN $6 THEN now() ELSE NULL END)`,
    [o.orgId, id, kind === "tenant" ? tenant : kind === "stranger" ? stranger : kind === "guarantor" ? guarantor : null, kind === "staff" || kind === "deleted-staff" ? member : null,
      new Date(at).toISOString(), kind === "deleted-staff"]);
  }
  return new Date(at).toISOString();
}

test("待你回覆: threads whose last real message is the tenant's; reading does not clear; staff reply does; one summary", async () => {
  const o = await makeOrg({ [TODAY_KIND_FLAGS.reply]: true });
  await thread(o, ["tenant", "staff", "tenant"]);
  await thread(o, ["tenant", "system"]);           // a system note is not a staff reply
  await thread(o, ["tenant", "deleted-staff"]);    // a deleted reply is not a reply
  await thread(o, ["tenant", "staff"]);            // answered
  await thread(o, ["stranger"]);                    // not a party of this lease
  await thread(o, ["guarantor"]);                   // a guarantor is not the tenant
  await query(`UPDATE thread_participants SET last_read_at = now() WHERE org_id = $1`, [o.orgId]);
  const result = await todayReplyTurn(o.staff.manager, ON);
  assert.equal(result.state, "ready");
  if (result.state === "ready") { assert.equal(result.threads, 3); assert.equal(result.oldest, "2026-11-14T01:00:00.000000Z"); }
  for (const role of ["accountant", "maintenance"] as const) await assert.rejects(todayReplyTurn(o.staff[role], ON), denied);
  assert.deepEqual(await todayReplyTurn((await makeOrg()).staff.admin, ON), { state: "off" });
  const noThreadPath = await makeOrg({ [TODAY_KIND_FLAGS.reply]: true, tenant_thread_create: false });
  assert.deepEqual(await todayReplyTurn(noThreadPath.staff.admin, ON), { state: "off" });
});

async function ticket(o: Org, status: string, createdAt: string, title = "洗手台漏水") {
  return (await query<{ id: string }>(`INSERT INTO maintenance_tickets (org_id, ticket_number, property_id, status, title, created_at)
    VALUES ($1, (SELECT coalesce(max(ticket_number), 0) + 1 FROM maintenance_tickets WHERE org_id = $1), $2, $3::ticket_status, $4, $5::timestamptz)
    RETURNING id::text`, [o.orgId, o.property, status, title, createdAt])).rows[0].id;
}
async function job(o: Org, ticketId: string, expiresIn: string, revoked = false) {
  await query(`INSERT INTO repair_vendor_jobs (org_id, ticket_id, vendor_name, vendor_phone, contact_window, token_hash, expires_at, created_by, active, revoked_at)
    VALUES ($1, $2, 'Synthetic vendor', '+886900000000', 'Weekdays', $3, clock_timestamp() + $4::interval, $5, NOT $6, CASE WHEN $6 THEN clock_timestamp() END)`,
  [o.orgId, ticketId, randomUUID().replace(/-/g, "").padEnd(64, "0"), expiresIn, o.staff.admin.userId, revoked]);
}

test("T-REPAIR: 輪到你 is step-first across every page of one snapshot; rows carry the repair item and why; roles", async () => {
  const o = await makeOrg();
  const inProgress: string[] = [];
  for (let i = 0; i < 55; i++) inProgress.push(await ticket(o, "assigned", new Date(Date.UTC(2026, 0, 1, i)).toISOString(), `舊工單 ${i}`));
  const dispatch = [await ticket(o, "open", "2026-11-10T00:00:00Z", "浴室天花板滴水"), await ticket(o, "open", "2026-11-11T00:00:00Z", "冷氣不冷")];
  const expired = await ticket(o, "assigned", "2026-11-12T00:00:00Z", "門鎖卡住"); await job(o, expired, "-1 day");
  await query("UPDATE repair_vendor_jobs SET created_at = '2026-11-12T00:00:00Z' WHERE ticket_id = $1", [expired]);
  const closed = await ticket(o, "closed", "2026-11-01T00:00:00Z");
  const plain = await staffRepairTurns(o.staff.admin, {}, ON);
  assert.equal(plain.state, "ready");
  if (plain.state !== "ready") return;
  assert.equal(plain.yourTurn, 58); assert.equal(plain.mine.length, 50);
  assert.ok(plain.mine.every(m => m.step === "in_progress"), "the gateway pages by date only");
  const today = await todayRepairRows(o.staff.admin, { turns: session => staffRepairTodayTurns(session, ON) });
  assert.equal(today.state, "ready");
  if (today.state !== "ready") return;
  assert.equal(today.yourTurn, 58); assert.equal(today.mine.length, 50);
  assert.deepEqual(today.mine.slice(0, 3).map(m => m.ticketId), [...dispatch, expired]);
  assert.deepEqual(today.mine.slice(0, 3).map(m => m.step), ["dispatch", "dispatch", "dispatch"]);
  assert.deepEqual(today.mine.slice(0, 3).map(m => [m.title, m.why]), [["浴室天花板滴水", null], ["冷氣不冷", null], ["門鎖卡住", "link"]]);
  assert.equal(today.mine[2].rule, "R8-blocked");
  assert.deepEqual(today.mine.slice(3).map(m => m.ticketId), inProgress.slice(0, 47));
  assert.ok(today.mine.every(m => m.place.startsWith("景興路套房") && m.dayNumber === null && !m.sinceExact));
  assert.ok(![...today.mine, ...today.others].some(m => m.ticketId === closed), "B1: closed repairs have no row");
  // The accountant has no tickets.update; maintenance gets no rows (MGT-149-AC7).
  await assert.rejects(todayRepairRows(o.staff.accountant, { turns: session => staffRepairTodayTurns(session, ON) }), denied);
  assert.deepEqual(await todayRepairRows(o.staff.maintenance, { turns: session => staffRepairTodayTurns(session, ON) }), { state: "off" });
  // Dispatch OFF: an open ticket stays visible as 等管理方派工 for a viewer who cannot act, and is not counted.
  const off = await makeOrg({ vendor_dispatch: false });
  const waiting = await ticket(off, "open", "2026-11-10T00:00:00Z");
  const rows = await todayRepairRows(off.staff.manager, { turns: session => staffRepairTodayTurns(session, ON) });
  assert.equal(rows.state, "ready");
  if (rows.state === "ready") {
    assert.equal(rows.yourTurn, 0);
    assert.deepEqual(rows.others.map(m => [m.ticketId, m.holder, m.step, m.viewerCanAct]), [[waiting, "manager", "dispatch", false]]);
  }
});
