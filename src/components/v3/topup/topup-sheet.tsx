"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "../../../i18n";
import { brandV3TopupCopy } from "../../../i18n/lanes/brand-v3-topup";
import { parseTopupAmount, TOPUP_NOTE_MAX, topupMoney, topupOver, validTopupDate } from "../../../lib/deposit-topup";
import { recordDepositTopupAction } from "../../../server/mf3-deposit-topup-actions";
import type { TopupInput, TopupResult } from "../../../server/mf3-deposit-topup";

type Props = {
  locale: Locale; leaseId: string; settlementId: string; currency: string; minorUnit: number;
  owedMinor: string; paidMinor: string; submit?: (input: TopupInput) => Promise<TopupResult>;
};
const newRequest = () => globalThis.crypto.randomUUID();
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

export type TopupFormState = { amount: string; date: string; note: string; saving: boolean; failed: boolean };
type FormProps = Omit<Props, "submit" | "leaseId" | "settlementId"> & TopupFormState & {
  titleId: string; firstRef?: React.Ref<HTMLInputElement>;
  onAmount?: (value: string) => void; onDate?: (value: string) => void; onNote?: (value: string) => void;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void; onClose?: () => void;
};

/**
 * The sheet (MGT-151-AC1/AC3/AC5): 金額 (必填), 日期 (必填), 備註 (選填). When this entry would make 已補 larger
 * than 應補 it asks 「比應補多收 NT${x}，確定嗎？」 and 確定 still saves. After a failed save every field keeps
 * its value, with 「沒有存成功，請再試一次。」 and 「再試一次」.
 */
export function TopupSheetForm(props: FormProps) {
  const c = brandV3TopupCopy(props.locale);
  const parsed = parseTopupAmount(props.amount, props.minorUnit);
  const over = topupOver(props.owedMinor, props.paidMinor, parsed);
  const step = props.minorUnit ? `0.${"0".repeat(props.minorUnit - 1)}1` : "1";
  return <div className="v3-topup-sheet" role="dialog" aria-modal="true" aria-labelledby={props.titleId} data-testid="topup-sheet"
    onKeyDown={event => { if (event.key === "Escape") props.onClose?.(); }}>
    <span className="v3-topup-grab" aria-hidden="true" />
    <div className="v3-topup-sheet-head"><h2 id={props.titleId}>{c.record}</h2>
      <button type="button" className="btn txt" onClick={props.onClose} disabled={props.saving}>{c.close}</button></div>
    <form onSubmit={props.onSubmit}>
      <label className="v3-topup-field"><span>{c.amount}</span>
        <input ref={props.firstRef} name="amount" type="number" inputMode="decimal" required min={step} step={step}
          value={props.amount} onChange={event => props.onAmount?.(event.target.value)}
          aria-invalid={props.amount !== "" && !parsed} data-testid="topup-amount" /></label>
      <label className="v3-topup-field"><span>{c.date}</span>
        <input name="date" type="date" required min="2000-01-01" max="2100-12-31" value={props.date}
          onChange={event => props.onDate?.(event.target.value)} data-testid="topup-date" /></label>
      <label className="v3-topup-field"><span>{c.note}</span>
        <input name="note" type="text" maxLength={TOPUP_NOTE_MAX} value={props.note}
          onChange={event => props.onNote?.(event.target.value)} data-testid="topup-note" /></label>
      {over !== "0" ? <p className="v3-topup-warn" role="status" data-testid="topup-over"><b>
        {c.over.replace("{amount}", topupMoney(over, props.currency, props.minorUnit))}</b></p> : null}
      {props.failed ? <p className="v3-topup-fail" role="alert" data-testid="topup-failed">{c.saveFailed}</p> : null}
      <button type="submit" className="btn pri block" disabled={props.saving} aria-busy={props.saving} data-testid="topup-confirm">
        {props.failed ? c.retry : c.confirm}</button>
      <button type="button" className="btn txt block" onClick={props.onClose} disabled={props.saving}>{c.cancel}</button>
    </form>
  </div>;
}

/**
 * 「記錄已收」 and its sheet. A retry of a failed save reuses the same request key, so a save that did
 * reach the server is never recorded twice; any edit makes it a different entry with a fresh key.
 */
export function TopupSheet({ submit = recordDepositTopupAction, leaseId, settlementId, ...view }: Props) {
  const c = brandV3TopupCopy(view.locale);
  const router = useRouter();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<TopupFormState>({ amount: "", date: "", note: "", saving: false, failed: false });
  const request = useRef<string>("");
  const first = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (open) first.current?.focus(); }, [open]);
  const show = () => { request.current = newRequest(); setForm({ amount: "", date: today(), note: "", saving: false, failed: false }); setOpen(true); };
  const hide = () => { if (form.saving) return; setOpen(false); opener.current?.focus(); };
  const edit = (key: "amount" | "date" | "note") => (value: string) => {
    request.current = newRequest();
    setForm(current => ({ ...current, [key]: value }));
  };
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountMinor = parseTopupAmount(form.amount, view.minorUnit);
    if (form.saving || !amountMinor || !validTopupDate(form.date) || form.note.trim().length > TOPUP_NOTE_MAX) return;
    setForm(current => ({ ...current, saving: true, failed: false }));
    let result: TopupResult;
    try {
      result = await submit({ leaseId, settlementId, requestId: request.current, amountMinor, receivedOn: form.date, note: form.note.trim() || null });
    } catch {
      result = { ok: false, reason: "failed" };
    }
    setForm(current => ({ ...current, saving: false, failed: !result.ok }));
    if (!result.ok) return;
    setOpen(false);
    router.refresh();
  }

  return <>
    <button ref={opener} type="button" className="btn pri v3-topup-record" data-testid="topup-record" onClick={show}>{c.record}</button>
    {open ? <div className="v3-topup-layer" data-testid="topup-sheet-layer">
      <div className="v3-topup-dim" aria-hidden="true" onClick={hide} />
      <TopupSheetForm {...view} {...form} titleId={titleId} firstRef={first}
        onAmount={edit("amount")} onDate={edit("date")} onNote={edit("note")} onSubmit={save} onClose={hide} />
    </div> : null}
  </>;
}
