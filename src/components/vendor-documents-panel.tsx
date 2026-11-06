"use client";
import { useRef, useState, useTransition } from 'react';
import { vendorDocumentsCopy } from '@/i18n/vendor-documents';
import { FixedDataForm, PaperScanForm, TradeItemsForm, documentAttachment, type VendorFixedData } from './vendor-document-forms';
import { tradeLineItems, tradeTotal, type TradeLineInput } from '@/server/vendor-document-trade-rules';

export type VendorDocumentsView = {
  profileVersion: number; profile: VendorFixedData;
  ticketNumber: string; totalMinor: string; itemsUnavailable?: boolean; items: Array<{ name: string; quantity: number | string; unit: string; unit_price_minor?: number | string; category?: TradeLineInput['category']; amount_minor: number | string }>;
  buyer: { kind: 'owner' | 'company'; titlePresent: boolean }; eligibleKind: 'receipt' | 'completion_statement';
  documents: Array<{ id: string; kind: 'receipt' | 'completion_statement'; doc_no: string; status: 'issued' | 'voided'; issued_at: string; reissued_from: string | null }>;
  history?: Array<{ id: string; version: number | null; issuerName: string; fixedData?: Omit<VendorFixedData, 'kind'>; sealPresent?: boolean; items: Array<{ name: string; quantity: number | string; unit: string; unit_price_minor?: number | string; category?: TradeLineInput['category']; amount_minor: number | string }>; scans: Array<{ id: string; mime_type: string }> }>;
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
  const [keys] = useState(() => ({ mark: crypto.randomUUID() }));
  const attempts = useRef(new Map<string, { fingerprint: string; body: Record<string, unknown> }>());
  const [completed, setCompleted] = useState<ReadonlySet<string>>(() => new Set());
  const kindExists = (kind: 'receipt' | 'completion_statement') => completed.has(kind) || view.documents.some((d) => d.kind === kind);
  const [editTrades, setEditTrades] = useState(false);
  const [trades, setTrades] = useState<TradeLineInput[]>(() => initial.items.length ? initial.items.map((i) => ({
    name: i.name, quantity: String(i.quantity), unit: i.unit, unit_price_minor: String(i.unit_price_minor ?? i.amount_minor), category: i.category ?? 'service',
  })) : [{ name: '', quantity: '1', unit: '', unit_price_minor: '', category: 'service' }]);
  let tradesValid = !editTrades;
  if (editTrades) { try { tradesValid = tradeTotal(tradeLineItems(trades)).toString() === view.totalMinor; } catch { /* Incomplete draft. */ } }
  const tradeFields = editTrades ? { tradeItems: trades } : {};
  const canIssue = tradesValid && (!view.itemsUnavailable || editTrades);
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
  function issue(kind: 'receipt' | 'completion_statement', receivedAmount?: string, documentId?: string) {
    const slot = documentId ? `reissue-${documentId}` : kind;
    if (completed.has(slot) || (!documentId && kindExists(kind))
      || (documentId && view.documents.some((d) => d.reissued_from === documentId))) return;
    const payload = { token, action: documentId ? 'reissue' : 'issue', kind, ...tradeFields,
      ...(documentId ? { documentId } : {}) };
    // Retain the exact body (including date and payment request ID) after an
    // uncertain response. A changed draft must never replay an old issuance key
    // or silently create another document after a possibly committed request.
    const fingerprint = JSON.stringify({ payload, receivedAmount, profileVersion: view.profileVersion });
    let attempt = attempts.current.get(slot);
    if (attempt && attempt.fingerprint !== fingerprint) { setNotice(''); setError(t.retryUnchanged); return; }
    if (!attempt) {
      attempt = { fingerprint, body: JSON.parse(JSON.stringify({ ...payload, documentDate: today(), idempotencyKey: crypto.randomUUID(),
        ...(receivedAmount ? { received: { requestId: crypto.randomUUID(), amountMinor: receivedAmount } } : {}) })) };
      attempts.current.set(slot, attempt);
    }
    const body = attempt.body;
    run(() => post('/api/vendor-documents', body), () => setCompleted((previous) => new Set([...previous, slot, kind])));
  }
  async function openPdf(res: Response) {
    if (!res.ok) { setError(t.unavailable); return; }
    const blob = !res.headers.get('content-type')?.includes('application/json') ? await res.blob()
      : new Blob([Uint8Array.from(atob((await res.json()).pdfBase64), (c) => c.charCodeAt(0))], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const download = (path: string, body: Record<string, unknown>) => start(async () => {
    setError(''); try { await openPdf(await post(path, body)); } catch { setError(t.unavailable); }
  });
  return (
    <main className="card pad" data-testid="vendor-documents">
      <h1>{t.title}</h1>
      <p>{t.ticket}: {view.ticketNumber}</p>
      <FixedDataForm key={view.profileVersion} profile={view.profile} version={view.profileVersion} pending={pending} locale={locale}
        save={(update, seal) => run(async () => {
          const attachment = seal ? await documentAttachment(seal, true) : undefined;
          return post('/api/vendor-documents', { token, action: 'update_fixed_data', update: {
            ...update, ...(attachment ? { seal: attachment } : {}),
          } });
        })} />
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
      <label><input type="checkbox" checked={editTrades} disabled={pending} onChange={(e) => setEditTrades(e.target.checked)} />{t.editTrades}</label>
      {editTrades && <TradeItemsForm rows={trades} setRows={setTrades} pending={pending} locale={locale} totalMinor={view.totalMinor} />}
      {canIssue && <div>
        <button type="button" className="btn" disabled={pending} onClick={() => download('/api/vendor-documents', { token, action: 'preview', kind: 'completion_statement', documentDate: today(), ...tradeFields })}>{t.preview} · {t.statement}</button>
        <button type="button" className="btn" disabled={pending || kindExists('completion_statement')} onClick={() => issue('completion_statement')}>{t.issueStatement}</button>
        {receiptAllowed ? <>
          <button type="button" className="btn" disabled={pending} onClick={() => download('/api/vendor-documents', { token, action: 'preview', kind: 'receipt', documentDate: today(), ...tradeFields })}>{t.preview} · {t.receipt}</button>
          <button type="button" className="btn pri" disabled={pending || kindExists('receipt') || remaining > BigInt(0)} onClick={() => issue('receipt')}>{t.issueReceipt}</button>
          {remaining > BigInt(0) && <button type="button" className="btn pri" disabled={pending || kindExists('receipt')} onClick={() => issue('receipt', remaining.toString())}>{t.oneStep}</button>}
          {remaining > BigInt(0) && <p className="small">{t.needFull}</p>}
        </> : view.eligibleKind !== 'receipt' ? <p className="small">{t.notEligible}</p> : null}
      </div>}
      {view.documents.length > 0 && <p className="small">{t.correctByReissue}</p>}
      <p className="small muted">{t.previewNote} {t.notTax}</p>
      <h2>{t.documents}</h2>
      {view.documents.length === 0 ? <p>{t.none}</p> : <ul>{view.documents.map((d) => <li key={d.id}>
        {d.kind === 'receipt' ? t.receipt : t.statement} {d.doc_no} · {d.status === 'voided' ? t.voided : t.issued} · {d.issued_at}
        <button type="button" className="btn" disabled={pending} onClick={() => download('/api/vendor-documents/pdf', { token, documentId: d.id })}>{t.download}</button>
        {view.history?.filter((h) => h.id === d.id).map((h) => <div key={h.id}>
          <p>{t.snapshotVersion} {h.version ?? '—'} · {h.issuerName}</p>
          {h.fixedData && <details><summary>{t.historicalDetails}</summary>
            <dl>{(['display_name', 'business_name', 'representative_name', 'phone_e164', 'address'] as const).map((key) => h.fixedData?.[key]
              ? <div key={key}><dt>{t[key]}</dt><dd>{h.fixedData[key]}</dd></div> : null)}</dl>
            <p>{h.sealPresent ? t.sealPresent : t.sealAbsent}</p>
          </details>}
          <ul>{h.items.map((item, i) => <li key={i}>{item.name} · {item.quantity} {item.unit} · {item.amount_minor}</li>)}</ul>
          {h.scans.map((scan) => <button type="button" className="btn" key={scan.id} disabled={pending}
            onClick={() => download('/api/vendor-documents/scan', { token, scanId: scan.id })}>{t.paperScan}</button>)}
        </div>)}
        {d.kind === 'receipt' && <PaperScanForm pending={pending} locale={locale} upload={(file, requestId) => new Promise<boolean>((resolve) => {
          setError(''); setNotice('');
          start(async () => {
            try {
              const attachment = await documentAttachment(file);
              const result = await post('/api/vendor-documents', { token, action: 'attach_scan', documentId: d.id, requestId, ...attachment });
              if (!result.ok) { setError(t.unavailable); resolve(false); return; }
              await refresh(); setNotice(t.done); resolve(true);
            } catch { setError(t.unavailable); resolve(false); }
          });
        })} />}
        {d.status === 'issued' && <>
          <input className="inp" aria-label={t.voidReason} placeholder={t.voidReason} value={reasons[d.id] ?? ''} maxLength={1000} disabled={pending} onChange={(e) => setReasons((r) => ({ ...r, [d.id]: e.target.value }))} />
          <button type="button" className="btn" disabled={pending || !(reasons[d.id] ?? '').trim()} onClick={() => run(() => post('/api/vendor-documents', { token, action: 'void', documentId: d.id, reason: (reasons[d.id] ?? '').trim() }))}>{t.void}</button>
        </>}
        {d.status === 'voided' && canIssue && <button type="button" className="btn" disabled={pending || completed.has(`reissue-${d.id}`) || view.documents.some((next) => next.reissued_from === d.id)} onClick={() => issue(d.kind, undefined, d.id)}>{t.reissue}</button>}
      </li>)}</ul>}
      {pending && <p role="status">{t.loading}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </main>
  );
}
