import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ownerRepliesCopy, staffOwnerCopy } from "../i18n/owner-replies-messages";
import { ownerText, postOwnerMessage, replyOwnerLifecycle } from "./owner-replies-messages";
import type { Session } from "./types";

const ORG = "10000000-0000-4000-8000-000000000001";
const ID = "30000000-0000-4000-8000-000000000001";

test("ownerText trims and bounds text (1..2000), rejects non-strings", () => {
  assert.equal(ownerText("  hello \n"), "hello");
  assert.equal(ownerText("x".repeat(2000)), "x".repeat(2000));
  for (const bad of ["", "   ", "x".repeat(2001), null, undefined, 3, {}, ["a"]]) assert.equal(ownerText(bad), null, JSON.stringify(bad));
});

test("non-owner or malformed inputs are unavailable before any database call", async () => {
  const owner: Session = { userId: ORG, sessionId: ID, orgId: ORG, liveOrgId: ORG, environment: "live", kind: "owner", role: null,
    email: "x@example.invalid", name: "x", locale: "en", calendar: "gregorian", leaseId: null };
  for (const s of [{ ...owner, kind: "staff" as const }, { ...owner, kind: "tenant" as const }, { ...owner, sessionId: "nope" }, { ...owner, needsSandbox: true }]) {
    assert.deepEqual(await replyOwnerLifecycle(s, { recordId: ID, noticeVersion: 1, requestId: ID, body: "x" }), { state: "unavailable" });
    assert.deepEqual(await postOwnerMessage(s, { propertyId: ID, requestId: ID, body: "x" }), { state: "unavailable" });
  }
  assert.deepEqual(await replyOwnerLifecycle(owner, { recordId: "bad", noticeVersion: 1, requestId: ID, body: "x" }), { state: "unavailable" });
  assert.deepEqual(await postOwnerMessage(owner, { propertyId: ID, requestId: "bad", body: "x" }), { state: "unavailable" });
});

test("copy: 屋主 wording, replies never imply consent/approval, both locales have the same keys", () => {
  const zh = ownerRepliesCopy("zh-TW"), en = ownerRepliesCopy("en");
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(zh.kind).sort(), Object.keys(en.kind).sort());
  assert.deepEqual(Object.keys(zh.filedBy).sort(), Object.keys(en.filedBy).sort());
  const flat = (o: Record<string, unknown>) => JSON.stringify(Object.values(o).map(v => typeof v === "function" ? (v as (...a: unknown[]) => string)("x", "y") : v));
  const text = flat(zh);
  for (const banned of ["房東", "房客", "收款", "收租", "代收", "入帳", "已收", "統一編號", "保證"]) assert.ok(!text.includes(banned), banned);
  assert.match(zh.lifecycleIntro, /屋主回覆/);
  assert.match(zh.lifecycleIntro, /不代表您同意、確認、核准或簽署/);
  assert.match(en.lifecycleIntro, /never means you agree to, confirm, approve or sign/);
  assert.match(zh.repliesNote, /不會被您的回覆取代或合併/);
  const szh = staffOwnerCopy("zh-TW"), sen = staffOwnerCopy("en");
  assert.deepEqual(Object.keys(szh).sort(), Object.keys(sen).sort());
  const staffText = flat(szh);
  for (const banned of ["房東", "房客", "收款", "收租", "代收", "入帳", "已收", "統一編號", "保證"]) assert.ok(!staffText.includes(banned), banned);
  assert.match(szh.repliesNote, /不代表同意、確認或核准/);
  assert.equal(zh.edited, "已編輯"); assert.equal(en.edited, "Edited");
});

test("migration: additive, RLS on new tables, revokes on every function, grants only gateways to authenticated", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261107113000_b023_owner_replies_messages.sql", import.meta.url), "utf8");
  for (const t of ["b023_owner_lifecycle_replies", "b023_owner_threads", "b023_owner_message_requests"]) {
    assert.match(sql, new RegExp(`ALTER TABLE app\\.${t} ENABLE ROW LEVEL SECURITY`), t);
    assert.match(sql, new RegExp(`app\\.${t}[\\s\\S]*FROM PUBLIC, anon, authenticated, service_role`), t);
  }
  const functions = [...sql.matchAll(/CREATE FUNCTION (app\.[a-z0-9_]+)\(/g)].map(m => m[1]);
  for (const fn of functions) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${fn.replace(".", "\\.")}\\([^)]*\\) FROM PUBLIC, anon, authenticated, service_role;`), fn);
  }
  const definers = sql.match(/SECURITY DEFINER SET search_path = [^ ]+ [^ ]+ [^ ]+ [^ ]+ AS/g) ?? [];
  assert.equal(definers.length, functions.length);
  for (const d of definers) assert.match(d, /search_path = pg_catalog, public, app, pg_temp AS/);
  const granted = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION (app\.[a-z0-9_]+)\([^)]*\) TO ([a-z_, ]+);/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(granted.map(g => g[0]).sort(), ["app.b023_owner_lifecycle_detail", "app.b023_owner_lifecycle_items", "app.b023_owner_message_threads",
    "app.b023_owner_thread_messages", "app.b023_post_owner_message", "app.b023_reply_owner_lifecycle",
    "app.b023_staff_owner_lifecycle_replies", "app.b023_staff_owner_threads"]);
  for (const [, to] of granted) assert.equal(to.trim(), "authenticated");
  // Only additive DDL: one new enum value; no change to existing tables, policies, functions or the slice-1 setting.
  assert.match(sql, /ALTER TYPE public\.thread_kind ADD VALUE IF NOT EXISTS 'owner_company';/);
  assert.doesNotMatch(sql, /ALTER TABLE public\.|DROP |CREATE OR REPLACE|CREATE POLICY|ALTER POLICY|GRANT [A-Z, ]+ ON (TABLE )?(public|app)\.|INSERT INTO public\.platform_settings/);
  const code = sql.split("\n").filter(line => !line.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /b012_response_versions/, "never touches B-012 responses");
  assert.doesNotMatch(code, /thread_participants/, "owners are never added as thread participants");
  void ORG;
});
