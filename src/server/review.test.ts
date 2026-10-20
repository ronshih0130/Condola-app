import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backupDisplay } from "./backup";
import { PERMS } from "./perms";
import { formatTaipei } from "./time";

const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;

const SPEC_LABELS = [
  "View dashboard (money totals)",
  "View properties, rooms, tenants, leases",
  "Add/edit properties, import",
  "Create/renew/end leases, send for signing",
  "See tenant phone",
  "Record/confirm/return payments, add charges",
  "Reverse/correct ledger entries",
  "Bank reconciliation",
  "View rent roll and statements",
  "Generate/reissue statements",
  "Add expenses (form + receipt)",
  "Month-close",
  "Update repair tickets",
  "Message tenants",
  "Export reports (CSV)",
  "Team: invite, roles, deactivate",
  "Rules, notifications, owner privacy",
  "Export all data",
];

const ERROR_KEYS = [
  "i_forbidden",
  "i_required",
  "i_generic",
  "i_not_found",
  "i_email_taken",
  "i_reset_expired",
  "i_auth_invalid",
  "i_auth_locked",
  "i_auth_disabled",
  "i_pw_mismatch",
  "i_pw_weak",
  "i_mfa_required_err",
  "i_invite_used",
  "i_invite_revoked",
  "i_invite_expired",
  "i_invite_invalid",
  "i_last_admin",
  "i_own_role",
  "i_confirm_needed",
];

test("sign-in times render in Asia/Taipei", () => {
  assert.equal(formatTaipei("2026-10-20T00:30:00Z"), "2026-10-20 08:30");
  assert.equal(formatTaipei(new Date("2026-10-20T16:00:00Z")), "2026-10-21 00:00");
  assert.equal(formatTaipei("not-a-date"), "");
});

test("showing backup codes asks the caller to clear the cookie", () => {
  const shown = backupDisplay("ABCD EFGH");
  assert.deepEqual(shown.codes, ["ABCD", "EFGH"]);
  assert.equal(shown.clearCookie, true);
  assert.deepEqual(backupDisplay(undefined).codes, []);
  assert.equal(backupDisplay("").clearCookie, true);
});

test("permission labels match the design spec wording", () => {
  assert.deepEqual(
    PERMS.map(([, label]) => en[label]),
    SPEC_LABELS,
  );
  for (const [, label] of PERMS) assert.ok(zh[label] && zh[label] !== en[label]);
});

test("error messages include a next step", () => {
  for (const key of ERROR_KEYS) {
    assert.match(en[key], /Please /);
    assert.match(zh[key], /請/);
  }
});
