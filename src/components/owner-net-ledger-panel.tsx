"use client";
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ownerNetLedgerCopy } from '@/i18n/owner-net-ledger';
import { recordReportDeliveryAction, recordStatementVersionAction } from '@/server/owner-net-ledger-actions';
import type { LedgerPanelView } from '@/server/owner-net-ledger-presentation';

export function OwnerNetLedgerPanel({ view, locale, negativeLabel }: { view: LedgerPanelView; locale: string; negativeLabel: string }) {
  const t = ownerNetLedgerCopy(locale), router = useRouter();
  const [reason, setReason] = useState(''), [requestId, setRequestId] = useState<string | null>(null);
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, start] = useTransition();
  const latest = view.latest;
  function record(e: React.FormEvent) {
    e.preventDefault();
    if (!reason || reason.length > 500 || reason !== reason.trim()) { setError(t.invalid); return; }
    const id = requestId ?? crypto.randomUUID(); setRequestId(id); setError(''); setNotice('');
    start(async () => {
      try {
        const r = await recordStatementVersionAction({ statementId: view.statementId, requestId: id, reason });
        if (r.state === 'recorded') { setRequestId(null); setReason(''); setNotice(t.recorded); router.refresh(); }
        else { if (r.state === 'invalid') setRequestId(null); setError(r.state === 'invalid' ? t.invalid : t.unavailable); }
      } catch { setError(t.unavailable); }
    });
  }
  function deliver() {
    const id = deliveryId ?? crypto.randomUUID(); setDeliveryId(id); setError(''); setNotice('');
    start(async () => {
      try {
        const r = await recordReportDeliveryAction({ statementId: view.statementId, versionId: view.latestVersionId, requestId: id });
        if (r.state === 'recorded') { setDeliveryId(null); router.refresh(); } else setError(t.unavailable);
      } catch { setError(t.unavailable); }
    });
  }
  return (
    <section className="card pad" data-testid="owner-net-ledger">
      <h2>{t.title}</h2>
      {latest ? (
        <>
          <h3>{t.latest}: {t.version(latest.versionNo)}</h3>
          <table className="tbl">
            <tbody>
              {latest.lines.map((line) => (
                <tr key={line.key} className={line.affectsBalance ? undefined : 'muted'}>
                  <td>{t.lines[line.key] ?? line.key}</td>
                  <td className="num">{line.amount}</td>
                </tr>
              ))}
              <tr><td>{latest.negative ? negativeLabel : t.net}</td><td className="num">{latest.net}</td></tr>
            </tbody>
          </table>
          {latest.negative && <p className="small" data-testid="owner-net-negative-note">{t.negativeNote}</p>}
          {latest.hasDirectRent && <p className="small muted">{t.directNote}</p>}
          <p className="small muted">{t.transferNote} {t.depositNote}</p>
          {latest.reconciles && <p className="small muted">{t.reconciles}</p>}
        </>
      ) : <p>{t.none}</p>}
      <h3>{t.history}</h3>
      <table className="tbl">
        <thead><tr><th>{t.versionLabel}</th><th>{t.at}</th><th>{t.actor}</th><th>{t.reason}</th></tr></thead>
        <tbody>
          {view.versions.map((v) => (
            <tr key={v.versionNo}>
              <td>{v.versionNo === 1 ? t.original : t.version(v.versionNo)}</td><td>{v.createdAt}</td><td>{v.actor ?? t.staffActor}</td>
              <td>{v.reason ?? '—'}{v.breakdown && (
                <details><summary>{t.breakdown}</summary>
                  <ul>{v.breakdown.lines.map((line) => <li key={line.key}>{t.lines[line.key] ?? line.key}: {line.amount}</li>)}
                    <li>{v.breakdown.negative ? negativeLabel : t.net}: {v.breakdown.net}</li></ul>
                </details>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.canRecord && (
        <form onSubmit={record}>
          <label>{t.reason}<input className="inp" value={reason} maxLength={500} disabled={pending || !!requestId} onChange={(e) => setReason(e.target.value)} required /></label>
          <button className="btn pri" disabled={pending}>{requestId ? t.retry : t.record}</button>
        </form>
      )}
      {view.deliveries && (
        <>
          <h3>{t.deliveries}</h3>
          <p className="small muted">{t.deliveryNote}</p>
          {view.deliveries.length === 0 ? <p>{t.noDeliveries}</p> : (
            <ul>{view.deliveries.map((d) => <li key={d.id}>{d.versionNo === 1 ? t.original : t.version(d.versionNo)} · {t.result[d.result] ?? d.result} · {d.createdAt}</li>)}</ul>
          )}
          {view.canRecord && <button type="button" className="btn" disabled={pending} onClick={deliver}>{deliveryId ? t.retry : t.deliver}</button>}
        </>
      )}
      {pending && <p role="status">{t.loading}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
