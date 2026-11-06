import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ownerPortalCopy } from "../i18n/owner-portal-access";
import { ownerPortalFlagValue } from "./owner-portal-access";
import { ownerDocumentHttp } from "./owner-portal-access-http";

const ORG = "10000000-0000-4000-8000-000000000001";
const DOC = "30000000-0000-4000-8000-000000000001";

test("owner_portal_extensions is strict: global object, boolean true, allowlist array and org boolean true", () => {
  const on = { enabled: true, allowed_org_ids: [ORG] }, org = { owner_portal_extensions: true };
  assert.equal(ownerPortalFlagValue(on, org, ORG), true);
  assert.equal(ownerPortalFlagValue(on, org, ORG.toUpperCase()), true);
  for (const global of [null, undefined, "true", [], { enabled: false, allowed_org_ids: [ORG] }, { enabled: "true", allowed_org_ids: [ORG] },
    { enabled: true, allowed_org_ids: ORG }, { enabled: true, allowed_org_ids: [] }, { enabled: true }]) {
    assert.equal(ownerPortalFlagValue(global, org, ORG), false, JSON.stringify(global));
  }
  for (const flags of [null, [], {}, { owner_portal_extensions: false }, { owner_portal_extensions: "true" }, { OWNER_PORTAL_EXTENSIONS: true }]) {
    assert.equal(ownerPortalFlagValue(on, flags, ORG), false, JSON.stringify(flags));
  }
});

test("document HTTP: invalid id or null open is 404 without calling a second time; view is inline", async () => {
  let calls = 0;
  const none = async () => { calls += 1; return null; };
  assert.equal((await ownerDocumentHttp({ documentId: "not-a-uuid", url: "http://localhost/o/files/x", open: none, logError: () => {} })).status, 404);
  assert.equal(calls, 0);
  assert.equal((await ownerDocumentHttp({ documentId: DOC, url: "http://localhost/o/files/x", open: none, logError: () => {} })).status, 404);
  assert.equal(calls, 1);
  const kinds: string[] = [];
  const file = async (kind: "view" | "download") => { kinds.push(kind); return { content: new Uint8Array([37, 80, 68, 70, 45]), file_name: "signed-lease-x.pdf", size_bytes: 5 }; };
  const view = await ownerDocumentHttp({ documentId: DOC, url: "http://localhost/o/files/x?view=1", open: file, logError: () => {} });
  assert.match(view.headers.get("Content-Disposition") ?? "", /^inline;/);
  const dl = await ownerDocumentHttp({ documentId: DOC, url: "http://localhost/o/files/x?view=0", open: file, logError: () => {} });
  assert.match(dl.headers.get("Content-Disposition") ?? "", /^attachment;/);
  assert.equal(dl.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(kinds, ["view", "download"]);
  const failing = await ownerDocumentHttp({ documentId: DOC, url: "http://localhost/o/files/x", open: async () => { throw new Error("db"); }, logError: () => {} });
  assert.equal(failing.status, 503);
});

test("copy: 屋主 wording, no consent language implied by views, both locales have the same keys", () => {
  const zh = ownerPortalCopy("zh-TW"), en = ownerPortalCopy("en");
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const text = JSON.stringify(Object.values(zh).map(v => typeof v === "function" ? (v as (...a: unknown[]) => string)("x", "y") : v));
  for (const banned of ["房東", "收款", "收租", "入帳", "已收", "統一編號"]) assert.ok(!text.includes(banned), banned);
  assert.match(zh.filesIntro, /不代表您同意、確認或簽署/);
  assert.match(en.filesIntro, /never means you agree to, confirm or sign/);
});

test("migration: RLS on, revokes on every function, grants only to authenticated on public gateways", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261107110000_b023_owner_portal_access.sql", import.meta.url), "utf8");
  assert.match(sql, /ALTER TABLE app\.b023_owner_document_access_events ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /'owner_portal_extensions','\{"enabled":false,"allowed_org_ids":\[\]\}'/);
  const functions = [...sql.matchAll(/CREATE FUNCTION (app\.[a-z0-9_]+)\(/g)].map(m => m[1]);
  for (const fn of functions) assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${fn.replace(".", "\\.")}\\(`), fn);
  const granted = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION (app\.[a-z0-9_]+)\([^)]*\) TO ([a-z_, ]+);/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(granted.map(g => g[0]).sort(), ["app.b023_open_owner_document", "app.b023_owner_documents", "app.b023_owner_repair_detail", "app.b023_owner_repairs"]);
  for (const [, to] of granted) assert.equal(to.trim(), "authenticated");
  assert.doesNotMatch(sql, /ALTER TABLE public\.|DROP |CREATE OR REPLACE|GRANT [A-Z, ]+ ON (TABLE )?(public|app)\./);
});
