import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeT } from "@/i18n";
import { StatementDocument } from "@/components/statement-document";

const t = makeT("zh-TW");

/** The statement page renders StatementDocument. This is that same render. */
export function renderStatementPage(row: {
  opening: number;
  rent: number;
  other: number;
  fee: number;
  expenses: number;
  payouts: number;
  closing: number;
}) {
  const body = renderToStaticMarkup(
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
      }}
      lines={[{ line_type: "expense", description: "冷氣維修", amount: String(row.expenses) }]}
    />,
  );
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"></head><body>${body}</body></html>\n`;
}
