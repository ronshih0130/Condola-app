import React from "react";
import Link from "next/link";
import { makeT, translate, type Locale } from "../../i18n";
import { brandV3Copy } from "../../i18n/lanes/brand-v3";
import { moneyLabel } from "../../server/format";
import { displaySampleName } from "../../server/sandbox-data";
import type { StaffPaymentTurns } from "../../server/b3-payment-turns";
import type { rentRoll } from "../../server/queries";
import { RoleAvatar } from "./role-avatar";
import { TurnTag } from "./turn-tag";

export type BillRow = Pick<Awaited<ReturnType<typeof rentRoll>>[number], "currency" | "due" | "received">;

export function PaymentTurnGroups({ turns, locale }: { turns: StaffPaymentTurns; locale: Locale }) {
  if (turns.state !== "ready") return null;
  const copy = brandV3Copy(locale), t = makeT(locale);
  const groups = [
    { holder: "manager", role: "m", title: "yourTurnGroup", rows: turns.mine },
    { holder: "tenant", role: "t", title: "othersTurnGroup", rows: turns.others },
  ] as const;
  const visible = groups.filter(group => group.rows.length > 0);
  if (visible.length === 0) return null;
  return <div className="card v3-turn-groups">{visible.map(group => <section className="v3-turn-group" key={group.holder}>
    <h2>{translate(copy, group.title, { count: turns.counts.filter(count => count.holder === group.holder).reduce((sum, count) => sum + count.count, 0) })}</h2>
    <ul>{group.rows.map(row => <li key={row.id}>
      <Link className="v3-turn-row" href="/m/payments">
        <RoleAvatar role={group.role} locale={locale} />
        <span>{[displaySampleName(row.place), row.tenantName && displaySampleName(row.tenantName), moneyLabel(row.amountMinor, row.currency, locale)].filter(Boolean).join("・")}・{group.holder === "manager"
          ? <TurnTag>{translate(copy, "yourTurnStep", { step: t("i_confirm_received") })}</TurnTag>
          : translate(copy, "waitingTenant", { name: row.tenantName ? `${locale === "en" ? " " : ""}${displaySampleName(row.tenantName)}` : "" })}</span>
      </Link>
    </li>)}</ul>
  </section>)}</div>;
}

export function ConfirmedBills({ rows, month, locale }: { rows: BillRow[]; month: number; locale: Locale }) {
  const copy = brandV3Copy(locale);
  const totals = new Map<string, { due: number; received: number; paid: number; total: number }>();
  for (const row of rows) {
    const sum = totals.get(row.currency) ?? { due: 0, received: 0, paid: 0, total: 0 };
    const due = Number(row.due), received = Number(row.received);
    sum.due += due;
    sum.received += received;
    if (due > 0) {
      sum.total++;
      if (received >= due) sum.paid++;
    }
    totals.set(row.currency, sum);
  }
  return <>{Array.from(totals).filter(([, sum]) => sum.total > 0).map(([currency, sum]) => {
    const percent = sum.due > 0 ? Math.floor(sum.received / sum.due * 100) : undefined;
    const label = translate(copy, "confirmedBills", { month });
    const progress = translate(copy, percent === undefined ? "billProgressWithoutPercent" : "billProgress", {
      amount: moneyLabel(sum.due, currency, locale), percent: percent ?? "", paid: sum.paid, total: sum.total,
    });
    return <section className="card v3-confirmed-bills" key={currency} data-testid="confirmed-bills" data-currency={currency}>
      <div><p>{label}</p><p className="v3-bill-amount">{moneyLabel(sum.received, currency, locale)}</p><Link className="v3-bill-source" href="/m/rent">{copy.source}</Link></div>
      <div>{percent !== undefined && <progress className="v3-bill-progress" value={Math.max(0, Math.min(100, percent))} max={100} aria-label={progress} />}<p>{progress}</p></div>
    </section>;
  })}</>;
}
