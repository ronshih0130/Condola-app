import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIT_PAGE_SIZE,
  actionKey,
  auditChanges,
  auditPageQuery,
  auditScreenQuery,
  decodeCursor,
  encodeCursor,
  maskAuditText,
  parseAuditFilters,
  presentAudit,
  recordHref,
  recordKey,
  recordLookupQuery,
  resolveRecord,
  summarizeChanges,
  taipeiRange,
} from "./audit-read";

const SECRET_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("identity numbers, phones, emails, and ids are masked", () => {
  const masked = maskAuditText(
    `屋主同意 A123456789 居留證 AB12345678 電話 +886912345678 與 0912345678 信 box@example.com 編號 ${SECRET_UUID}`,
  );
  assert.equal(masked.masked, true);
  assert.match(masked.text, /屋主同意/);
  assert.doesNotMatch(masked.text, /A123456789/i);
  assert.doesNotMatch(masked.text, /AB12345678/i);
  assert.doesNotMatch(masked.text, /\+886/);
  assert.doesNotMatch(masked.text, /0912345678/);
  assert.doesNotMatch(masked.text, /box@example.com/i);
  assert.doesNotMatch(masked.text, /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/i);
  assert.equal(maskAuditText("押金原因").masked, false);
  const phones = [
    "+886 912 345 678",
    "+886-912-345-678",
    "+886 0912 345 678",
    "0912-345-678",
    "0912 345 678",
    "(02) 2345-6789",
    "02-2345-6789",
    "04-123-4567",
    "037-123-456",
    "07 1234567",
    "+886 2 2345 6789",
  ];
  for (const phone of phones) {
    const hit = maskAuditText(`請聯絡 ${phone} 謝謝`);
    assert.equal(hit.masked, true, phone);
    assert.equal(hit.text.includes(phone), false, phone);
    assert.doesNotMatch(hit.text, /\d{6}/, phone);
  }
  const together = maskAuditText("請打 +886912345678 02-2345-6789 0912-345-678");
  assert.equal(together.masked, true);
  assert.doesNotMatch(together.text, /\+886|2345|0912/);
  assert.equal(maskAuditText("租金 2026-10-21 共 12000").masked, false);
});

test("changed columns never keep sensitive names", () => {
  const summary = summarizeChanges(["number_hash", "phone_e164", "rent_amount_minor", "secret_token", "updated_at", "label"]);
  assert.deepEqual(summary.fields, ["i_audit_f_rent", "i_audit_f_label"]);
  assert.equal(summary.masked, true);
  const packed = JSON.stringify(summary);
  assert.equal(packed.includes("number_hash"), false);
  assert.equal(packed.includes("phone"), false);
  assert.equal(packed.includes("secret"), false);
});

test("Taipei date bounds and keyset cursors stay exact", () => {
  assert.deepEqual(taipeiRange("2026-10-21", "2026-10-21"), {
    start: "2026-10-20T16:00:00.000Z",
    end: "2026-10-21T16:00:00.000Z",
  });
  assert.deepEqual(taipeiRange("not-a-day", "2026-13-40"), { start: null, end: null });
  const cursor = encodeCursor("2026-10-21T01:02:03.123456Z", "42");
  assert.deepEqual(decodeCursor(cursor), { at: "2026-10-21T01:02:03.123456Z", id: "42" });
  assert.equal(decodeCursor("not-a-cursor"), null);
  assert.equal(decodeCursor(encodeCursor("2026-10-21T01:02:03.123Z", "42")), null);
  assert.equal(decodeCursor(encodeCursor("2026-13-40T99:99:99.000000Z", "1")), null);
  assert.equal(decodeCursor(encodeCursor("2026-02-31T00:00:00.000000Z", "1")), null);
  assert.equal(decodeCursor(encodeCursor("2026-10-21T01:02:03.123456Z", "9999999999999999999")), null);
  assert.equal(decodeCursor(encodeCursor("2026-10-21T01:02:03.123456Z", "9223372036854775808")), null);
  assert.deepEqual(decodeCursor(encodeCursor("2026-10-21T01:02:03.123456Z", "9223372036854775807")), {
    at: "2026-10-21T01:02:03.123456Z",
    id: "9223372036854775807",
  });
  assert.equal(decodeCursor("a".repeat(240)), null);
  assert.equal(parseAuditFilters({ cursor: encodeCursor("2026-13-40T00:00:00.000000Z", "12") }).cursor, null);
  assert.equal(parseAuditFilters({ cursor: encodeCursor("2026-10-21T01:02:03.123456Z", "1".repeat(40)) }).cursor, null);
});

test("filters ignore unknown users, actions, and record types", () => {
  const parsed = parseAuditFilters({
    user: "not-a-uuid",
    action: "drop table",
    record: "auth.users",
    from: "2026-10-01",
    to: "yesterday",
    cursor: "%%%",
  });
  assert.equal(parsed.actorId, null);
  assert.equal(parsed.action, null);
  assert.equal(parsed.eventType, null);
  assert.equal(parsed.tableName, null);
  assert.equal(parsed.from, "2026-10-01");
  assert.equal(parsed.to, null);
  assert.equal(parsed.cursor, null);
  assert.equal(parseAuditFilters({ action: "sign_in" }).eventType, "sign_in");
  assert.equal(parseAuditFilters({ action: "update", record: "leases" }).action, "update");
  assert.equal(parseAuditFilters({ action: "update", record: "leases" }).tableName, "leases");
});

test("links go to lease, tenant, and property records and nowhere else for identity rows", () => {
  const lease = "10000000-0000-4000-8000-0000000000aa";
  assert.equal(recordHref("leases", lease), `/m/leases/${lease}`);
  assert.equal(recordHref("properties", lease), `/m/properties/${lease}`);
  assert.equal(recordHref("contacts", lease, { tenant: true }), `/m/tenants/${lease}`);
  assert.equal(recordHref("contacts", lease, { owner: true }), `/m/owners/${lease}`);
  assert.equal(recordHref("identity_documents", lease), null);
  assert.equal(recordHref("auth_events", "sign_in"), null);
  assert.equal(recordKey("contacts", { tenant: true }), "i_audit_rec_tenant");
  assert.equal(recordKey("contacts", { owner: true }), "i_audit_rec_owner");
  assert.equal(recordKey("leases"), "i_audit_rec_lease");
  const missing = resolveRecord("leases", lease, null);
  assert.equal(missing.found, false);
  assert.equal(missing.href, null);
  const idDoc = resolveRecord("identity_documents", lease, null);
  assert.equal(idDoc.found, true);
  assert.equal(idDoc.href, null);
  assert.equal(idDoc.recordKey, "i_audit_rec_id");
});

test("a presented row shows who, what, which, and when without sensitive values", () => {
  const rowId = "10000000-0000-4000-8000-0000000000bb";
  const view = presentAudit(
    {
      id: "99",
      occurred_key: "2026-10-20T16:30:00.000000Z",
      occurred_at: "2026-10-20T16:30:00.000Z",
      actor_name: "林雅婷",
      has_actor: true,
      table_name: "leases",
      row_id: rowId,
      action: "update",
      event_type: null,
      changed_cols: ["rent_amount_minor", "phone_e164", "number_masked"],
      reason: `屋主同意 A123456789 ${SECRET_UUID}`,
    },
    { text: "王小美 信義松仁 3F" },
  );
  assert.equal(view.who, "林雅婷");
  assert.equal(view.actionKey, "i_audit_act_update");
  assert.deepEqual(view.fields, ["i_audit_f_rent"]);
  assert.equal(view.masked, true);
  assert.match(view.reason, /屋主同意/);
  assert.equal(view.recordText, "王小美 信義松仁 3F");
  assert.equal(view.href, `/m/leases/${rowId}`);
  assert.equal(view.when, "2026-10-21 00:30");
  assert.equal(actionKey("insert", "sign_in"), "i_audit_ev_sign_in");
  assert.equal(actionKey("insert", "internal_probe"), "i_audit_act_insert");
  const packed = JSON.stringify({ ...view, href: "", cursor: "" });
  assert.doesNotMatch(packed, /A123456789/i);
  assert.doesNotMatch(packed, new RegExp(SECRET_UUID, "i"));
  assert.equal(packed.includes("phone_e164"), false);
  assert.equal(packed.includes("number_masked"), false);
  assert.equal(packed.includes(rowId), false);
});

test("the page query is a keyset seek and does not read snapshots", () => {
  const open = auditPageQuery({
    orgId: "10000000-0000-4000-8000-000000000001",
    actorId: null,
    action: null,
    eventType: null,
    tableName: null,
    rowId: null,
    from: null,
    to: null,
    cursor: null,
    limit: 500,
  });
  assert.match(open.sql, /ORDER BY a\.occurred_at DESC, a\.id DESC/);
  assert.match(open.sql, /LIMIT \$2/);
  assert.equal(open.params.at(-1), AUDIT_PAGE_SIZE + 1);
  assert.doesNotMatch(open.sql, /OFFSET/i);
  assert.match(open.sql, /a\.old_row -> col/);
  assert.match(open.sql, /a\.new_row -> col/);
  assert.match(open.sql, /unnest\(COALESCE\(a\.changed_cols/);
  assert.match(open.sql, /AS field_changes/);
  assert.equal(open.sql.includes("a.old_row,"), false);
  assert.equal(open.sql.includes("a.new_row,"), false);
  assert.equal(open.sql.includes("actor_user_id ="), false);

  const narrowed = auditPageQuery({
    orgId: "10000000-0000-4000-8000-000000000001",
    actorId: "20000000-0000-4000-8000-000000000001",
    action: "update",
    eventType: null,
    tableName: "leases",
    rowId: "10000000-0000-4000-8000-0000000000bb",
    from: "2026-10-20T16:00:00.000Z",
    to: "2026-10-21T16:00:00.000Z",
    cursor: { at: "2026-10-21T01:02:03.123456Z", id: "42" },
    limit: 9,
  });
  assert.match(narrowed.sql, /a\.actor_user_id = \$2::uuid/);
  assert.match(narrowed.sql, /a\.action = \$3::audit_action/);
  assert.match(narrowed.sql, /a\.table_name = \$4/);
  assert.match(narrowed.sql, /a\.row_id = \$5/);
  assert.match(narrowed.sql, /\(a\.occurred_at, a\.id\) < \(\$8::timestamptz, \$9::bigint\)/);
  assert.equal(narrowed.params.at(-1), 9);
  assert.equal(narrowed.sql.includes("drop table"), false);
  assert.equal(JSON.stringify(narrowed.params).includes("old_row"), false);
});

test("a changed rent shows major units, and phone or hash values stay off the page", () => {
  assert.deepEqual(
    auditChanges([
      { column: "rent_amount_minor", before: 120000, after: 150000 },
      { column: "phone_e164", before: null, after: "+886912345678" },
      { column: "number_hash", before: null, after: "hash-secret" },
      { column: "updated_at", before: "old", after: "new" },
    ]),
    [{ fieldKey: "i_audit_f_rent", before: "1200", after: "1500" }],
  );
  const rowId = "10000000-0000-4000-8000-0000000000bb";
  const view = presentAudit(
    {
      id: "9",
      occurred_key: "2026-10-20T16:30:00.000000Z",
      occurred_at: "2026-10-20T16:30:00.000Z",
      actor_name: "林雅婷",
      has_actor: true,
      table_name: "leases",
      row_id: rowId,
      action: "update",
      event_type: null,
      changed_cols: ["rent_amount_minor", "phone_e164", "number_hash"],
      field_changes: [
        { column: "rent_amount_minor", before: 120000, after: 150000 },
        { column: "phone_e164", before: null, after: "+886912345678" },
        { column: "number_hash", before: null, after: "hash-secret" },
      ],
      reason: "屋主同意調租",
    },
    { text: "王小美 信義松仁 3F" },
  );
  assert.deepEqual(view.changes, [{ fieldKey: "i_audit_f_rent", before: "1200", after: "1500" }]);
  assert.equal(view.fields.includes("i_audit_f_rent"), false);
  assert.equal(view.masked, true);
  const packed = JSON.stringify(view);
  assert.doesNotMatch(packed, /\+886912345678/);
  assert.equal(packed.includes("hash-secret"), false);
  assert.equal(packed.includes("phone_e164"), false);
  assert.equal(packed.includes("number_hash"), false);
});

test("the screen and its record names are one statement each", () => {
  const orgId = "10000000-0000-4000-8000-000000000001";
  const rowId = "10000000-0000-4000-8000-0000000000bb";
  const screen = auditScreenQuery({
    orgId,
    actorId: null,
    action: null,
    eventType: null,
    tableName: null,
    rowId: null,
    from: null,
    to: null,
    cursor: null,
    limit: AUDIT_PAGE_SIZE + 1,
  });
  assert.equal(screen.sql.includes(";"), false);
  assert.match(screen.sql, /FROM audit_log a/);
  assert.match(screen.sql, /FROM org_members m/);
  assert.doesNotMatch(screen.sql, /OFFSET/i);
  const tables = ["leases", "contacts", "properties", "payments", "maintenance_tickets", "org_members"];
  const lookup = recordLookupQuery(orgId, new Map(tables.map((table) => [table, [rowId]])));
  assert.ok(lookup);
  assert.equal(lookup.sql.includes(";"), false);
  assert.equal(lookup.sql.split("UNION ALL").length, tables.length);
  assert.equal(lookup.params.length, 1 + tables.length);
  assert.equal(recordLookupQuery(orgId, new Map()), null);
});
