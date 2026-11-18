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
type Labels = { amount: string; max: string; paidOn: string; last5: string; required: string; lastUsed: string; note: string; notePlaceholder: string; submit: string; saving: string; cancel: string; retry: string; errorItem: string };

/**
 * Per-tab draft of the report form (TEN-53-AC6 「失敗保留內容」). Bound to the signed-in tenant, the org and the lease, in
 * both the key and the payload; only the four form values are stored. Written on send, read back once after a failed
 * send, removed after that, and swept whenever 繳款 renders (so after a successful send) or another account's form opens.
 * There is no client sign-out hook (sign-out is a plain form post), so the sweep is what clears a previous account's draft.
 */
export type DraftOwner = { userId: string; orgId: string; leaseId: string };
const DRAFT_PREFIX = "condola:b090-report:";
export const reportDraftKey = (o: DraftOwner) => `${DRAFT_PREFIX}${o.userId}:${o.orgId}:${o.leaseId}`;
export function writeDraft(o: DraftOwner, values: Values): string {
  return JSON.stringify({ v: 1, userId: o.userId, orgId: o.orgId, leaseId: o.leaseId, values: { amount: values.amount, paidOn: values.paidOn, last5: values.last5, note: values.note } });
}
export function readDraft(raw: string | null, o: DraftOwner): Values | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { v?: unknown; userId?: unknown; orgId?: unknown; leaseId?: unknown; values?: Record<string, unknown> };
    if (d.v !== 1 || d.userId !== o.userId || d.orgId !== o.orgId || d.leaseId !== o.leaseId || !d.values || typeof d.values !== "object") return null;
    const keys = ["amount", "paidOn", "last5", "note"] as const;
    if (!keys.every(k => typeof d.values![k] === "string" && (d.values![k] as string).length <= 500)) return null;
    const v = d.values as Values;
    return { amount: v.amount, paidOn: v.paidOn, last5: v.last5, note: v.note };
  } catch { return null; }
}
/** Removes every report draft in this tab except `keep` (the current owner's key, when one is about to be read). */
export function sweepDrafts(storage: Pick<Storage, "length" | "key" | "removeItem">, keep: string | null) {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k?.startsWith(DRAFT_PREFIX) && k !== keep) keys.push(k); }
  for (const k of keys) storage.removeItem(k);
}

/** 繳款 (RT-PAY) renders this: no form is open, so no draft is needed (covers the redirect after a successful send). */
export function ReportDraftSweep() {
  useEffect(() => { try { sweepDrafts(sessionStorage, null); } catch { /* storage blocked: nothing stored either */ } }, []);
  return null;
}

/** One send per press: a second submit while the first is under way is dropped (TEN-53-AC6). */
export function submitGate() {
  let open = true;
  return { take: () => { if (!open) return false; open = false; return true; }, release: () => { open = true; } };
}

const FIELD_ORDER: ReportField[] = ["amount", "paidOn", "last5"];

/** The screen-reader summary and the field to focus, in form order. */
export function errorNotice(problems: Partial<Record<ReportField, string>>, labels: Pick<Labels, "amount" | "paidOn" | "last5" | "errorItem">, formMessage: string | null) {
  const fields = FIELD_ORDER.filter(f => problems[f]);
  const items = fields.map(f => labels.errorItem.replace("{field}", labels[f]).replace("{message}", problems[f]!));
  return { focus: fields[0] ?? null, text: [...(formMessage ? [formMessage] : []), ...items].join(" ") };
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
 * Errors (client checks, or the server's refusal after a send) go to an assertive live region, and focus moves to the
 * first invalid field after the error markup has committed (effect), never straight after setState.
 */
export function TenantReportForm({ action, owner, currency, restMinor, defaults, lastUsed, needsLast5, serverError, messages, labels }: {
  action: ReportAction; owner: DraftOwner; currency: string; restMinor: number; defaults: Values; lastUsed: boolean; needsLast5: boolean;
  serverError: { field: ReportField | null; message: string } | null; messages: Record<ReportProblem, string>; labels: Labels;
}) {
  const [values, setValues] = useState<Values>(defaults);
  const [problems, setProblems] = useState<Partial<Record<ReportField, string>>>(serverError?.field ? { [serverError.field]: serverError.message } : {});
  const [notice, setNotice] = useState<{ id: number; focus: ReportField | null; text: string } | null>(null);
  const [announced, setAnnounced] = useState("");
  const [sending, setSending] = useState(false);
  const gate = useRef(submitGate());
  const formRef = useRef<HTMLFormElement>(null);
  const { userId, orgId, leaseId } = owner;
  // Mount: sweep other drafts, read this owner's draft once, restore it only after a failed send, then announce the
  // server's refusal (field or form) and focus its field.
  useEffect(() => {
    const me = { userId, orgId, leaseId }, key = reportDraftKey(me);
    try {
      sweepDrafts(sessionStorage, key);
      const draft = readDraft(sessionStorage.getItem(key), me);
      sessionStorage.removeItem(key);
      if (serverError && draft) setValues(draft);
    } catch { /* storage blocked: the prefilled values stay */ }
    if (serverError) {
      const n = errorNotice(serverError.field ? { [serverError.field]: serverError.message } : {}, labels, serverError.field ? null : serverError.message);
      setNotice({ id: 1, ...n });
    }
    // Runs once per mount; the page remounts the form (new key) after every send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!notice) return;
    if (notice.focus) formRef.current?.querySelector<HTMLInputElement>(`[data-field="${notice.focus}"]`)?.focus();
    // Clear, then fill on the next frame, so the same message twice is announced twice.
    setAnnounced("");
    const frame = requestAnimationFrame(() => setAnnounced(notice.text));
    return () => cancelAnimationFrame(frame);
  }, [notice]);
  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement>) => setValues(v => ({ ...v, [k]: e.target.value }));
  const settled = useCallback(() => { gate.current.release(); setSending(false); }, []);
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (sending || !gate.current.take()) { event.preventDefault(); return; }
    const found = reportProblems({ ...values, last5: needsLast5 ? values.last5 : "00000" }, restMinor, currency);
    const fields = Object.keys(found) as ReportField[];
    if (fields.length) {
      event.preventDefault();
      gate.current.release();
      const next = Object.fromEntries(fields.map(f => [f, messages[found[f]!]])) as Partial<Record<ReportField, string>>;
      setProblems(next);
      setNotice(n => ({ id: (n?.id ?? 0) + 1, ...errorNotice(next, labels, null) }));
      return;
    }
    setProblems({});
    setAnnounced("");
    setSending(true);
    try { sessionStorage.setItem(reportDraftKey(owner), writeDraft(owner, values)); } catch { /* no draft: values still go to the server */ }
  }
  const minor = parseAmountMinor(values.amount, currency);
  const err = (f: ReportField) => problems[f] ? <small className="t-pay-err" id={`report-${f}-err`}>{problems[f]}</small> : null;
  const aria = (f: ReportField) => problems[f] ? { "aria-invalid": true as const, "aria-describedby": `report-${f}-err` } : {};
  return <form ref={formRef} className="t-pay-card t-pay-form" action={action} onSubmit={onSubmit} noValidate data-testid="tenant-report-form">
    <input type="hidden" name="leaseId" value={leaseId} />
    <input type="hidden" name="returnTo" value="tenant" />
    <input type="hidden" name="amount" value={minor === null ? values.amount : String(minor / 100)} />
    <div className="t-pay-sr" role="alert" aria-live="assertive" aria-atomic="true" data-testid="tenant-report-errors">{announced}</div>
    {serverError && !serverError.field ? <p className="t-pay-alert" data-testid="tenant-report-failed">{serverError.message}</p> : null}
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
