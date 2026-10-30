import assert from "node:assert/strict";
import test from "node:test";
import { getVendorReceiptCopy } from "../i18n/lanes/vendor-receipt";
import type { JobTypeLineItem } from "./job-types-rules";
import {
  canTransitionDocumentStatus,
  decideDocumentKind,
  formatDocumentNo,
  issueVendorDocument,
  reissueVendorDocument,
  toChineseUppercaseAmount,
  validateBuyer,
  validateDocumentTotals,
  VendorReceiptRuleError,
  voidVendorDocument,
  type IssueVendorDocumentInput,
  type VendorReceiptErrorKey,
} from "./vendor-receipt-rules";

function expectError(action: () => unknown, code: VendorReceiptErrorKey): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof VendorReceiptRuleError);
    assert.equal(error.code, code);
    assert.equal(error.message, getVendorReceiptCopy().errors[code]);
    return true;
  });
}

function line(overrides: Partial<JobTypeLineItem> = {}): JobTypeLineItem {
  return {
    name: "水電 - 測試服務", quantity: 2, unit: "小時",
    unit_price_minor: 600, amount_minor: 1200, category: "labor",
    ...overrides,
  };
}

function issueInput(
  overrides: Partial<IssueVendorDocumentInput> = {},
): IssueVendorDocumentInput {
  return {
    id: "document-1",
    vendor_profile_id: "vendor-1",
    ticket_id: "ticket-1",
    vendor_code: "DEMO",
    vendor: { kind: "business", tax_id: "04595257", qualification_attested: true },
    seq: 1,
    buyer: { kind: "owner", receipt_title: "測試抬頭" },
    items: [line()],
    total_minor: 1200,
    ticket_actual_cost_minor: 1200,
    ...overrides,
  };
}

test("only an attested business with a valid tax ID gets a receipt", () => {
  for (const qualification_attested of [false, true]) {
    for (const tax_id of [undefined, null, "", "04595257"]) {
      assert.equal(decideDocumentKind({
        kind: "individual", qualification_attested, tax_id,
      }), "completion_statement");
    }
  }
  assert.equal(decideDocumentKind(issueInput().vendor), "receipt");
  assert.equal(decideDocumentKind({
    kind: "business", tax_id: "04595257", qualification_attested: false,
  }), "completion_statement");
  for (const tax_id of [undefined, null, "", "04595258", "invalid"]) {
    assert.equal(decideDocumentKind({
      kind: "business", tax_id, qualification_attested: true,
    }), "completion_statement");
  }
});

test("owner title is mandatory and never falls back to contact data", () => {
  for (const receipt_title of [undefined, null, "", " \n "]) {
    const buyer = { kind: "owner" as const, receipt_title, display_name: "不可替代抬頭" };
    expectError(() => validateBuyer(buyer), "ownerReceiptTitleMissing");
    expectError(() => issueVendorDocument(issueInput({ buyer })), "ownerReceiptTitleMissing");
  }
  assert.deepEqual(validateBuyer({ kind: "owner", receipt_title: " 測試抬頭 " }), {
    kind: "owner", receipt_title: "測試抬頭",
  });
});

test("owner snapshots reject extra personal fields", () => {
  for (const key of ["display_name", "address", "phone", "tax_id", "email"]) {
    expectError(() => validateBuyer({
      kind: "owner", receipt_title: "測試抬頭", [key]: "禁止輸出",
    }), "buyerPiiForbidden");
  }
  assert.deepEqual(Object.keys(issueVendorDocument(issueInput()).buyer).sort(), [
    "kind", "receipt_title",
  ]);
});

test("company buyer requires name, address and checksum-valid tax ID", () => {
  const company = {
    kind: "company" as const, name: " 測試管理公司 ", address: " 測試地址 ", tax_id: "04595257",
  };
  assert.deepEqual(validateBuyer(company), {
    kind: "company", name: "測試管理公司", address: "測試地址", tax_id: "04595257",
  });
  for (const field of ["name", "address", "tax_id"] as const) {
    for (const value of [undefined, null, "", " \n "]) {
      expectError(() => validateBuyer({ ...company, [field]: value }), "companyBuyerIncomplete");
    }
  }
  for (const tax_id of ["04595257", "04595252", "10458575", "10458574", "12345675", "12345676"]) {
    assert.equal(validateBuyer({ ...company, tax_id }).kind, "company");
  }
  for (const tax_id of ["04595258", "1234567", "123456789", "1234567A", " 04595257"]) {
    expectError(() => validateBuyer({ ...company, tax_id }), "companyBuyerIncomplete");
  }
  assert.equal("phone" in validateBuyer({ ...company, ...{ phone: "private" } }), false);
});

test("document numbers pad receipts and mark completion statements", () => {
  assert.equal(formatDocumentNo("DEMO", 1, "receipt"), "DEMO-000001");
  assert.equal(formatDocumentNo("DEMO", 123456, "receipt"), "DEMO-123456");
  assert.equal(formatDocumentNo("DEMO", 1, "completion_statement"), "DEMO-W-1");
  for (const seq of [0, -1, 0.5, NaN, Infinity, 2 ** 53]) {
    expectError(() => formatDocumentNo("DEMO", seq, "receipt"), "invalidDocumentCode");
  }
  for (const code of ["", " ", "a/b", "-DEMO", "DEMO-"]) {
    expectError(() => formatDocumentNo(code, 1, "receipt"), "invalidDocumentCode");
  }
});

test("Chinese uppercase amounts include zero gaps", () => {
  const vectors: [number, string][] = [
    [0, "新臺幣零元整"], [1, "新臺幣壹元整"], [10, "新臺幣壹拾元整"],
    [100, "新臺幣壹佰元整"], [1001, "新臺幣壹仟零壹元整"],
    [1200, "新臺幣壹仟貳佰元整"], [10000, "新臺幣壹萬元整"],
    [10001, "新臺幣壹萬零壹元整"], [100000001, "新臺幣壹億零壹元整"],
  ];
  for (const [amount, expected] of vectors) {
    assert.equal(toChineseUppercaseAmount(amount), expected);
  }
  for (const amount of [-1, 0.5, NaN, Infinity, 2 ** 53]) {
    expectError(() => toChineseUppercaseAmount(amount), "invalidLineItems");
  }
});

test("totals preserve quantities and material/labor amounts", () => {
  const items = [
    line({ name: "材料", category: "material", quantity: 3, unit: "項",
      unit_price_minor: 100, amount_minor: 300 }),
    line(),
  ];
  assert.equal(validateDocumentTotals(items, 1500, 1500), 1500);
  const document = issueVendorDocument(issueInput({
    items, total_minor: 1500, ticket_actual_cost_minor: 1500,
  }));
  assert.deepEqual(document.items, items);
  assert.equal(document.uppercase_total, "新臺幣壹仟伍佰元整");
});

test("non-divisible amounts remain authoritative through issue and reissue", () => {
  for (const [amount, unitPrice] of [[100, 33], [101, 34], [1, 0]]) {
    const items = [line({ quantity: 3, amount_minor: amount, unit_price_minor: 999 })];
    const input = issueInput({ items, total_minor: amount, ticket_actual_cost_minor: amount });
    assert.equal(validateDocumentTotals(items, amount, amount), amount);
    const document = issueVendorDocument(input);
    assert.equal(document.items[0].unit_price_minor, unitPrice);
    assert.equal(document.items[0].amount_minor, amount);
    assert.equal(document.total_minor, amount);
    assert.equal(items[0].unit_price_minor, 999);
    const replacement = reissueVendorDocument(
      voidVendorDocument(document, "更正", "2026-10-26T00:00:00Z"),
      { ...input, id: "document-2", seq: 2 },
    );
    assert.equal(replacement.items[0].unit_price_minor, unitPrice);
    assert.equal(replacement.items[0].amount_minor, amount);
  }
});

test("invalid rows, unsafe sums and total mismatches are rejected", () => {
  const invalidRows: Partial<JobTypeLineItem>[] = [
    { name: " " }, { unit: "" }, { quantity: 0 }, { quantity: -1 }, { quantity: 1.5 },
    { unit_price_minor: -1 }, { unit_price_minor: 0.5 },
    { amount_minor: 0 }, { amount_minor: -1 }, { amount_minor: 1200.5 },
    { amount_minor: NaN }, { amount_minor: Infinity }, { amount_minor: 1199 },
  ];
  for (const row of invalidRows) {
    expectError(() => validateDocumentTotals([line(row)], 1200, 1200), "invalidLineItems");
  }
  expectError(() => validateDocumentTotals([], 0, 0), "invalidLineItems");
  for (const total of [-1, 0.5, NaN, Infinity, 2 ** 53, 1199]) {
    expectError(() => validateDocumentTotals([line()], total, 1200), "invalidLineItems");
  }
  const large = line({
    quantity: 1, unit_price_minor: Number.MAX_SAFE_INTEGER, amount_minor: Number.MAX_SAFE_INTEGER,
  });
  expectError(() => validateDocumentTotals([large, large], Number.MAX_SAFE_INTEGER, 0), "invalidLineItems");
  for (const cost of [1199, 1201, -1, 1200.5, NaN, Infinity, 2 ** 53]) {
    expectError(() => issueVendorDocument(issueInput({
      ticket_actual_cost_minor: cost,
    })), "totalMismatchWithTicketCost");
  }
});

test("individual statements carry the fixed notice and omit receipt seal", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const document = issueVendorDocument(issueInput({
      locale, vendor: { kind: "individual", qualification_attested: true, tax_id: "04595257" },
    }));
    assert.equal(document.kind, "completion_statement");
    assert.ok(document.notices.includes("本文件非稅務憑證"));
    assert.equal(document.apply_receipt_seal, false);
  }
});

test("void is a one-way transition and preserves original content", () => {
  const original = issueVendorDocument(issueInput());
  const voided = voidVendorDocument(original, " 更正 ", "2026-10-26T00:00:00Z");
  assert.equal(original.status, "issued");
  assert.equal(voided.status, "voided");
  assert.equal(voided.void_reason, "更正");
  assert.equal(voided.doc_no, original.doc_no);
  assert.deepEqual(voided.items, original.items);
  assert.equal(canTransitionDocumentStatus("issued", "voided"), true);
  assert.equal(canTransitionDocumentStatus("voided", "issued"), false);
  expectError(() => voidVendorDocument(voided, "更正", "2026-10-26"), "invalidVoidTransition");
  expectError(() => voidVendorDocument(original, " ", "2026-10-26"), "voidReasonRequired");
  expectError(() => voidVendorDocument(original, "更正", "invalid"), "invalidVoidTransition");
});

test("reissue requires a voided source and a fresh matching identity", () => {
  const original = issueVendorDocument(issueInput());
  const next = issueInput({ id: "document-2", seq: 2 });
  expectError(() => reissueVendorDocument(original, next), "invalidReissueSource");
  const source = voidVendorDocument(original, "更正", "2026-10-26T00:00:00Z");
  const replacement = reissueVendorDocument(source, next);
  assert.equal(replacement.doc_no, "DEMO-000002");
  assert.equal(replacement.reissued_from, original.id);
  assert.equal(replacement.status, "issued");
  assert.equal(replacement.void_reason, null);
  for (const overrides of [
    { id: original.id }, { seq: 1 }, { seq: 0 },
    { vendor_profile_id: "other" }, { ticket_id: "other" }, { vendor_code: "OTHER" },
  ]) {
    expectError(() => reissueVendorDocument(source, { ...next, ...overrides }), "invalidReissueSource");
  }
  expectError(() => reissueVendorDocument(source, {
    ...next, ticket_actual_cost_minor: 1199,
  }), "totalMismatchWithTicketCost");
});

test("completion statements retain kind and notice after reissue", () => {
  const input = issueInput({ vendor: { kind: "individual", qualification_attested: false } });
  const source = voidVendorDocument(issueVendorDocument(input), "更正", "2026-10-26T00:00:00Z");
  const replacement = reissueVendorDocument(source, { ...input, id: "statement-2", seq: 2 });
  assert.equal(replacement.doc_no, "DEMO-W-2");
  assert.equal(replacement.reissued_from, source.id);
  assert.ok(replacement.notices.includes("本文件非稅務憑證"));
  assert.equal(replacement.apply_receipt_seal, false);
});
