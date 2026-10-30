import {
  getVendorReceiptCopy,
  type VendorReceiptErrors,
  type VendorReceiptLocale,
} from "../i18n/lanes/vendor-receipt";
import type { JobTypeLineItem } from "./job-types-rules";

export type VendorDocumentKind = "receipt" | "completion_statement";
export type VendorDocumentStatus = "issued" | "voided";
export type VendorReceiptErrorKey = keyof VendorReceiptErrors;

export class VendorReceiptRuleError extends Error {
  constructor(public readonly code: VendorReceiptErrorKey) {
    super(getVendorReceiptCopy().errors[code]);
    this.name = "VendorReceiptRuleError";
  }
}

function fail(code: VendorReceiptErrorKey): never {
  throw new VendorReceiptRuleError(code);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validMoney(value: number): boolean {
  // Despite the column suffix, one unit is one integer NT$.
  return Number.isSafeInteger(value) && value >= 0;
}

// Keep the checksum policy aligned with onboarding.
function validTaxId(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const weights = [1, 2, 1, 2, 1, 2, 4, 1];
  let sum = 0;
  for (let index = 0; index < weights.length; index += 1) {
    const product = Number(value.charAt(index)) * weights[index];
    sum += Math.floor(product / 10) + (product % 10);
  }
  return [5, 10].some(
    (divisor) =>
      sum % divisor === 0 ||
      (value.charAt(6) === "7" && (sum + 1) % divisor === 0),
  );
}

export interface ReceiptVendor {
  kind: "business" | "individual";
  tax_id?: string | null;
  qualification_attested: boolean;
}

export function decideDocumentKind(vendor: ReceiptVendor): VendorDocumentKind {
  if (vendor.kind === "individual") return "completion_statement";
  return vendor.qualification_attested === true &&
    typeof vendor.tax_id === "string" &&
    validTaxId(vendor.tax_id)
    ? "receipt"
    : "completion_statement";
}

export type BuyerInput =
  | {
      kind: "company";
      name?: string | null;
      address?: string | null;
      tax_id?: string | null;
    }
  | {
      kind: "owner";
      receipt_title?: string | null;
    };

export type BuyerSnapshot =
  | { kind: "company"; name: string; address: string; tax_id: string }
  | { kind: "owner"; receipt_title: string };

export function validateBuyer(input: BuyerInput): BuyerSnapshot {
  if (input.kind === "owner") {
    if (!nonEmpty(input.receipt_title)) fail("ownerReceiptTitleMissing");
    if (Object.keys(input).some((key) => key !== "kind" && key !== "receipt_title")) {
      fail("buyerPiiForbidden");
    }
    return { kind: "owner", receipt_title: input.receipt_title.trim() };
  }
  if (
    input.kind !== "company" ||
    !nonEmpty(input.name) ||
    !nonEmpty(input.address) ||
    typeof input.tax_id !== "string" ||
    !validTaxId(input.tax_id)
  ) {
    fail("companyBuyerIncomplete");
  }
  return {
    kind: "company",
    name: input.name.trim(),
    address: input.address.trim(),
    tax_id: input.tax_id,
  };
}

export function formatDocumentNo(
  vendorCode: string,
  seq: number,
  kind: VendorDocumentKind,
): string {
  if (
    !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(vendorCode) ||
    !Number.isSafeInteger(seq) ||
    seq < 1
  ) {
    fail("invalidDocumentCode");
  }
  return kind === "receipt"
    ? `${vendorCode}-${String(seq).padStart(6, "0")}`
    : `${vendorCode}-W-${seq}`;
}

const DIGITS = "零壹貳參肆伍陸柒捌玖";
const SMALL_UNITS = ["", "拾", "佰", "仟"];
const GROUP_UNITS = ["", "萬", "億", "兆"];

function uppercaseGroup(value: number): string {
  let result = "";
  let pendingZero = false;
  for (let position = 3; position >= 0; position -= 1) {
    const digit = Math.floor(value / 10 ** position) % 10;
    if (digit === 0) {
      if (result) pendingZero = true;
      continue;
    }
    if (pendingZero) result += DIGITS.charAt(0);
    result += DIGITS.charAt(digit) + SMALL_UNITS[position];
    pendingZero = false;
  }
  return result;
}

export function toChineseUppercaseAmount(amount: number): string {
  if (!validMoney(amount)) fail("invalidLineItems");
  if (amount === 0) return "新臺幣零元整";

  const groups: number[] = [];
  let remaining = amount;
  while (remaining > 0) {
    groups.push(remaining % 10000);
    remaining = Math.floor(remaining / 10000);
  }

  let result = "";
  let skippedGroup = false;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === 0) {
      if (result) skippedGroup = true;
      continue;
    }
    if (result && (skippedGroup || group < 1000)) result += "零";
    result += uppercaseGroup(group) + GROUP_UNITS[index];
    skippedGroup = false;
  }
  return `新臺幣${result}元整`;
}

export function validateDocumentTotals(
  items: readonly JobTypeLineItem[],
  totalMinor: number,
  ticketActualCostMinor: number,
): number {
  if (!validMoney(totalMinor) || items.length === 0) fail("invalidLineItems");

  let sum = 0;
  for (const item of items) {
    if (
      !nonEmpty(item.name) ||
      !nonEmpty(item.unit) ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 ||
      !validMoney(item.unit_price_minor) ||
      !validMoney(item.amount_minor) ||
      item.amount_minor <= 0 ||
      !["service", "material", "labor"].includes(item.category)
    ) {
      fail("invalidLineItems");
    }
    // Amounts are authoritative. A rounded display price may be zero and its
    // product with quantity need not equal the row amount.
    sum += item.amount_minor;
    if (!Number.isSafeInteger(sum)) fail("invalidLineItems");
  }
  if (sum !== totalMinor) fail("invalidLineItems");
  if (!validMoney(ticketActualCostMinor) || totalMinor !== ticketActualCostMinor) {
    fail("totalMismatchWithTicketCost");
  }
  return sum;
}

export interface VendorDocument {
  readonly id: string;
  readonly vendor_profile_id: string;
  readonly ticket_id: string;
  readonly vendor_code: string;
  readonly kind: VendorDocumentKind;
  readonly seq: number;
  readonly doc_no: string;
  readonly buyer: BuyerSnapshot;
  readonly items: readonly JobTypeLineItem[];
  readonly total_minor: number;
  readonly uppercase_total: string;
  readonly title: string;
  readonly notices: readonly string[];
  readonly apply_receipt_seal: boolean;
  readonly status: VendorDocumentStatus;
  readonly voided_at: string | null;
  readonly void_reason: string | null;
  readonly reissued_from: string | null;
}

export interface IssueVendorDocumentInput {
  id: string;
  vendor_profile_id: string;
  ticket_id: string;
  vendor_code: string;
  vendor: ReceiptVendor;
  seq: number;
  buyer: BuyerInput;
  items: readonly JobTypeLineItem[];
  total_minor: number;
  ticket_actual_cost_minor: number;
  locale?: VendorReceiptLocale;
}

export function issueVendorDocument(input: IssueVendorDocumentInput): VendorDocument {
  if (
    !nonEmpty(input.id) ||
    !nonEmpty(input.vendor_profile_id) ||
    !nonEmpty(input.ticket_id)
  ) {
    fail("invalidDocumentCode");
  }
  const kind = decideDocumentKind(input.vendor);
  const docNo = formatDocumentNo(input.vendor_code, input.seq, kind);
  const buyer = validateBuyer(input.buyer);
  validateDocumentTotals(input.items, input.total_minor, input.ticket_actual_cost_minor);
  const labels = getVendorReceiptCopy(input.locale).labels;
  const notices =
    kind === "receipt"
      ? [labels.receiptDisclaimer]
      : Array.from(
          new Set([
            getVendorReceiptCopy("zh-TW").labels.nonTaxVoucherNotice,
            labels.nonTaxVoucherNotice,
            labels.completionStatementDisclaimer,
          ]),
        );

  return {
    id: input.id,
    vendor_profile_id: input.vendor_profile_id,
    ticket_id: input.ticket_id,
    vendor_code: input.vendor_code,
    kind,
    seq: input.seq,
    doc_no: docNo,
    buyer,
    items: input.items.map((item) => ({
      ...item,
      unit_price_minor: Math.round(item.amount_minor / item.quantity),
    })),
    total_minor: input.total_minor,
    uppercase_total: toChineseUppercaseAmount(input.total_minor),
    title: kind === "receipt" ? labels.receiptTitle : labels.completionStatementTitle,
    notices,
    apply_receipt_seal: kind === "receipt",
    status: "issued",
    voided_at: null,
    void_reason: null,
    reissued_from: null,
  };
}

export function canTransitionDocumentStatus(
  from: VendorDocumentStatus,
  to: VendorDocumentStatus,
): boolean {
  return from === "issued" && to === "voided";
}

export function voidVendorDocument(
  document: VendorDocument,
  reason: string,
  voidedAt: string,
): VendorDocument {
  if (!canTransitionDocumentStatus(document.status, "voided")) {
    fail("invalidVoidTransition");
  }
  if (!nonEmpty(reason)) fail("voidReasonRequired");
  if (!nonEmpty(voidedAt) || !Number.isFinite(Date.parse(voidedAt))) {
    fail("invalidVoidTransition");
  }
  return {
    ...document,
    status: "voided",
    void_reason: reason.trim(),
    voided_at: new Date(voidedAt).toISOString(),
  };
}

export function reissueVendorDocument(
  source: VendorDocument,
  input: IssueVendorDocumentInput,
): VendorDocument {
  if (
    source.status !== "voided" ||
    !nonEmpty(source.void_reason) ||
    !nonEmpty(source.voided_at) ||
    input.id === source.id ||
    input.vendor_profile_id !== source.vendor_profile_id ||
    input.ticket_id !== source.ticket_id ||
    input.vendor_code !== source.vendor_code ||
    input.seq <= source.seq
  ) {
    fail("invalidReissueSource");
  }
  const replacement = issueVendorDocument(input);
  if (replacement.doc_no === source.doc_no) fail("invalidReissueSource");
  return { ...replacement, reissued_from: source.id };
}
