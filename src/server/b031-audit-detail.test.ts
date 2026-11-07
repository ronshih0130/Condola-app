import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuditDetailBlock, AuditRows } from "@/components/audit-log";
import { makeT } from "@/i18n";
import { detailMoney, foldWidth, maskDetailText, presentDetail, type AuditView } from "./audit-read";
import { KEPT_PROBES, SENSITIVE_PROBES } from "./b031-audit-detail-fixture";

(globalThis as { React?: unknown }).React = React;

const raw = (changes: unknown, reason: string | null = null, withheld = 0) => ({ audit_id: "1", reason, changes, withheld });

test("only allowlisted fields with their expected kind are shown; the rest count as withheld", () => {
  const view = presentDetail(raw([
    { f: "rent_amount_minor", k: "money", b: "3000000", a: "3300000", c: "TWD" },
    { f: "legal_name", k: "text", b: "秘密", a: "秘密二" },
    { f: "session_token", k: "text", b: "a", a: "b" },
    { f: "role", k: "money", b: "1", a: "2" },
    { f: "role", k: "code", b: "manager", a: "admin" },
  ], null, 2), "zh-TW");
  assert.ok(view);
  assert.deepEqual(view.changes, [
    { fieldKey: "i_audit_f_rent", before: { text: "NT$30,000" }, after: { text: "NT$33,000" } },
    { fieldKey: "i_audit_f_role", before: { key: "i_role_manager" }, after: { key: "i_role_admin" } },
  ]);
  assert.equal(view.withheld, 5);
  assert.equal(JSON.stringify(view).includes("秘密"), false);
  assert.equal(presentDetail(raw([{ f: "notes", k: "text", b: "a", a: "b" }]), "zh-TW"), null);
  assert.equal(presentDetail(raw("not json"), "zh-TW"), null);
});

test("read side re-masks: unmasked phone/email, IDs, UUIDs and emails inside text never pass through", () => {
  const view = presentDetail(raw([
    { f: "phone_e164", k: "phone", b: "+886912345678", a: "+886*******78" },
    { f: "email", k: "email", b: "someone@example.test", a: "s***@example.test" },
    { f: "display_name", k: "text", b: "王 A123456789 bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", a: "x@example.test" },
    { f: "end_date", k: "date", b: "2027-01-01", a: "not-a-date" },
    { f: "status", k: "code", b: "Active; DROP", a: "terminated" },
    { f: "is_owner", k: "bool", b: "false", a: "true" },
  ], "更正 A123456789 0912-345-678"), "zh-TW");
  assert.ok(view);
  const packed = JSON.stringify(view);
  for (const secret of ["+886912345678", "someone@example.test", "A123456789", "bbbbbbbb-bbbb", "x@example.test", "0912-345-678", "DROP"]) {
    assert.equal(packed.includes(secret), false, secret);
  }
  assert.deepEqual(view.changes[0].after, { text: "+886*******78" });
  assert.deepEqual(view.changes[1].after, { text: "s***@example.test" });
  assert.deepEqual(view.changes[3].after, { text: "••••••••••" });
  assert.deepEqual(view.changes[4].after, { key: "i_st_terminated" });
  assert.deepEqual(view.changes[5], { fieldKey: "i_audit_d_is_owner", before: { key: "i_audit_v_no" }, after: { key: "i_audit_v_yes" } });
  assert.match(view.reason, /^更正 /);
});

test("money is exact BigInt minor units, never a float", () => {
  assert.equal(detailMoney("900719925474099301", "TWD", "zh-TW"), "NT$9,007,199,254,740,993.01");
  assert.equal(detailMoney("-3300000", "TWD", "en"), "-NT$33,000");
  assert.equal(detailMoney("0", "TWD", "en"), "NT$0");
  assert.equal(detailMoney("12345", "USD", "en"), "USD 123.45");
  assert.equal(detailMoney("1.5", "TWD", "en"), "••••••••••");
  assert.equal(detailMoney("99999999999999999999", "TWD", "en"), "••••••••••");
});

test("viewer renders reason and before → after in both locales; rows without detail render no detail block", () => {
  const detail = presentDetail(raw([
    { f: "start_date", k: "date", b: null, a: "2027-01-01" },
    { f: "role", k: "code", b: "accountant", a: "manager" },
  ], "屋主同意", 1), "zh-TW");
  assert.ok(detail);
  const zh = renderToStaticMarkup(React.createElement(AuditDetailBlock, { detail, t: makeT("zh-TW") }));
  assert.match(zh, /變更明細/);
  assert.match(zh, /原因：屋主同意/);
  assert.match(zh, /起始日：（空白） → 2027-01-01/);
  assert.match(zh, /角色：會計 → 經理/);
  assert.match(zh, /另有 1 個欄位因隱私不顯示/);
  const en = renderToStaticMarkup(React.createElement(AuditDetailBlock, { detail: { ...detail, reason: "" }, t: makeT("en") }));
  assert.match(en, /Change detail/);
  assert.match(en, /No reason recorded/);
  assert.match(en, /Role: Accountant → Manager/);

  const entry: AuditView = {
    cursor: "c", who: "A", whoKey: null, actionKey: "i_audit_act_update", fields: [], other: false, masked: false, reason: "",
    recordKey: "i_audit_rec_lease", recordText: "", href: null, found: true, when: "2026-11-06 10:00",
  };
  const off = renderToStaticMarkup(React.createElement(AuditRows, { entries: [entry], t: makeT("zh-TW"), testId: "audit-list" }));
  assert.equal(off.includes("audit-detail"), false);
  const on = renderToStaticMarkup(React.createElement(AuditRows, { entries: [{ ...entry, detail }], t: makeT("zh-TW"), testId: "audit-list" }));
  assert.match(on, /data-testid="audit-detail"/);
});

test("migration is additive, default OFF, private, and pins search_path on every SECURITY DEFINER function", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261107130000_b031_audit_detail.sql", import.meta.url), "utf8");
  assert.match(sql, /VALUES \('audit_detail', '\{"enabled":false,"allowed_org_ids":\[\]\}'::jsonb\)\s+ON CONFLICT \(key\) DO NOTHING/);
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE FROM|ALTER TABLE public\.|UPDATE public\.)/i);
  assert.match(sql, /REVOKE ALL ON app\.b031_audit_details FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.b031_audit_detail_rows\(uuid, bigint\[\]\) TO authenticated;\s*$/);
  assert.equal((sql.match(/GRANT /g) ?? []).length, 1, "single grant");
  const definers = sql.match(/SECURITY DEFINER[^\n]*/g) ?? [];
  assert.equal(definers.length, 3);
  for (const line of definers) assert.match(line, /SET search_path = pg_catalog, pg_temp AS \$\$/);
  assert.match(sql, /app\.has_role\(p_org, '\{admin\}'::public\.org_role\[\]\)/);
  for (const word of ["房東", "收款", "收租", "入帳", "已收", "統一編號"]) assert.equal(sql.includes(word), false, word);

  const flags = readFileSync(new URL("../../ops/flags.yaml", import.meta.url), "utf8");
  const block = flags.slice(flags.indexOf("  audit_detail:")).split("\n").slice(1, 8).map((line) => line.trim().split(":")[0]);
  assert.deepEqual(block, ["owner", "expires_at", "default", "ring", "global_kill", "org_override", "activation"]);
  assert.match(flags, /audit_detail:\n {4}owner: Ron\n[\s\S]*?default: false/);
});

// Fix round 1 (independent review M1/M2): reviewer probes as regressions.
test("detail masking covers spaced, dashed, parenthesised and full-width Taiwan formats", () => {
  for (const probe of SENSITIVE_PROBES) {
    for (const text of [probe, `備註 ${probe} 結束`]) {
      const result = maskDetailText(text);
      assert.equal(result.masked, true, text);
      assert.doesNotMatch(result.text, /[0-9０-９]{2}/, `${text} -> ${result.text}`);
      assert.equal(result.text.includes("gmail"), false, text);
    }
  }
});

test("reason codes, ordinary words and short numbers are never masked as tokens", () => {
  for (const probe of KEPT_PROBES) assert.deepEqual(maskDetailText(probe), { text: probe, masked: false }, probe);
  assert.equal(foldWidth("陳先生（屋主）Ａ１＠"), "陳先生（屋主）A1@");
});

test("reviewer present.ts probe: no raw value survives presentDetail", () => {
  const view = presentDetail({
    audit_id: "1",
    reason: "退押金至 822-12-345678-9 或 (02) 2345-6789 身分證 Ａ１２３４５６７８９ A 123 456 789 卡 4111 1111 1111 1111",
    changes: [
      { f: "termination_reason", k: "text", b: null, a: "帳戶 822-12-345678-9 ０９１２３４５６７８" },
      { f: "label", k: "text", b: "3F", a: "3F (02) 2345-6789" },
      { f: "address_display", k: "text", b: null, a: "台北市 Ａ１２３４５６７８９" },
      { f: "email", k: "email", b: "w***@gmail.com", a: "w***@A123456789.tw" },
      { f: "phone_e164", k: "phone", b: "+886*******78", a: "0912345678" },
      { f: "rent_amount_minor", k: "money", b: "3000000", a: "3100000", c: "USD" },
    ],
    withheld: 2,
  }, "zh-TW");
  assert.ok(view);
  const packed = JSON.stringify(view);
  for (const raw of ["822-12", "2345-6789", "１２３", "123 456", "4111", "A123456789", "0912345678", "０９１２"]) {
    assert.equal(packed.includes(raw), false, raw);
  }
  assert.match(view.reason, /^退押金至 /);
  assert.deepEqual(view.changes[0].after, { text: "帳戶 ••••••••••" });
  assert.deepEqual(view.changes[1].after, { text: "3F ••••••••••" });
  assert.deepEqual(view.changes[3], { fieldKey: "i_audit_d_email", before: { text: "w***@gmail.com" }, after: { text: "••••••••••" } });
  assert.deepEqual(view.changes[4].after, { text: "••••••••••" });
});

test("detail value labels say the same thing in both locales", () => {
  const zh = makeT("zh-TW");
  const en = makeT("en");
  assert.equal(zh("i_audit_d_base_rent"), zh("i_base_rent"));
  assert.equal(en("i_audit_d_base_rent"), en("i_base_rent"));
  assert.equal(zh("i_audit_v_none"), "尚無續約動作");
  assert.equal(en("i_audit_v_none"), "No renewal activity");
});
