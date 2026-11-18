"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { parseAmountMinor, reportProblems, type ReportField, type ReportProblem } from "../../../server/b090-tenant-pay-form";

/** The existing tenant report action (actionRecordPayment), passed in by the page. */
export type ReportAction = (formData: FormData) => void | Promise<void>;

/** TEN-52-AC2: 「複製」 copies the account number. */
export function PayCopyButton({ value, label }: { value: string; label: string }) {
  return <button type="button" className="t-pay-text" data-testid="tenant-pay-copy" onClick={() => { void navigator.clipboard?.writeText(value).catch(() => {}); }}>{label}</button>;
}

type Values = { amount: string; paidOn: string; last5: string; note: string };
type Labels = { amount: string; max: string; paidOn: string; last5: string; required: string; lastUsed: string; note: string; notePlaceholder: string; submit: string; saving: string; cancel: string; retry: string };

/** Per-tab draft, written on send and read back once after a failed send (TEN-53-AC6 「失敗保留內容」). */
export const reportDraftKey = (leaseId: string) => `condola:b090-report:${leaseId}`;
export function readDraft(raw: string | null): Values | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    const keys = ["amount", "paidOn", "last5", "note"] as const;
    if (!keys.every(k => typeof d[k] === "string" && (d[k] as string).length <= 500)) return null;
    return { amount: d.amount as string, paidOn: d.paidOn as string, last5: d.last5 as string, note: d.note as string };
  } catch { return null; }
}

/** One send per press: a second submit while the first is under way is dropped (TEN-53-AC6). */
export function submitGate() {
  let open = true;
  return { take: () => { if (!open) return false; open = false; return true; }, release: () => { open = true; } };
}

function SubmitButton({ labels, failed, sending, onSettled }: { labels: Labels; failed: boolean; sending: boolean; onSettled: () => void }) {
  const { pending } = useFormStatus();
  const busy = pending || sending;
  const was = useRef(false);
  useEffect(() => { if (was.current && !pending) onSettled(); was.current = pending; }, [pending, onSettled]);
  return <button type="submit" className="t-pay-solid" data-testid="tenant-report-submit" disabled={busy} aria-busy={busy || undefined}>
    {busy ? labels.saving : failed ? labels.retry : labels.submit}
  </button>;
}

/**
 * RT-REPORT form. Posts to the existing tenant report action (fields leaseId, amount, paidOn, last5, reference,
 * returnTo=tenant); the server keeps its own checks, including the B-087 「only the unreported part」 guard.
 */
export function TenantReportForm({ action, leaseId, currency, restMinor, defaults, lastUsed, needsLast5, serverError, messages, labels }: {
  action: ReportAction; leaseId: string; currency: string; restMinor: number; defaults: Values; lastUsed: boolean; needsLast5: boolean;
  serverError: { field: ReportField | null; message: string } | null; messages: Record<ReportProblem, string>; labels: Labels;
}) {
  const [values, setValues] = useState<Values>(defaults);
  const [problems, setProblems] = useState<Partial<Record<ReportField, string>>>(serverError?.field ? { [serverError.field]: serverError.message } : {});
  const [sending, setSending] = useState(false);
  const gate = useRef(submitGate());
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    try {
      const key = reportDraftKey(leaseId), draft = readDraft(sessionStorage.getItem(key));
      sessionStorage.removeItem(key);
      if (serverError && draft) setValues(draft);
    } catch { /* storage blocked: the prefilled values stay */ }
  }, [leaseId, serverError]);
  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement>) => setValues(v => ({ ...v, [k]: e.target.value }));
  const settled = useCallback(() => { gate.current.release(); setSending(false); }, []);
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (sending || !gate.current.take()) { event.preventDefault(); return; }
    const found = reportProblems({ ...values, last5: needsLast5 ? values.last5 : "00000" }, restMinor, currency);
    const fields = Object.keys(found) as ReportField[];
    if (fields.length) {
      event.preventDefault();
      gate.current.release();
      setProblems(Object.fromEntries(fields.map(f => [f, messages[found[f]!]])));
      formRef.current?.querySelector<HTMLInputElement>(`[data-field="${fields[0]}"]`)?.focus();
      return;
    }
    setProblems({});
    setSending(true);
    try { sessionStorage.setItem(reportDraftKey(leaseId), JSON.stringify(values)); } catch { /* no draft: values still go to the server */ }
  }
  const minor = parseAmountMinor(values.amount, currency);
  const err = (f: ReportField) => problems[f] ? <small className="t-pay-err" id={`report-${f}-err`}>{problems[f]}</small> : null;
  const aria = (f: ReportField) => problems[f] ? { "aria-invalid": true as const, "aria-describedby": `report-${f}-err` } : {};
  return <form ref={formRef} className="t-pay-card t-pay-form" action={action} onSubmit={onSubmit} noValidate data-testid="tenant-report-form">
    <input type="hidden" name="leaseId" value={leaseId} />
    <input type="hidden" name="returnTo" value="tenant" />
    <input type="hidden" name="amount" value={minor === null ? values.amount : String(minor / 100)} />
    {serverError && !serverError.field ? <p className="t-pay-alert" role="alert" data-testid="tenant-report-failed">{serverError.message}</p> : null}
    <label className="t-pay-field"><span>{labels.amount}</span>
      <input data-field="amount" inputMode={currency.trim().toUpperCase() === "TWD" ? "numeric" : "decimal"} className="num" value={values.amount} onChange={set("amount")} {...aria("amount")} />
      <small>{labels.max}</small>{err("amount")}</label>
    <label className="t-pay-field"><span>{labels.paidOn}</span>
      <input data-field="paidOn" type="date" name="paidOn" className="num" value={values.paidOn} onChange={set("paidOn")} {...aria("paidOn")} />{err("paidOn")}</label>
    {needsLast5 ? <label className="t-pay-field"><span>{labels.last5}　<span className="t-pay-badge t-pay-warn">{labels.required}</span></span>
      <input data-field="last5" name="last5" inputMode="numeric" autoComplete="off" maxLength={5} className="num" value={values.last5} onChange={set("last5")} {...aria("last5")} />
      {lastUsed && values.last5 === defaults.last5 ? <small data-testid="tenant-report-last-used">{labels.lastUsed}</small> : null}{err("last5")}</label> : null}
    <label className="t-pay-field"><span>{labels.note}</span>
      <input name="reference" maxLength={200} placeholder={labels.notePlaceholder} value={values.note} onChange={set("note")} /></label>
    <SubmitButton labels={labels} sending={sending} failed={Boolean(serverError && !serverError.field)} onSettled={settled} />
    <Link className="t-pay-text t-pay-cancel" href="/t/pay">{labels.cancel}</Link>
  </form>;
}
