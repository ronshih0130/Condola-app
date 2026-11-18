import React, { type ReactNode } from "react";
import Link from "next/link";
import { dictionary, type Locale } from "../../../i18n";
import { brandV3TenantLeaseRepairCopy } from "../../../i18n/lanes/brand-v3-tenant-lease-repair";
import { formatDate } from "../../../server/format";
import type { RepairStage, TenantRepairProgress, TenantRepairRow } from "../../../server/b090-tenant-lease-repair";
import type { CalendarMode } from "../../../server/types";
import { Illustration } from "../illustrations";

/** The badge word for a stage: the step name, or 已取消. */
export function repairStageLabel(stage: RepairStage, locale: Locale): string {
  const copy = brandV3TenantLeaseRepairCopy(locale).repair;
  return stage === "cancelled" ? copy.cancelled : copy.steps[stage];
}

/** TEN-56-AC4: one sentence on whose turn it is / what happens next, from the ticket status only. */
export function repairLead(stage: RepairStage, locale: Locale, company: string): string {
  return brandV3TenantLeaseRepairCopy(locale).repair.lead[stage].replace("{company}", company);
}

/**
 * RT-REPAIR list (`/t/repair`). Each repair is the RT-HOME card: 「報修・{title}」, its step badge and 「看進度」 (text).
 * The existing 新增報修 form follows unchanged (RT-REPAIR-NEW with the visit choice needs B-088).
 */
export function TenantRepairListV3({ repairs, locale, notices, empty, newForm }: {
  repairs: TenantRepairRow[]; locale: Locale; notices: ReactNode; empty: { title: string; hint: string }; newForm: ReactNode;
}) {
  const copy = brandV3TenantLeaseRepairCopy(locale).repair;
  return <section className="v3-tenant-repair" data-testid="tenant-repair-v3" data-view="list">
    <h1 className="t-rp-lead">{copy.title}</h1>
    {notices}
    {repairs.length === 0 ? <div className="t-rp-card t-rp-empty" data-testid="repair-tenant-empty">
      <Illustration name="08" />
      <p><b>{empty.title}</b></p>
      <p className="t-rp-muted">{empty.hint}</p>
    </div> : null}
    {repairs.map(repair => <div key={repair.id} className="t-rp-card" data-testid={`tenant-repair-${repair.number}`}>
      <div className="t-rp-row">
        <h2>{copy.cardTitle.replace("{title}", repair.title)}</h2>
        {repair.stage ? <span className="t-rp-badge" data-testid={`tenant-repair-status-${repair.number}`}>{repairStageLabel(repair.stage, locale)}</span> : null}
      </div>
      <Link className="t-rp-text" href={`/t/repair?id=${encodeURIComponent(repair.id)}`}>{copy.viewProgress}</Link>
    </div>)}
    <div className="t-rp-card t-rp-form" id="new-repair">{newForm}</div>
  </section>;
}

/**
 * RT-REPAIR progress (`/t/repair?id=`): lead, steps 已回報 → 已派工 → 處理中 → 已完成, 「你送出的內容」 and
 * 「有問題傳訊息」 (text). No cost, vendor or internal line (TEN-56-AC4). Done: 已完成 with its date and no tenant
 * confirmation; 「有問題傳訊息」 and 「新增報修」 are the ways forward (TEN-56-AC5). Today's cancel control and
 * the repair's comment/photo thread stay below (existing behaviour; `cancel` and `thread` are rendered by the page).
 */
export function TenantRepairProgressV3({ repair, locale, calendar, company, notices, category, cancel, thread }: {
  repair: TenantRepairProgress; locale: Locale; calendar: CalendarMode; company: string; notices: ReactNode;
  category: { label: string; value: string }; cancel: ReactNode; thread: ReactNode;
}) {
  const copy = brandV3TenantLeaseRepairCopy(locale).repair;
  const dict = dictionary(locale);
  const ended = repair.stage === "done" || repair.stage === "cancelled";
  return <section className="v3-tenant-repair" data-testid="tenant-repair-v3" data-view="progress" data-stage={repair.stage}>
    <h1 className="t-rp-lead" data-testid="tenant-repair-lead">{repairLead(repair.stage, locale, company)}</h1>
    {notices}
    <div className="t-rp-card" data-testid="repair-detail">
      <div className="t-rp-row">
        <h2>{repair.title}</h2>
        {repair.stage === "cancelled" ? <span className="t-rp-badge">{copy.cancelled}</span> : null}
      </div>
      {repair.steps.length ? <ol className="t-rp-steps" role="list" data-testid="tenant-repair-steps">
        {repair.steps.map(step => <li key={step.id} className={step.state} aria-current={step.current ? "step" : undefined}>
          <i aria-hidden="true" />
          {step.date ? copy.stepAt.replace("{step}", copy.steps[step.id]).replace("{date}", formatDate(step.date, locale, calendar, dict)) : copy.steps[step.id]}
        </li>)}
      </ol> : null}
    </div>
    <div className="t-rp-card" data-testid="tenant-repair-sent">
      <h2>{copy.sent}</h2>
      {repair.description ? <p>{repair.description}</p> : null}
      <p className="t-rp-kv"><span>{category.label}</span><b>{category.value}</b></p>
      <div className="t-rp-actions">
        <Link className="t-rp-text" href="/t/messages" data-testid="tenant-repair-message">{copy.message}</Link>
        {ended ? <Link className="t-rp-text" href="/t/repair#new-repair" data-testid="tenant-repair-new">{copy.newRepair}</Link> : null}
      </div>
      {cancel}
    </div>
    <div className="t-rp-card t-rp-thread">{thread}</div>
  </section>;
}

/** G-LOAD (GS-02 = A): skeleton only, no status, count or amount. */
export function TenantRepairLoading() {
  return <section className="v3-tenant-repair" data-testid="tenant-repair-loading" aria-busy="true">
    <div className="t-rp-skel t-rp-skel-lead" aria-hidden="true" />
    <div className="t-rp-skel t-rp-skel-card" aria-hidden="true" />
    <div className="t-rp-skel t-rp-skel-card" aria-hidden="true" />
  </section>;
}

/** G-ERR (GS-02 = A): the approved read-error line with 「再試一次」 (outline link back to the same page). */
export function TenantRepairError({ locale, retryHref }: { locale: Locale; retryHref: string }) {
  const copy = brandV3TenantLeaseRepairCopy(locale);
  return <section className="v3-tenant-repair" data-testid="tenant-repair-error">
    <h1 className="t-rp-lead">{copy.repair.title}</h1>
    <div className="t-rp-card" role="alert"><p>{copy.readFailed}</p><Link className="t-rp-outline" href={retryHref}>{copy.retry}</Link></div>
  </section>;
}
