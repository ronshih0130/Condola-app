"use client";

import React, { useEffect, useId, useReducer, useRef } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "../../../i18n";
import { brandV3TopupCopy } from "../../../i18n/lanes/brand-v3-topup";
import { checkTopupAmount, dateIn, parseTopupAmount, TOPUP_NOTE_MAX, topupDateAllowed, topupMoney, topupOver } from "../../../lib/deposit-topup";
import { closedSheet, createTopupSender, topupSheetReducer, topupSignature } from "./topup-controller";
import { recordDepositTopupAction } from "../../../server/mf3-deposit-topup-actions";
import type { TopupInput, TopupResult } from "../../../server/mf3-deposit-topup";

type Props = {
  locale: Locale; leaseId: string; settlementId: string; currency: string; minorUnit: number;
  owedMinor: string; paidMinor: string; submit?: (input: TopupInput) => Promise<TopupResult>;
};
const newRequest = () => globalThis.crypto.randomUUID();
/** The viewer's own calendar date; the gateway still applies the org-local today. */
const localToday = () => dateIn(Intl.DateTimeFormat().resolvedOptions().timeZone);

export type TopupFormState = { amount: string; date: string; note: string; saving: boolean; failed: boolean; today?: string };
type FormProps = Omit<Props, "submit" | "leaseId" | "settlementId"> & TopupFormState & {
  titleId: string; firstRef?: React.Ref<HTMLInputElement>; sheetRef?: React.Ref<HTMLDivElement>;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onAmount?: (value: string) => void; onDate?: (value: string) => void; onNote?: (value: string) => void;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void; onClose?: () => void;
};

/**
 * The sheet (MGT-151-AC1/AC3/AC5): 金額 (必填), 日期 (必填), 備註 (選填). When this entry would make 已補 larger
 * than 應補 it asks 「比應補多收 NT${x}，確定嗎？」 and 確定 still saves. After a failed save every field keeps
 * its value, with 「沒有存成功，請再試一次。」 and 「再試一次」 (GS-02); 確定 is only the normal confirm.
 * Both message regions stay mounted so screen readers announce a change of text reliably.
 */
export function TopupSheetForm(props: FormProps) {
  const c = brandV3TopupCopy(props.locale);
  const parsed = parseTopupAmount(props.amount, props.minorUnit);
  const over = topupOver(props.owedMinor, props.paidMinor, parsed);
  const step = props.minorUnit ? `0.${"0".repeat(props.minorUnit - 1)}1` : "1";
  return <div ref={props.sheetRef} className="v3-topup-sheet" role="dialog" aria-modal="true" aria-labelledby={props.titleId} data-testid="topup-sheet"
    onKeyDown={event => { if (event.key === "Escape") props.onClose?.(); else props.onKeyDown?.(event); }}>
    <span className="v3-topup-grab" aria-hidden="true" />
    <div className="v3-topup-sheet-head"><h2 id={props.titleId}>{c.record}</h2>
      <button type="button" className="btn txt" onClick={props.onClose} disabled={props.saving}>{c.close}</button></div>
    <form onSubmit={props.onSubmit}>
      <label className="v3-topup-field"><span>{c.amount}</span>
        <input ref={props.firstRef} name="amount" type="number" inputMode="decimal" required min={step} step={step}
          value={props.amount} onChange={event => props.onAmount?.(event.target.value)}
          aria-invalid={props.amount !== "" && !parsed} data-testid="topup-amount" /></label>
      <label className="v3-topup-field"><span>{c.date}</span>
        <input name="date" type="date" required min="2000-01-01" max={props.today ?? "2100-12-31"} value={props.date}
          onChange={event => props.onDate?.(event.target.value)} data-testid="topup-date" /></label>
      <label className="v3-topup-field"><span>{c.note}</span>
        <input name="note" type="text" maxLength={TOPUP_NOTE_MAX} value={props.note}
          onChange={event => props.onNote?.(event.target.value)} data-testid="topup-note" /></label>
      <p className="v3-topup-warn" role="status" aria-live="polite" data-testid="topup-over">{over !== "0" ? <b>
        {c.over.replace("{amount}", topupMoney(over, props.currency, props.minorUnit))}</b> : null}</p>
      <p className="v3-topup-fail" role="alert" data-testid="topup-failed">{props.failed ? c.saveFailed : null}</p>
      <button type="submit" className="btn pri block" disabled={props.saving} aria-busy={props.saving} data-testid="topup-confirm">
        {props.failed ? c.retry : c.confirm}</button>
      <button type="button" className="btn txt block" onClick={props.onClose} disabled={props.saving}>{c.cancel}</button>
    </form>
  </div>;
}

/**
 * MO-TOPUP-DUP toast (OQ-081): the app's existing `.toast` (globals.css), v3 colours in topup.css. The
 * status region stays mounted and only its text changes, so it is announced; empty, it is visually
 * hidden. No timer: it goes when the sheet is opened again or the page reloads.
 */
export function TopupDupToast({ show, locale }: { show: boolean; locale: Locale }) {
  return <div className="toast v3-topup-toast" role="status" data-testid="topup-dup">{show ? brandV3TopupCopy(locale).dup : null}</div>;
}

/** Tab and Shift+Tab stay inside the sheet while it is open. */
export function trapTab(event: React.KeyboardEvent<HTMLElement>, root: HTMLElement | null) {
  if (event.key !== "Tab" || !root) return;
  const items = [...root.querySelectorAll<HTMLElement>("button, input, [href], [tabindex]:not([tabindex='-1'])")]
    .filter(el => !el.hasAttribute("disabled"));
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1], active = root.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (active === last || !root.contains(active))) { event.preventDefault(); first.focus(); }
}

/**
 * 「記錄已收」 and its sheet. State and request keys live in topup-controller (unit tested); this is wiring.
 * Focus stays in the sheet while it is open and returns to 「記錄已收」 when it closes (saved or not).
 */
export function TopupSheet({ submit = recordDepositTopupAction, leaseId, settlementId, ...view }: Props) {
  const c = brandV3TopupCopy(view.locale);
  const router = useRouter();
  const titleId = useId();
  const [state, dispatch] = useReducer(topupSheetReducer, closedSheet);
  const sender = useRef<ReturnType<typeof createTopupSender> | null>(null);
  if (!sender.current) sender.current = createTopupSender(submit);
  const first = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (state.open) first.current?.focus();
    else if (wasOpen.current) opener.current?.focus();
    wasOpen.current = state.open;
  }, [state.open]);
  const hide = () => dispatch({ type: "close" });
  const edit = (field: "amount" | "date" | "note") => (value: string) => dispatch({ type: "edit", field, value });
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.saving || sender.current!.busy || !state.key) return;
    const amount = checkTopupAmount(state.amount, view.minorUnit);
    if (!amount.ok && amount.reason === "format") return; // the browser's required/number validation covers it
    // Above the cap, a future date or an over-long note: not sent; the GS-02 save error, input kept.
    if (!amount.ok || !topupDateAllowed(state.date, localToday()) || state.note.trim().length > TOPUP_NOTE_MAX) {
      dispatch({ type: "refused" });
      return;
    }
    const content = { amountMinor: amount.minor, receivedOn: state.date, note: state.note.trim() || null };
    dispatch({ type: "start", signature: topupSignature(content) });
    const outcome = await sender.current!.send({ leaseId, settlementId }, state.key, content);
    if (outcome === "busy") return;
    dispatch({ type: "done", outcome });
    // saved, or landed (conflict: an earlier attempt with this key was recorded): show it, sheet closed;
    // landed after an edit also shows the MO-TOPUP-DUP toast (state.dupNotice).
    if (outcome === "saved" || outcome === "landed") router.refresh();
  }

  return <>
    <button ref={opener} type="button" className="btn pri v3-topup-record" data-testid="topup-record"
      onClick={() => dispatch({ type: "open", today: localToday(), key: newRequest() })}>{c.record}</button>
    {state.open ? <div className="v3-topup-layer" data-testid="topup-sheet-layer">
      <div className="v3-topup-dim" aria-hidden="true" onClick={hide} />
      <TopupSheetForm {...view} amount={state.amount} date={state.date} note={state.note} saving={state.saving}
        failed={state.failed} today={localToday()}
        titleId={titleId} firstRef={first} sheetRef={sheet}
        onAmount={edit("amount")} onDate={edit("date")} onNote={edit("note")} onSubmit={save} onClose={hide}
        onKeyDown={event => trapTab(event, sheet.current)} />
    </div> : null}
    <TopupDupToast show={state.dupNotice} locale={view.locale} />
  </>;
}
