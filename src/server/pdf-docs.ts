import { dictionary, type Locale, type T } from "@/i18n";
import type { PdfBlock, PdfDocument, PdfRow } from "@/lib/pdf-document";
import { formatDate, moneyLabel, ownerSettlement, signedMoneyLabel } from "@/server/format";
import { renderOfficialLease } from "@/server/official-lease";
import { can } from "@/server/perms";
import type { CalendarMode, Session } from "@/server/types";

export function canDownloadLeasePdf(session: Session) {
  if (session.kind === "tenant") return true;
  if (session.kind === "staff") return can(session.role, "props.view");
  return false;
}

export function canDownloadStatementPdf(session: Session) {
  if (session.kind === "owner") return true;
  if (session.kind === "staff") return can(session.role, "stmt.view");
  return false;
}

export type LeasePdfSource = {
  id: string;
  orgId: string;
  documentSha256: string | null;
  currency: string;
  rentMinor: number;
  depositMinor: number;
  depositMonths: string | null;
  depositOverrideReason: string | null;
  dueDay: number;
  rentFrequency: string;
  startDate: string;
  endDate: string | null;
  place: string;
  tenant: string;
  ownerName: string | null;
  address: unknown;
  addressDisplay: string;
  floor: string | null;
  roomLabel: string | null;
  scope: "whole" | "partial";
  electricityMethod: string | null;
  ratePerKwh: string | null;
  bankName: string | null;
};

export type StatementPdfLine = { lineType: string; description: string | null; amount: number };

export type StatementPdfSource = {
  id: string;
  orgId: string;
  ownerName: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  opening: number;
  rent: number;
  other: number;
  fee: number;
  expenses: number;
  payouts: number;
  closing: number;
  lines: StatementPdfLine[];
  addresses: string[];
  audience: "owner" | "staff";
};

export function buildLeasePdf(source: LeasePdfSource, t: T): PdfDocument {
  const rendered = renderOfficialLease({
    tenantName: source.tenant,
    ownerName: source.ownerName,
    address: source.address,
    addressDisplay: source.addressDisplay,
    floor: source.floor,
    roomLabel: source.roomLabel,
    scope: source.scope,
    startDate: source.startDate,
    endDate: source.endDate,
    rentMinor: source.rentMinor,
    rentFrequency: source.rentFrequency,
    dueDay: source.dueDay,
    depositMinor: source.depositMinor,
    depositMonths: source.depositMonths,
    electricityMethod: source.electricityMethod,
    ratePerKwh: source.ratePerKwh,
    bankName: source.bankName,
    // bank_accounts has no holder column. Do not copy the 屋主 name into 戶名.
    accountHolder: null,
  });
  const preface = [t("pdf_paper_note")];
  if (source.depositOverrideReason) preface.push(`${t("pdf_deposit_reason")}：${source.depositOverrideReason}`);
  const hash = source.documentSha256?.trim() || "";
  return {
    filename: "lease.pdf",
    title: "住宅租賃契約書範本",
    subtitle: source.place,
    blocks: [
      { kind: "text", heading: "", lines: preface },
      { kind: "text", heading: "", lines: rendered.text.split("\n") },
    ],
    footerLabel: hash ? t("pdf_hash_label") : t("pdf_hash_missing"),
    footerHash: hash,
  };
}

export function buildStatementPdf(source: StatementPdfSource, locale: Locale, calendar: CalendarMode, t: T): PdfDocument {
  const dict = dictionary(locale);
  const figures = ownerSettlement({
    opening: source.opening,
    rent: source.rent,
    other: source.other,
    fee: source.fee,
    expenses: source.expenses,
    payouts: source.payouts,
    closing: source.closing,
  });
  const money = (minor: number) => moneyLabel(minor, source.currency, locale);
  const rows: PdfRow[] = [
    { label: t("i_opening"), value: money(figures.opening) },
    { label: t("i_rent_received"), value: money(figures.rent) },
    { label: t("i_other_income"), value: money(figures.other) },
    { label: t("i_fee"), value: money(figures.fee) },
    { label: t("i_expenses"), value: money(figures.expenses) },
  ];
  if (figures.owes > 0) {
    rows.push({ label: t("i_net_owner"), value: `${t("owner_owes")} ${money(figures.owes)}` });
  } else {
    rows.push({ label: t("i_net_owner"), value: money(figures.payable) });
    rows.push({ label: t("i_closing"), value: money(Math.max(0, figures.closing)) });
  }
  const blocks: PdfBlock[] = [];
  const addresses = source.addresses.map((address) => address.trim()).filter(Boolean);
  if (addresses.length) {
    blocks.push({ kind: "text", heading: "", lines: addresses.map((address) => `${t("i_address")}：${address}`) });
  }
  blocks.push({ kind: "rows", heading: "", rows });
  if (figures.owes > 0) {
    blocks.push({
      kind: "text",
      heading: "",
      lines: [
        t("owner_owes_reason", {
          "金額": money(figures.owes).replace(/^NT\$/, ""),
          cost: money(figures.costs),
          rent: money(figures.rent + figures.other),
        }),
      ],
    });
  }
  if (source.lines.length) {
    blocks.push({
      kind: "rows",
      heading: t("pdf_lines"),
      rows: source.lines.map((line) => ({
        label: line.description || t("i_expenses"),
        value: signedMoneyLabel(line.amount, source.currency, locale),
      })),
    });
  }
  const notes = [t("i_actor")];
  if (source.audience === "staff") notes.push(t("i_einvoice"));
  blocks.push({ kind: "text", heading: "", lines: notes });
  const period = `${formatDate(source.periodStart, locale, calendar, dict)} - ${formatDate(source.periodEnd, locale, calendar, dict)}`;
  return {
    filename: "owner-statement.pdf",
    title: t("pdf_statement_title"),
    subtitle: `${source.ownerName} · ${period}`,
    blocks,
    footerLabel: t("i_period"),
    footerHash: `${source.periodStart}/${source.periodEnd}`,
  };
}
