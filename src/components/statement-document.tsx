import React, { type ReactNode } from "react";
import type { Locale, T } from "@/i18n";
import { BrandImage } from "@/components/brand";
import { moneyLabel, ownerSettlement, statementPeriodNet, statementSignedMoney } from "@/server/format";

export function StatementDocument({
  t,
  locale,
  row,
  lines,
  note,
  v2,
}: {
  t: T;
  locale: Locale;
  lines?: { line_type: string; description: string | null; amount: string }[];
  row: {
    currency: string;
    opening: string;
    rent: string;
    other: string;
    fee: string;
    expenses: string;
    payouts: string;
    closing: string;
  };
  note?: ReactNode;
  v2?: boolean;
}) {
  const figures = ownerSettlement({
    opening: Number(row.opening),
    rent: Number(row.rent),
    other: Number(row.other),
    fee: Number(row.fee),
    expenses: Number(row.expenses),
    payouts: Number(row.payouts),
    closing: Number(row.closing),
  });
  const money = (minor: number) => moneyLabel(minor, row.currency, locale);
  const signed = (minor: number) => statementSignedMoney(minor, row.currency, locale);
  const amount = (value: string) => v2 && value.startsWith("\u2212") ? <span className="amount-neg">{value}</span> : value;
  const periodNet = statementPeriodNet(figures);
  const negative = periodNet < 0;
  const summary = [
    ["i_stmt_opening", signed(figures.opening), "statement-opening"],
    ["i_rent_received", money(figures.rent), "statement-rent"],
    ["i_other_income", money(figures.other), ""],
    ["i_fee", money(figures.fee), "statement-fee"],
    ["i_expenses", signed(figures.expenses), ""],
  ] as const;
  return (
    <div className="card" style={{ maxWidth: 640 }} data-testid="statement-document">
      <BrandImage variant="horizontal" alt={t("i_brand")} className="statement-logo" {...(v2 ? { v2: true, locale } : {})} />
      <table className="t">
        <tbody>
          {summary.map(([key, value, testid]) => (
            <tr key={key}>
              <td>{t(key)}</td>
              <td className="num" data-testid={testid || undefined}>
                {amount(value)}
              </td>
            </tr>
          ))}
          {figures.payouts !== 0 ? (
            <tr>
              <td>{t("i_payouts")}</td>
              <td className="num" data-testid="statement-payouts">
                {amount(signed(figures.payouts))}
              </td>
            </tr>
          ) : null}
          <tr data-testid={negative ? "owner-owes" : undefined}>
            <td>{negative ? t("owner_owes") : t("i_net_owner")}</td>
            <td className="num" data-testid="statement-net">
              {negative ? <span className="chip warn">{amount(signed(periodNet))}</span> : money(periodNet)}
            </td>
          </tr>
          <tr>
            <td>{t("i_stmt_closing")}</td>
            <td className="num" data-testid="statement-closing">
              {amount(signed(figures.closing))}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="small" data-testid="statement-formula">
        {t("i_stmt_formula", {
          opening: signed(figures.opening),
          net: signed(periodNet),
          closing: signed(figures.closing),
        })}
      </p>
      {negative ? (
        <div className="bd">
          <div className="alert warn small" data-testid="owner-owes-reason">
            ⚠ {t("i_stmt_negative", { amount: signed(periodNet) })}
          </div>
        </div>
      ) : null}
      {lines && lines.length > 0 ? (
        <table className="t">
          <tbody>
            {lines.map((line, index) => (
              <tr key={`${line.line_type}-${index}`}>
                <td data-testid="statement-line">{line.description || t("i_expenses")}</td>
                <td className="num" data-testid="statement-line-amount">{amount(signed(Number(line.amount)))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {note ? <div className="bd">{note}</div> : null}
    </div>
  );
}
