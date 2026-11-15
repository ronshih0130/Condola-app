"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "../../../../i18n";
import { moneyPageCopy } from "../../../../i18n/lanes/brand-v3-money";
import { ownStatusCopy } from "../../../../i18n/lanes/brand-v3-own-status";
import { brandV3TodayCopy } from "../../../../i18n/lanes/brand-v3";
import { actionConfirmPayment } from "../../../../server/actions";
import { CompletionCheck } from "../../completion-check";

type Details = { paymentId: string; ownerName: string; target: string; amount: string; date: string; locale: Locale; returnTo: string };
type Step = "confirm" | "done";

/** Uses the existing action; no client-supplied owner identity enters the write. */
export function ProxyConfirmation(props: Details) {
  const [open, setOpen] = useState(false);
  const [completed, setCompleted] = useState(false);
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="btn o" data-testid="confirm-owner-payment" disabled={completed}
      onClick={() => setOpen(true)}>{moneyPageCopy(props.locale).confirm}</button>
    {open && <ProxySheet {...props} onClose={done => {
      setOpen(false); setCompleted(done); trigger.current?.focus();
      if (done) router.refresh();
    }} />}
  </>;
}

export function ProxySheetBody({ ownerName, target, amount, date, locale, step, busy, failed, submit, close }: Details & {
  step: Step; busy: boolean; failed: boolean; submit: () => void; close: () => void;
}) {
  const copy = moneyPageCopy(locale), own = ownStatusCopy(locale);
  return step === "done" ? <>
    <p role="status" data-testid="proxy-done"><CompletionCheck />{own.proxyDone.replace("{屋主}", ownerName)}</p>
    <button type="button" className="v3-proxy-text" onClick={close}>{copy.proxyClose}</button>
  </> : <form onSubmit={event => { event.preventDefault(); submit(); }} aria-busy={busy}>
    <p>{own.proxyNote}</p>
    <dl><dt>{copy.proxyTarget}</dt><dd>{target}</dd><dt>{copy.proxyAmount}</dt><dd>{amount}</dd>
      <dt>{copy.proxyDate}</dt><dd>{date}</dd><dt>{copy.proxyOwner}</dt><dd>{ownerName}</dd></dl>
    {failed && <p role="alert">{copy.proxyError}</p>}
    <div className="v3-proxy-actions">
      <button type="submit" className="btn pri" disabled={busy}>{failed ? brandV3TodayCopy(locale).retry : copy.proxyConfirm}</button>
      <button type="button" className="v3-proxy-text" disabled={busy} onClick={close}>{copy.proxyCancel}</button>
    </div>
  </form>;
}

export function ProxySheet(props: Details & { onClose: (done: boolean) => void }) {
  const [step, setStep] = useState<Step>("confirm");
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const inFlight = useRef(false), dialog = useRef<HTMLDialogElement>(null), title = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement as HTMLElement | null;
    element?.showModal(); title.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { element?.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { title.current?.focus(); }, [step]);
  const close = () => { if (!inFlight.current) props.onClose(step === "done"); };
  async function submit() {
    if (inFlight.current || step === "done") return;
    inFlight.current = true; setBusy(true); setFailed(false);
    const data = new FormData();
    data.set("paymentId", props.paymentId); data.set("returnTo", props.returnTo);
    data.set("proxyOwnerConfirmed", "true"); data.set("presentation", "owner-proxy");
    try { await actionConfirmPayment(data); setStep("done"); }
    catch { setFailed(true); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="v3-proxy-sheet" aria-labelledby={id}
    onCancel={event => { event.preventDefault(); close(); }}>
    <h2 id={id} ref={title} tabIndex={-1}>{ownStatusCopy(props.locale).proxyTitle}</h2>
    <ProxySheetBody {...props} step={step} busy={busy} failed={failed} submit={() => { void submit(); }} close={close} />
  </dialog>;
}
