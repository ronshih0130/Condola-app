import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { query } from "./db";
import { auditV3Read, type AuditV3Read } from "./b073-audit";
import { entryText } from "../components/v3/m/settings/audit";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// B-073 / R5-AUDIT (MGT-136 company log: AC2, AC3, AC4) against a disposable local database: the real SQL, the
// audit_log RLS policy and the seeded firms. Synthetic audit rows only, dated in 2019 so they never mix with seed
// activity; nothing outbound.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);

function staff(userId: string, role: Session["role"], orgId: string): Session {
  return { userId, sessionId: randomUUID(), email: "audit-v3@example.invalid", name: "Audit", kind: "staff", role, orgId, liveOrgId: orgId,
    environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
}
const admin = staff(USERS.admin, "admin", ORG_ID);
const coast = staff(USERS.coastAdmin, "admin", ORG2_ID);
const NOW = () => Date.parse("2026-11-17T12:00:00Z");
const ready = (read: AuditV3Read) => {
  if (read.state !== "ready") throw new Error(`expected ready, got ${read.state}`);
  return read;
};
type Row = { org: string; actor: string | null; table: string; rowId: string; action: string; at: string; changed?: string[] | null; reason?: string | null; old?: unknown; next?: unknown; event?: string | null };
async function insert(rows: Row[]) {
  for (const row of rows)
    await query(
      `INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, old_row, new_row, changed_cols, reason, occurred_at)
       VALUES ($1, $2, 'app', $3, $4, $5::audit_action, $6, $7::jsonb, $8::jsonb, $9::text[], $10, $11::timestamptz)`,
      [row.org, row.actor, row.table, row.rowId, row.action, row.event ?? null, row.old === undefined ? null : JSON.stringify(row.old),
        row.next === undefined ? null : JSON.stringify(row.next), row.changed ?? null, row.reason ?? null, row.at]);
}
/** Letters only: a UUID or a long digit run in a reason is masked by the reader, as today. */
const tagOf = (prefix: string) => `${prefix}-${Array.from({ length: 10 }, () => "abcdefghjk"[Math.floor(Math.random() * 10)]).join("")}`;
const texts = (read: AuditV3Read) => ready(read).entries.map(entry => entryText("zh-TW", entry));

test("MGT-136-AC2/AC4: an admin sees the company's entries in plain words; only named values; sensitive values masked; never another company's", async () => {
  const lease = (await query<{ id: string }>("SELECT id::text AS id FROM leases WHERE org_id = $1 ORDER BY id LIMIT 1", [ORG_ID])).rows[0].id;
  const contact = (await query<{ id: string }>("SELECT id::text AS id FROM contacts WHERE org_id = $1 AND is_tenant ORDER BY id LIMIT 1", [ORG_ID])).rows[0].id;
  const marker = tagOf("rfaudit");
  await insert([
    { org: ORG_ID, actor: USERS.admin, table: "leases", rowId: lease, action: "update", at: "2019-03-10T07:02:00Z", changed: ["rent_amount_minor", "updated_at"], reason: `續約調漲 ${marker}`,
      old: { rent_amount_minor: 1800000, currency: "TWD", phone_e164: "+886912000111", tax_id: "A123456789" },
      next: { rent_amount_minor: 1850000, currency: "TWD", phone_e164: "+886912000111", tax_id: "A123456789" } },
    { org: ORG_ID, actor: USERS.admin, table: "contacts", rowId: contact, action: "update", at: "2019-03-10T08:00:00Z", changed: ["phone_e164"], reason: marker,
      old: { phone_e164: "+886912000222" }, next: { phone_e164: "+886912000333" } },
    { org: ORG2_ID, actor: USERS.coastAdmin, table: "leases", rowId: lease, action: "update", at: "2019-03-10T09:00:00Z", changed: ["notes"], reason: `org-two ${marker}` },
  ]);
  const read = ready(await auditV3Read(admin, { from: "2019-03-10", to: "2019-03-10" }, { now: NOW }));
  const lines = texts(read).filter(line => line.includes(marker));
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[1], /^[^把]+把.+的租金從 NT\$18,000 改成 NT\$18,500・原因：續約調漲 rfaudit-/);
  assert.match(lines[0], /^.+ 修改・租客 .+・敏感欄位已遮罩・原因：rfaudit-/);
  assert.deepEqual(read.entries.filter(entry => entry.reason.includes(marker)).map(entry => `${entry.item}・${entry.when}`), ["租客・2019/03/10 16:00", "租約・2019/03/10 15:02"]);
  const packed = JSON.stringify(read);
  for (const secret of ["886912000", "0912000", "A123456789", "org-two", "phone_e164", "tax_id"]) assert.equal(packed.includes(secret), false, secret);
  // The other company's admin sees only its own entry for the same day.
  const theirs = texts(await auditV3Read(coast, { from: "2019-03-10", to: "2019-03-10" }, { now: NOW })).filter(line => line.includes(marker));
  assert.equal(theirs.length, 1); assert.match(theirs[0], /org-two/);
  // A person filter naming another company's admin finds nothing here.
  assert.equal(ready(await auditV3Read(admin, { user: USERS.coastAdmin, from: "2019-03-10", to: "2019-03-10" }, { now: NOW })).entries.length, 0);
});

test("MGT-136-AC3: manager, accountant and maintenance get 403 (forbidden) and read nothing", async () => {
  for (const [role, user] of [["manager", USERS.manager], ["accountant", USERS.accountant], ["maintenance", USERS.maintenance]] as const)
    assert.deepEqual(await auditV3Read(staff(user, role, ORG_ID), {}, { now: NOW }), { state: "forbidden" }, role);
  // A forged admin session for a non-admin user is still refused by the audit_log policy: nothing comes back.
  const forged = ready(await auditV3Read(staff(USERS.manager, "admin", ORG_ID), { from: "2019-03-10", to: "2019-03-10" }, { now: NOW }));
  assert.deepEqual(forged.entries, []);
});

test("MGT-136-AC2 filters: by person, by Taipei day range and by item (租約・繳款・單位 and today's other records)", async () => {
  const unit = (await query<{ id: string }>("SELECT id::text AS id FROM units WHERE org_id = $1 ORDER BY id LIMIT 1", [ORG_ID])).rows[0].id;
  const lease = (await query<{ id: string }>("SELECT id::text AS id FROM leases WHERE org_id = $1 ORDER BY id LIMIT 1", [ORG_ID])).rows[0].id;
  const tag = tagOf("rffilter");
  await insert([
    { org: ORG_ID, actor: USERS.admin, table: "units", rowId: unit, action: "update", at: "2019-04-01T15:59:00Z", changed: ["label"], reason: tag, old: { label: "2F" }, next: { label: "2F-1" } },
    { org: ORG_ID, actor: USERS.manager, table: "leases", rowId: lease, action: "update", at: "2019-04-01T16:00:00Z", changed: ["notes"], reason: tag },
    { org: ORG_ID, actor: USERS.manager, table: "properties", rowId: randomUUID(), action: "insert", at: "2019-04-03T01:00:00Z", reason: tag },
  ]);
  const mine = (input: Record<string, string>) => auditV3Read(admin, input, { now: NOW }).then(read => ready(read).entries.filter(entry => entry.reason.includes(tag)));
  // Taipei days: 2019-04-01 15:59Z is still 04-01 in Taipei (23:59); 16:00Z is 04-02.
  assert.equal((await mine({ from: "2019-04-01", to: "2019-04-01" })).length, 1);
  assert.equal((await mine({ from: "2019-04-02", to: "2019-04-03" })).length, 2);
  assert.equal((await mine({ from: "2019-04-01", to: "2019-04-03" })).length, 3);
  const byPerson = await mine({ user: USERS.manager, from: "2019-04-01", to: "2019-04-03" });
  assert.deepEqual(byPerson.map(entry => entry.item), ["物件", "租約"]);
  const units = await mine({ item: "unit", from: "2019-04-01", to: "2019-04-03" });
  assert.equal(units.length, 1); assert.equal(units[0].item, "單位");
  assert.match(entryText("zh-TW", units[0]), /^.+把.+的標籤從「2F」改成「2F-1」・原因：rffilter-/);
  assert.deepEqual((await mine({ item: "lease", from: "2019-04-01", to: "2019-04-03" })).map(entry => entry.item), ["租約"]);
  assert.deepEqual((await mine({ item: "properties", from: "2019-04-01", to: "2019-04-03" })).map(entry => entry.item), ["物件"]);
  assert.equal((await mine({ item: "payment", from: "2019-04-01", to: "2019-04-03" })).length, 0);
  // No match: the page shows 「找不到符合的紀錄」 + 「清除篩選」 (component test); the read is simply empty and ready.
  assert.deepEqual(ready(await auditV3Read(admin, { item: "payment", from: "2019-04-01", to: "2019-04-01" }, { now: NOW })).entries, []);
});

test("MGT-136-AC2 paging: 25 a page newest first; 下一頁 then 上一頁 returns the same page; nothing repeats or is skipped", async () => {
  const tag = tagOf("rfpage");
  // A month with no audit rows yet (reruns on the same database pick another one).
  let month = "";
  for (let year = 1990; year < 2019 && !month; year += 1) {
    const free = await query("SELECT 1 FROM audit_log WHERE org_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz LIMIT 1", [ORG_ID, `${year}-05-01T00:00:00+08:00`, `${year}-06-01T00:00:00+08:00`]);
    if (!free.rows.length) month = `${year}-05`;
  }
  assert.ok(month, "a free month");
  await insert(Array.from({ length: 30 }, (_, i) => ({ org: ORG_ID, actor: USERS.admin, table: "properties", rowId: randomUUID(), action: "insert",
    at: `${month}-${String(1 + i).padStart(2, "0")}T02:00:00Z`, reason: `${tag} ${i}` })));
  const filter = { item: "properties", from: `${month}-01`, to: `${month}-31` };
  const first = ready(await auditV3Read(admin, filter, { now: NOW }));
  assert.equal(first.entries.length, 25); assert.equal(first.prev, null); assert.ok(first.next);
  assert.deepEqual(first.entries.map(entry => entry.reason), Array.from({ length: 25 }, (_, i) => `${tag} ${29 - i}`));
  const second = ready(await auditV3Read(admin, { ...filter, cursor: first.next! }, { now: NOW }));
  assert.deepEqual(second.entries.map(entry => entry.reason), [4, 3, 2, 1, 0].map(i => `${tag} ${i}`));
  assert.equal(second.next, null); assert.ok(second.prev);
  const back = ready(await auditV3Read(admin, { ...filter, before: second.prev! }, { now: NOW }));
  assert.deepEqual(back.entries.map(entry => entry.key), first.entries.map(entry => entry.key));
  assert.equal(back.prev, null); assert.equal(back.next, first.next);
});
