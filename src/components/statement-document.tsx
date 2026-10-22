import type { ReactNode } from "react";
import type { Locale, T } from "@/i18n";
import { BrandImage } from "@/components/brand";
import { moneyLabel, ownerSettlement, signedMoneyLabel } from "@/server/format";
import { civilPeriodLabel, previousPeriod } from "@/server/rent-settlement-math";

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
    firm?: string;
    period_start?: string;
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
  const firm = Number(row.firm ?? 0);
  const money = (minor: number) => moneyLabel(minor, row.currency, locale);
  const signed = (minor: number) => signedMoneyLabel(minor, row.currency, locale);
  const bare = (minor: number) => money(Math.abs(minor)).replace(/^NT\$/, "");
  const period = row.period_start ? row.period_start.slice(0, 7) : "";
  const prev = period ? civilPeriodLabel(previousPeriod(period)) : "";
  const summary = [
    ["i_opening", money(figures.opening), "statement-opening"],
    ["i_stmt_firm_rent", money(firm), "statement-firm"],
    ["i_rent_received", money(figures.rent), "statement-rent"],
    ["i_other_income", money(figures.other), ""],
    ["i_fee", money(figures.fee), "statement-fee"],
    ["i_expenses", money(figures.expenses), ""],
    ["i_payouts", money(figures.payouts), "statement-payouts"],
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
            <td>{t("i_stmt_owner_net")}</td>
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
            <td>{t("i_closing")}</td>
            <td className="num" data-testid="statement-closing">
              {signed(figures.closing)}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="small" data-testid="statement-formula">
        {t("i_stmt_formula", {
          opening: money(figures.opening),
          firm: money(firm),
          costs: money(figures.costs),
          payouts: money(figures.payouts),
          closing: signed(figures.closing),
        })}
      </p>
      {prev ? (
        <p className="small muted" data-testid="statement-prev-close">
          {t("i_stmt_prev_close", { period: prev })} {money(figures.opening)}
        </p>
      ) : null}
      {figures.owes > 0 ? (
        <div className="bd">
          <div className="alert warn small" data-testid="owner-owes-reason">
            ⚠ {t("i_stmt_negative", { amount: bare(figures.owes) })}
          </div>
        </div>
      ) : null}
      {lines && lines.length > 0 ? (
        <table className="t">
          <tbody>
            {lines
              .filter((line) => !String(line.description ?? "").includes("電費（空房"))
              .map((line, index) => (
                <tr key={`${line.line_type}-${index}`}>
                  <td data-testid="statement-line">{line.description || t("i_expenses")}</td>
                  <td
                    className="num"
                    data-testid={String(line.description ?? "").includes("押金") ? "statement-deposit" : "statement-line-amount"}
                  >
                    {signedMoneyLabel(Number(line.amount), row.currency, locale)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      ) : null}
      <p className="small muted" data-testid="statement-footer">
        {t("i_stmt_footer")}
      </p>
      {note ? <div className="bd">{note}</div> : null}
    </div>
  );
}
