import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ownerAccountCopy } from "../i18n/owner-account";
import {
  ownerAccountView, ownerDisplayName, revokeOwnerSession, saveOwnerProfile, setOwnerNotificationPreference,
} from "./owner-account";
import type { Session } from "./types";

const ORG = "10000000-0000-4000-8000-000000000001";
const ID = "30000000-0000-4000-8000-000000000001";
const owner: Session = { userId: ORG, sessionId: ID, orgId: ORG, liveOrgId: ORG, environment: "live", kind: "owner", role: null,
  email: "x@example.invalid", name: "x", locale: "en", calendar: "gregorian", leaseId: null };

test("ownerDisplayName trims, bounds 1..100 code points and rejects control characters", () => {
  assert.equal(ownerDisplayName("  陳屋主 "), "陳屋主");
  assert.equal(ownerDisplayName("x".repeat(100)), "x".repeat(100));
  assert.equal(ownerDisplayName("😀".repeat(100)), "😀".repeat(100), "astral characters count once (as in SQL length())");
  for (const bad of ["", "  ", "x".repeat(101), "a\u0000b", "a\nb", null, 3, {}]) assert.equal(ownerDisplayName(bad), null, JSON.stringify(bad));
});

test("non-owner or malformed inputs are null/unavailable before any database call", async () => {
  for (const s of [{ ...owner, kind: "staff" as const }, { ...owner, kind: "tenant" as const }, { ...owner, sessionId: "nope" }, { ...owner, needsSandbox: true }]) {
    assert.equal(await ownerAccountView(s), null);
    assert.deepEqual(await revokeOwnerSession(s, { targetSessionId: ID, requestId: ID }), { state: "unavailable" });
    assert.deepEqual(await saveOwnerProfile(s, { requestId: ID, displayName: "x", locale: "en", channel: null, version: "0".repeat(32) }), { state: "unavailable" });
    assert.deepEqual(await setOwnerNotificationPreference(s, { requestId: ID, category: "repair_updates", enabled: false }), { state: "unavailable" });
  }
  assert.deepEqual(await revokeOwnerSession(owner, { targetSessionId: "bad", requestId: ID }), { state: "unavailable" });
  assert.deepEqual(await saveOwnerProfile(owner, { requestId: "bad", displayName: "x", locale: "en", channel: null, version: "0".repeat(32) }), { state: "unavailable" });
  assert.deepEqual(await setOwnerNotificationPreference(owner, { requestId: "bad", category: "repair_updates", enabled: false }), { state: "unavailable" });
});

test("copy: 屋主 wording, no banned words, same keys in both locales, recent-auth and read-only notes", () => {
  const zh = ownerAccountCopy("zh-TW"), en = ownerAccountCopy("en");
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const k of ["categories", "channels", "languages"] as const) assert.deepEqual(Object.keys(zh[k]).sort(), Object.keys(en[k]).sort(), k);
  const flat = (o: Record<string, unknown>) => JSON.stringify(Object.values(o).map(v => typeof v === "function" ? (v as (...a: unknown[]) => string)("x") : v));
  for (const text of [flat(zh), flat(en)]) {
    for (const banned of ["房東", "房客", "收款", "收租", "代收", "入帳", "已收", "統一編號", "保證", "身分證"]) assert.ok(!text.includes(banned), banned);
  }
  assert.match(zh.title, /屋主/);
  assert.match(zh.reauthNote, /15 分鐘/);
  assert.match(en.reauthNote, /15 minutes/);
  assert.match(zh.profileNote, /電子郵件與手機號碼目前無法在這裡修改/);
  assert.match(zh.prefsNote, /預設全部開啟/);
  assert.match(zh.prefsNote, /通知寄送功能支援後套用/, "never promises opted-out sends stop today");
  assert.match(en.prefsNote, /will apply once notification delivery supports it/);
  assert.doesNotMatch(zh.prefsNote + en.prefsNote, /不再寄送|no longer sent/);
  assert.equal(zh.signOutDevice, "讓該裝置登出"); assert.equal(en.signOutDevice, "Sign out that device");
  assert.match(zh.sessionScope, /整個 Condola 登入/); assert.match(en.sessionScope, /whole Condola session/);
});

test("migration: additive, RLS on new tables, revokes on every function, grants only gateways to authenticated", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261107116000_b023_owner_account_preferences.sql", import.meta.url), "utf8");
  for (const t of ["b023_owner_session_revocations", "b023_owner_profile_revisions", "b023_owner_notification_preferences", "b023_owner_preference_requests"]) {
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
  assert.deepEqual(granted.map(g => g[0]).sort(), ["app.b023_owner_notification_settings", "app.b023_owner_profile", "app.b023_owner_sessions",
    "app.b023_revoke_owner_session", "app.b023_save_owner_profile", "app.b023_set_owner_notification_preference"]);
  for (const [, to] of granted) assert.equal(to.trim(), "authenticated");
  assert.doesNotMatch(sql, /ALTER TABLE public\.|ALTER TYPE|DROP |CREATE OR REPLACE|CREATE POLICY|ALTER POLICY|GRANT [A-Z, ]+ ON (TABLE )?(public|app)\.|INSERT INTO public\.platform_settings/);
  const code = sql.split("\n").filter(line => !line.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /id_number|tax_id|legal_name|bank_account/, "no ID, tax or bank fields");
  assert.doesNotMatch(code, /SET\s+(email|phone_e164)\s*=|,\s*(email|phone_e164)\s*=/, "email/phone are never written");
  assert.match(code, /interval '15 minutes'/, "recent-auth window");
});
