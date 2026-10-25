import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Link from "next/link";
import { makeT } from "@/i18n";
import { StatementDocument } from "@/components/statement-document";
import { StatementRosterTable } from "@/components/statement-roster";
import { moneyLabel, ownerSettlement, signedMoneyLabel } from "@/server/format";
import { civilPeriodLabel } from "@/server/rent-settlement-math";

const t = makeT("zh-TW");

function page(body: string) {
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"></head><body>${body}</body></html>\n`;
}

/** The statement page renders StatementDocument. This is that same render. */
export function renderStatementPage(row: {
  opening: number;
  rent: number;
  other: number;
  fee: number;
  expenses: number;
  payouts: number;
  closing: number;
  firm: number;
}) {
  return page(
    renderToStaticMarkup(
      <StatementDocument
        t={t}
        locale="zh-TW"
        row={{
          currency: "TWD",
          opening: String(row.opening),
          rent: String(row.rent),
          other: String(row.other),
          fee: String(row.fee),
          expenses: String(row.expenses),
          payouts: String(row.payouts),
          closing: String(row.closing),
          firm: String(row.firm),
          period_start: "2026-10-01",
        }}
        lines={[{ line_type: "expense", description: "冷氣維修", amount: String(row.expenses) }]}
      />,
    ),
  );
}

/** The settlement list on /m/statements renders StatementRosterTable. */
export function renderSettlementList(row: {
  opening: number;
  rent: number;
  other: number;
  fee: number;
  expenses: number;
  payouts: number;
  closing: number;
}) {
  const figures = ownerSettlement({
    opening: row.opening,
    rent: row.rent,
    other: row.other,
    fee: row.fee,
    expenses: row.expenses,
    payouts: row.payouts,
    closing: row.closing,
  });
  const money = (minor: number) => moneyLabel(minor, "TWD", "zh-TW");
  const signed = (minor: number) => signedMoneyLabel(minor, "TWD", "zh-TW");
  const net =
    figures.owes > 0 ? (
      <span className="chip warn" data-testid="owner-owes">
        {t("owner_owes")} {signed(-figures.owes)}
      </span>
    ) : (
      money(figures.payable)
    );
  return page(
    renderToStaticMarkup(
      <StatementRosterTable
        t={t}
        rows={[
          {
            key: "qa",
            ownerName: "QA屋主甲",
            periodLabel: "2026年10月",
            units: "1",
            opening: signed(figures.opening),
            rent: money(figures.rent),
            costs: money(figures.costs),
            net,
            closing: signed(figures.closing),
            status: <span className="chip ok">{t("i_generated")}</span>,
          },
        ]}
      />,
    ),
  );
}

/** The owner list at /o/statements. Opening and closing are on each row. */
export function renderOwnerStatementList(row: {
  opening: number;
  rent: number;
  other: number;
  fee: number;
  expenses: number;
  payouts: number;
  closing: number;
}) {
  const figures = ownerSettlement({
    opening: row.opening,
    rent: row.rent,
    other: row.other,
    fee: row.fee,
    expenses: row.expenses,
    payouts: row.payouts,
    closing: row.closing,
  });
  const amount =
    figures.owes > 0
      ? signedMoneyLabel(-figures.owes, "TWD", "zh-TW")
      : moneyLabel(Math.max(0, figures.payable), "TWD", "zh-TW");
  const signed = (minor: number) => signedMoneyLabel(minor, "TWD", "zh-TW");
  return page(
    renderToStaticMarkup(
      <div>
        <h2>{t("i_owner_nav_stmt")}</h2>
        <p>
          <Link href="/o/statements/10000000-0000-4000-8000-000000000088">
            {civilPeriodLabel("2026-10")} · {t("i_opening")} {signed(figures.opening)} · {t("i_closing")} {signed(figures.closing)} ·{" "}
            {figures.owes > 0 ? (
              <span className="chip warn" data-testid="owner-owes">
                {t("owner_owes")} {amount}
              </span>
            ) : (
              amount
            )}
          </Link>
        </p>
      </div>,
    ),
  );
}
