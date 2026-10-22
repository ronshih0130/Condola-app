import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { issueUploadGrant, issueVendorUploadGrant, uploadGrantMatches, vendorUploadGrantMatches } from "./ticket-photos";
import {
  cleanContactWindow,
  displayVendorPhone,
  hashVendorToken,
  newVendorToken,
  vendorCompletedOn,
  vendorCostMinor,
  vendorDispatchEnabled,
  vendorJobPath,
  vendorLinkOpen,
  vendorName,
  vendorPhone,
  vendorTokenAcceptable,
} from "./vendor-repair-rules";
import { FlowError } from "./errors";

const BANNED = ["入帳", "收租", "收款", "欠租", "已收", "代收", "示範", "測試模式", "沙盒", "房東"];

test("vendor dispatch is on for the sample company and beta firms, and off otherwise", () => {
  assert.equal(vendorDispatchEnabled({ environment: "sandbox", planTier: "free", featureFlags: {} }), true);
  assert.equal(vendorDispatchEnabled({ environment: "live", planTier: "beta", featureFlags: {} }), true);
  assert.equal(vendorDispatchEnabled({ environment: "live", planTier: "free", featureFlags: {} }), false);
  assert.equal(vendorDispatchEnabled({ environment: "live", planTier: "pro", featureFlags: { vendor_dispatch: true } }), false);
  assert.equal(vendorDispatchEnabled({ environment: "sandbox", planTier: "free", featureFlags: { vendor_dispatch: false } }), false);
  assert.equal(vendorDispatchEnabled({ environment: "live", planTier: "beta", featureFlags: { vendor_dispatch: "false" } }), false);
});

test("vendor links are one token, and closed links fail closed", () => {
  const token = newVendorToken();
  assert.equal(vendorTokenAcceptable(token), true);
  assert.equal(vendorTokenAcceptable("short"), false);
  assert.equal(vendorTokenAcceptable(`${token}&next=/m`), false);
  assert.equal(hashVendorToken(token), hashVendorToken(` ${token} `));
  assert.equal(hashVendorToken(token).length, 64);
  assert.equal(vendorJobPath(token), `/v/${token}`);
  const now = new Date("2026-10-22T00:00:00Z");
  const later = new Date("2026-11-05T00:00:00Z");
  const open = { active: true, revoked: false, expiresAt: later, now, enabled: true };
  assert.equal(vendorLinkOpen(open), true);
  assert.equal(vendorLinkOpen({ ...open, revoked: true }), false);
  assert.equal(vendorLinkOpen({ ...open, active: false }), false);
  assert.equal(vendorLinkOpen({ ...open, enabled: false }), false);
  assert.equal(vendorLinkOpen({ ...open, expiresAt: now }), false);
  assert.equal(vendorCompletedOn("2026-11-01", "2026-10-22"), "2026-11-01");
  assert.equal(vendorCompletedOn("2026-10-01", "2026-10-22"), "2026-10-22");
  assert.equal(vendorCompletedOn(null, "2026-10-22"), "2026-10-22");
});

test("vendor name, phone, window, and cost use the existing field rules", () => {
  assert.equal(vendorName("  陳水電  "), "陳水電");
  assert.equal(vendorPhone("0912000111", "+886"), "+886912000111");
  assert.equal(displayVendorPhone("+886912000111"), "0912000111");
  assert.equal(displayVendorPhone("+14155550123"), "+14155550123");
  assert.equal(cleanContactWindow("  週三   14:00-17:00 "), "週三 14:00-17:00");
  assert.equal(vendorCostMinor("2400"), 240000);
  assert.throws(() => vendorPhone("123", "+886"), (error: unknown) => error instanceof FlowError && error.key === "errors.phone");
  assert.throws(() => vendorCostMinor("0"), (error: unknown) => error instanceof FlowError && error.key === "errors.expenseAmount");
  assert.throws(() => cleanContactWindow("  "), (error: unknown) => error instanceof FlowError && error.key === "errors.required");
});

test("a vendor upload grant only matches that link", () => {
  const previous = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-key";
  try {
    const ticket = "30000000-0000-4000-8000-000000000002";
    const path = "org/10000000-0000-4000-8000-000000000001/tickets/30000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000003.jpg";
    const grant = issueVendorUploadGrant("abc", ticket, path);
    assert.equal(vendorUploadGrantMatches("abc", ticket, path, grant), true);
    assert.equal(vendorUploadGrantMatches("abd", ticket, path, grant), false);
    assert.equal(uploadGrantMatches("abc", ticket, path, grant), false);
    const staff = issueUploadGrant("abc", ticket, path);
    assert.notEqual(staff, grant);
    assert.equal(vendorUploadGrantMatches("abc", ticket, path, staff), false);
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previous;
  }
});

test("the vendor page reuses the repair photo upload and the migration only adds", () => {
  const page = readFileSync(new URL("../app/v/[token]/page.tsx", import.meta.url), "utf8");
  const upload = readFileSync(new URL("../components/ticket-photos.tsx", import.meta.url), "utf8");
  const sql = readFileSync(new URL("../../supabase/migrations/20261029120000_vendor_repair.sql", import.meta.url), "utf8");
  assert.match(page, /TicketPhotoUpload/);
  assert.match(page, /\/api\/vendor-jobs\/photos\/sign/);
  assert.match(page, /\/api\/vendor-jobs\/photos\/confirm/);
  assert.match(upload, /\/api\/tickets\/photos\/sign/);
  assert.match(upload, /body: file/);
  assert.doesNotMatch(page, /createImageBitmap|sharp|sendLine|sendMail/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS vendor_job_id uuid/);
  assert.match(sql, /app\.open_vendor_job/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /ALTER TABLE maintenance_tickets/);
  assert.doesNotMatch(sql, /SET NOT NULL/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app\.open_vendor_job\(text\) FROM anon, authenticated/);
});

test("new vendor copy is in both catalogs and skips the banned words", () => {
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
  const keys = [
    "i_vendor_dispatch",
    "i_vendor_name",
    "i_vendor_phone",
    "i_vendor_window",
    "i_vendor_window_hint",
    "i_vendor_dispatch_send",
    "i_vendor_link",
    "i_vendor_link_hint",
    "i_vendor_copy",
    "i_vendor_copied",
    "i_vendor_revoke",
    "i_vendor_status_open",
    "i_vendor_status_revoked",
    "i_vendor_status_expired",
    "i_vendor_reported",
    "i_vendor_confirm",
    "i_vendor_confirmed",
    "i_vendor_page_title",
    "i_vendor_address",
    "i_vendor_issue",
    "i_vendor_done",
    "i_vendor_cost",
    "i_vendor_submit",
    "i_vendor_sent",
    "i_vendor_job_closed",
    "i_vendor_photos",
    "i_vendor_done_photos",
    "i_audit_ev_repair_dispatch",
    "i_audit_ev_repair_dispatch_revoke",
    "i_audit_ev_repair_vendor_report",
    "i_audit_ev_repair_cost_confirm",
  ];
  for (const key of keys) {
    assert.equal(typeof zh[key], "string", key);
    assert.equal(typeof en[key], "string", key);
    assert.equal(zh[key].includes("房東"), false, key);
    for (const word of BANNED) assert.equal(zh[key].includes(word), false, `${key} ${word}`);
  }
  assert.match(zh.i_vendor_confirm, /屋主/);
  assert.match(zh.i_vendor_sent, /屋主/);
});
