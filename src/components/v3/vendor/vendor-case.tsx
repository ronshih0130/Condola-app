"use client";

import React, { useId, useRef, useState } from "react";
import type { Locale } from "../../../i18n";
import { vendorCaseCopy } from "../../../i18n/lanes/brand-v3-vendor-case";
import type { VendorCaseStage } from "../../../server/b105-vendor-case";
import { createDecisionController } from "./vendor-case-controller";

/**
 * B-105 Round 7 batch 3 job content inside the V-TOKEN shell (VEN-26-AC1 amended; GS-25, GS-26, GS-49).
 * Only the approved frames are drawn (GS-44): RV-JOB-ACCEPT with the RV-DECLINE sheet, RV-JOB-WAIT, and the
 * declined toast sentence. Stages whose back end is not built yet show the job card and 其他 with no lead
 * and no solid button (GS-01). 開通與類型 is not listed until its page exists (B-065).
 */
export type VendorCaseViewProps = {
  locale: Locale;
  token: string;
  heading: string;
  company: string;
  /** unavailable: the case read failed (GS-02 read error in place). */
  stage: VendorCaseStage | "unavailable";
  /** MGT-104-AC2: a date set at dispatch (not stored before B-042d-D3; always null today). */
  presetDate: string | null;
  /** MGT-104-AC4: the agreed date cannot be before the visit date. */
  scheduledOn: string | null;
  ownerWaitVersion: number | null;
  estimates: boolean;
};

type Pending = "accepted" | "declined" | null;


export function VendorCaseView(props: VendorCaseViewProps) {
  const copy = vendorCaseCopy(props.locale);
  const id = useId();
  const path = `/v/${encodeURIComponent(props.token)}`;
  if (props.stage === "unavailable") {
    return <>
      <CaseStyles />
      <section className="v-token-card v-case-card" aria-labelledby={`${id}-job`}>
        <h2 id={`${id}-job`}>{props.heading}</h2>
        <div className="v-case-error" role="alert">
          <p>{copy.readError}</p>
          <button type="button" className="v-token-secondary" onClick={() => window.location.reload()}>{copy.retry}</button>
        </div>
      </section>
    </>;
  }
  if (props.stage === "declined") {
    return <>
      <CaseStyles />
      <div className="v-token-lead" role="status"><h1>{copy.declined.replace("{company}", props.company)}</h1></div>
    </>;
  }
  const lead = props.stage === "accept" ? copy.leadAccept.replace("{company}", props.company)
    : props.stage === "owner_wait" ? copy.leadWait : null;
  const badge = props.stage === "accept" ? { text: copy.badgeAccept, tone: "info" }
    : props.stage === "owner_wait" ? { text: copy.badgeWait, tone: "warn" } : null;
  const others: { href: string; label: string }[] = [];
  if (props.stage === "owner_wait" && props.estimates && props.ownerWaitVersion !== null) {
    others.push({ href: `${path}/estimate`, label: copy.viewEstimate.replace("{n}", String(props.ownerWaitVersion)) });
  }
  if (props.stage !== "accept") others.push({ href: `${path}/photos`, label: copy.photos });
  return <>
    <CaseStyles />
    {lead ? <div className="v-token-lead"><h1>{lead}</h1></div> : null}
    <section className="v-token-card v-case-card" aria-labelledby={`${id}-job`} data-stage={props.stage}>
      <h2 id={`${id}-job`}>{props.heading}</h2>
      {badge ? <dl><div><dt>{copy.status}</dt><dd><span className={`v-case-badge v-case-badge-${badge.tone}`}>{badge.text}</span></dd></div></dl> : null}
      {props.stage === "accept" ? <AcceptDecision {...props} /> : null}
    </section>
    {others.length ? <section className="v-token-card v-case-other" aria-labelledby={`${id}-other`}>
      <h2 id={`${id}-other`}>{copy.other}</h2>
      <ul className="v-case-list">{others.map(item => <li key={item.href}><a href={item.href}>{item.label}</a></li>)}</ul>
    </section> : null}
  </>;
}

export function CaseStyles() {
  // eslint-disable-next-line @next/next/no-css-tags -- bearer-org ON-only stylesheet, scoped like vendor-token.css
  return <link rel="stylesheet" href="/brand/v3/vendor-case.css" />;
}

function AcceptDecision(props: VendorCaseViewProps) {
  const copy = vendorCaseCopy(props.locale);
  const id = useId();
  const sheet = useRef<HTMLDialogElement>(null);
  const acceptForm = useRef<HTMLFormElement>(null);
  const declineForm = useRef<HTMLFormElement>(null);
  const [date, setDate] = useState(props.presetDate ?? "");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [failed, setFailed] = useState<Pending>(null);
  // One request id per decision kind for this page, so a retry is a replay, never a second write.
  const [controller] = useState(() => createDecisionController({
    fetch: (input, init) => fetch(input, init), reload: () => window.location.reload(),
  }));

  async function decide(decision: "accepted" | "declined") {
    if (controller.busy) return;
    setPending(decision); setFailed(null);
    const outcome = await controller.submit(props.token, decision, { agreedOn: date, reason });
    setPending(null);
    // recorded / conflict reload the page (the stored decision shows); invalid and failed keep every input.
    if (outcome === "invalid" || outcome === "failed") setFailed(decision);
  }
  // 「再試一次」 resubmits the form, so the browser checks (date min, required) run again.
  const retry = (decision: "accepted" | "declined") =>
    (decision === "accepted" ? acceptForm : declineForm).current?.requestSubmit();
  const failure = (decision: "accepted" | "declined") => failed === decision ? <div className="v-case-error" role="alert">
    <p>{copy.saveError}</p>
    <button type="button" className="v-token-secondary" onClick={() => retry(decision)} disabled={pending !== null}>{copy.retry}</button>
  </div> : null;

  return <>
    <form ref={acceptForm} className="v-case-form" onSubmit={event => { event.preventDefault(); void decide("accepted"); }}>
      {props.presetDate ? <p className="v-case-help">{copy.duePreset}</p> : null}
      <label className="v-case-field" htmlFor={`${id}-due`}>{copy.dueLabel}</label>
      <input id={`${id}-due`} className="v-case-input" type="date" name="agreedOn" value={date}
        min={props.scheduledOn ?? undefined} required={props.presetDate !== null}
        aria-describedby={`${id}-due-help`} onChange={event => { setDate(event.target.value); setFailed(null); }} />
      <p className="v-case-help" id={`${id}-due-help`}>{copy.dueHelp}</p>
      {failure("accepted")}
      <button type="submit" className="v-token-primary v-case-block" disabled={pending !== null} aria-busy={pending === "accepted"}>{copy.accept}</button>
      <button type="button" className="v-token-secondary v-case-block" aria-haspopup="dialog" disabled={pending !== null}
        onClick={() => sheet.current?.showModal()}>{copy.decline}</button>
    </form>
    <dialog ref={sheet} className="v-token-sheet v-case-sheet" aria-labelledby={`${id}-sheet`}>
      <form ref={declineForm} onSubmit={event => { event.preventDefault(); void decide("declined"); }}>
        <h2 id={`${id}-sheet`}>{copy.declineTitle}</h2>
        <label className="v-case-field" htmlFor={`${id}-reason`}>{copy.declineReason}</label>
        <input id={`${id}-reason`} className="v-case-input" type="text" name="reason" maxLength={500} value={reason}
          onChange={event => { setReason(event.target.value); setFailed(null); }} />
        {failure("declined")}
        <button type="submit" className="v-token-primary v-case-block" disabled={pending !== null} aria-busy={pending === "declined"}>{copy.declineConfirm}</button>
        <button type="button" className="v-case-text v-case-block" onClick={() => sheet.current?.close()}>{copy.cancel}</button>
      </form>
    </dialog>
  </>;
}
