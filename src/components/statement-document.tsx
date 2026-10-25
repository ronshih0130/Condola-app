import React, { type ReactNode } from "react";
import type { Locale, T } from "@/i18n";
import { BrandImage } from "@/components/brand";
import { moneyLabel, ownerSettlement, signedMoneyLabel, statementPeriodNet } from "@/server/format";

export function StatementDocument({
  t,
  locale,
  row,
  lines,
  note,
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
  const signed = (minor: number) => signedMoneyLabel(minor, row.currency, locale);
  const periodNet = statementPeriodNet(figures);
  const bare = money(Math.abs(figures.net)).replace(/^NT\$/, "");
  const summary = [
    ["i_stmt_opening", signed(figures.opening), "statement-opening"],
    ["i_rent_received", money(figures.rent), "statement-rent"],
    ["i_other_income", money(figures.other), ""],
    ["i_fee", money(figures.fee), "statement-fee"],
    ["i_expenses", signed(figures.expenses), ""],
  ] as const;
  return (
    <div className="card" style={{ maxWidth: 640 }} data-testid="statement-document">
      <BrandImage variant="horizontal" alt={t("i_brand")} className="statement-logo" />
      <table className="t">
        <tbody>
          {summary.map(([key, value, testid]) => (
            <tr key={key}>
              <td>{t(key)}</td>
              <td className="num" data-testid={testid || undefined}>
                {value}
              </td>
            </tr>
          ))}
          <tr>
            <td>{t("i_net_owner")}</td>
            <td className="num" data-testid="statement-net">
              {figures.owes > 0 ? (
                <span className="chip warn" data-testid="owner-owes">
                  {t("owner_owes")} {signed(-figures.owes)}
                </span>
              ) : (
                money(figures.payable)
              )}
            </td>
          </tr>
          <tr>
            <td>{t("i_stmt_closing")}</td>
            <td className="num" data-testid="statement-closing">
              {signed(figures.closing)}
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
      {figures.owes > 0 ? (
        <div className="bd">
          <div className="alert warn small" data-testid="owner-owes-reason">
            ⚠ {t("i_stmt_negative", { amount: bare })}
          </div>
        </div>
      ) : null}
      {lines && lines.length > 0 ? (
        <table className="t">
          <tbody>
            {lines.map((line, index) => (
              <tr key={`${line.line_type}-${index}`}>
                <td data-testid="statement-line">{line.description || t("i_expenses")}</td>
                <td className="num" data-testid="statement-line-amount">{signedMoneyLabel(Number(line.amount), row.currency, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {note ? <div className="bd">{note}</div> : null}
    </div>
  );
}
