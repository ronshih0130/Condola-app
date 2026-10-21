import { dictionary, type Locale, type T } from "@/i18n";
import type { PdfBlock, PdfDocument, PdfRow } from "@/lib/pdf-document";
import { formatDate, formatMoney, moneyLabel, ownerSettlement } from "@/server/format";
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
  startDate: string;
  endDate: string | null;
  notes: string | null;
  templateBody: string | null;
  place: string;
  firm: string;
  tenant: string;
  ownerName: string | null;
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
  audience: "owner" | "staff";
};

function splitLines(value: string | null) {
  if (!value) return [];
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function monthsText(value: string | null) {
  if (!value) return null;
  const months = Number(value);
  if (!Number.isFinite(months)) return null;
  return Number.isInteger(months) ? String(months) : String(months);
}

export function buildLeasePdf(source: LeasePdfSource, locale: Locale, calendar: CalendarMode, t: T): PdfDocument {
  const dict = dictionary(locale);
  const rent = formatMoney(source.rentMinor, source.currency, locale);
  const deposit = formatMoney(source.depositMinor, source.currency, locale);
  const start = formatDate(source.startDate, locale, calendar, dict);
  const end = source.endDate ? formatDate(source.endDate, locale, calendar, dict) : "";
  const term = end ? `${start} - ${end}` : t("pdf_clause_open", { start });
  const months = monthsText(source.depositMonths);
  const rows: PdfRow[] = [
    { label: t("s_74f19b0"), value: source.tenant || t("i_empty") },
  ];
  if (source.ownerName) rows.push({ label: t("i_owner"), value: source.ownerName });
  rows.push(
    { label: t("i_firm_label"), value: source.firm },
    { label: t("i_space"), value: source.place },
    { label: t("i_term"), value: term },
    { label: t("i_rent_label"), value: rent },
    { label: t("i_deposit_label"), value: deposit },
  );
  if (source.depositOverrideReason) {
    rows.push({ label: t("pdf_deposit_reason"), value: source.depositOverrideReason });
  }
  rows.push({ label: t("i_due_day_label"), value: t("i_due_day", { day: source.dueDay }) });

  const synthesized = [
    t("pdf_clause_rent", { rent, day: source.dueDay }),
    months ? t("pdf_clause_deposit_months", { amount: deposit, months }) : t("pdf_clause_deposit", { amount: deposit }),
  ];
  if (source.depositOverrideReason) synthesized.push(t("pdf_clause_reason", { reason: source.depositOverrideReason }));
  synthesized.push(end ? t("pdf_clause_term", { start, end }) : t("pdf_clause_open", { start }));
  const templateLines = splitLines(source.templateBody);
  const noteLines = splitLines(source.notes).filter((line) => !templateLines.includes(line) && !synthesized.includes(line));
  const clauseLines = templateLines.length
    ? [...templateLines, ...noteLines]
    : [...synthesized, ...noteLines].map((line, index) => `${index + 1}. ${line}`);

  const hash = source.documentSha256?.trim() || "";
  const blocks: PdfBlock[] = [
    { kind: "rows", heading: t("s_a44f330"), rows },
    { kind: "text", heading: t("s_22b6bac"), lines: clauseLines },
  ];
  return {
    filename: "lease.pdf",
    title: t("s_a611841"),
    subtitle: source.place,
    blocks,
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
  const money = (minor: number) => formatMoney(minor, source.currency, locale);
  const labeled = (minor: number) => moneyLabel(minor, source.currency, locale);
  const rows: PdfRow[] = [
    { label: t("i_opening"), value: money(figures.opening) },
    { label: t("i_rent_received"), value: money(figures.rent) },
    { label: t("i_other_income"), value: money(figures.other) },
    { label: t("i_fee"), value: labeled(figures.fee) },
    { label: t("i_expenses"), value: labeled(figures.expenses) },
  ];
  if (figures.owes > 0) {
    rows.push({ label: t("i_net_owner"), value: `${t("owner_owes")} ${labeled(figures.owes)}` });
  } else {
    rows.push({ label: t("i_net_owner"), value: labeled(figures.payable) });
    rows.push({ label: t("i_closing"), value: labeled(Math.max(0, figures.closing)) });
  }
  const blocks: PdfBlock[] = [{ kind: "rows", heading: "", rows }];
  if (figures.owes > 0) {
    blocks.push({
      kind: "text",
      heading: "",
      lines: [t("owner_owes_reason", { cost: labeled(figures.costs), rent: labeled(figures.rent + figures.other) })],
    });
  }
  if (source.lines.length) {
    blocks.push({
      kind: "rows",
      heading: t("pdf_lines"),
      rows: source.lines.map((line) => ({
        label: line.description || t("i_expenses"),
        value: money(line.amount),
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
