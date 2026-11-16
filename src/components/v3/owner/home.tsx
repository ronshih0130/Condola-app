"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { makeT, type Locale } from "../../../i18n";
import { brandV3OwnerHomeCopy, brandV3OwnerShellCopy, brandV3ShellCopy, brandV3TodayCopy } from "../../../i18n/lanes/brand-v3";
import { repairApprovalCopy } from "../../../i18n/repair-approval";
import { assertDecision } from "../../../server/repair-approval-rules";
import type { OwnerHistoryRow } from "../../../server/repair-approval";
import { postOwnerDecision, type DecisionRequest } from "../../../app/o/approvals/decision-request";
import { Emergency } from "../../../app/o/approvals/emergency";
import { Illustration } from "../illustrations";
import { WaitMark } from "../wait-mark";

export type EstimateRow = {
  ticketId: string; versionId: string; version: string; requestId: string;
  property: string; item: string; amount: string; vendor: string | null; scope: string;
  managementExplanation: string | null; emergency: OwnerHistoryRow | null;
};
export type OwnerHomeState = { status: "ready"; rows: EstimateRow[] } | { status: "error" };

/**
 * FE-OWNEMPTY: `summary` (the O-HOME summary row) renders only when its reader supplies data, and the
 * O-EMPTY 「看總覽」 link renders only when 總覽 is live (`overviewHref`); neither is invented here.
 */
export function OwnerHomeV3({ name, locale, state, estimate, summary, overviewHref }: {
  name: string; locale: Locale; state: OwnerHomeState; estimate?: string; summary?: React.ReactNode; overviewHref?: string;
}) {
  const router = useRouter();
  const copy = brandV3OwnerHomeCopy(locale);
  const [removed, setRemoved] = useState<string[]>([]);
  const [selected, setSelected] = useState<EstimateRow | null>(null);
  const [notice, setNotice] = useState("");
  const trigger = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const handledLink = useRef<string | undefined>(undefined);
  const rows = state.status === "ready" ? state.rows.filter(row => !removed.includes(row.versionId)) : [];
  useEffect(() => {
    // Once the query leaves (close replaces /o?estimate=… with /o), forget it so the same deep link opens again.
    if (!estimate) { handledLink.current = undefined; return; }
    if (handledLink.current === estimate || state.status !== "ready") return;
    handledLink.current = estimate;
    const row = state.rows.find(row => row.ticketId === estimate);
    if (row && !removed.includes(row.versionId)) setSelected(row);
  }, [estimate, state, removed]);
  const close = (decided = false) => {
    if (decided && selected) setRemoved(previous => [...previous, selected.versionId]);
    setSelected(null);
    // Deep links are consumed once; do not reopen a decided or dismissed panel.
    if (estimate) router.replace("/o", { scroll: false });
    router.refresh();
    requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus();
      else heading.current?.focus();
    });
  };
  const named = Boolean(name.trim());
  // FE-OWNEMPTY: at zero the lead is its own sentence, never a second 「首頁」 under the shell title.
  const title = state.status === "error" || rows.some(row => row.emergency) ? brandV3OwnerShellCopy(locale).home
    : rows.length === 0 ? (named ? copy.leadEmpty : copy.leadEmptyNoName).replace("{name}", name.trim())
    : (named ? copy.lead : copy.leadNoName).replace("{name}", name.trim()).replace("{count}", String(rows.length));
  return <section className="v3-owner-home" data-testid="owner-home-v3">
    <h1 ref={heading} tabIndex={-1}>{title}</h1>
    {state.status === "ready" && summary ? <div className="owner-summary" data-testid="owner-summary">{summary}</div> : null}
    <section className="owner-task-card" aria-labelledby="owner-tasks-title">
      <h2 id="owner-tasks-title">{copy.tasks}</h2>
      {state.status === "error" ? <div role="alert"><p>{copy.failure}</p>
        <button className="owner-action owner-primary" onClick={() => router.refresh()}>{brandV3TodayCopy(locale).retry}</button>
      </div> : rows.length ? <ul className="owner-estimates">{rows.map(row => <li key={row.versionId} data-testid="owner-estimate-row">
        <div><b>{row.property}{row.item}</b><div className="owner-badges"><span>{copy.estimate} {row.amount}</span><span>{row.emergency ? copy.emergencyNote : copy.pending}</span></div></div>
        <button className="owner-action" onClick={event => { trigger.current = event.currentTarget; setSelected(row); setNotice(""); }}>{copy.approve}</button>
      </li>)}</ul> : <div className="owner-empty" data-testid="owner-empty"><Illustration name="20" /><h3>{copy.empty}</h3><p>{copy.emptyDetail}</p>
        {overviewHref ? <Link className="owner-text-link" href={overviewHref}>{copy.overview}</Link> : null}</div>}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
    {selected ? <EstimatePanel key={selected.versionId} row={selected} locale={locale} onClose={close}
      onReturned={() => { setNotice(repairApprovalCopy(locale).recorded); close(true); }} /> : null}
  </section>;
}

export function EstimatePanel({ row, locale, onClose, onReturned }: {
  row: EstimateRow; locale: Locale; onClose: (decided?: boolean) => void; onReturned: () => void;
}) {
  const copy = brandV3OwnerHomeCopy(locale);
  const existing = repairApprovalCopy(locale);
  const closeCopy = brandV3ShellCopy(locale).close;
  const retry = brandV3TodayCopy(locale).retry;
  const [step, setStep] = useState<"estimate" | "back" | "done">("estimate");
  const [decision, setDecision] = useState<"rejected" | "more_information">("rejected");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const request = useRef<DecisionRequest | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal(); // Native modal provides focus trapping and makes the background inert.
    title.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { element?.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { title.current?.focus(); }, [step]);
  async function submit() {
    if (inFlight.current || conflict) return;
    const outcome = step === "back" ? decision : "approved";
    const trimmed = step === "back" ? reason.trim() || null : null;
    try { assertDecision({ decision: outcome, reason: trimmed }); }
    catch { setMessage(existing.rejected_invalid); return; }
    const previous = request.current;
    const requestId = previous && previous.decision === outcome && previous.reason === trimmed ? previous.requestId
      : previous ? crypto.randomUUID() : row.requestId;
    request.current = { requestId, versionId: row.versionId, decision: outcome, reason: trimmed };
    inFlight.current = true; setBusy(true); setMessage(""); setFailed(false);
    try {
      const status = await postOwnerDecision(request.current);
      if (status === "recorded") {
        if (outcome === "approved") setStep("done"); else onReturned();
      } else {
        setMessage(status === "rejected_conflict" ? existing.rejected_conflict
          : status === "rejected_invalid" ? existing.rejected_invalid
          : status === "rejected_disabled" ? existing.rejected_disabled : existing.unavailable);
        setConflict(status === "rejected_conflict");
        setFailed(status !== "rejected_conflict");
      }
    } catch { setMessage(existing.unavailable); setFailed(true); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const version = copy.versionNumber.replace("{n}", row.version);
  return <dialog className="owner-estimate-panel" ref={dialog} aria-labelledby={id}
    onCancel={event => { event.preventDefault(); if (!inFlight.current) onClose(step === "done"); }}>
    <h2 id={id} ref={title} tabIndex={-1}>{step === "done" ? copy.done : step === "back" ? copy.back : copy.title}</h2>
    {step === "done" ? <><WaitMark /><dl>
      <dt>{copy.approvedVersion}</dt><dd>{version}</dd><dt>{copy.amount}</dt><dd>{row.amount}</dd>
      <dt>{copy.status}</dt><dd>{existing.approved}</dd></dl><p>{copy.handoff}</p>
      <button className="owner-action owner-text" onClick={() => onClose(true)}>{closeCopy}</button>
    </> : <form noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
      {step === "estimate" ? <>
        <p>{copy.prompt.replace("{item}", row.item).replace("{amount}", row.amount)}</p>
        <dl><dt>{copy.property}</dt><dd>{row.property}</dd><dt>{copy.item}</dt><dd>{row.item}</dd>
          <dt>{copy.estimate}</dt><dd>{row.amount}</dd><dt>{copy.vendor}</dt><dd>{row.vendor || "—"}</dd>
          <dt>{copy.description}</dt><dd><p>{row.scope}</p>{row.managementExplanation ? <p>{row.managementExplanation}</p> : null}</dd>
          {BigInt(row.version) > BigInt(1) ? <><dt>{copy.version}</dt><dd>{version}</dd></> : null}</dl>
        {row.emergency ? <Emergency row={row.emergency} copy={existing} /> : null}
        <p>{row.emergency ? copy.emergencyNote : copy.note}</p>
      </> : <>
        <div className="owner-outcomes" role="group" aria-label={existing.decision}>
          <button type="button" className="owner-action" aria-pressed={decision === "rejected"} disabled={busy}
            onClick={() => setDecision("rejected")}>{existing.reject}</button>
          <button type="button" className="owner-action" aria-pressed={decision === "more_information"} disabled={busy}
            onClick={() => setDecision("more_information")}>{existing.requestInformation}</button>
        </div>
        <label htmlFor={`${id}-reason`}>{copy.reason}</label><textarea id={`${id}-reason`} required maxLength={4000}
          value={reason} onChange={event => setReason(event.target.value)} disabled={busy} aria-describedby={message ? `${id}-message` : undefined} />
      </>}
      {message ? <p id={`${id}-message`} role="alert">{message}</p> : null}
      <div className="owner-panel-actions">
        {!conflict ? <button className="owner-action owner-primary" type="submit" disabled={busy}>
          {failed ? retry : step === "back" ? copy.back : copy.approve}</button> : null}
        {step === "estimate" && !conflict ? <button className="owner-action" type="button" disabled={busy}
          onClick={() => { setStep("back"); setMessage(""); setFailed(false); }}>{copy.back}</button> : null}
        <button className="owner-action owner-text" type="button" disabled={busy} onClick={() => {
          if (step === "back" && !conflict) { setStep("estimate"); setMessage(""); setFailed(false); }
          else onClose();
        }}>{step === "back" && !conflict ? makeT(locale)("i_cancel") : closeCopy}</button>
      </div>
    </form>}
  </dialog>;
}
