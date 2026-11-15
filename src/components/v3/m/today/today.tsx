import React from "react";
import Link from "next/link";
import { dictionary, makeT, translate, type Locale } from "../../../../i18n";
import { brandV3TodayCopy, brandV3NavigationCopy } from "../../../../i18n/lanes/brand-v3";
import { hasMonthlyFigure, monthlyBillTotals, rowKey, todayOverview, todayRowHref, type TodayMonthly, type TodayTurns, type TodayRow, type TodayMore } from "../../../../lib/b3-today";
import { EMPTY_ACTIONS, emptyActionAllowed, resolveEmptyCta } from "../../../../lib/empty-cta";
import { formatDate, moneyLabel } from "../../../../server/format";
import { displaySampleName } from "../../../../server/sandbox-data";
import type { SetupProgress } from "../../../../server/onboarding-progress";
import type { PermKey } from "../../../../server/perms";
import type { Session } from "../../../../server/types";
import { OnboardingProgress } from "../../../onboarding-progress";
import { EmptyPrimary, EmptyState } from "../../../empty-state";
import { RoleAvatar } from "../../role-avatar";
import { ClearDrawing } from "./clear-drawing";
import { SignupNotice } from "./signup-notice";

function TurnRow({ item, session, roomUnits }: { item: TodayRow; session: Session; roomUnits: Record<string, string> }) {
  const copy = brandV3TodayCopy(session.locale);
  const tr = (key: keyof typeof copy, vars: Record<string, string | number> = {}) => translate(copy, key, vars);
  const row = item.row;
  const name = row.tenantName ? displaySampleName(row.tenantName) : "";
  const waitName = name ? `${session.locale === "en" ? " " : ""}${name}` : "";
  const date = (value: string) => formatDate(value, session.locale, session.calendar, dictionary(session.locale));
  let subline = "", badge = "", turn = "";
  const mine = item.type === "rental" || (item.type === "payment" && item.row.holder === "manager");
  if (item.type === "payment") {
    // The payment reader has paidOn, not the invoice's rent period. Never invent a rent month.
    subline = [name, moneyLabel(item.row.amountMinor, item.row.currency, session.locale)].filter(Boolean).join("・");
    badge = mine ? copy.reported : "";
    turn = mine ? tr("yourStep", { step: copy.confirm }) : tr("reReport", { name: waitName });
  } else if (item.type === "overdue") {
    // This is an all-period/all-charge balance, not just oldestMonth's rent.
    // Keep the sourced tenant and amount; the approved rent-period clause needs a breakdown.
    subline = [name, moneyLabel(item.row.amountMinor, item.row.currency, session.locale)].filter(Boolean).join("・");
    badge = tr("overdue", { days: item.row.dayNumber });
    turn = tr("overdueTurn", { name: waitName });
    // Reminder history is unavailable, not a fabricated zero or successful delivery.
  } else {
    const rental = item.row;
    if (rental.kind === "vacant") {
      subline = [rental.dayNumber !== null ? tr("vacantDays", { days: rental.dayNumber }) : "",
        rental.rentMinor !== null && rental.rentCurrency ? tr("vacantRent", { amount: moneyLabel(rental.rentMinor, rental.rentCurrency, session.locale) }) : ""].filter(Boolean).join("・");
      badge = copy.vacantBadge; turn = tr("yourStep", { step: copy.vacant });
    } else if (rental.kind === "renewal_ask") {
      subline = [name, rental.date ? tr("renewalDate", { date: date(rental.date) }) : ""].filter(Boolean).join("・");
      badge = rental.dayNumber !== null ? tr("renewalDays", { days: rental.dayNumber }) : "";
      turn = tr("yourStep", { step: copy.renewal });
    } else {
      // Reader merges notice and declined-renewal cases without exposing the reason.
      // Do not claim "不續約" for a notice-only case; keep the sourced name/date subset.
      subline = [name, rental.date ? tr("departureDate", { date: date(rental.date) }) : ""].filter(Boolean).join("・");
      badge = copy.earlyBadge; turn = tr("yourStep", { step: copy.early });
    }
  }
  return <li data-turn-kind={item.type === "rental" ? item.row.kind : item.type === "payment" ? item.row.rule : "overdue"}>
    <Link className="v3-today-row" href={todayRowHref(item, roomUnits)}>
      <span className="v3-today-row-main"><strong>{displaySampleName(row.place)}</strong>{subline && <span>{subline}</span>}</span>
      {badge ? <span className={`v3-today-badge${item.type === "overdue" ? " v3-today-badge-overdue" : ""}`}>{badge}</span> : <span />}
      <span className="v3-today-turn"><RoleAvatar role={mine ? "m" : "t"} locale={session.locale} /><span>{turn}</span></span>
    </Link>
  </li>;
}
function TurnGroup({ holder, count, rows, more, session, roomUnits }: {
  holder: "mine" | "others"; count: number; rows: TodayRow[]; more: TodayMore[]; session: Session; roomUnits: Record<string, string>;
}) {
  if (!count) return null;
  const copy = brandV3TodayCopy(session.locale);
  // The money area name exists only as the navigation string (copy guard, PLT-49): reuse it.
  const areaMoney = brandV3NavigationCopy(session.locale).money;
  const names = { payments: copy.confirm, vacant: copy.vacant, renewal: copy.renewal, early: copy.early, overdue: areaMoney };
  return <section className="v3-today-group" data-testid={`today-${holder}`} aria-labelledby={`today-${holder}-title`}>
    <h2 id={`today-${holder}-title`}>{translate(copy, holder, { count })}</h2>
    <ul>{rows.map(item => <TurnRow key={rowKey(item)} item={item} session={session} roomUnits={roomUnits} />)}</ul>
    {more.length > 0 && <div className="v3-today-more">{more.map(item => <Link key={item.kind} href={item.href}>
      {more.length > 1 && <span>{names[item.kind]}・</span>}{translate(copy, "more", { count: item.count })}
    </Link>)}</div>}
  </section>;
}
export function ConfirmedBills({ data, locale }: { data: TodayMonthly; locale: Locale }) {
  const copy = brandV3TodayCopy(locale);
  return <div className="v3-today-monthly" data-testid="today-monthly">{monthlyBillTotals(data.rows, data.defaultCurrency).map(([currency, sum]) => {
    const percent = sum.due > BigInt(0) ? Number(sum.received * BigInt(100) / sum.due) : undefined;
    const zero = sum.received === BigInt(0);
    const progress = translate(copy, zero || percent === undefined ? "billProgressWithoutPercent" : "billProgress", {
      amount: moneyLabel(sum.due.toString(), currency, locale), percent: percent ?? "", paid: sum.paid, total: sum.total,
    });
    return <section className="card v3-today-bills" key={currency} data-testid="confirmed-bills" data-currency={currency}>
      <div><h2>{translate(copy, "confirmedBills", { month: data.month })}</h2>
        <p className={`v3-today-amount${zero ? " v3-today-amount-empty" : ""}`}>{zero ? copy.noConfirmed : moneyLabel(sum.received.toString(), currency, locale)}</p>
        <Link href="/m/rent">{copy.source}</Link></div>
      <div>{percent !== undefined && <progress value={Math.max(0, Math.min(100, percent))} max={100} aria-label={progress} />}<p>{progress}</p></div>
    </section>;
  })}</div>;
}
function SetupCard({ setup, locale }: { setup: SetupProgress; locale: Locale }) {
  const permitted = (key: PermKey) => setup.permissions.includes(key);
  if (!setup.checklistOn || !setup.checklist) {
    if (setup.hasUnits) return null;
    const cta = resolveEmptyCta({ page: "DASH", setup, can: permitted });
    return <div className="card v3-today-setup"><EmptyState id="DASH" locale={locale} cta={cta} /></div>;
  }
  // Shared progress stores the first global step; managers skip company details.
  const next = setup.checklist.steps.find(step => !step.done);
  const visibleSetup = { ...setup, step: (next?.index ?? 4) as SetupProgress["step"] };
  const cta = resolveEmptyCta({ page: "DASH", setup: visibleSetup, can: permitted });
  if (!setup.checklist.completedAt && setup.hasUnits && visibleSetup.step < 2) {
    const action = next?.id === "company" ? EMPTY_ACTIONS.company : next?.id === "unit" ? EMPTY_ACTIONS.unit : null;
    if (emptyActionAllowed(action, setup, permitted)) cta.primary = action;
  }
  const noUnits = !setup.hasUnits && !setup.checklist.completedAt;
  const needsEarlyAction = !setup.checklist.completedAt && setup.hasUnits && visibleSetup.step < 2;
  return <div className="card v3-today-setup"><OnboardingProgress progress={visibleSetup} locale={locale} cta={cta} />
    {noUnits && <EmptyState id="DASH" locale={locale} cta={cta} />}
    {needsEarlyAction && cta.primary && <EmptyPrimary action={cta.primary} locale={locale} />}
  </div>;
}
export function TodayPage({ session, turns, monthly, setup, setupFailed = false, query }: {
  session: Session; turns: TodayTurns; monthly?: TodayMonthly; setup?: SetupProgress; setupFailed?: boolean; query: { dupFirm?: string; code?: string };
}) {
  const copy = brandV3TodayCopy(session.locale), overview = setupFailed ? { state: "unavailable" as const } : todayOverview(turns);
  // The money area name exists only as the navigation string (copy guard, PLT-49): reuse it.
  const areaMoney = brandV3NavigationCopy(session.locale).money;
  const setupPending = !!setup && (session.role === "admin" || session.role === "manager") && (!setup.hasUnits
    || (setup.checklistOn && !!setup.checklist && !setup.checklist.completedAt && setup.checklist.steps.some(step => !step.done)));
  const noTurnsDuringSetup = setupPending && (overview.state === "off" || (overview.state === "ready" && !overview.mineCount && !overview.othersCount));
  const name = session.name.trim();
  const greeting = name ? translate(copy, "greeting", { name }) : "";
  let headline: string;
  if (overview.state === "unavailable") headline = name ? translate(copy, "greetingOnly", { name }) : copy.failure;
  else if (noTurnsDuringSetup || overview.state === "off") headline = name ? translate(copy, "greetingOnly", { name })
    : noTurnsDuringSetup ? makeT(session.locale)("es_setup_title") : copy.title;
  else headline = greeting + (overview.mineCount ? translate(copy, "headline", { count: overview.mineCount }) : overview.othersCount ? copy.waitingHeadline : copy.clearHeadline);
  let supporting = "";
  if (overview.state === "ready") {
    const actions = (["payments", "renewal", "early", "vacant"] as const).flatMap(kind => overview.counts[kind]
      ? [translate(copy, ({ payments: "paymentSummary", renewal: "renewalSummary", early: "earlySummary", vacant: "vacantSummary" } as const)[kind], { count: overview.counts[kind] })] : []);
    supporting = (actions.length ? actions.join(copy.separator) + copy.summaryEnd : "") + (overview.othersCount ? translate(copy, "waitingSummary", { count: overview.othersCount }) : "");
  }
  if (session.environment === "sandbox") supporting = copy.sandbox;
  const checkedAreas = overview.state === "ready" ? [overview.checkedPayments && areaMoney, overview.checkedRentals && copy.rentals].filter(Boolean).join(copy.separator) : "";
  return <div className="v3-today" data-testid="today-v3">
    <SignupNotice query={query} locale={session.locale} />
    <header className="v3-lead v3-today-lead"><h1 data-testid="today-headline">{headline}</h1>{supporting && <p data-testid="today-supporting">{supporting}</p>}</header>
    {setup && (session.role === "admin" || session.role === "manager") && <SetupCard setup={setup} locale={session.locale} />}
    {overview.state === "unavailable" ? <section className="card v3-today-message" data-testid="today-failure">
      {name && <h2>{copy.failure}</h2>}<p>{copy.failureDetail}</p><form action="/m" method="get"><button className="btn o" type="submit">{copy.retry}</button></form>
    </section> : overview.state === "off" ? null : overview.mineCount || overview.othersCount ? <div className="card v3-today-groups">
      <TurnGroup holder="mine" count={overview.mineCount} rows={overview.mine} more={overview.mineMore} session={session} roomUnits={turns.roomUnits} />
      <TurnGroup holder="others" count={overview.othersCount} rows={overview.others} more={overview.othersMore} session={session} roomUnits={turns.roomUnits} />
    </div> : noTurnsDuringSetup ? null : <section className="card v3-today-message v3-today-clear" data-testid="today-clear">
      <ClearDrawing /><h2>{copy.clear}</h2>{checkedAreas && <p>{translate(copy, "checked", { areas: checkedAreas })}</p>}
    </section>}
    {hasMonthlyFigure(monthly) && <ConfirmedBills data={monthly} locale={session.locale} />}
  </div>;
}
