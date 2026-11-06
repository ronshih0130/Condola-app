"use client";
import { useState, useTransition } from 'react';
import { vendorDocumentsCopy } from '@/i18n/vendor-documents';

export type VendorDocumentsView = {
  ticketNumber: string; totalMinor: string; itemsUnavailable?: boolean; items: Array<{ name: string; quantity: number | string; unit: string; amount_minor: number | string }>;
  buyer: { kind: 'owner' | 'company'; titlePresent: boolean }; eligibleKind: 'receipt' | 'completion_statement';
  documents: Array<{ id: string; kind: 'receipt' | 'completion_statement'; doc_no: string; status: 'issued' | 'voided'; issued_at: string; reissued_from: string | null }>;
  history?: Array<{ id: string; version: number; issuerName: string; items: Array<{ name: string; quantity: number | string; unit: string; amount_minor: number | string }>; scans: Array<{ id: string; mime_type: string }> }>;
  receivedMinor: string; marks: Array<{ amountMinor: string; createdAt: string }>;
};

const today = () => new Date().toISOString().slice(0, 10);
const group = (v: string) => v.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  return res;
}

export function VendorDocumentsPanel({ token, initial, locale }: { token: string; initial: VendorDocumentsView; locale: string }) {
  const t = vendorDocumentsCopy(locale);
  const [view, setView] = useState(initial), [amount, setAmount] = useState(''), [reasons, setReasons] = useState<Record<string, string>>({});
  const [pending, start] = useTransition(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [keys] = useState(() => ({ statement: crypto.randomUUID(), receipt: crypto.randomUUID(), oneStep: crypto.randomUUID(), mark: crypto.randomUUID(), oneStepMark: crypto.randomUUID() }));
  const total = BigInt(view.totalMinor), received = BigInt(view.receivedMinor), remaining = total > received ? total - received : BigInt(0);
  const receiptAllowed = view.eligibleKind === 'receipt' && view.buyer.titlePresent;
  const refresh = async () => { const r = await post('/api/vendor-documents', { token, action: 'context' }); if (r.ok) setView(await r.json()); };
  const run = (fn: () => Promise<Response>, after?: () => void) => {
    setError(''); setNotice('');
    start(async () => {
      try {
        const r = await fn();
        if (!r.ok) { const body = await r.json().catch(() => ({})); setError(body.error === 'receipt_requires_full_payment' ? t.needFull : body.error === 'items_unavailable' ? t.itemsUnavailable : t.unavailable); return; }
        after?.(); setNotice(t.done); await refresh();
      } catch { setError(t.unavailable); }
    });
  };
  function record() {
    if (!/^[1-9][0-9]{0,15}$/.test(amount)) { setError(t.invalid); return; }
    run(() => post('/api/vendor-documents', { token, action: 'mark_received', requestId: keys.mark, amountMinor: amount }), () => { setAmount(''); keys.mark = crypto.randomUUID(); });
  }
  const issue = (kind: 'receipt' | 'completion_statement', key: string, received?: { requestId: string; amountMinor: string }) =>
    run(() => post('/api/vendor-documents', { token, action: 'issue', kind, documentDate: today(), idempotencyKey: key, ...(received ? { received } : {}) }));
  async function openPdf(res: Response) {
    if (!res.ok) { setError(t.unavailable); return; }
    const blob = !res.headers.get('content-type')?.includes('application/json') ? await res.blob()
      : new Blob([Uint8Array.from(atob((await res.json()).pdfBase64), (c) => c.charCodeAt(0))], { type: 'application/pdf' });
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
  }
  return (
    <main className="card pad" data-testid="vendor-documents">
      <h1>{t.title}</h1>
      <p>{t.ticket}: {view.ticketNumber}</p>
      <h2>{t.items}</h2>
      <ul>{view.items.map((i, n) => <li key={n}>{i.name} × {i.quantity}{i.unit ? ` ${i.unit}` : ''} · {group(String(i.amount_minor))}</li>)}</ul>
      <p><strong>{t.total}: {group(view.totalMinor)}</strong></p>
      {view.itemsUnavailable && <p role="status">{t.itemsUnavailable}</p>}
      <p>{t.buyer}: {view.buyer.kind === 'owner' ? t.buyerOwner : t.buyerCompany}</p>
      {!view.buyer.titlePresent && <p role="status">{t.titleMissing}</p>}
      <h2>{t.paidTitle}</h2>
      {view.marks.length === 0 ? <p>{t.noMarks}</p> : <ul>{view.marks.map((m, n) => <li key={n}>{m.createdAt} · {group(m.amountMinor)}</li>)}</ul>}
      <p>{t.paid}: {group(view.receivedMinor)} · {t.remaining}: {group(remaining.toString())}</p>
      <p className="small muted">{t.partialNote}</p>
      <label>{t.recordLabel}<input className="inp" inputMode="numeric" value={amount} disabled={pending} onChange={(e) => setAmount(e.target.value.trim())} /></label>
      <button type="button" className="btn" disabled={pending} onClick={record}>{t.record}</button>
      {!view.itemsUnavailable && <div>
        <button type="button" className="btn" disabled={pending} onClick={() => start(async () => openPdf(await post('/api/vendor-documents', { token, action: 'preview', kind: 'completion_statement', documentDate: today() })))}>{t.preview} · {t.statement}</button>
        <button type="button" className="btn" disabled={pending} onClick={() => issue('completion_statement', keys.statement)}>{t.issueStatement}</button>
        {receiptAllowed ? <>
          <button type="button" className="btn" disabled={pending} onClick={() => start(async () => openPdf(await post('/api/vendor-documents', { token, action: 'preview', kind: 'receipt', documentDate: today() })))}>{t.preview} · {t.receipt}</button>
          <button type="button" className="btn pri" disabled={pending || remaining > BigInt(0)} onClick={() => issue('receipt', keys.receipt)}>{t.issueReceipt}</button>
          {remaining > BigInt(0) && <button type="button" className="btn pri" disabled={pending} onClick={() => issue('receipt', keys.oneStep, { requestId: keys.oneStepMark, amountMinor: remaining.toString() })}>{t.oneStep}</button>}
          {remaining > BigInt(0) && <p className="small">{t.needFull}</p>}
        </> : view.eligibleKind !== 'receipt' ? <p className="small">{t.notEligible}</p> : null}
        <p className="small muted">{t.previewNote} {t.notTax}</p>
      </div>}
      <h2>{t.documents}</h2>
      {view.documents.length === 0 ? <p>{t.none}</p> : <ul>{view.documents.map((d) => <li key={d.id}>
        {d.kind === 'receipt' ? t.receipt : t.statement} {d.doc_no} · {d.status === 'voided' ? t.voided : t.issued} · {d.issued_at}
        <button type="button" className="btn" disabled={pending} onClick={() => start(async () => openPdf(await post('/api/vendor-documents/pdf', { token, documentId: d.id })))}>{t.download}</button>
        {view.history?.filter((h) => h.id === d.id).map((h) => <div key={h.id}>
          <p>{t.snapshotVersion} {h.version} · {h.issuerName}</p>
          <ul>{h.items.map((item, i) => <li key={i}>{item.name} · {item.quantity} {item.unit} · {item.amount_minor}</li>)}</ul>
          {h.scans.map((scan) => <button type="button" className="btn" key={scan.id} disabled={pending}
            onClick={() => start(async () => openPdf(await post('/api/vendor-documents/scan', { token, scanId: scan.id })))}>{t.paperScan}</button>)}
        </div>)}
        {d.status === 'issued' && <>
          <input className="inp" aria-label={t.voidReason} placeholder={t.voidReason} value={reasons[d.id] ?? ''} maxLength={1000} disabled={pending} onChange={(e) => setReasons((r) => ({ ...r, [d.id]: e.target.value }))} />
          <button type="button" className="btn" disabled={pending || !(reasons[d.id] ?? '').trim()} onClick={() => run(() => post('/api/vendor-documents', { token, action: 'void', documentId: d.id, reason: (reasons[d.id] ?? '').trim() }))}>{t.void}</button>
        </>}
        {d.status === 'voided' && <button type="button" className="btn" disabled={pending} onClick={() => run(() => post('/api/vendor-documents', { token, action: 'reissue', kind: d.kind, documentDate: today(), documentId: d.id, idempotencyKey: `reissue-${d.id}` }))}>{t.reissue}</button>}
      </li>)}</ul>}
      {pending && <p role="status">{t.loading}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </main>
  );
}
