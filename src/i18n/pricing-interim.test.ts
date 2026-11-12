// FILE: src/i18n/pricing-interim.test.ts
//
// Condola B-045 — unit tests for the interim pricing / plan-application / usage copy.
// Stories: PLT-26 (plan & price copy), PLT-29 (application flow copy), PLT-30 (usage copy).
// Amendments C1 / C2 and spec §4 amendments folded in and enforced here:
//   - C1: no landlord/tenant terms ("房東"/"房客") and no payment-collection terms
//         ("收款"/"收租"); no "即將推出"; invoice wording stays receipts-only.
//   - C2: the activation clock starts at 確認入帳 (payment confirmed), never at submission
//         ("送出申請後 1 個工作天內" is forbidden); the design-partner term ("設計夥伴")
//         is confined to the design-partner FAQ pair.
//   - spec §4 amendments: prices are NT$39 / NT$59, not NT$30 / NT$40; billing is per-unit
//         in NT$ only (no USD / US$ / 席次 / 含稅 / 未稅); the free tier is "最多 5 戶"
//         counted from the 6th unit ("第 6 戶起", not "第 5 戶起" / "前 4 戶免費");
//         trials are 3 / 6 months (not 前 3 個月免費); no 專業 Pro; no 合作期間免費.
//
// Scope note: these tests only walk the approved static copy strings. They do NOT re-derive
// the interim billing math (that belongs to the pricing-math suite) and perform no I/O.

import test from "node:test";
import assert from "node:assert/strict";
import { pricingInterimCopy } from "./pricing-interim";

const LOCALES = ["zh-TW", "en"] as const;

// Functions in the copy object are called with the agreed sample args, keyed by field name.
const SAMPLE_ARGS: Record<string, unknown[]> = {
  calc_result_std: [8, "117", "1,287"],
  calc_result_pre: [8, "177", "1,947"],
  units_free: [3],
  units_paid: [12],
};

function walkStrings(value: unknown, key: string, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value === "function") {
    const args = SAMPLE_ARGS[key] ?? [];
    const result = (value as (...a: unknown[]) => unknown)(...args);
    if (typeof result === "string") out.push(result);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkStrings(v, k, out);
    }
  }
}

function allStrings(locale: string): string[] {
  const out: string[] = [];
  walkStrings(pricingInterimCopy(locale), "", out);
  return out;
}

const FORBIDDEN = [
  "房東",
  "房客",
  "收款",
  "收租",
  "即將推出",
  "專業 Pro",
  "NT$30",
  "NT$40",
  "第 5 戶起",
  "前 4 戶免費",
  "前 3 個月免費",
  "合作期間免費",
  "含稅",
  "未稅",
  "USD",
  "US$",
  "席次",
  "送出申請後 1 個工作天內",
  "送出後 1 個工作天內",
];

for (const locale of LOCALES) {
  test(`[${locale}] no forbidden substrings appear in any walked copy string (C1/C2, spec §4)`, () => {
    const strings = allStrings(locale);
    assert.ok(strings.length > 0, "expected the copy walk to yield strings");
    for (const forbidden of FORBIDDEN) {
      const hit = strings.find((s) => s.includes(forbidden));
      assert.equal(hit, undefined, `found forbidden "${forbidden}" in: ${hit ?? ""}`);
    }
  });
}

test("[zh-TW] trial CTAs state the free-trial length (PLT-26)", () => {
  const copy = pricingInterimCopy("zh-TW");
  assert.ok(
    copy.pricing.cta_trial_std.includes("免費試用 3 個月"),
    `cta_trial_std: ${copy.pricing.cta_trial_std}`,
  );
  assert.ok(
    copy.pricing.cta_trial_pre.includes("免費試用 6 個月"),
    `cta_trial_pre: ${copy.pricing.cta_trial_pre}`,
  );
});

test("[zh-TW] trial note is present and the table omits a trial-threshold claim (PLT-26)", () => {
  const copy = pricingInterimCopy("zh-TW");
  assert.ok(copy.pricing.trial_manual_note.trim().length > 0, "trial_manual_note must be nonempty");
  assert.ok(!copy.pricing.after_table.includes("試用門檻"), "after_table must not mention 試用門檻");
});

test("[zh-TW] the activation clock starts at payment confirmation (C2, PLT-29)", () => {
  const copy = pricingInterimCopy("zh-TW");
  const confirmed = "確認入帳後 1 個工作天內為你開通"; // success_body ends this with 為你開通 too
  assert.ok(copy.pricing.footer_cta.includes(confirmed), `footer_cta: ${copy.pricing.footer_cta}`);
  assert.ok(copy.apply.lead.includes(confirmed), `apply.lead: ${copy.apply.lead}`);
  assert.ok(copy.apply.success_body.includes(confirmed), `apply.success_body: ${copy.apply.success_body}`);
  assert.ok(
    !copy.apply.lead.includes("送出申請後 1 個工作天內"),
    "apply.lead must not anchor the clock to submission",
  );
  assert.ok(
    !copy.apply.success_body.includes("送出申請後 1 個工作天內"),
    "apply.success_body must not anchor the clock to submission",
  );
});

test("[zh-TW] the invoice FAQ promises receipts only (C1, PLT-30)", () => {
  const copy = pricingInterimCopy("zh-TW");
  assert.ok(
    copy.pricing.faq_invoice_a.includes("目前提供收據，暫無法開立統一發票"),
    `faq_invoice_a: ${copy.pricing.faq_invoice_a}`,
  );
});

test("[zh-TW] 設計夥伴 appears only in the design-partner FAQ pair (C2)", () => {
  const copy = pricingInterimCopy("zh-TW");
  assert.ok(copy.pricing.faq_partner_q.includes("設計夥伴"), "faq_partner_q must mention 設計夥伴");
  assert.ok(copy.pricing.faq_partner_a.includes("設計夥伴"), "faq_partner_a must mention 設計夥伴");
  const leaked = allStrings("zh-TW").filter((s) => s.includes("設計夥伴"));
  assert.equal(
    leaked.length,
    2,
    `設計夥伴 must appear in exactly the two FAQ fields, but appeared in: ${leaked.join(" | ")}`,
  );
});
