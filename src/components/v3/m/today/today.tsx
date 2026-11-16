import React from "react";
import Link from "next/link";
import { dictionary, makeT, translate, type Locale } from "../../../../i18n";
import { brandV3TodayCopy, brandV3NavigationCopy } from "../../../../i18n/lanes/brand-v3";
import { hasMonthlyFigure, monthlyBillTotals, rowKey, todayOverview, todayRowHref, type TodayMonthly, type TodayTurns, type TodayRow, type TodayMore, type WaitingParty } from "../../../../lib/b3-today";
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

type TodayCopy = ReturnType<typeof brandV3TodayCopy>;
type Avatar = "m" | "t" | "o" | "v";
const REPAIR_STEP: Record<string, keyof TodayCopy> = { confirm_cost: "repairConfirm", dispatch: "repairDispatch", re_estimate: "repairReEstimate",
  in_progress: "repairInProgress", approve_estimate: "repairApprove", do_repair: "repairDo", report_cost: "repairReport" };
/** MGT-105-AC2 「最久 {多久}」: whole hours (at least 1) under two days, then whole days. */
export function waitLabel(copy: TodayCopy, since: string | null, now: Date): string {
  const ms = since ? now.getTime() - Date.parse(since) : NaN;
  if (!Number.isFinite(ms)) return "";
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return hours < 48 ? translate(copy, "waitHours", { count: hours }) : translate(copy, "waitDays", { count: Math.floor(hours / 24) });
}
/** MGT-149-AC2/AC5: B6 sentences; 「輪到你」 only when the viewer can act; no day clause when inexact. */
function repairRow(row: Extract<TodayRow, { type: "repair" }>["row"], copy: TodayCopy) {
  const tr = (key: keyof TodayCopy, vars: Record<string, string | number> = {}) => translate(copy, key, vars);
  const stepKey = REPAIR_STEP[row.step];
  if (!stepKey) throw new Error("Unapproved repair step");
  const step = copy[stepKey] as string;
  const mine = row.holder === "manager" && row.viewerCanAct;
  const turn = mine ? tr("yourStep", { step }) : row.holder === "owner" ? tr("waitOwner", { step })
    : row.holder === "vendor" ? tr("waitVendor", { step }) : tr("waitManager", { step });
  const why = row.why === "declined" ? copy.whyDeclined : row.why === "link" ? copy.whyLink : "";
  return { main: row.place, subline: [row.title, why].filter(Boolean).join(copy.separatorDot),
    turn: row.dayNumber !== null ? [turn, tr("repairDay", { days: row.dayNumber })].join(copy.separatorDot) : turn,
    avatar: ({ manager: "m", owner: "o", vendor: "v" } as const)[row.holder as "manager" | "owner" | "vendor"] ?? "m", mine };
}
function TurnRow({ item, session, roomUnits, now }: { item: TodayRow; session: Session; roomUnits: Record<string, string>; now: Date }) {
  const copy = brandV3TodayCopy(session.locale);
  const tr = (key: keyof typeof copy, vars: Record<string, string | number> = {}) => translate(copy, key, vars);
  const date = (value: string) => formatDate(value, session.locale, session.calendar, dictionary(session.locale));
  let main = "", subline = "", badge = "", turn = "", avatar: Avatar = "m", mine = true, kind = "";
  if (item.type === "repair") {
    ({ main, subline, turn, avatar, mine } = repairRow(item.row, copy)); kind = `repair-${item.row.step}`;
  } else if (item.type === "reply") {
    main = copy.replyTitle; kind = "reply";
    const wait = waitLabel(copy, item.row.oldest, now);
    subline = wait ? tr("replyLine", { count: item.row.threads, wait }) : "";
    turn = tr("yourStep", { step: copy.reply });
  } else if (item.type === "bank") {
    main = copy.bankTitle; kind = "bank"; subline = tr("bankLine", { count: item.row.count }); turn = tr("yourStep", { step: copy.bank });
  } else if (item.type === "monthClose") {
    main = copy.monthCloseTitle; kind = "month-close";
    subline = tr("monthCloseLine", { month: item.row.month, count: item.row.owners });
    turn = tr("yourStep", { step: copy.monthClose });
  } else {
    const row = item.row;
    main = row.place;
    const name = row.tenantName ? displaySampleName(row.tenantName) : "";
    const waitName = name ? `${session.locale === "en" ? " " : ""}${name}` : "";
    mine = item.type === "rental" || (item.type === "payment" && item.row.holder === "manager");
    avatar = mine ? "m" : "t";
    kind = item.type === "rental" ? item.row.kind : item.type === "payment" ? item.row.rule : "overdue";
    if (item.type === "payment") {
      // The payment reader has paidOn, not the invoice's rent period. Never invent a rent month.
      subline = [name, moneyLabel(item.row.amountMinor, item.row.currency, session.locale)].filter(Boolean).join("・");
      badge = mine ? copy.reported : "";
      turn = mine ? tr("yourStep", { step: copy.confirm }) : tr("reReport", { name: waitName });
    } else if (item.type === "overdue") {
      // T-ROWS (hub PR #15): exactly one rent invoice → 「{租客}・{月} 月租金 NT$…」; otherwise 「{租客}・逾期未繳 NT$…」.
      const amount = moneyLabel(item.row.amountMinor, item.row.currency, session.locale);
      subline = [name, item.row.singleRentInvoice ? tr("overdueRent", { month: item.row.oldestMonth, amount }) : tr("overdueOpen", { amount })].filter(Boolean).join("・");
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
        // T-ROWS (hub PR #15): declined renewal → 「{租客}不續約・{date} 搬出」; a recorded notice → 「{租客}・{date} 搬出」.
        const who = rental.reason === "declined" && name ? tr("declined", { name }) : name;
        subline = [who, rental.date ? tr("departureDate", { date: date(rental.date) }) : ""].filter(Boolean).join("・");
        badge = copy.earlyBadge; turn = tr("yourStep", { step: copy.early });
      }
    }
  }
  // One holder avatar, one sentence, the whole row is the link; nothing actionable inside it (T-ROWS-2).
  return <li data-turn-kind={kind}>
    <Link className="v3-today-row" href={todayRowHref(item, roomUnits)}>
      <span className="v3-today-row-main"><strong>{displaySampleName(main)}</strong>{subline && <span>{subline}</span>}</span>
      {badge ? <span className={`v3-today-badge${item.type === "overdue" ? " v3-today-badge-overdue" : ""}`}>{badge}</span> : <span />}
      <span className="v3-today-turn"><RoleAvatar role={avatar} locale={session.locale} /><span>{turn}</span></span>
    </Link>
  </li>;
}
function TurnGroup({ holder, count, rows, more, session, roomUnits, now }: {
  holder: "mine" | "others"; count: number; rows: TodayRow[]; more: TodayMore[]; session: Session; roomUnits: Record<string, string>; now: Date;
}) {
  if (!count) return null;
  const copy = brandV3TodayCopy(session.locale);
  // Area names exist only as navigation strings (copy guard, PLT-49): reuse them.
  const nav = brandV3NavigationCopy(session.locale);
  const names: Record<TodayMore["kind"], string> = { payments: copy.confirm, vacant: copy.vacant, renewal: copy.renewal, early: copy.early, overdue: nav.money,
    repairs: nav.maintenance };
  return <section className="v3-today-group" data-testid={`today-${holder}`} aria-labelledby={`today-${holder}-title`}>
    <h2 id={`today-${holder}-title`}>{translate(copy, holder, { count })}</h2>
    <ul>{rows.map(item => <TurnRow key={rowKey(item)} item={item} session={session} roomUnits={roomUnits} now={now} />)}</ul>
    {more.length > 0 && <div className="v3-today-more">{more.map(item => <Link key={item.kind} href={item.href}>
      {more.length > 1 && <span>{names[item.kind]}・</span>}{translate(copy, "more", { count: item.count })}
    </Link>)}</div>}
  </section>;
}
/** T-LINE: 「{動作} {n} 筆／件、…。另外 {k} 件在等{各方}。」; only parties with rows are named. */
export function waitingParties(copy: ReturnType<typeof brandV3TodayCopy>, waiting: Record<WaitingParty, number>): string {
  // Frames name only 租客／屋主／廠商; staff-held rows the viewer cannot act on still count in {k} but are not named.
  const parties = (["tenant", "owner", "vendor"] as const).filter(party => waiting[party] > 0)
    .map(party => copy[({ tenant: "partyTenant", owner: "partyOwner", vendor: "partyVendor" } as const)[party]]);
  return parties.length > 1 ? `${parties.slice(0, -1).join(copy.separator)}${copy.partyLast}${parties.at(-1)}` : parties[0] ?? "";
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
/** T-SETUP (GS-47 = A): while the next visible setup step is 邀請租客 or 租客加入 (2–3 of 4), 今天 shows only the
 * checklist. Returns the steps still left, or null when normal 今天 applies (flag OFF, 0–1 steps, done, other roles). */
export function setupOnlyRemaining(setup: SetupProgress | undefined, role: Session["role"]): number | null {
  if (!setup || (role !== "admin" && role !== "manager")) return null;
  const list = setup.checklist;
  if (!setup.checklistOn || !list || list.completedAt || !setup.hasUnits) return null;
  const next = list.steps.find(step => !step.done);
  return next && next.index >= 2 ? list.total - list.completed : null;
}
function SetupCard({ setup, locale, only = false }: { setup: SetupProgress; locale: Locale; only?: boolean }) {
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
  return <div className={`card v3-today-setup${only ? " v3-today-setup-only" : ""}`}><OnboardingProgress progress={visibleSetup} locale={locale} cta={cta} />
    {noUnits && <EmptyState id="DASH" locale={locale} cta={cta} />}
    {needsEarlyAction && cta.primary && <EmptyPrimary action={cta.primary} locale={locale} />}
  </div>;
}
export function TodayPage({ session, turns, monthly, setup, setupFailed = false, query, interim, now = new Date() }: {
  session: Session; turns: TodayTurns; monthly?: TodayMonthly; setup?: SetupProgress; setupFailed?: boolean; query: { dupFirm?: string; code?: string };
  interim?: InterimNumbers; now?: Date;
}) {
  const copy = brandV3TodayCopy(session.locale), overview = setupFailed ? { state: "unavailable" as const } : todayOverview(turns);
  // The money area name exists only as the navigation string (copy guard, PLT-49): reuse it.
  const areaMoney = brandV3NavigationCopy(session.locale).money;
  const setupPending = !!setup && (session.role === "admin" || session.role === "manager") && (!setup.hasUnits
    || (setup.checklistOn && !!setup.checklist && !setup.checklist.completedAt && setup.checklist.steps.some(step => !step.done)));
  const noTurnsDuringSetup = setupPending && (overview.state === "off" || (overview.state === "ready" && !overview.mineCount && !overview.othersCount));
  const name = session.name.trim();
  const setupLeft = setupOnlyRemaining(setup, session.role);
  if (setup && setupLeft !== null) {
    // Checklist only: no turn groups, waiting groups, number block, interim KPIs or supporting line (GS-47).
    return <div className="v3-today" data-testid="today-v3" data-setup-only="">
      <SignupNotice query={query} locale={session.locale} />
      <header className="v3-lead v3-today-lead"><h1 data-testid="today-headline">
        {name ? translate(copy, "setupHeadline", { name, k: setupLeft }) : translate(copy, "setupHeadlineNoName", { k: setupLeft })}</h1></header>
      <SetupCard setup={setup} locale={session.locale} only />
    </div>;
  }
  const greeting = name ? translate(copy, "greeting", { name }) : "";
  let headline: string;
  if (overview.state === "unavailable") headline = name ? translate(copy, "greetingOnly", { name }) : copy.failure;
  else if (noTurnsDuringSetup || overview.state === "off") headline = name ? translate(copy, "greetingOnly", { name })
    : noTurnsDuringSetup ? makeT(session.locale)("es_setup_title") : copy.title;
  else headline = greeting + (overview.mineCount ? translate(copy, "headline", { count: overview.mineCount }) : overview.othersCount ? copy.waitingHeadline : copy.clearHeadline);
  let supporting = "";
  if (overview.state === "ready") {
    // Same kind order as the 輪到你 group (MGT-148-AC3, MGT-149-AC4).
    const summaries = { payments: "paymentSummary", confirmCost: "confirmCostSummary", dispatch: "dispatchSummary", reEstimate: "reEstimateSummary",
      reply: "replySummary", bank: "bankSummary", monthClose: "monthCloseSummary",
      renewal: "renewalSummary", early: "earlySummary", vacant: "vacantSummary" } as const;
    const actions = (Object.keys(summaries) as (keyof typeof summaries)[]).flatMap(kind => overview.counts[kind]
      ? [translate(copy, summaries[kind], { count: overview.summary[kind] })] : []);
    supporting = (actions.length ? actions.join(copy.separator) + copy.summaryEnd : "")
      // With only staff-held waits there is no drawn party to name, so the sentence is left out (GS-44).
      + (overview.othersCount && waitingParties(copy, overview.waiting) ? translate(copy, "waitingSummary", { count: overview.othersCount, parties: waitingParties(copy, overview.waiting) }) : "");
  }
  if (session.environment === "sandbox") supporting = copy.sandbox;
  const checkedAreas = overview.state === "ready" ? [overview.checkedPayments && areaMoney, overview.checkedRentals && copy.rentals,
    overview.checkedRepairs && brandV3NavigationCopy(session.locale).maintenance].filter(Boolean).join(copy.separator) : "";
  return <div className="v3-today" data-testid="today-v3">
    <SignupNotice query={query} locale={session.locale} />
    <header className="v3-lead v3-today-lead"><h1 data-testid="today-headline">{headline}</h1>{supporting && <p data-testid="today-supporting">{supporting}</p>}</header>
    {setup && (session.role === "admin" || session.role === "manager") && <SetupCard setup={setup} locale={session.locale} />}
    {overview.state === "unavailable" ? <section className="card v3-today-message" data-testid="today-failure">
      {name && <h2>{copy.failure}</h2>}<p>{copy.failureDetail}</p><form action="/m" method="get"><button className="btn o" type="submit">{copy.retry}</button></form>
    </section> : overview.state === "off" ? null : overview.mineCount || overview.othersCount ? <div className="card v3-today-groups">
      <TurnGroup holder="mine" count={overview.mineCount} rows={overview.mine} more={overview.mineMore} session={session} roomUnits={turns.roomUnits} now={now} />
      <TurnGroup holder="others" count={overview.othersCount} rows={overview.others} more={overview.othersMore} session={session} roomUnits={turns.roomUnits} now={now} />
    </div> : noTurnsDuringSetup ? null : <section className="card v3-today-message v3-today-clear" data-testid="today-clear">
      <ClearDrawing /><h2>{copy.clear}</h2>{checkedAreas && <p>{translate(copy, "checked", { areas: checkedAreas })}</p>}
    </section>}
    {hasMonthlyFigure(monthly) && <ConfirmedBills data={monthly} locale={session.locale} />}
    {interim ? <InterimCards data={interim} locale={session.locale} /> : null}
  </div>;
}


/** B3A-TODAY-NUM interim: the two numbers that have not reached their destination pages yet, unchanged from today's
 * dashboard (same labels, values and links); each leaves 今天 in the PR that adds it to its page. 已繳 and 待確認 are not
 * shown (the large number replaces 已繳; the to-confirm count is on the money page).
 * 未結餘額 moved to the money month page in phase 3 PR 2. */
export type InterimNumbers = { outstanding: string | number; owingCount: number; tickets: number; occupied: number; rooms: number };
export function InterimCards({ data, locale }: { data: InterimNumbers; locale: Locale }) {
  const t = makeT(locale);
  const cards = [
    data.tickets > 0 ? <Link key="tickets" className="card kpi" href="/m/tickets"><div className="lbl">{t("i_nav_tickets")}</div><div className="val">{data.tickets}</div></Link> : null,
    data.occupied > 0 ? <Link key="occupied" className="card kpi" href="/m/leases"><div className="lbl">{t("i_occ")}</div><div className="val">{data.occupied}/{data.rooms}</div></Link> : null,
  ].filter(Boolean);
  return cards.length ? <div className="grid5 v3-today-interim" data-testid="today-interim">{cards}</div> : null;
}
