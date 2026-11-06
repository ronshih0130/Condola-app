import assert from "node:assert/strict";
import test from "node:test";
import { notificationEventCopy } from "@/i18n/lanes/notification-events";
import { repairApprovalCopy } from "@/i18n/repair-approval";
import { renderNotificationMessage, type NotificationKind } from "./notification-event-producers";

const FORBIDDEN = ["房東", "收款", "收租", "入帳", "已收", "統一編號"];
const cases: Array<[NotificationKind, Record<string, unknown>, "staff" | "tenant" | "owner"]> = [
  ["invite_issued", { invite_kind: "tenant", expires_on: "2026-11-14" }, "tenant"],
  ["invite_issued", { invite_kind: "owner", expires_on: "2026-11-14" }, "owner"],
  ["rent_due", { due_date: "2026-11-03", balance_minor: "2800000", currency: "TWD" }, "tenant"],
  ["rent_overdue", { due_date: "2026-11-03", balance_minor: "2800000", currency: "TWD" }, "staff"],
  ["rent_manual", { due_date: "2026-11-03", balance_minor: "2800000", currency: "TWD" }, "tenant"],
  ["payment_confirmed", { amount_minor: "100", currency: "TWD" }, "tenant"],
  ["payment_rejected", { amount_minor: "100", currency: "TWD" }, "tenant"],
  ["payment_reversed", { amount_minor: "100", currency: "TWD" }, "tenant"],
  ["handover_published", { phase: "move_out", revision: 2 }, "tenant"],
  ["report_version_recorded", { version_no: 2, period_start: "2095-01-01", period_end: "2095-01-31" }, "owner"],
  ["repair_approval_requested", { version_no: 1, amount_minor: "600000", currency: "TWD" }, "owner"],
  ["repair_emergency_notice", { version_no: 1, category: "electricity" }, "owner"],
  ["repair_decision_recorded", { version_no: 2, decision: "more_information" }, "staff"],
];

test("repair labels in the notification lane are verbatim copies of the repair decision copy", () => {
  for (const locale of ["en", "zh-TW"] as const) {
    const existing = repairApprovalCopy(locale) as Record<string, string>;
    for (const [key, value] of Object.entries(notificationEventCopy(locale).repair)) assert.equal(value, existing[key], `${locale} ${key}`);
  }
});

test("every event kind renders EN and zh-TW text with no forbidden or delivery-claim wording", () => {
  for (const [kind, vars, persona] of cases) {
    for (const locale of ["en", "zh-TW"] as const) {
      const message = renderNotificationMessage({ kind, vars, locale, persona, recipientName: "Synthetic", firmName: "Synthetic firm" });
      assert.ok(message.subject.length > 0 && message.text.startsWith("Synthetic"), `${kind} ${locale}`);
      assert.ok(!/undefined|NaN|\{|\}/.test(message.text), `${kind} ${locale}: ${message.text}`);
      for (const word of FORBIDDEN) assert.ok(!`${message.subject}${message.text}`.includes(word), `${kind} ${locale} contains ${word}`);
      assert.ok(!/delivered|已送達/.test(message.text));
    }
  }
});
