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
  type BuyerInput,
  type IssueVendorDocumentInput,
  type VendorReceiptErrorKey,
} from "./vendor-receipt-rules";

function expectError(
  action: () => unknown,
  code: VendorReceiptErrorKey,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof VendorReceiptRuleError);
    assert.equal(error.code, code);
    assert.equal(error.message, getVendorReceiptCopy().errors[code]);
    return true;
  });
}

function line(
  overrides: Partial<JobTypeLineItem> = {},
): JobTypeLineItem {
  return {
    name: "水電 - 測試服務",
    quantity: 2,
    unit: "小時",
    unit_price_minor: 600,
    amount_minor: 1200,
    category: "labor",
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
    vendor: {
      kind: "business",
      tax_id: "04595257",
      qualification_attested: true,
    },
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
      assert.equal(
        decideDocumentKind({
          kind: "individual",
          qualification_attested,
          tax_id,
        }),
        "completion_statement",
      );
    }
  }
  assert.equal(decideDocumentKind(issueInput().vendor), "receipt");
  assert.equal(
    decideDocumentKind({
      kind: "business",
      tax_id: "04595257",
      qualification_attested: false,
    }),
    "completion_statement",
  );
  for (const tax_id of [undefined, null, "", "04595258", "invalid"]) {
    assert.equal(
      decideDocumentKind({
        kind: "business",
        tax_id,
        qualification_attested: true,
      }),
      "completion_statement",
    );
  }
});

test("owner title is mandatory and never falls back to contact data", () => {
  for (const receipt_title of [undefined, null, "", " \n "]) {
    const buyer = {
      kind: "owner" as const,
      receipt_title,
      display_name: "不可替代抬頭",
    };
    expectError(() => validateBuyer(buyer), "ownerReceiptTitleMissing");
    expectError(
      () => issueVendorDocument(issueInput({ buyer })),
      "ownerReceiptTitleMissing",
    );
  }
  assert.deepEqual(
    validateBuyer({ kind: "owner", receipt_title: " 測試抬頭 " }),
    { kind: "owner", receipt_title: "測試抬頭" },
  );
});

test("owner snapshots reject extra fields, including personal data", () => {
  for (const key of ["display_name", "address", "phone", "tax_id", "email"]) {
    const buyer = {
      kind: "owner" as const,
      receipt_title: "測試抬頭",
      [key]: "禁止輸出",
    };
    expectError(() => validateBuyer(buyer), "buyerPiiForbidden");
  }
  const document = issueVendorDocument(issueInput());
  assert.deepEqual(Object.keys(document.buyer).sort(), [
    "kind",
    "receipt_title",
  ]);
});

test("company buyer requires name, address and checksum-valid tax ID", () => {
  const company = {
    kind: "company" as const,
    name: " 測試管理公司 ",
    address: " 測試地址 ",
    tax_id: "04595257",
  };
  assert.deepEqual(validateBuyer(company), {
    kind: "company",
    name: "測試管理公司",
    address: "測試地址",
    tax_id: "04595257",
  });

  for (const field of ["name", "address", "tax_id"] as const) {
    for (const value of [undefined, null, "", " \n "]) {
      expectError(
        () => validateBuyer({ ...company, [field]: value }),
        "companyBuyerIncomplete",
      );
    }
  }
  for (const tax_id of [
    "04595257",
    "04595252",
    "10458575",
    "10458574",
    "12345675",
    "12345676",
  ]) {
    assert.equal(
      validateBuyer({ ...company, tax_id }).kind,
      "company",
      tax_id,
    );
  }
  for (const tax_id of [
    "04595258",
    "1234567",
    "123456789",
    "1234567A",
    " 04595257",
  ]) {
    expectError(
      () => validateBuyer({ ...company, tax_id }),
      "companyBuyerIncomplete",
    );
  }
  const withExtraData = { ...company, phone: "private" };
  assert.equal("phone" in validateBuyer(withExtraData), false);
});

test("document numbers pad receipts and mark completion statements", () => {
  assert.equal(formatDocumentNo("DEMO", 1, "receipt"), "DEMO-000001");
  assert.equal(formatDocumentNo("DEMO", 123456, "receipt"), "DEMO-123456");
  assert.equal(formatDocumentNo("DEMO", 1000000, "receipt"), "DEMO-1000000");
  assert.equal(
    formatDocumentNo("DEMO", 1, "completion_statement"),
    "DEMO-W-1",
  );
  assert.equal(
    formatDocumentNo("DEMO-2", 1234567, "completion_statement"),
    "DEMO-2-W-1234567",
  );
  for (const seq of [0, -1, 1.5, NaN, Infinity, 2 ** 53]) {
    expectError(
      () => formatDocumentNo("DEMO", seq, "receipt"),
      "invalidDocumentCode",
    );
  }
  for (const code of ["", " ", " DEMO", "DEMO\n", "A/B", "A--B"]) {
    expectError(
      () => formatDocumentNo(code, 1, "receipt"),
      "invalidDocumentCode",
    );
  }
});

test("Chinese uppercase amounts include required vectors and zero gaps", () => {
  const vectors: ReadonlyArray<readonly [number, string]> = [
    [0, "新臺幣零元整"],
    [1, "新臺幣壹元整"],
    [10, "新臺幣壹拾元整"],
    [101, "新臺幣壹佰零壹元整"],
    [1001, "新臺幣壹仟零壹元整"],
    [10000, "新臺幣壹萬元整"],
    [12000, "新臺幣壹萬貳仟元整"],
    [100000000, "新臺幣壹億元整"],
    [10001, "新臺幣壹萬零壹元整"],
    [10010, "新臺幣壹萬零壹拾元整"],
    [100100001, "新臺幣壹億零壹拾萬零壹元整"],
    [100010000, "新臺幣壹億零壹萬元整"],
    [100000001, "新臺幣壹億零壹元整"],
    [1000000000000, "新臺幣壹兆元整"],
    [Number.MAX_SAFE_INTEGER,
      "新臺幣玖仟零柒兆壹仟玖佰玖拾貳億伍仟肆佰柒拾肆萬零玖佰玖拾壹元整"],
  ];
  for (const [amount, expected] of vectors) {
    assert.equal(toChineseUppercaseAmount(amount), expected, String(amount));
  }
  for (const amount of [-1, 0.5, NaN, Infinity, 2 ** 53]) {
    expectError(() => toChineseUppercaseAmount(amount), "invalidLineItems");
  }
});

test("totals preserve quantities and material/labor amounts", () => {
  const items = [
    line({
      name: "水電 - 材料",
      category: "material",
      quantity: 3,
      unit: "項",
      unit_price_minor: 100,
      amount_minor: 300,
    }),
    line(),
  ];
  assert.equal(validateDocumentTotals(items, 1500, 1500), 1500);
  const document = issueVendorDocument(
    issueInput({
      items,
      total_minor: 1500,
      ticket_actual_cost_minor: 1500,
    }),
  );
  assert.deepEqual(document.items, items);
  assert.equal(document.uppercase_total, "新臺幣壹仟伍佰元整");
  assert.equal(getVendorReceiptCopy().labels.currencyPrefix, "NT$");
});

test("invalid rows, unsafe sums and total mismatches are rejected", () => {
  const invalidRows: Partial<JobTypeLineItem>[] = [
    { name: " " },
    { unit: "" },
    { quantity: 0 },
    { quantity: -1 },
    { quantity: 1.5 },
    { unit_price_minor: -1 },
    { unit_price_minor: 0.5 },
    { amount_minor: 0 },
    { amount_minor: -1 },
    { amount_minor: 1200.5 },
    { amount_minor: NaN },
    { amount_minor: Infinity },
    { amount_minor: 1199 },
  ];
  for (const row of invalidRows) {
    expectError(
      () => validateDocumentTotals([line(row)], 1200, 1200),
      "invalidLineItems",
    );
  }
  expectError(() => validateDocumentTotals([], 0, 0), "invalidLineItems");
  for (const total of [-1, 0.5, NaN, Infinity, 2 ** 53, 1199]) {
    expectError(
      () => validateDocumentTotals([line()], total, 1200),
      "invalidLineItems",
    );
  }
  const large = line({
    quantity: 1,
    unit_price_minor: Number.MAX_SAFE_INTEGER,
    amount_minor: Number.MAX_SAFE_INTEGER,
  });
  expectError(
    () => validateDocumentTotals([large, large], Number.MAX_SAFE_INTEGER, 0),
    "invalidLineItems",
  );
  for (const cost of [1199, 1201, -1, 1200.5, NaN, Infinity, 2 ** 53]) {
    expectError(
      () => issueVendorDocument(
        issueInput({ ticket_actual_cost_minor: cost }),
      ),
      "totalMismatchWithTicketCost",
    );
  }
});

test("individual statements carry the fixed notice and omit receipt seal", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const document = issueVendorDocument(
      issueInput({
        locale,
        vendor: {
          kind: "individual",
          tax_id: "04595257",
          qualification_attested: true,
        },
      }),
    );
    assert.equal(document.kind, "completion_statement");
    assert.equal(document.doc_no, "DEMO-W-1");
    assert.equal(document.apply_receipt_seal, false);
    assert.equal(
      document.title,
      getVendorReceiptCopy(locale).labels.completionStatementTitle,
    );
    assert.ok(document.notices.includes("本文件非稅務憑證"));
  }
  const receipt = issueVendorDocument(issueInput());
  assert.equal(receipt.title, getVendorReceiptCopy().labels.receiptTitle);
  assert.equal(receipt.apply_receipt_seal, true);
});

test("issued snapshots are detached from mutable caller input", () => {
  const input = issueInput();
  const item = line();
  const buyer: BuyerInput = { kind: "owner", receipt_title: "原始抬頭" };
  const document = issueVendorDocument({ ...input, buyer, items: [item] });
  item.name = "後續變更";
  buyer.receipt_title = "後續抬頭";
  assert.equal(document.items[0].name, "水電 - 測試服務");
  assert.deepEqual(document.buyer, {
    kind: "owner",
    receipt_title: "原始抬頭",
  });
});

test("only issued to voided is allowed, with reason and explicit timestamp", () => {
  assert.equal(canTransitionDocumentStatus("issued", "voided"), true);
  assert.equal(canTransitionDocumentStatus("issued", "issued"), false);
  assert.equal(canTransitionDocumentStatus("voided", "issued"), false);
  assert.equal(canTransitionDocumentStatus("voided", "voided"), false);

  const original = issueVendorDocument(issueInput());
  expectError(
    () => voidVendorDocument(original, " \n ", "2026-10-26T00:00:00Z"),
    "voidReasonRequired",
  );
  expectError(
    () => voidVendorDocument(original, "更正", "invalid"),
    "invalidVoidTransition",
  );
  const voided = voidVendorDocument(
    original,
    " 更正服務內容 ",
    "2026-10-26T00:00:00Z",
  );
  assert.equal(original.status, "issued");
  assert.equal(original.void_reason, null);
  assert.equal(voided.status, "voided");
  assert.equal(voided.void_reason, "更正服務內容");
  assert.equal(voided.voided_at, "2026-10-26T00:00:00.000Z");
  assert.equal(voided.doc_no, original.doc_no);
  assert.deepEqual(voided.items, original.items);
  expectError(
    () => voidVendorDocument(voided, "再次作廢", "2026-10-27T00:00:00Z"),
    "invalidVoidTransition",
  );
});

test("reissue creates a distinct issued document linked to a voided source", () => {
  const original = issueVendorDocument(issueInput());
  const nextInput = issueInput({ id: "document-2", seq: 2 });
  expectError(
    () => reissueVendorDocument(original, nextInput),
    "invalidReissueSource",
  );
  const voided = voidVendorDocument(
    original,
    "更正",
    "2026-10-26T00:00:00Z",
  );
  const replacement = reissueVendorDocument(voided, nextInput);
  assert.equal(replacement.id, "document-2");
  assert.equal(replacement.status, "issued");
  assert.equal(replacement.doc_no, "DEMO-000002");
  assert.equal(replacement.reissued_from, original.id);
  assert.equal(replacement.void_reason, null);
  assert.equal(replacement.voided_at, null);
  assert.equal(voided.status, "voided");
  assert.equal(voided.doc_no, "DEMO-000001");

  for (const overrides of [
    { id: original.id },
    { seq: 1 },
    { seq: 0 },
    { vendor_profile_id: "other-vendor" },
    { ticket_id: "other-ticket" },
    { vendor_code: "OTHER" },
  ]) {
    expectError(
      () => reissueVendorDocument(voided, { ...nextInput, ...overrides }),
      "invalidReissueSource",
    );
  }
  expectError(
    () => reissueVendorDocument(
      voided,
      { ...nextInput, ticket_actual_cost_minor: 1199 },
    ),
    "totalMismatchWithTicketCost",
  );
});

test("completion statements retain their kind and notice after reissue", () => {
  const input = issueInput({
    vendor: { kind: "individual", qualification_attested: false },
  });
  const source = voidVendorDocument(
    issueVendorDocument(input),
    "更正",
    "2026-10-26T00:00:00Z",
  );
  const replacement = reissueVendorDocument(source, {
    ...input,
    id: "statement-2",
    seq: 2,
  });
  assert.equal(replacement.doc_no, "DEMO-W-2");
  assert.equal(replacement.reissued_from, source.id);
  assert.equal(replacement.kind, "completion_statement");
  assert.ok(replacement.notices.includes("本文件非稅務憑證"));
  assert.equal(replacement.apply_receipt_seal, false);
});
