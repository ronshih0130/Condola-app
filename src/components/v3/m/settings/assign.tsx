import React from "react";
import Link from "next/link";
import { makeT, type Locale } from "../../../../i18n";
import { brandV3AssignCopy, fillAssign } from "../../../../i18n/lanes/brand-v3-assign";
import type { AssignPerson } from "../../../../server/b059-maint-unit-assign";
import { EmptyIllustration } from "../../../empty-illustration";
import { Illustration } from "../../illustrations";

/**
 * B-059 單位分派 presentation (server-safe, no hooks). Frames: 「設定・單位分派（經理從設定進來）」 (one row per
 * maintenance person, 「已分派 {n} 個單位」 + outline 「編輯」, no solid button), its empty and no-permission notes
 * (MGT-118-AC6, AC7), and 「設定・團隊・林志豪負責的單位（公司還沒有單位）」. AC8: the read failure stays on the page
 * with 「再試一次」 to the same URL; the skeleton holds the layout while loading.
 */
export const ASSIGN_HREF = "/m/assign";
export const assignEditHref = (id: string) => `/m/assign/${encodeURIComponent(id)}`;
/** 「新增同事」 opens R5-ADD on 團隊 (Brand 3.0 round 5 words, daily-ops Needs grill 5 = A). */
export const ASSIGN_ADD_HREF = "/m/team?add=1#v3-team-panel";
/** 「建立單位」: the approved UNIT empty-state action. */
export const ASSIGN_NEW_UNIT_HREF = "/m/units/new";

export function AssignLoading({ locale, edit = false }: { locale: Locale; edit?: boolean }) {
  const c = brandV3AssignCopy(locale);
  return <section className="v3-assign" aria-busy="true" aria-label={c.title} data-testid={edit ? "assign-edit-loading" : "assign-loading"}>
    <div className="v3-assign-head" aria-hidden="true"><span className="v3-assign-skeleton title" /><span className="v3-assign-skeleton" /></div>
    <div className="v3-assign-card" aria-hidden="true">{[0, 1, 2].map(line => <span className="v3-assign-skeleton" key={line} />)}</div>
  </section>;
}

export function AssignError({ locale, retryHref }: { locale: Locale; retryHref: string }) {
  const c = brandV3AssignCopy(locale);
  return <section className="v3-assign" aria-label={c.title} data-testid="assign-error">
    <div className="v3-assign-state" role="alert"><p>{c.readFailed}</p><a className="btn" href={retryHref}>{c.retry}</a></div>
  </section>;
}

/** MGT-118-AC7 (`assign-perm`): accountants and maintenance; no list, no edit. */
export function AssignNoPerm({ locale }: { locale: Locale }) {
  const c = brandV3AssignCopy(locale);
  return <section className="v3-assign" aria-label={c.title} data-testid="assign-perm">
    <div className="v3-assign-state"><Illustration name="26" /><h2>{c.noPermTitle}</h2><p>{c.noPermBody}</p></div>
  </section>;
}

/** MGT-118-AC6: a role that can add people (團隊 is admin only) gets the illustration, the sentence and 「新增同事」;
 *  a manager gets only 「還沒有維修人員，請管理員先加入。」 with no primary button (PRINCIPLES 54). */
export function AssignEmpty({ locale, canAdd }: { locale: Locale; canAdd: boolean }) {
  const c = brandV3AssignCopy(locale);
  return <div className="v3-assign-state" data-testid={canAdd ? "assign-empty-add" : "assign-empty"}>
    {canAdd ? <><EmptyIllustration name="people" /><h2>{c.emptyTitle}</h2><p>{c.emptyBody}</p>
      <Link className="btn pri" href={ASSIGN_ADD_HREF} data-testid="assign-empty-add-button">{c.emptyAdd}</Link></>
      : <p>{c.emptyManager}</p>}
  </div>;
}

export function AssignListView({ locale, people, canAdd }: { locale: Locale; people: AssignPerson[]; canAdd: boolean }) {
  const c = brandV3AssignCopy(locale);
  return <section className="v3-assign" aria-labelledby="v3-assign-title" data-testid="assign">
    <header className="v3-assign-head"><h1 id="v3-assign-title">{c.title}</h1><p>{c.help}</p></header>
    {people.length ? <div className="v3-assign-card"><ul className="v3-assign-list" data-testid="assign-list">
      {people.map(person => <li className="v3-assign-row" key={person.id} data-person={person.id}>
        <div><b>{fillAssign(c.person, { name: person.name })}</b><span className="v3-assign-sub">{fillAssign(c.assigned, { n: person.units })}</span></div>
        <Link className="btn" href={assignEditHref(person.id)} aria-label={`${c.edit} ${person.name}`}>{c.edit}</Link>
      </li>)}
    </ul></div> : <AssignEmpty locale={locale} canAdd={canAdd} />}
  </section>;
}

/** 公司還沒有單位: nothing to tick, so no 「儲存」; the approved UNIT title and 「建立單位」. */
export function AssignNoUnits({ locale, name }: { locale: Locale; name: string }) {
  const c = brandV3AssignCopy(locale);
  const t = makeT(locale);
  return <section className="v3-assign" aria-labelledby="v3-assign-edit-title" data-testid="assign-edit-empty">
    <header className="v3-assign-head"><h1 id="v3-assign-edit-title">{fillAssign(c.editTitle, { name })}</h1></header>
    <div className="v3-assign-state"><EmptyIllustration name="home" /><h2>{t("es_UNIT_title")}</h2>
      <p>{fillAssign(c.noUnitsBody, { name })}</p><Link className="btn pri" href={ASSIGN_NEW_UNIT_HREF}>{t("es_UNIT_action")}</Link></div>
  </section>;
}
