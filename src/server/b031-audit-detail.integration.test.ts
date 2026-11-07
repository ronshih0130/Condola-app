import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Client, type QueryResult } from "pg";
import { AuditRows } from "@/components/audit-log";
import { makeT } from "@/i18n";
import { AUDIT_DETAIL_SQL, loadAuditHistory, loadAuditScreen, type AuditView } from "./audit-read";
import { writeAudit } from "./audit";
import { setMemberRole } from "./auth";
import { OFF_FLOWS, adminSession, insertOffFixture, offFlow, withoutCursors } from "./b031-audit-detail-fixture";
import { query, tx, withClient } from "./db";
import { createLease, createProperty, updateLease } from "./domain";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import { updateOwner } from "./portfolio";
import { insertTestAuthSession } from "./test-auth-session";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

(globalThis as { React?: unknown }).React = React;
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);

type QueryFn = (sql: string, values?: unknown[]) => Promise<QueryResult>;
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
const admin = adminSession();
const t = makeT("zh-TW");

function staff(userId: string, role: Session["role"], orgId = ORG_ID): Session {
  return { ...adminSession(), userId, role, orgId, liveOrgId: orgId };
}

test.before(async () => {
  clone = await cloneTestDatabase();
  await withClient(async (client) => {
    admin.sessionId = await insertTestAuthSession(client, USERS.admin);
  });
});
test.after(async () => {
  mock.restoreAll();
  await clone?.cleanup();
});
test.afterEach(() => mock.restoreAll());

async function setFlag(global: unknown, orgFlags: Record<string, unknown> = { [ORG_ID]: true, [ORG2_ID]: true }) {
  if (global === undefined) await query(`DELETE FROM platform_settings WHERE key = 'audit_detail'`);
  else {
    await query(
      `INSERT INTO platform_settings (key, value) VALUES ('audit_detail', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(global)],
    );
  }
  for (const org of [ORG_ID, ORG2_ID]) {
    if (org in orgFlags) {
      await query(`UPDATE organizations SET feature_flags = jsonb_set(feature_flags, '{audit_detail}', $2::jsonb) WHERE id = $1`, [org, JSON.stringify(orgFlags[org])]);
    } else {
      await query(`UPDATE organizations SET feature_flags = feature_flags - 'audit_detail' WHERE id = $1`, [org]);
    }
  }
}
const ON = { enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] };
const OFF = { enabled: false, allowed_org_ids: [] };

async function detailCount() {
  return (await query<{ n: number }>(`SELECT count(*)::int AS n FROM app.b031_audit_details`)).rows[0].n;
}
async function detailIds(org: string) {
  return (await query<{ id: string }>(`SELECT audit_id::text AS id FROM app.b031_audit_details WHERE org_id = $1 ORDER BY audit_id`, [org])).rows.map((row) => row.id);
}
/** Through tx(): request.jwt.claim.sub + app.active_org_id + SET LOCAL ROLE authenticated, like production. */
async function gateway(userId: string, pinned: string, org: string, ids: string[]) {
  return tx(userId, async (client) => (await client.query(AUDIT_DETAIL_SQL, [org, ids])).rows, { orgId: pinned });
}
/** Raw role probe that keeps the SQLSTATE. */
async function asRole(role: "anon" | "service_role" | "authenticated", sql: string, params: unknown[] = []) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('app.active_org_id', $2, true)`, [USERS.admin, ORG_ID]);
      await client.query(`SET LOCAL ROLE ${role}`);
      return await client.query(sql, params);
    } finally {
      await client.query("ROLLBACK");
    }
  });
}
function code(error: unknown) {
  return (error as { code?: string }).code;
}
function render(entries: AuditView[]) {
  return renderToStaticMarkup(React.createElement(AuditRows, { entries, t, testId: "audit-list" }));
}
async function ownerFixture() {
  const owner = (await query<{ id: string }>(`SELECT id::text FROM contacts WHERE org_id = $1 AND is_owner AND archived_at IS NULL ORDER BY created_at, id LIMIT 1`, [ORG_ID])).rows[0];
  const properties = (await query<{ id: string }>(`SELECT property_id::text AS id FROM property_owners WHERE org_id = $1 AND owner_contact_id = $2`, [ORG_ID, owner.id])).rows.map((row) => row.id);
  return { ownerId: owner.id, properties };
}
async function memberId(userId: string, org = ORG_ID) {
  return (await query<{ id: string }>(`SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2`, [org, userId])).rows[0].id;
}

test("ON: admin sees actor, time, reason and before/after for covered production mutations", async () => {
  await setFlag(ON);
  const property = await createProperty(admin, {
    name: "B031 細節物件", city: "台北市", district: "大安區", street: "測試路 1 號", currency: "TWD", ownerMode: "new",
    ownerName: "B031 測試屋主", ownerPhone: "0912000333", ownerEmail: "b031-owner@example.test", canViewTenantPhone: false,
    unitLabel: "A", floor: "1", rentalMode: "by_room", rooms: [{ label: "A", roomType: "suite", baseRentMajor: 30000 }],
  });
  const lease = await createLease(admin, {
    roomId: property.roomIds[0], tenantName: "B031 測試租客", tenantPhone: "0912000444", tenantEmail: "b031-tenant@example.test",
    lineUserId: "", startDate: "2026-12-01", endDate: "2027-11-30", rentMajor: 30000, depositMonths: 2, depositReason: "", dueDay: 5,
    splitMethod: "even", periodStart: "2026-12-01", periodEnd: "2026-12-31", billTotalMajor: null, usageKwh: null, rateMajor: null,
    rateSource: "bill_average", overrideReason: "", subUsages: [],
  });
  const version = (await query<{ v: string }>(`SELECT updated_at::text AS v FROM leases WHERE id = $1`, [lease.leaseId])).rows[0].v;
  await updateLease(admin, { leaseId: lease.leaseId, rentMajor: 33000, depositMonths: 2, depositReason: "", updatedAt: version });

  // Reason-bearing write on the same authenticated path the app uses (noteChange/set_config).
  await tx(admin.userId, async (client) => {
    await client.query(`SELECT set_config('app.change_reason', $1, true)`, ["屋主同意延長 A123456789 0912-345-678"]);
    await client.query(`UPDATE leases SET end_date = '2027-12-31' WHERE id = $1`, [lease.leaseId]);
  }, { orgId: ORG_ID });

  const history = await loadAuditHistory(admin, "leases", lease.leaseId);
  const rent = history.entries.find((entry) => entry.detail?.changes.some((change) => change.fieldKey === "i_audit_f_rent"));
  assert.ok(rent?.detail, "rent edit has detail");
  assert.equal(rent.who, "林雅婷");
  assert.match(rent.when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(rent.detail.reason, "");
  assert.deepEqual(rent.detail.changes.find((change) => change.fieldKey === "i_audit_f_rent"), {
    fieldKey: "i_audit_f_rent", before: { text: "NT$30,000" }, after: { text: "NT$33,000" },
  });
  assert.deepEqual(rent.detail.changes.find((change) => change.fieldKey === "i_audit_f_deposit"), {
    fieldKey: "i_audit_f_deposit", before: { text: "NT$60,000" }, after: { text: "NT$66,000" },
  });
  const extended = history.entries.find((entry) => entry.detail?.changes.some((change) => change.fieldKey === "i_audit_f_end"));
  assert.ok(extended?.detail);
  assert.match(extended.detail.reason, /^屋主同意延長 /);
  assert.doesNotMatch(extended.detail.reason, /A123456789|0912-345-678/);
  assert.deepEqual(extended.detail.changes.find((change) => change.fieldKey === "i_audit_f_end"), {
    fieldKey: "i_audit_f_end", before: { text: "2027-11-30" }, after: { text: "2027-12-31" },
  });

  const { ownerId, properties } = await ownerFixture();
  await updateOwner(admin, ownerId, { name: "陳建宏", email: "b031-new-owner@example.test", phone: "0923555666", propertyIds: properties });
  const contact = (await loadAuditHistory(admin, "contacts", ownerId)).entries.find((entry) => entry.detail);
  assert.ok(contact?.detail);
  const phone = contact.detail.changes.find((change) => change.fieldKey === "i_audit_d_phone");
  const email = contact.detail.changes.find((change) => change.fieldKey === "i_audit_d_email");
  assert.deepEqual(phone?.after, { text: "+886*******66" });
  assert.deepEqual(email?.after, { text: "b***@example.test" });

  const manager = await memberId(USERS.manager);
  await setMemberRole(admin, manager, "accountant");
  await setMemberRole(admin, manager, "manager");
  const role = (await loadAuditHistory(admin, "org_members", manager)).entries.find((entry) => entry.detail);
  assert.ok(role?.detail);
  assert.deepEqual(role.detail.changes, [{ fieldKey: "i_audit_f_role", before: { key: "i_role_accountant" }, after: { key: "i_role_manager" } }]);

  const screen = await loadAuditScreen(admin, {});
  assert.ok(screen.entries.some((entry) => entry.detail));
  const html = render(screen.entries);
  assert.match(html, /data-testid="audit-detail"/);
  assert.match(html, /租金：NT\$30,000 → NT\$33,000/);
  assert.match(html, /原因：屋主同意延長/);
  assert.match(html, /未填寫原因/);
  assert.match(html, /角色：會計 → 經理/);
  const english = renderToStaticMarkup(React.createElement(AuditRows, { entries: screen.entries, t: makeT("en"), testId: "audit-list" }));
  assert.match(english, /Change detail/);
  assert.match(english, /Rent: NT\$30,000 → NT\$33,000/);
  for (const raw of ["b031-new-owner@example.test", "0923555666", "+886923555666", "A123456789", "0912-345-678"]) {
    assert.equal(html.includes(raw), false, raw);
    assert.equal(JSON.stringify(screen).includes(raw), false, raw);
  }
});

test("masking: no raw ID, bank, phone, email or token-like value is stored or rendered", async () => {
  await setFlag(ON);
  const { ownerId } = await ownerFixture();
  const token = "tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
  const secrets = ["A123456789", "AB12345678", token, "0123456789012345", "+886912345678", "0912345678", "owner.secret@example.test", "秘密法定姓名", "line-user-secret"];
  await tx(admin.userId, async (client) => {
    await client.query(`SELECT set_config('app.change_reason', $1, true)`, [`更正 A123456789 ${token} 帳號 0123456789012345`]);
    await client.query(
      `UPDATE contacts SET display_name = $2, phone_e164 = '+886912345678', email = 'owner.secret@example.test',
              legal_name = '秘密法定姓名', notes = '帳號 0123456789012345', line_user_id = 'line-user-secret',
              company_name = $3
        WHERE id = $1`,
      // The live display name is also the existing record label, so the token goes in company_name.
      [ownerId, "陳建宏 A123456789", `AB12345678 公司 ${token}`],
    );
  }, { orgId: ORG_ID });
  // A row whose changed columns include secret-shaped keys (written by a future trigger, say).
  await query(
    `INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, changed_cols, old_row, new_row)
     VALUES ($1, $2, 'authenticated', 'contacts', $3, 'update', ARRAY['session_token','password','id_number_hash','display_name']::text[],
             $4::jsonb, $5::jsonb)`,
    [ORG_ID, USERS.admin, ownerId, JSON.stringify({ session_token: token, password: "Fixture1234", id_number_hash: "hash-secret", display_name: "x" }),
      JSON.stringify({ session_token: `${token}x`, password: "Changed1234", id_number_hash: "hash-secret-2", display_name: "y" })],
  );
  const stored = (await query<{ reason: string | null; changes: unknown; withheld: number }>(
    `SELECT reason, changes, withheld FROM app.b031_audit_details WHERE org_id = $1 AND table_name = 'contacts' ORDER BY audit_id DESC LIMIT 2`, [ORG_ID],
  )).rows;
  assert.equal(stored.length, 2);
  const packed = JSON.stringify(stored);
  for (const secret of [...secrets, "Fixture1234", "Changed1234", "hash-secret", "session_token", "password", "id_number_hash", "legal_name", "line_user_id", "notes"]) {
    assert.equal(packed.includes(secret), false, `stored: ${secret}`);
  }
  assert.equal(stored[0].withheld, 3, "three secret-shaped columns withheld");
  assert.ok(stored[1].withheld >= 3, "legal name, notes, LINE id withheld");
  assert.match(packed, /\+886\*{7}78/);
  assert.match(packed, /o\*\*\*@example\.test/);

  // Log scan: capture every console channel while reading and rendering.
  const logged: string[] = [];
  for (const channel of ["log", "info", "warn", "error", "debug"] as const) {
    mock.method(console, channel, (...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  }
  const history = await loadAuditHistory(admin, "contacts", ownerId);
  const screen = await loadAuditScreen(admin, { record: "contacts" });
  const html = render(history.entries) + render(screen.entries);
  mock.restoreAll();
  const json = JSON.stringify([history, screen]);
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
  const ids = (await query<{ id: string }>(`SELECT audit_id::text AS id FROM app.b031_audit_details`)).rows.map((row) => row.id);
  for (const secret of [...secrets, "Fixture1234", "hash-secret"]) {
    assert.equal(html.includes(secret), false, `rendered: ${secret}`);
    assert.equal(json.includes(secret), false, `view: ${secret}`);
    assert.equal(logged.join("\n").includes(secret), false, `logged: ${secret}`);
    assert.equal(hrefs.some((href) => href.includes(secret)), false, `url: ${secret}`);
  }
  // URL scan: links stay the existing record links; detail adds no query parameters or audit ids.
  for (const href of hrefs) {
    assert.match(href, /^\/m\/(owners|tenants|leases|properties|statements|team|units\/room|units\/whole)(\/[0-9a-f-]+)?$/, href);
    assert.equal(ids.some((id) => href.includes(`=${id}`)), false, href);
  }
  assert.match(html, /另有 3 個欄位因隱私不顯示/);
});

test("role filtering is enforced in the DB: only an active admin of the pinned org receives detail", async () => {
  await setFlag(ON);
  await tx(USERS.coastAdmin, async (client) => {
    await client.query(`SELECT set_config('app.change_reason', 'coast-only-marker', true)`);
    await client.query(`UPDATE org_members SET title = 'Coast lead' WHERE org_id = $1 AND user_id = $2`, [ORG2_ID, USERS.coastAdmin]);
  }, { orgId: ORG2_ID });
  const ours = await detailIds(ORG_ID);
  const theirs = await detailIds(ORG2_ID);
  assert.ok(ours.length > 0 && theirs.length > 0);

  assert.ok((await gateway(USERS.admin, ORG_ID, ORG_ID, ours)).length > 0, "admin of pinned org");
  for (const user of [USERS.manager, USERS.accountant, USERS.maintenance, USERS.tenant, USERS.owner]) {
    assert.equal((await gateway(user, ORG_ID, ORG_ID, ours)).length, 0, `non-admin ${user}`);
  }
  assert.equal((await gateway(USERS.coastAdmin, ORG_ID, ORG_ID, ours)).length, 0, "other org admin pinned here");
  assert.equal((await gateway(USERS.coastAdmin, ORG2_ID, ORG_ID, ours)).length, 0, "pin mismatch");
  assert.equal((await gateway(USERS.coastAdmin, ORG2_ID, ORG2_ID, ours)).length, 0, "foreign ids under own org");
  assert.equal((await gateway(USERS.admin, ORG_ID, ORG_ID, theirs)).length, 0, "cross-org ids");
  assert.equal((await gateway(USERS.admin, ORG_ID, ORG2_ID, theirs)).length, 0, "other org parameter");
  const coast = await gateway(USERS.coastAdmin, ORG2_ID, ORG2_ID, theirs);
  assert.equal(coast.length, theirs.length);
  assert.equal(JSON.stringify(await gateway(USERS.admin, ORG_ID, ORG_ID, [...ours, ...theirs])).includes("coast-only-marker"), false);

  // A suspended admin loses detail immediately.
  await query(`UPDATE org_members SET status = 'suspended' WHERE org_id = $1 AND user_id = $2`, [ORG2_ID, USERS.coastAdmin]);
  assert.equal((await gateway(USERS.coastAdmin, ORG2_ID, ORG2_ID, theirs)).length, 0, "suspended admin");
  await query(`UPDATE org_members SET status = 'active' WHERE org_id = $1 AND user_id = $2`, [ORG2_ID, USERS.coastAdmin]);

  await assert.rejects(() => asRole("authenticated", `SELECT * FROM app.b031_audit_details`), (error) => code(error) === "42501");
  await assert.rejects(() => asRole("anon", AUDIT_DETAIL_SQL, [ORG_ID, ours]), (error) => code(error) === "42501");
  await assert.rejects(() => asRole("service_role", AUDIT_DETAIL_SQL, [ORG_ID, ours]), (error) => code(error) === "42501");
  for (const helper of ["app.b031_audit_detail_on($1::uuid)", "app.b031_mask_text($1::text)"]) {
    await assert.rejects(() => asRole("authenticated", `SELECT ${helper}`, [ORG_ID]), (error) => code(error) === "42501", helper);
  }
  await assert.rejects(() => asRole("authenticated", `INSERT INTO app.b031_audit_details (audit_id, org_id, table_name, changes) VALUES (1, $1, 'leases', '[{}]')`, [ORG_ID]), (error) => code(error) === "42501");

  for (const role of ["manager", "accountant"] as const) {
    const page = await loadAuditScreen(staff(role === "manager" ? USERS.manager : USERS.accountant, role), {});
    assert.equal(page.entries.length, 0);
  }
  const coastPage = await loadAuditScreen(staff(USERS.coastAdmin, "admin", ORG2_ID), {});
  assert.ok(coastPage.entries.some((entry) => entry.detail?.reason === "coast-only-marker"));
  assert.equal(JSON.stringify(await loadAuditScreen(admin, {})).includes("coast-only-marker"), false);
});

test("OFF: partial or malformed flag shapes write nothing and read nothing", async () => {
  await setFlag(ON);
  const before = await detailCount();
  assert.ok(before > 0);
  const ours = await detailIds(ORG_ID);
  const variants: [string, unknown, Record<string, unknown>][] = [
    ["default OFF", OFF, {}],
    ["global off, org on", { enabled: false, allowed_org_ids: [ORG_ID] }, { [ORG_ID]: true }],
    ["global string true", { enabled: "true", allowed_org_ids: [ORG_ID] }, { [ORG_ID]: true }],
    ["org not allowlisted", { enabled: true, allowed_org_ids: [ORG2_ID] }, { [ORG_ID]: true }],
    ["allowlist missing", { enabled: true }, { [ORG_ID]: true }],
    ["allowlist as string", { enabled: true, allowed_org_ids: ORG_ID }, { [ORG_ID]: true }],
    ["org flag absent", ON, {}],
    ["org flag string", ON, { [ORG_ID]: "true" }],
    ["org flag false", ON, { [ORG_ID]: false }],
    ["setting row absent", undefined, { [ORG_ID]: true }],
  ];
  for (const [name, global, orgFlags] of variants) {
    await setFlag(global, orgFlags);
    await tx(admin.userId, async (client) => {
      await client.query(`SELECT set_config('app.change_reason', $1, true)`, [`off ${name}`]);
      await client.query(`UPDATE org_members SET title = $3 WHERE org_id = $1 AND user_id = $2`, [ORG_ID, USERS.accountant, `Title ${name}`]);
    }, { orgId: ORG_ID });
    assert.equal(await detailCount(), before, `no write: ${name}`);
    assert.equal((await gateway(USERS.admin, ORG_ID, ORG_ID, ours)).length, 0, `no read: ${name}`);
    const page = await loadAuditScreen(admin, {});
    assert.equal(page.entries.some((entry) => "detail" in entry), false, `no detail: ${name}`);
  }
  await setFlag(OFF, {});
});

test("OFF complete SQL trace, presented page and rendered rows match the pre-slice-2 baseline", async () => {
  // Detail rows exist (captured while ON) so an OFF read that ignored the flag would show them.
  await setFlag(ON);
  await insertOffFixture();
  assert.ok((await query(`SELECT 1 FROM app.b031_audit_details d JOIN audit_log a ON a.id = d.audit_id WHERE a.row_id = ANY($1)`, [["10000000-0000-4000-8000-0000000b31a1", "10000000-0000-4000-8000-0000000b31a2"]])).rowCount === 2);
  await setFlag(OFF, {});
  const baseline = JSON.parse(readFileSync(new URL("./fixtures/b031-audit-detail-off.json", import.meta.url), "utf8")) as Record<string, { sql: string[]; result: unknown; html: string }>;
  for (const flow of OFF_FLOWS) {
    const statements: string[] = [];
    const original = Client.prototype.query;
    const trace = mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
      assert.equal(typeof sql, "string", "trace must capture every statement");
      statements.push(sql);
      return (original as unknown as QueryFn).call(this, sql, values);
    }) as typeof original);
    let result: { entries: AuditView[] };
    try {
      result = await offFlow({ loadAuditScreen, loadAuditHistory } as never, flow)() as { entries: AuditView[] };
    } finally {
      trace.mock.restore();
    }
    assert.equal(statements.filter((sql) => sql === AUDIT_DETAIL_SQL).length, 1, `exactly one extra read: ${flow}`);
    statements.splice(statements.indexOf(AUDIT_DETAIL_SQL), 1);
    assert.deepEqual(statements, baseline[flow].sql, `SQL: ${flow}`);
    assert.deepEqual(withoutCursors(result), baseline[flow].result, `result: ${flow}`);
    assert.equal(render(result.entries), baseline[flow].html, `html: ${flow}`);
  }
});

test("reason is optional: blank becomes none, long reasons are capped, detail is still recorded", async () => {
  await setFlag(ON);
  const cases: [string | null, string | null][] = [[null, null], ["   ", null], ["原因 ".repeat(200), "原因 ".repeat(200).slice(0, 500)], ["  屋主要求更正  ", "屋主要求更正"]];
  for (const [index, [reason, expected]] of cases.entries()) {
    await tx(admin.userId, async (client) => {
      if (reason !== null) await client.query(`SELECT set_config('app.change_reason', $1, true)`, [reason]);
      await client.query(`UPDATE org_members SET title = $3 WHERE org_id = $1 AND user_id = $2`, [ORG_ID, USERS.maintenance, `Reason case ${index}`]);
    }, { orgId: ORG_ID });
    const row = (await query<{ reason: string | null; changes: { a: string }[] }>(
      `SELECT d.reason, d.changes FROM app.b031_audit_details d JOIN audit_log a ON a.id = d.audit_id
        WHERE d.org_id = $1 AND d.table_name = 'org_members' ORDER BY d.audit_id DESC LIMIT 1`, [ORG_ID],
    )).rows[0];
    assert.equal(row.reason, expected);
    assert.equal(row.changes[0].a, `Reason case ${index}`);
  }
  const member = await memberId(USERS.maintenance);
  const entries = (await loadAuditHistory(admin, "org_members", member)).entries.filter((entry) => entry.detail);
  assert.ok(entries.some((entry) => entry.detail!.reason === ""));
  assert.match(render(entries), /未填寫原因/);
});

test("only allowlisted updates are detailed; inserts, deletes, app events and other tables are not", async () => {
  await setFlag(ON);
  const before = await detailCount();
  await query(
    `INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, changed_cols, old_row, new_row)
     VALUES ($1, $2, 'authenticated', 'payments', 'p1', 'update', ARRAY['amount_minor'], '{"amount_minor":1}', '{"amount_minor":2}'),
            ($1, $2, 'authenticated', 'leases', 'l1', 'insert', NULL, NULL, '{"rent_amount_minor":2}'),
            ($1, $2, 'authenticated', 'leases', 'l2', 'delete', NULL, '{"rent_amount_minor":2}', NULL),
            ($1, $2, 'authenticated', 'leases', 'l3', 'update', ARRAY['notes','template_variables'], '{"notes":"a","template_variables":{}}', '{"notes":"b","template_variables":{"x":1}}'),
            (NULL, $2, 'authenticated', 'leases', 'l4', 'update', ARRAY['rent_amount_minor'], '{"rent_amount_minor":1}', '{"rent_amount_minor":2}')`,
    [ORG_ID, USERS.admin],
  );
  await writeAudit(ORG_ID, USERS.admin, "role_change", { memberId: "m", role: "manager" });
  assert.equal(await detailCount(), before);
});

test("detail rows are append-only and big amounts keep exact precision", async () => {
  await setFlag(ON);
  await query(
    `INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, changed_cols, old_row, new_row)
     VALUES ($1, $2, 'authenticated', 'leases', $3, 'update', ARRAY['rent_amount_minor'],
             '{"rent_amount_minor":900719925474099300,"currency":"TWD"}', '{"rent_amount_minor":900719925474099301,"currency":"TWD"}')`,
    [ORG_ID, USERS.admin, "10000000-0000-4000-8000-0000000b31a3"],
  );
  const row = (await query<{ audit_id: string; changes: { b: string; a: string }[] }>(
    `SELECT audit_id::text, changes FROM app.b031_audit_details ORDER BY audit_id DESC LIMIT 1`,
  )).rows[0];
  assert.equal(row.changes[0].a, "900719925474099301");
  const entry = (await loadAuditHistory(admin, "leases", "10000000-0000-4000-8000-0000000b31a3")).entries[0];
  assert.deepEqual(entry.detail?.changes[0].after, { text: "NT$9,007,199,254,740,993.01" });
  await assert.rejects(() => query(`UPDATE app.b031_audit_details SET reason = 'x' WHERE audit_id = $1`, [row.audit_id]), (error) => code(error) === "23514");
  await assert.rejects(() => query(`DELETE FROM app.b031_audit_details WHERE audit_id = $1`, [row.audit_id]), (error) => code(error) === "23514");
  await setFlag(OFF, {});
});
