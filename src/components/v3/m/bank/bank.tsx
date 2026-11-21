"use client";

import React, { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { makeT, translate, type Locale } from "../../../../i18n";
import { brandV3BankCopy } from "../../../../i18n/lanes/brand-v3";
import { bankMatchingStrings } from "../../../../i18n/bank-matching";
import type { BankCandidate, BankMonth, BankMonthFilter, BankMonthRow } from "../../../../server/b3-bank-month";
import { EmptyState } from "../../../empty-state";
import { signedMoneyLabel } from "../../../../server/format";

export function bankHref(month?: string, filter: string = "review", cursor?: string) {
  const params = new URLSearchParams({ filter });
  if (month !== undefined) params.set("month", month);
  if (cursor !== undefined) params.set("cursor", cursor);
  return `/m/bank?${params}`;
}
export function adjacentBankMonth(month: string, direction: -1 | 1) {
  const [year, part] = month.split("-").map(Number);
  const index = year * 12 + part - 1 + direction;
  return `${Math.floor(index / 12).toString().padStart(4, "0")}-${(index % 12 + 1).toString().padStart(2, "0")}`;
}
/** Exact integer fallback avoids rounding large values; unlike moneyLabel this preserves debits. */
export function bankAmount(amount: string, currency: string, locale: Locale) {
  if (Number.isSafeInteger(Number(amount))) return signedMoneyLabel(amount, currency, locale);
  const value = BigInt(amount), absolute = value < BigInt(0) ? -value : value;
  return `${currency} ${value < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}
// Existing endpoint owns consent, bank.reconcile, item gates, validation and the existing writers.
// No optimistic financial state: failures keep the row/form, successes refresh the authoritative reader.
export async function submitBankRequest(body: FormData | Record<string, string>, send: typeof fetch = fetch) {
  const multipart = body instanceof FormData;
  const response = await send("/api/bank/matching", {
    method: "POST", credentials: "same-origin",
    ...(multipart ? { body } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json() as { ok?: boolean };
  if (!response.ok || result.ok !== true) throw new Error(response.status === 403 ? "errors.forbidden" : "errors.generic");
}
export function BankLoading({ locale }: { locale: Locale }) {
  const s = brandV3BankCopy(locale);
  return <section className="v3-bank" aria-busy="true" aria-label={s.loading} data-testid="bank-loading">
    <h1>{makeT(locale)("i_nav_bank")}</h1><div className="v3-bank-skeleton" /><div className="v3-bank-skeleton" />
  </section>;
}
const candidateKey = (c: BankCandidate) => c.suggestionId ? `suggestion:${c.suggestionId}` : `payment:${c.paymentId}`;
function CandidateLabel({ candidate, locale }: { candidate: BankCandidate; locale: Locale }) {
  return <>{candidate.name || "—"} · {candidate.paidOn} · {bankAmount(candidate.amountMinor, candidate.currency, locale)}
    {candidate.invoices.map(i => <span key={i.id} className="v3-bank-sub">{i.number}{i.month ? ` · ${i.month}` : ""} · {bankAmount(i.amountMinor, candidate.currency, locale)}</span>)}</>;
}
export function BankDecision({ row, locale, mode, onClose, onSuccess }: {
  row: BankMonthRow; locale: Locale; mode: "match" | "reject"; onClose: () => void; onSuccess: () => void;
}) {
  const s = brandV3BankCopy(locale), legacy = bankMatchingStrings(locale), t = makeT(locale), router = useRouter();
  const suggestions = row.candidates.filter(c => c.suggestionId !== null);
  const [choice, setChoice] = useState(suggestions.length === 1 ? candidateKey(suggestions[0]) : "");
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const sending = useRef(false);
  // One request id per operation (B009 idempotency, as the legacy form sends): a retry of the same decision after a
  // lost response reuses it and gets the stored receipt; changing the decision, candidate or reason starts a new one.
  const operation = useRef<{ key: string; id: string } | null>(null);
  const selected = row.candidates.find(c => candidateKey(c) === choice);
  async function submit(form: FormData) {
    if (sending.current || !selected) return;
    sending.current = true; setBusy(true); setError(null);
    const reason = String(form.get("reason") ?? "");
    const key = JSON.stringify([row.id, mode, candidateKey(selected), reason]);
    if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    try {
      await submitBankRequest({ bankId: row.id, decision: mode, reason, requestId: operation.current.id,
        ...(selected.suggestionId ? { suggestionId: selected.suggestionId } : { paymentId: selected.paymentId }) });
      onSuccess();
    } catch (e) { setError(t(e instanceof Error && e.message === "errors.forbidden" ? "errors.forbidden" : "errors.generic")); }
    finally { sending.current = false; setBusy(false); }
  }
  return <section className="v3-bank-panel" aria-label={mode === "reject" ? s.reject : s.confirm} data-testid="bank-decision">
    <div className="v3-bank-toolbar"><h3>{mode === "reject" ? s.reject : s.confirm}</h3><button type="button" className="btn" onClick={onClose} disabled={busy}>{s.close}</button></div>
    <p>{row.postedOn} · {row.last5 || "—"} · {bankAmount(row.amountMinor, row.currency, locale)}</p><p>{row.account} · {row.memo || "—"}</p>
    <form onSubmit={event => { event.preventDefault(); void submit(new FormData(event.currentTarget)); }}>
      <fieldset disabled={busy}><legend>{legacy.choose}</legend>
        {row.candidates.filter(c => mode !== "reject" || c.suggestionId).map(c => <label key={candidateKey(c)} className="v3-bank-option">
          <input type="radio" name="payment" value={candidateKey(c)} checked={choice === candidateKey(c)} onChange={() => setChoice(candidateKey(c))} required />
          <span><CandidateLabel candidate={c} locale={locale} />{c.suggestionId && <span className="v3-bank-sub">{legacy.basis}: {[
            c.basis.amountExact ? legacy.amountExact : "", c.basis.last5Matched ? legacy.last5Matched : "",
            c.basis.dateDeltaDays !== null ? legacy.dateGap.replace("{days}", String(c.basis.dateDeltaDays)) : "",
          ].filter(Boolean).join(" · ") || legacy.basisUnavailable}</span>}</span>
        </label>)}
        {!row.candidates.length && <p>{s.none} · {legacy.positive}</p>}
        <label className="fg">{legacy.reason}<select name="reason" className="inp" required defaultValue="">
          <option value="" disabled>{legacy.reasonChoose}</option>{Object.entries(legacy.reasons).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select></label>
        <button className="btn" disabled={!selected || (mode === "reject" && !selected.suggestionId)}>{mode === "reject" ? s.reject : s.confirm}</button>
      </fieldset>
      {error && <div role="alert"><p>{error}</p><button type="button" className="btn" onClick={() => router.refresh()} disabled={busy}>{s.retry}</button></div>}
    </form>
  </section>;
}
function BankUpload({ accounts, locale, onSuccess }: { accounts: Extract<BankMonth, { state: "ready" }>["accounts"]; locale: Locale; onSuccess: () => void }) {
  const s = brandV3BankCopy(locale), legacy = bankMatchingStrings(locale), t = makeT(locale);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const sending = useRef(false);
  async function upload(form: FormData) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try { await submitBankRequest(form); onSuccess(); }
    catch (e) { setError(t(e instanceof Error && e.message === "errors.forbidden" ? "errors.forbidden" : "errors.generic")); }
    finally { sending.current = false; setBusy(false); }
  }
  return <details id="bank-import" className="v3-bank-upload"><summary className="btn pri">{s.upload}</summary>
    <form onSubmit={event => { event.preventDefault(); void upload(new FormData(event.currentTarget)); }}>
      {accounts.length ? <fieldset disabled={busy}>
        <legend>{s.upload}</legend>
        <label className="fg">{legacy.account}<select name="account" className="inp" required>{accounts.map(a => <option key={a.id} value={a.id}>{a.nickname} · {a.currency}</option>)}</select></label>
        <label className="fg">{legacy.csv}<input className="inp" type="file" name="file" accept=".csv,text/csv" required /></label>
        <label className="fg">{legacy.encoding}<select className="inp" name="encoding"><option value="utf-8">UTF-8</option><option value="big5">Big5</option></select></label>
        <label className="fg">{legacy.dateFormat}<select className="inp" name="dateFormat"><option value="iso">YYYY-MM-DD</option><option value="roc">ROC/MM/DD</option></select></label>
        <button className="btn">{s.upload}</button>
      </fieldset> : <p>{legacy.noAccounts}</p>}
      {error && <p role="alert">{error}</p>}
    </form>
  </details>;
}
export function BankMonthView({ data, locale, month, filter, cursor }: {
  data: BankMonth; locale: Locale; month?: string; filter?: string; cursor?: string;
}) {
  const s = brandV3BankCopy(locale), t = makeT(locale), router = useRouter();
  const [panel, setPanel] = useState<{ id: string; mode: "match" | "reject" } | null>(null);
  const [refreshing, startRefresh] = useTransition();
  function refresh() { startRefresh(() => router.refresh()); }
  function success() { setPanel(null); refresh(); }
  if (data.state !== "ready") return <section className="v3-bank" data-testid="bank-unavailable">
    <h1>{t("i_nav_bank")}</h1><p role="alert">{s.failure}</p><Link className="btn" href={bankHref(month, filter, cursor)} onClick={refresh}>{s.retry}</Link>
  </section>;
  const labelMonth = String(Number(data.month.slice(5)));
  const selected = data.rows.find(row => row.id === panel?.id);
  return <section className="v3-bank" aria-busy={refreshing} data-testid="bank-month">
    <nav className="v3-bank-month" aria-label={s.month}>
      <Link aria-label={s.previous} href={bankHref(adjacentBankMonth(data.month, -1), data.filter)}>‹</Link>
      <span>{data.month.slice(0, 4)} · {labelMonth}</span>
      <Link aria-label={s.next} href={bankHref(adjacentBankMonth(data.month, 1), data.filter)}>›</Link>
    </nav>
    <header className="v3-bank-lead"><div><h1>{translate(s, "lead", { month: labelMonth, ...data.counts })}</h1>
      <p>{translate(s, "lastUpload", { time: data.lastUploadAt ? new Intl.DateTimeFormat(locale, { timeZone: data.timezone, dateStyle: "short", timeStyle: "short" }).format(new Date(data.lastUploadAt)) : "—" })}</p>
      <p className="v3-bank-sub">{s.uploadScope}</p></div><BankUpload accounts={data.accounts} locale={locale} onSuccess={refresh} />
    </header>
    <div className="card"><nav className="v3-bank-chips" aria-label={t("i_status")}>
      {(["review", "matched", "all"] as BankMonthFilter[]).map(tab => <Link key={tab} className="btn" aria-current={data.filter === tab ? "page" : undefined} href={bankHref(data.month, tab)}>{s[tab]} <span>{data.counts[tab]}</span></Link>)}
    </nav>
    {data.counts.all === 0 ? <EmptyState id="BANK" locale={locale} /> : data.rows.length === 0 ? <p className="v3-bank-empty">{t("i_search_none")}</p> : <>
      <div className="v3-bank-row v3-bank-labels" aria-hidden="true"><span>{s.dateLast5}</span><span>{t("i_amount_label")}</span><span>{s.suggestion}</span><span /></div>
      <ul className="v3-bank-rows">{data.rows.map(row => {
        const review = row.status === "unmatched" || row.status === "suggested";
        const single = row.candidateState.count === 1;
        return <li key={row.id} data-testid="bank-row" data-status={row.status}>
          <div className="v3-bank-row">
            <div><strong>{row.postedOn}</strong><span className="v3-bank-sub">{translate(s, "last5", { last5: row.last5 || "—" })}</span><span className="v3-bank-sub">{row.account}</span></div>
            <strong className="v3-bank-amount">{bankAmount(row.amountMinor, row.currency, locale)}</strong>
            <div><strong>{review ? translate(s, row.candidateState.kind, { count: row.candidateState.count }) : s[row.status === "matched" ? "matched" : "ignored"]}</strong>
              <span className="v3-bank-sub">{row.memo}</span>{review && single && <span className="v3-bank-sub"><CandidateLabel candidate={row.candidates.find(c => c.suggestionId)!} locale={locale} /></span>}</div>
            <div className="v3-bank-actions">{review && <>
              <button type="button" className="btn" onClick={() => setPanel({ id: row.id, mode: "match" })} aria-expanded={panel?.id === row.id} aria-controls={`bank-panel-${row.id}`}>
                {single ? s.confirm : row.candidateState.count ? s.choose : s.manual}</button>
              {single && <button type="button" className="v3-bank-text" onClick={() => setPanel({ id: row.id, mode: "reject" })}>{s.reject}</button>}
            </>}</div>
          </div>
          {selected?.id === row.id && panel && <div id={`bank-panel-${row.id}`}><BankDecision key={`${row.id}-${panel.mode}`} row={row} locale={locale} mode={panel.mode} onClose={() => setPanel(null)} onSuccess={success} /></div>}
        </li>;
      })}</ul>
    </>}
    <footer className="v3-bank-toolbar"><span>{translate(s, "shown", { shown: data.rows.length, total: data.filteredCount })}</span>
      {data.nextCursor && <Link className="btn" href={bankHref(data.month, data.filter, data.nextCursor)}>{s.more}</Link>}
    </footer></div>
  </section>;
}
